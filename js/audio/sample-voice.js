/**
 * Flexatone — audio/sample-voice.js
 * Layer 3 (audio): the per-voice Sampler at the Web Audio level.
 *   - importSampleFile(file): decode any browser-supported sound file → mono 48 kHz → sample library.
 *   - createToneSource(ctx, { sample, wave }): what every studio creates where it used to call
 *     ctx.createOscillator() + setPeriodicWave(wave). Without a sample spec it *is* that oscillator.
 *     With one it is an AudioBufferSourceNode playing the voice's region, wrapped so the existing code
 *     keeps working unchanged: `frequency` calls (value, setValueAtTime, ramps, setValueCurveAtTime)
 *     become playbackRate = Hz / root; `detune`, connect, start, stop, onended pass through.
 *     Pitch-only voices (spec.play = 'pitch') record the frequency / detune calls instead and, when
 *     stop() gives the end time, render the grains (modules/sample-source.js renderGrainShift) into a
 *     buffer played at rate 1. Every studio calls start() then stop() right away, so nothing changes there.
 *     음높이만 모드: frequency/detune 호출을 기록했다가 stop()으로 끝 시각이 정해지면 그레인을 렌더해 1배속 재생.
 * 계층 3 (audio): 웹 오디오 단계의 보이스별 샘플러. 기존 오실레이터 자리에 그대로 들어가도록
 * frequency 호출을 playbackRate = Hz / 루트로 바꿔 주는 래퍼.
 *
 * Imports: core/*, modules/*. Browser audio APIs only (no DOM).
 */

import { midiToFreq } from '../core/units.js';
import { registerSelfCheck } from '../core/state.js';
import { addSample, getSample, removeSample, MAX_SAMPLE_SEC } from '../core/sample-library.js';
import { normalizeSampleSpec, sampleRegionKey, renderSampleRegion, integrateReadSec, regionStartOffset, renderGrainShift, sampleTapeSpeed } from '../modules/sample-source.js';

/** Rate every imported file is stored at (the app's export rate). / 가져온 파일의 저장 샘플레이트 */
export const SAMPLE_STORE_RATE = 48000;

// --------------------------------------------------------------------------
// Import / 가져오기
// --------------------------------------------------------------------------

/**
 * Decode a sound file (WAV, AIFF, MP3, OGG, FLAC, M4A … whatever the browser decodes), mix it to
 * mono, resample to 48 kHz, cut to MAX_SAMPLE_SEC, and add it to the library.
 * 사운드 파일 디코딩 → 모노 48 kHz → 최대 길이로 자름 → 라이브러리에 추가.
 * @param {File|Blob} file
 * @returns {Promise<{ entry: object, cut: boolean }>}
 */
export async function importSampleFile(file) {
  const bytes = await file.arrayBuffer();
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('Web Audio API is not available');
  // decodeAudioData resamples to the context's rate / 컨텍스트 레이트로 리샘플
  const ctx = new Offline(1, 1, SAMPLE_STORE_RATE);
  const buf = await ctx.decodeAudioData(bytes);
  const cut = buf.duration > MAX_SAMPLE_SEC + 1e-3;
  const n = Math.min(buf.length, Math.round(MAX_SAMPLE_SEC * buf.sampleRate));
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  const name = String(file.name || 'Sample').replace(/\.[a-z0-9]{1,5}$/i, '');
  const entry = addSample({ name, sampleRate: buf.sampleRate, data: mono });
  return { entry, cut };
}

// --------------------------------------------------------------------------
// Region buffers (cached, context-independent) / 구간 버퍼 (캐시, 컨텍스트 무관)
// --------------------------------------------------------------------------

const regionCache = new Map(); // key → { buffer, loop, seconds }
const REGION_CACHE_MAX = 48;

function makeBuffer(data, sampleRate) {
  const Ctor = globalThis.AudioBuffer;
  if (typeof Ctor === 'function') {
    try {
      const b = new Ctor({ length: data.length, numberOfChannels: 1, sampleRate });
      b.copyToChannel(data, 0);
      return b;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * The voice's region as an AudioBuffer (null when the file is not in the library).
 * An AudioBuffer may be played by any context, live or offline. / 어떤 컨텍스트에서도 재생 가능
 * @returns {{ buffer: AudioBuffer, data: Float32Array, sampleRate: number, loop: boolean, seconds: number } | null}
 */
export function getSampleRegionBuffer(spec) {
  const s = normalizeSampleSpec(spec);
  const entry = getSample(s.id);
  if (!entry) return null;
  const key = sampleRegionKey(s);
  let hit = regionCache.get(key);
  if (hit) {
    regionCache.delete(key);
    regionCache.set(key, hit);
    return hit;
  }
  const r = renderSampleRegion(entry, s);
  const buffer = makeBuffer(r.data, r.sampleRate);
  if (!buffer) return null;
  hit = { buffer, data: r.data, sampleRate: r.sampleRate, loop: r.loop, seconds: r.data.length / r.sampleRate };
  if (regionCache.size >= REGION_CACHE_MAX) regionCache.delete(regionCache.keys().next().value);
  regionCache.set(key, hit);
  return hit;
}

// --------------------------------------------------------------------------
// Oscillator-shaped sample source / 오실레이터 모양의 샘플 소스
// --------------------------------------------------------------------------

/** An AudioParam view that multiplies every value by `k` (Hz → playback rate). / 값에 k를 곱하는 파라미터 */
function scaledParam(param, k) {
  const p = {
    get value() { return param.value / k; },
    set value(v) { param.value = v * k; },
    setValueAtTime(v, t) { param.setValueAtTime(v * k, t); return p; },
    linearRampToValueAtTime(v, t) { param.linearRampToValueAtTime(v * k, t); return p; },
    exponentialRampToValueAtTime(v, t) { param.exponentialRampToValueAtTime(Math.max(1e-6, v * k), t); return p; },
    setTargetAtTime(v, t, c) { param.setTargetAtTime(v * k, t, c); return p; },
    setValueCurveAtTime(curve, t, d) {
      const c = new Float32Array(curve.length);
      for (let i = 0; i < curve.length; i++) c[i] = curve[i] * k;
      param.setValueCurveAtTime(c, t, d);
      return p;
    },
    cancelScheduledValues(t) { param.cancelScheduledValues(t); return p; },
  };
  return p;
}

/**
 * An AudioParam stand-in that only records what is scheduled and can be read back at any context
 * time (set, linear / exponential ramps, setTargetAtTime as a step, setValueCurveAtTime).
 * 예약된 값을 기록만 하고 임의 시각의 값을 읽을 수 있는 AudioParam 대용.
 */
function recordedParam(initial) {
  const ev = [];
  let base = initial;
  const p = {
    get value() { return base; },
    set value(v) { base = Number(v) || 0; },
    setValueAtTime(v, t) { ev.push({ k: 'set', t, v }); return p; },
    linearRampToValueAtTime(v, t) { ev.push({ k: 'lin', t, v }); return p; },
    exponentialRampToValueAtTime(v, t) { ev.push({ k: 'exp', t, v }); return p; },
    setTargetAtTime(v, t) { ev.push({ k: 'set', t, v }); return p; },
    setValueCurveAtTime(curve, t, d) { ev.push({ k: 'curve', t, d, c: Float32Array.from(curve) }); return p; },
    cancelScheduledValues(t) { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].t >= t) ev.splice(i, 1); return p; },
    /** Value at context time `time`. / 시각 time의 값 */
    at(time) {
      let v = base;
      let tPrev = -Infinity;
      for (const e of ev) {
        if (e.k === 'curve') {
          if (time < e.t) break;
          const n = e.c.length;
          if (time >= e.t + e.d) { v = e.c[n - 1]; tPrev = e.t + e.d; continue; }
          const x = ((time - e.t) / e.d) * (n - 1);
          const j = Math.min(n - 2, Math.floor(x));
          return e.c[j] + (x - j) * (e.c[j + 1] - e.c[j]);
        }
        if (time < e.t) {
          if (e.k === 'lin' && Number.isFinite(tPrev)) return v + ((time - tPrev) / (e.t - tPrev)) * (e.v - v);
          if (e.k === 'exp' && Number.isFinite(tPrev) && v > 0 && e.v > 0) return v * Math.pow(e.v / v, (time - tPrev) / (e.t - tPrev));
          break;
        }
        v = e.v;
        tPrev = e.t;
      }
      return v;
    },
  };
  return p;
}

class SampleTone {
  constructor(ctx, region, spec) {
    this.isSample = true;
    this.node = ctx.createBufferSource();
    this.region = region;
    this.rootMidi = spec.root;
    this.pitchOnly = spec.play === 'pitch';
    this.speed = spec.speed;
    this.tapeSpeed = sampleTapeSpeed(spec); // tape: rate = speed · Hz / root / 테이프 배율
    this.grainSec = spec.grainMs / 1000;
    this.offset = 0;
    this.silent = !region;
    this.started = false;
    this.rendered = false;
    if (this.pitchOnly) {
      // Recorded; turned into grains at stop() / 기록 후 stop()에서 그레인으로 렌더
      this.frequency = recordedParam(midiToFreq(spec.root));
      this.detune = recordedParam(0);
    } else {
      if (region) {
        this.node.buffer = region.buffer;
        this.node.loop = region.loop;
      }
      this.frequency = scaledParam(this.node.playbackRate, this.tapeSpeed / midiToFreq(spec.root));
      this.detune = this.node.detune;
    }
  }

  /** Region seconds already read before start (the voice started earlier). / 시작 전 이미 읽은 구간 초 */
  setReadSec(readSec) {
    if (!this.region) return;
    if (this.pitchOnly) { this.offset = Math.max(0, readSec); return; } // the grain renderer wraps / 그레인 렌더러가 처리
    const off = regionStartOffset(readSec, this.region.seconds, this.region.loop);
    if (off === null) this.silent = true; // one shot already over / 원샷이 이미 끝남
    else this.offset = off;
  }

  connect(dest, ...rest) { return this.node.connect(dest, ...rest); }
  disconnect(...args) { try { this.node.disconnect(...args); } catch { /* ignore */ } }
  start(t = 0) {
    if (this.silent) return;
    this.started = true;
    if (this.pitchOnly) { this.startT = t; return; } // rendered at stop() / stop()에서 렌더
    this.node.start(t, this.offset);
  }

  stop(t = 0) {
    if (!this.started) return;
    if (this.pitchOnly && !this.rendered) {
      this.rendered = true;
      this.renderGrains(this.startT, t);
      this.node.start(this.startT);
    }
    this.node.stop(t);
  }

  /** Render the pitch-only buffer for [t0, t1] (context time). / 음높이만 버퍼 렌더 */
  renderGrains(t0, t1) {
    const ctx = this.node.context;
    const outRate = ctx.sampleRate;
    const n = Math.max(1, Math.round((t1 - t0) * outRate));
    const reg = this.region;
    if (!reg.loop && this.offset >= reg.seconds) return; // one shot already over / 원샷이 이미 끝남
    const inv = 1 / midiToFreq(this.rootMidi);
    const data = renderGrainShift({
      src: reg.data,
      srcRate: reg.sampleRate,
      loop: reg.loop,
      outRate,
      n,
      readStartSec: this.offset,
      speed: this.speed,
      grainSec: this.grainSec,
      ratioAt: (i) => {
        const time = t0 + i / outRate;
        return this.frequency.at(time) * inv * Math.pow(2, this.detune.at(time) / 1200);
      },
    });
    const buf = makeBuffer(data, outRate);
    if (buf) this.node.buffer = buf;
  }

  set onended(fn) { this.node.onended = fn; }
  get onended() { return this.node.onended; }
}

/**
 * Oscillator for a synth voice, or a SampleTone for a Sampler voice. A Sampler voice whose file is
 * missing stays silent (never falls back to the synth). / 신스 보이스 = 오실레이터, 샘플러 보이스 = SampleTone
 * @param {BaseAudioContext} ctx
 * @param {{ sample?: object|null, wave?: PeriodicWave|null, tape?: boolean }} opts
 *   tape: force tape playback (open-ended sources such as the scrub audition, which never call stop())
 */
export function createToneSource(ctx, { sample = null, wave = null, tape = false } = {}) {
  if (sample) {
    const s = normalizeSampleSpec(sample);
    // Forced tape (scrub audition) previews the pitch: a pitch-only voice's read speed must not shift it
    // 강제 테이프(스크럽 미리듣기)는 음높이 미리듣기 — 음높이만 보이스의 읽기 속도가 음높이를 바꾸면 안 됨
    if (tape) { if (s.play === 'pitch') s.speed = 1; s.play = 'tape'; }
    return new SampleTone(ctx, getSampleRegionBuffer(s), s);
  }
  const osc = ctx.createOscillator();
  if (wave) osc.setPeriodicWave(wave);
  return osc;
}

/**
 * When a Sampler voice starts playing in its middle (cue / loop pass), skip what it would already
 * have read: tape speed · ∫ hz(t) / root dt, pitch only speed · elapsed, from the voice start.
 * 보이스 중간에서 시작할 때 테이프 재생이 이미 읽었을 만큼 건너뜀. No-op for oscillators.
 * @param {object} tone      value returned by createToneSource
 * @param {(sec: number) => number} hzAt heard frequency at a document second
 */
export function skipSampleRead(tone, hzAt, voiceStartSec, fromSec) {
  if (!tone || !tone.isSample || !(fromSec > voiceStartSec + 1e-6)) return;
  // Pitch only: the pointer moves at `speed` regardless of pitch / 음높이만: 포인터는 음높이와 무관
  if (tone.pitchOnly) { tone.setReadSec(tone.speed * (fromSec - voiceStartSec)); return; }
  const sr = tone.node.context?.sampleRate || SAMPLE_STORE_RATE;
  tone.setReadSec(tone.tapeSpeed * integrateReadSec(hzAt, voiceStartSec, fromSec, tone.rootMidi, { blockSec: 128 / sr })); // k-rate playbackRate / k-rate 보정
}

registerSelfCheck('Sampler audio: region buffer, tape octave up = half the length, pitch-only octave up = same length, tape speed', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline || typeof globalThis.AudioBuffer !== 'function') { a.ok(true, 'Web Audio unavailable — skipped'); return; }
  const sr = SAMPLE_STORE_RATE;
  const data = new Float32Array(sr / 2); // 0.5 s of DC-free noise burst / 0.5초
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.05) * 0.8;
  const entry = addSample({ name: 'check-sampler', sampleRate: sr, data });
  const spec = { id: entry.id, root: 60, xfadeMs: 0 };
  const reg = getSampleRegionBuffer(spec);
  a.ok(reg && Math.abs(reg.seconds - 0.5) < 1e-3, 'region seconds');
  const ctx = new Offline(1, sr, sr);
  const tone = createToneSource(ctx, { sample: spec });
  a.ok(tone.isSample, 'sample tone');
  tone.frequency.value = midiToFreq(72); // one octave up → rate 2 / 한 옥타브 위 → 2배속
  a.near(tone.node.playbackRate.value, 2, 1e-4, 'rate');
  tone.connect(ctx.destination);
  tone.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  let last = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 1e-4) last = i;
  a.near(last / sr, 0.25, 0.01, `sound ends at ${(last / sr).toFixed(3)} s`);
  // Tape speed ×2 at the root note: rate 2, and a mid-voice start skips twice as much / 테이프 속도 ×2
  const fast = createToneSource(new Offline(1, 128, sr), { sample: { ...spec, speed: 2 } });
  fast.frequency.value = midiToFreq(60);
  a.near(fast.node.playbackRate.value, 2, 1e-4, 'tape speed ×2 → rate 2');
  skipSampleRead(fast, () => midiToFreq(60), 0, 0.1);
  a.near(fast.offset, 0.2, 0.002, `tape speed ×2 skips ${fast.offset.toFixed(3)} s for 0.1 s`);
  const floor = createToneSource(new Offline(1, 128, sr), { sample: { ...spec, speed: 0 } });
  floor.frequency.value = midiToFreq(60);
  a.ok(floor.node.playbackRate.value > 0, 'tape speed 0 keeps a small positive rate');
  const scrub = createToneSource(new Offline(1, 128, sr), { sample: { ...spec, play: 'pitch', speed: 0.5 }, tape: true });
  scrub.frequency.value = midiToFreq(60);
  a.near(scrub.node.playbackRate.value, 1, 1e-4, 'forced tape of a pitch-only voice ignores its read speed');
  const missing = createToneSource(new Offline(1, 128, sr), { sample: { id: 'smp_missing' } });
  a.ok(missing.silent, 'missing file → silent');
  missing.start(0);
  missing.stop(0.01); // no throw / 예외 없음
  // Pitch only: one octave up keeps the region length (0.5 s), with a frequency curve / 음높이만: 옥타브 위에서도 길이 유지
  const ctx2 = new Offline(1, sr, sr);
  const pt = createToneSource(ctx2, { sample: { ...spec, play: 'pitch' } });
  a.ok(pt.pitchOnly, 'pitch-only tone');
  pt.frequency.setValueCurveAtTime(new Float32Array([midiToFreq(72), midiToFreq(72)]), 0, 1);
  pt.connect(ctx2.destination);
  pt.start(0);
  pt.stop(1);
  pt.stop(0.9); // a second stop (transport teardown) must not re-render or throw / 두 번째 stop 허용
  const out2 = (await ctx2.startRendering()).getChannelData(0);
  let last2 = 0;
  for (let i = 0; i < out2.length; i++) if (Math.abs(out2[i]) > 1e-3) last2 = i;
  a.near(last2 / sr, 0.5, 0.05, `pitch-only sound ends at ${(last2 / sr).toFixed(3)} s`);
  removeSample(entry.id); // keep the check file out of the user's library / 점검용 파일 제거
}, { group: 'audio' });

registerSelfCheck('Voice-source seam: createToneSource without a sample = the plain oscillator (bit-identical)', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'Web Audio unavailable — skipped'); return; }
  const sr = 24000;
  const render = async (make) => {
    const ctx = new Offline(1, sr / 4, sr);
    const wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0.3, 0]), new Float32Array([0, 1, 0, 0.4]));
    const osc = make(ctx, wave);
    osc.frequency.setValueCurveAtTime(new Float32Array([220, 330, 247]), 0, 0.2);
    osc.detune.setValueAtTime(15, 0.1);
    osc.connect(ctx.destination);
    osc.start(0);
    osc.stop(0.24);
    return { osc, data: (await ctx.startRendering()).getChannelData(0) };
  };
  const ref = await render((ctx, wave) => { const o = ctx.createOscillator(); o.setPeriodicWave(wave); return o; });
  const got = await render((ctx, wave) => createToneSource(ctx, { wave }));
  a.ok(typeof OscillatorNode === 'undefined' || got.osc instanceof OscillatorNode, 'no sample → a real OscillatorNode');
  a.ok(!got.osc.isSample, 'not a sample tone');
  let maxDiff = 0;
  for (let i = 0; i < ref.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref.data[i] - got.data[i]));
  a.ok(maxDiff === 0, `identical render (max diff ${maxDiff})`);
}, { group: 'audio' });
