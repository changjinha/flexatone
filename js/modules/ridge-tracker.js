/**
 * Flexatone — modules/ridge-tracker.js
 * Layer 1 (modules, pure): ridge tracking on a time × pitch amplitude matrix — follows the local
 * maxima of each frame through time and returns them as tracks (pitch and amplitude per frame).
 * 계층 1 (modules, 순수): 시간 × 음고 진폭 행렬의 리지 트래킹 — 프레임별 극대점을 시간에 따라 이어 트랙으로 반환.
 *
 * Domain-agnostic: the matrix is M[f·N + i] (frame f, bin i), any non-negative values. Used by the
 * Grid Studio for "Bake to Glissando Voices" and for the Manager's Master View lines.
 * (Wave Studio has its own tracker in wave-engine.js; it could use this one too — not changed here.)
 * 행렬 형식은 M[f·N + i]. 그리드 스튜디오의 베이킹과 마스터 뷰 선에 사용.
 *
 * Imports: nothing. No DOM / Audio APIs.
 */

/**
 * @param {Float32Array} M matrix, frames × bins
 * @param {number} N bins per frame
 * @param {number} F frames
 * @param {{ thresh?: number, maxJump?: number, maxGap?: number, minLen?: number, maxTracks?: number, step?: number, smooth?: number }} [o]
 *   thresh    peaks below thresh·(matrix maximum) are ignored            극대 임계 (행렬 최댓값 대비)
 *   maxJump   largest move of a track between two analysed frames (bins)  프레임 간 최대 이동 (빈)
 *   maxGap    analysed frames a track may be silent before it ends       끊김 허용 (분석 프레임 수)
 *   minLen    shortest track kept (analysed frames)                       최소 길이
 *   maxTracks keep the strongest tracks only (by energy)                  에너지 순 상한
 *   step      analyse every step-th frame                                 분석 간격
 *   smooth    box radius (bins) applied along pitch before the maxima are searched, so a wide,
 *             uneven ridge (a blurred cluster) is one ridge   극대 탐색 전 음고 방향 평활 반경
 * @returns {{ tracks: Array<{ f0: number, step: number, bin: Float32Array, amp: Float32Array, width: number, energy: number }>, total: number, peak: number }}
 *   bin[j] = fractional bin at frame f0 + j·step (parabolic peak), amp[j] = amplitude there (0 inside
 *   a bridged gap), width = mean half-width of the ridge in bins (second moment around the peak).
 */
export function trackRidges(M, N, F, o = {}) {
  const { thresh = 0.05, maxJump = 4, maxGap = 8, minLen = 4, maxTracks = 64, step = 1, smooth = 0 } = o;
  const sm = Math.max(0, Math.round(smooth));
  const row = sm ? new Float32Array(N) : null;
  let peak = 0;
  for (let j = 0; j < M.length; j++) if (M[j] > peak) peak = M[j];
  if (!(peak > 0)) return { tracks: [], total: 0, peak: 0 };
  const floor = Math.max(1e-6, thresh * peak);
  const open = []; // { f0, bins: [], amps: [], last, gap, w, wn }
  const done = [];
  const found = [];
  const close = (tr) => {
    // drop the bridged tail / 끝의 끊김 구간 제거
    while (tr.amps.length && tr.amps[tr.amps.length - 1] === 0) { tr.amps.pop(); tr.bins.pop(); }
    if (tr.amps.length >= minLen) done.push(tr);
  };
  for (let f = 0; f < F; f += step) {
    const o0 = f * N;
    found.length = 0;
    if (sm) {
      // running box mean of radius sm / 반경 sm의 이동 평균
      let acc = 0;
      for (let i = 0; i < Math.min(sm, N); i++) acc += M[o0 + i];
      for (let i = 0; i < N; i++) {
        if (i + sm < N) acc += M[o0 + i + sm];
        if (i - sm - 1 >= 0) acc -= M[o0 + i - sm - 1];
        row[i] = acc > 1e-9 ? acc / (2 * sm + 1) : 0;
      }
    }
    for (let i = 0; i < N; i++) {
      const v = sm ? row[i] * (2 * sm + 1) > floor ? row[i] : 0 : M[o0 + i];
      if (sm ? v <= 0 : v < floor) continue;
      const l = i > 0 ? (sm ? row[i - 1] : M[o0 + i - 1]) : 0;
      const r = i < N - 1 ? (sm ? row[i + 1] : M[o0 + i + 1]) : 0;
      if (v < l || v <= r) continue; // plateau: the right edge wins once / 고원은 오른쪽 끝 한 번만
      const den = l - 2 * v + r;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
      // half-width: second moment around the peak while the values keep falling / 극대 주변 2차 모멘트
      let s0 = M[o0 + i];
      let s2 = 0;
      for (let d = 1; d < 64; d++) {
        const a = i - d >= 0 ? M[o0 + i - d] : 0;
        const b = i + d < N ? M[o0 + i + d] : 0;
        if (a < floor * 0.25 && b < floor * 0.25) break;
        s0 += a + b;
        s2 += (a + b) * d * d;
      }
      // amplitude of a smoothed ridge = the strongest original bin under the box / 평활된 리지의 진폭 = 상자 안 원본 최댓값
      let amp = v;
      if (sm) { amp = 0; for (let d = -sm; d <= sm; d++) if (i + d >= 0 && i + d < N && M[o0 + i + d] > amp) amp = M[o0 + i + d]; }
      found.push({ bin: i + off, amp, width: Math.sqrt(s2 / s0), used: false });
    }
    // tracks that are sounding choose first (strongest first), bridged ones last; the search radius
    // never grows, so a track that ended cannot take over a neighbour's ridge
    // 소리 나는 트랙이 먼저(센 순), 끊긴 트랙은 나중에 고름. 탐색 반경은 늘지 않음 — 끝난 트랙이 이웃 리지를 빼앗지 못함
    open.sort((a, b) => a.gap - b.gap || b.lastAmp - a.lastAmp);
    for (const tr of open) {
      let best = null;
      let bd = maxJump;
      for (const q of found) {
        if (q.used) continue;
        const d = Math.abs(q.bin - tr.last);
        if (d <= bd) { bd = d; best = q; }
      }
      if (best) {
        best.used = true;
        tr.bins.push(best.bin);
        tr.amps.push(best.amp);
        tr.last = best.bin;
        tr.lastAmp = best.amp;
        tr.gap = 0;
        tr.w += best.width;
        tr.wn++;
      } else {
        tr.gap++;
        tr.bins.push(tr.last);
        tr.amps.push(0);
      }
    }
    // a track that has just lost its ridge takes over a newborn track next to it (a stepped line: the
    // new step fades in while the old one fades out, so both were seen for a moment)
    // 방금 리지를 잃은 트랙은 바로 옆에서 막 생긴 트랙을 이어받음 (계단형 선: 새 단이 켜지는 동안 옛 단이 꺼짐)
    for (const tr of open) {
      if (tr.gap !== 1 || tr.dead) continue;
      let pick = null;
      for (const nb of open) {
        if (nb === tr || nb.dead || nb.gap !== 0 || nb.amps.length > 4 || nb.amps.length >= tr.amps.length) continue;
        if (Math.abs(nb.bins[0] - tr.bins[tr.bins.length - 1 - nb.amps.length]) > maxJump) continue;
        if (!pick || nb.lastAmp > pick.lastAmp) pick = nb;
      }
      if (!pick) continue;
      const n = pick.amps.length;
      const o = tr.amps.length - n;
      for (let j = 0; j < n; j++) if (pick.amps[j] >= tr.amps[o + j]) { tr.amps[o + j] = pick.amps[j]; tr.bins[o + j] = pick.bins[j]; }
      tr.last = pick.last;
      tr.lastAmp = pick.lastAmp;
      tr.gap = 0;
      pick.dead = true;
    }
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].dead) open.splice(k, 1);
      else if (open[k].gap > maxGap) { close(open[k]); open.splice(k, 1); }
    }
    for (const q of found) if (!q.used) open.push({ f0: f, bins: [q.bin], amps: [q.amp], last: q.bin, lastAmp: q.amp, gap: 0, w: q.width, wn: 1 });
  }
  for (const tr of open) close(tr);
  const tracks = done.map((tr) => {
    let energy = 0;
    for (const a of tr.amps) energy += a * a;
    return { f0: tr.f0, step, bin: Float32Array.from(tr.bins), amp: Float32Array.from(tr.amps), width: tr.w / Math.max(1, tr.wn), energy };
  });
  tracks.sort((a, b) => b.energy - a.energy);
  const total = tracks.length;
  const kept = tracks.slice(0, Math.max(0, maxTracks));
  kept.sort((a, b) => a.f0 - b.f0 || a.bin[0] - b.bin[0]);
  return { tracks: kept, total, peak };
}
