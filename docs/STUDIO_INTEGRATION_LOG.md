# Studio Integration Log — 충돌 기록 및 우회 방법

Records every conflict found while porting single-file prototypes into Flexatone, and how it was
resolved. / 단일 HTML 프로토타입을 모듈로 옮기며 발견한 충돌과 해결 방법 기록.

---

## Field Studio (`ChangjinHA_vector_field_glissando_trajectory_simulator_261120_1.html`)

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/field/vector-field-engine.js` | studios (pure) | `VectorFieldPluginEngine` (curl noise, pitch wells, field, RK2 `bakeVoice`), memoised edit-time bake cache, `lookupBakedSample` |
| `js/studios/field-studio.js` | studios (pure) | `FieldStudio` plugin, document helpers (`getFieldParams`, `editField`), **Bake to Glissando Voices** |
| `js/studios/field/field-audio.js` | audio tier | baked-only scheduler, lowpass Curvature→Bright, transport, 48 kHz WAV, Baked JSON |
| `js/studios/field/field-canvases.js` | UI tier | vector-field canvas (quiver, wells, nodes, retrograde) + profile monitor |
| `js/studios/field/field-panels.js` | UI tier | **added** — workspace DOM (strip, toolbar, racks) |
| `js/ui/studio-host.js` | UI | **added** — mounts studio workspaces, hides the Glissando editor, routes the transport |
| `js/ui/workspaces.js` | UI | **added** — registers each studio's UI/audio tier with the host |
| `js/ui/option-inspector.js` | UI | Option(Alt) inspector + `HELP_DB` (EN/KO) |
| `js/ui/number-scrub.js` | UI | type or drag-up/down on every number input |
| `.claude/devserver.py` | dev only | `http.server` + `Cache-Control: no-store` (preview pane only) |

### Conflicts & resolutions / 충돌과 해결

1. **Layer rule vs. requested paths** — the architecture DAG says `studios/*` must not import `audio/*`,
   `ui/*` or touch the DOM, but the prompt places `field-audio.js` (Web Audio) and
   `field-canvases.js` (DOM) under `studios/field/`.
   → Kept the requested paths, enforced the rule by **import direction**: the pure files
   (`vector-field-engine.js`, `field-studio.js`) never import the audio/UI files; only
   `ui/workspaces.js` → `ui/studio-host.js` (UI tier) imports them. Each file's header says which tier it belongs to.
   / 경로는 유지하고 import 방향으로 계층 규칙을 지킴.

2. **Duplicate DOM ids** — the prototype uses `btnPlay`, `mainCanvas`, `engineTabs`,
   `voiceCardsContainer`, `btnAddVoice` … which already exist in `index.html`.
   → The Field workspace builds its own DOM without ids (element references only); the shared
   header transport (Play / Stop / Loop / Export WAV / Space / Enter) is routed to the active studio
   by `studio-host.activeTransport()`. / 자체 DOM은 id 없이 생성, 헤더 트랜스포트는 활성 스튜디오로 라우팅.

3. **StudioRegistry had no notion of a full workspace** (it only renders a small generator panel).
   → Added an optional plugin field `workspace: '<id>'` (ignored by the registry validator) and the
   UI-side `registerWorkspace()` host. Glissando is unchanged. / 플러그인에 `workspace` 필드 추가.

4. **Guiding curves differ slightly** — the prototype had its own copies of the 9 engines (e.g. a
   different damped envelope, tanh ratchet). Requirement 2 says to reuse `modules/curve-engine.js`,
   so the Field Studio now uses Flexatone's engines; guide shapes can differ a little from the
   prototype at the same parameter values. / 요구사항대로 공용 엔진 사용 → 프로토타입과 모양이 약간 다를 수 있음.

5. **Timbre** — the prototype built its own 28-harmonic wave. Replaced by
   `timbre-synth.computeAdditiveCoefficients` (shared 5-wave mixer), keeping the Curvature→Bright
   boost (saw/rich + 0.45·b). / 공용 음색 합성기로 교체.

6. **Separate AudioContext / master** — the prototype created its own context and never faded on
   stop. → Shares `audio-engine.ensureAudioCtx()`, adds 12 ms transport fades, and
   `studio-host.stopAllAudio()` runs on every studio switch, Stop, Escape and project load, so two
   studios never sound at once. / 공용 컨텍스트 사용, 전환 시 전체 정지.

7. **State persistence** — the prototype kept state in a closure. → The whole Field document lives in
   `appState.studioParams.field` (saved in projects, undoable). View-only edits (pan/zoom/toggles,
   active particle) use `history: false`. `bakedPoints` are never stored: they are a cache keyed by a
   physics signature. / 문서는 studioParams에 저장, 베이킹 결과는 캐시로만 유지.

8. **Bug found during the port: non-deterministic defaults.** Default particles had random ids, so
   before the first edit every `getParams()` produced a new bake signature and the field was
   re-integrated on every animation frame (57 bakes in 1 s of playback). → Default particles now
   have fixed ids; a self-check asserts deterministic defaults and 0 bakes during playback.

9. **Bake to Glissando fidelity** — `captureCurveToCustomPoints` copies a custom source verbatim.
   → Called with `includeTransforms: true` to force an adaptive fit (tolerance 0.0015 ≈ < 5 cents
   over two octaves); Speed→Gain becomes the voice's gain points.

10. **Browser module cache** — `python3 -m http.server` lets the browser cache ES modules, so edits
    did not show up after reload in the preview. → `.claude/devserver.py` (same server +
    `no-store`) is used for the preview only. For your own browser, a hard reload (⌘⇧R) or DevTools
    “Disable cache” is enough. / 미리보기 전용 무캐시 서버.

### Edit-time baking guarantees / 베이킹 보장

- `bakeFieldVoices()` re-integrates only when the physics signature changes (field, nodes,
  guide, particle physics). Sonification edits (Speed→Gain, Curvature→Bright, timbre, retro mode)
  never re-bake.
- `field-audio.js` builds every automation curve from `lookupBakedSample()` (array lookup).
  Verified: 0 integrations during 1.2 s of live playback and during an offline render.

### Local Regions / 국소 영역

- `studios/field/field-regions.js` (pure): `createFieldRegion`, `regionSdf`, `regionWeight`,
  `regionModulation`. Rect/ellipse masks with smoothstep feather and invert. Each region scales
  guide / nodes / turbulence / wells (`mult_c = Π lerp(1, gain_c, w)`) and adds a local push.
- `evaluateFieldAt()` applies the modulation; `regions` is part of the bake signature. Without any
  region the field is bit-identical to before. Old projects load with `regions: []`.
- UI: "Local Regions" rack in `field-panels.js`, canvas draw/drag/resize in `field-canvases.js`,
  `view.showRegions` toggle. Self-check: "Field studio: local regions modulate the field only inside".

---

## Risset Studio (`ChangjinHA_risset_shepard_sonic_field_studio_60_voices_261121_1.html`)

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/risset/risset-core.js` | studios (pure) | S¹ phase, 2–60 voice document, trajectory shaping (v = 0 ⇒ y = 0), runtime step, bake segments |
| `js/studios/risset/harmony-grid.js` | studios (pure) | offset grid, Pitch ⇄ Interval parsers (upper-casing, `#`/`b`), pattern extractor, `formatClean`, presets |
| `js/studios/risset/local-particles.js` | studios (pure) | Local Emergence (Bypass / Random / Sine, fades, band mask) |
| `js/studios/risset/loop-automation.js` | studios (pure) | looping automation lanes (core spline utils), effective values |
| `js/studios/risset/peq-envelope.js` | studios (pure) | Global Envelope (Bell-Pass default, Gaussian, Raised Cosine; σ ≤ 1.00) + RBJ peaking EQ, presets |
| `js/studios/risset-studio.js` | studios (pure) | `RissetStudio` plugin, `getRissetParams` / `editRisset`, Bake to Glissando |
| `js/studios/risset/risset-audio.js` | audio tier | **added** — runtime clock, live engine + PEQ chain, offline WAV |
| `js/studios/risset/risset-panels.js` | UI tier | **added** — workspace DOM + 5 canvases |
| `js/modules/gain-bus.js` | modules | **added** `compensationForCount(n)` (1/√N shared with the master bus) |

### Conflicts & resolutions / 충돌과 해결

1. **Same layer issue as Field** (audio + DOM files under `studios/`). Same fix: the pure modules
   never import `risset-audio.js` / `risset-panels.js`; only `ui/workspaces.js` does.
2. **Prompt lists no file for the live audio engine or the workspace UI.** → Added
   `risset-audio.js` and `risset-panels.js` instead of putting Web Audio / DOM code into the pure
   `risset-studio.js` controller.
3. **Duplicate ids / own header** (`btnPlay`, `btnLangKo/En`, `btnSaveJson` …). → No ids in the
   workspace; the shared header drives it: Play / Space / Enter toggle the live engine, Export WAV
   renders `WAV (s)` seconds, Save / Load store the document inside the Flexatone project, EN/한국어
   uses `core/i18n.js` (default `en`).
4. **Prototype language default was Korean** → Flexatone default `en`, `ko` via the header toggle.
5. **Automation lanes used `{ t, v }` linear points.** Requirement 2 asks for the core spline
   utilities → lanes are standard `{ x, y, handles }` spline points (`normalizeLane` still reads the
   prototype's `{ t, v }`). Double-click / segment-bend / right-click delete reuse
   `splitSplineSegmentPreservingShape`, `elevateSplineSegmentHandles`, `removeSplinePoint`.
6. **The prototype's PEQ curve was a Gaussian approximation.** → The display now uses the exact
   RBJ peaking-biquad magnitude (what the BiquadFilterNodes actually do).
7. **Trajectory shaping (new).** Shapes are defined as y(τ) = v·F(τ) with F(0) = 0 and F(kP) = kP,
   so v = 0 ⇒ y ≡ 0 for every shape and the mean speed stays v. Self-checked for all 5 shapes.
8. **Spelling of typed pitches** — resyncing from offsets always produced sharps (`Bb2` → `A#2`).
   → The last typed pitch list (`pitchText`) is shown as long as it still matches the offsets.
9. **Quarter tones** — 36.5 was named `C#2−50¢`; now named from the lower note (`C2+50¢`).
10. **Bake to Glissando** — Glissando voices cannot wrap, so each Risset voice is cut at its wrap
    points (top → bottom) into separate `11. Custom` voices (registry cap: 64 voices).
11. **Offline render cost** — the prototype froze A_local and automation during export. → The
    offline render advances automation, shaping and local particles every 64 samples with
    phase-continuous oscillators (60 voices × 3 s ≈ 0.7 s to render).

## Risset upgrade (A-1 → A-5, theory Part 1-1 / 1-2)

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/risset/signal-graph.js` | studios (pure) | multichannel signal contract `phase/vel/amp/ampGlobal/aLocal/mass/buoy[N]`, `defineStage`, `runStages` |
| `js/studios/risset/risset-voicebank.js` | studios (pure DSP) | `RissetVoiceBank` (self-contained, no imports): sample-accurate S¹ phase, envelope, PolyBLEP pulse, Kuramoto, tilt/flutter weights; `buildRissetWorkletSource()` (Blob) |
| `js/studios/risset/color-analysis.js` | studios (pure) | R_total (Sethares/Plomp–Levelt), H, C_spec, colour-invariance PI controller |
| `js/studios/risset/dynamics.js` | studios (pure) | interaction dynamics on S¹ (0th/1st/2nd/delay, RK4 100 Hz) |
| `risset-core.js` | studios (pure) | runtime split into stages `phaseCore → grid → envelope → local → dynamics → output → analysis`; control frames; deterministic dynamics bake cache |
| `local-particles.js`, `harmony-grid.js`, `peq-envelope.js`, `loop-automation.js` | studios (pure) | extended (κ / fade spread / Hz mask / mass, ratio grid, skew/γ via the bank, controller base override) |
| `risset-audio.js` | audio | worklet engine + oscillator fallback, offline render through the same bank, audio-tier self-checks |
| `risset-panels.js` | UI | engine selector, ratio grid, span ratio, skew/γ, colour section + time series, rhythm↔tone, particles 2.0, dynamics |

### Conflicts & resolutions / 충돌과 해결

1. **Worklet file path vs. Blob rule.** The roadmap named `audio/worklets/risset-processor.js`; the
   project rule forbids fetching a separate worklet file. → The worklet is a Blob built from
   `RissetVoiceBank.toString()` + a thin processor. The same class renders WAV export and runs in the
   self-checks (offline vs. worklet: max |Δ| < 1e-6).
2. **"Phase accumulator with block-interpolated controls" vs. sample-accurate wrap.** Interpolating only
   pitch/amp per block cannot wrap exactly. → The bank integrates the **S¹ phase** per sample from ω (= dp/dt),
   evaluates the envelope per sample and interpolates only the gain g and scale per block. Control
   phase errors are spread over 50 ms (no jumps); |e| > 0.25 or a new slot hard-sets the phase.
3. **Pre-existing bug found by the new level check:** `stepLocalParticles` read `local.mode` but the
   document field is `localMode` → "Bypass" never bypassed and "Random" was unreachable (everything ran
   the Sine LFO). Fixed; the default field is now really un-flickered (documented behaviour).
4. **Colour controller instability.** First version (gain range/4) oscillated (loop gain ≈ 1.9). →
   Actuation range/16 + 0.25 s first-order lag; anti-windup. Composition: controller → base value, then
   automation → ± deviation (`computeEffective(…, baseOverride)`).
5. **γ (kurtosis) applies to Bell-Pass only**; Gaussian / Raised Cosine keep their definitions (generalising
   them would change the existing shapes). Skew splits σ for all three.
6. **A-3 plan vs. theory text (theory wins).** The plan said "extend v up to the audio band"; Part 1-1 §4
   describes the *voice frequencies* moving from the rhythm band (0.5–15 Hz) into the audio band. → v keeps
   −1…+1; the base pitch reaches MIDI −49 (≈ 0.5 Hz) with a log f_min slider; span may be 1–144 st.
7. **Aliasing.** Plain 2-point PolyBLEP measured −21 dB at 5 kHz. Theory: the waveform/duty morph *is*
   the anti-aliasing measure → the pulse fades back to a sine as the harmonic headroom fs/2f drops from 20
   to 4. Measured (duty 0.3): 250 Hz −51 dB, 1 kHz −39, 2.5 kHz −39, 5 kHz −48, ≥ 8 kHz −111 dB. Partials
   above 0.4·fs fade out (Nyquist guard).
8. **"Sync r" (A-3) vs. Kuramoto (A-5).** Two different phases: A-3 couples the *oscillator waveform*
   phases ψ (pulse alignment, r measured in the worklet, mean field weighted by audible amplitude); A-5
   couples the *S¹ pitch* positions. Kept as separate parameters.
9. **Buoyancy reinterpreted.** First version B = β·A_l·∂A/∂p pointed toward the envelope peak from both
   sides — an attractor that collapsed all voices into the peak (clipping). The theory calls B a lifting
   force → B = β·A_l·|∂A_g/∂p| (always upward, strongest on the flanks); against gravity −g·M it drives a
   convection cycle.
10. **Dynamics vs. space-regions rotation θ.** Decision: **separate.** The macro rotation v₀ is the existing v
    (shaping, automation and v = 0 ⇒ y = 0 untouched); dynamics move positions xᵢ relative to that frame,
    pᵢ = wrap(φ + xᵢ). θ rotates only the reading frame of the time × phase plane; rotated regions read the
    current xᵢ (frozen over τ — future trails are not predicted).
11. **Stiffness.** m₀ prevents division by zero but not numerical blow-up (a silent voice has ẋ = 20·F at
    m₀ = 0.05). → Smooth saturation: |ẋ| ≤ 1.5 cycle/s (1st), |ẍ| ≤ 40 cycle/s², |u| ≤ 6 (2nd).
12. **Reproducible export.** With dynamics on, WAV export and Bake to Glissando start from the grid at t = 0
    with a seeded RNG and read pre-integrated xᵢ(t) (cache keyed by a physics signature without view/export
    fields; default region id `r0` is deterministic). Live playback integrates in real time: 0 bakes. With
    dynamics off, export still starts from the current live state (unchanged).
13. **Peak headroom.** Moving voices raise the crest factor: RMS stays at the 1/√N level (0.214 vs 0.218 off)
    but peaks can touch the ±0.98 clamp (6 samples / 6 s at N = 24 with noise). Documented in the tutorial.

### Set aside / 보류

- **Octave-stack synchronisation (A-3).** First-order Kuramoto only entrains rates within ≈ ±K Hz; voices an
  octave apart are not aligned (measured r 0.74 at K = +4, 0.95 at K = −4). Needs n:m (harmonic) coupling,
  which the theory does not specify.
- **Fallback engine** (oscillators) stays sine: no pulse morph and no Kuramoto (tilt/flutter weights are applied).
- **Rotation parameters are not automatable** (spin / swing cover the motion); no per-region dynamics.
- **Future trails with dynamics** are drawn from the current positions (not predicted); past trails use the
  100 Hz history (max 4 s, older parts fall back to the oldest sample).

### Checks / 점검

`runSelfCheck()`: **71/71** (from 58; Risset added 13: signal graph, voice bank Blob, wrap/1/√N/v = 0,
offline = worklet, roughness/cents/envelope, colour controller, PolyBLEP aliasing + even harmonics,
Kuramoto, particles 2.0 = legacy, mass/buoyancy, dynamics invariance, energy decay, 0 bakes + cache +
Kuramoto spacing). CPU: 60 voices ≈ 45 ms per second of audio in the bank (229 ms before sub-blocks + sine table).

---

## Cross-studio checks / 스튜디오 간 점검 (all passed)

- Audio exclusivity: Glissando → Risset → Field → Glissando while playing — each switch stops the
  previous engine (`studio-host.stopAllAudio`).
- Glissando-only shortcuts (arrows, Shift+R, Delete) do nothing inside Field / Risset.
- Undo/redo crosses studios in order (Risset edit, Field edit → undo, undo).
- Save → change → Load restores Glissando voices, Field and Risset documents together.
- EN ⇄ 한국어 switches every studio.
- Render loop: added a timer fallback when the page is hidden (rAF pauses), so a studio switch
  always re-lays out the page.
- `runSelfCheck()`: 52/52 (groups: i18n 3, units 3, math 6, state 5, engine 12, timbre 5, gain 4,
  studio 10, audio 4).

---

## Output stage (dB taper · Sone / masking analyzer) / 출력 단계

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/core/units.js` (extended) | core | `createDbTaper` (A linear dB / B DAW, ε = 10^(dBmin/20), `meterNorm`, `meterTicks`), `LN_TO_DB` / `DB_TO_LN`, `onePoleCoef` |
| `js/core/state.js` (extended) | core | `appState.output` (+ `normalizeOutputConfig`, saved with the project prefs); voice `dbTaper` / `dbMin` |
| `js/modules/gain-bus.js` (extended) | modules | envelope `'db'` unit now uses the taper (A/B, dBmin per voice) — defaults identical to before |
| `js/modules/loudness-model.js` | modules | `LoudnessAnalyzer`: 1024-FFT / 512 hop, outer-ear weight, 24 Bark, Low/Mid/High spreading lerp, α = 0.23 LUT, calibration; zero-GC |
| `js/modules/output-stage.js` | modules | fader taper/dB helpers, Loudness Lock step, self-checks |
| `js/audio/output-bus.js` | audio | fader GainNode (setTargetAtTime τ 5–10 ms) → destination, Blob AudioWorklet tap, 30 fps frames, offline output gain |
| `js/ui/output-panel.js` | ui | header strip (mode, fader, dB, taper, dBmin, τ, meter, Sone, target, analyzer) + band view |

### Conflicts & resolutions / 충돌과 해결

1. **"Single HTML + Blob worklet" vs. multi-file ES modules.** → The worklet *is* a Blob: its source
   is `LoudnessAnalyzer.toString()` + a 20-line processor, so no extra worklet file is fetched and the
   same class is unit-tested on the main thread. The class must stay self-contained (self-check).
2. **Every studio connected to `ctx.destination` directly** (Glissando, scrub, Field, Risset). →
   All live paths now connect to `getOutputBus(ctx)`; offline renders end in `createOfflineOutput(ctx)`,
   so Export WAV = what you hear (verified −6 dB → ×0.5012 for Glissando and Field).
   Internal self-check renders do *not* use the output stage (`outputStage` option off) so they do not
   depend on the user's fader.
3. **Existing envelope `'db'` unit** was a fixed linear −60 dB map. → Kept as the default (taper A,
   −60 dB); taper B and dBmin are new per-voice options. Old projects load unchanged.
4. **Zero-GC vs. postMessage.** The audio path allocates nothing; `postMessage` structured-clones one
   101-float packet ~30×/s (unavoidable without SharedArrayBuffer, which needs cross-origin isolation).
5. **Sticky header height.** The band view sits at the top of the page body (`#outputBandsHost`), not in
   the sticky header, so opening it never covers the editor.
6. **Analyzer accuracy (measured).** 1 kHz tone: 40/50/60/70/80 dB SPL → 1.0/2.3/4.6/10.8/21 sone
   (ISO 532B: 1/2/4/8/16). Slightly high above 70 dB because of the shallow upper masking slope.

### Checks / 점검

- `runSelfCheck()`: **54/54** (new: dB taper A/B + meter mapping; analyzer calibration, ear weighting,
  masking spread, buffer reuse, Loudness Lock convergence).
- Live: fader −12 dB → peak ×0.2515 (expected 0.2512); Sone Lock target 20 → measured 19.5 within ~2.5 s;
  Glissando / Risset / Field all metered through the bus; EN ⇄ 한국어.


---

## Loudness Manager (naming) & Tempo Manager / 라우드니스 매니저 · 템포 매니저

**Naming.** The level controls (amp / dB / sone: output strip, dB taper, Sone Lock, track `gainDb`) are now called the
**Loudness Manager**; its UI title is `out.title`. The time controls are the **Tempo Manager**.
음량(진폭/dB/sone) 조절 = Loudness Manager, 시간 조절 = Tempo Manager.

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/core/tempo.js` | core | tempo contract `{mode:'rate'\|'bpm', rate, bpm, refBpm}`, `tempoRate`, `combineRates`, `patchTempo`, normalize |
| `js/modules/tempo-manager.js` | modules | `applyTempoToVoices` / `applyTempoToFieldParams` (÷ rate), `runtimeStepScale`, self-check |
| `js/core/manager-state.js` | core | `appState.manager.tempo`, `instance.tempo`, `setManagerTempo` (rescales the arrangement), `contentRate` |
| `js/audio/manager-mixer.js` | audio | track rate = master × instance: scaled docs → offline buffers, Risset engine clock, export |
| `js/studios/risset/risset-audio.js`, `risset-core.js` | audio / studios | `engine.step(dt, rate)`, `renderRissetBuffer({timeScale})`, ω in real seconds |
| `js/ui/manager-panel.js` | ui | master tempo (bar) + per-track tempo (× ⇄ BPM), Master View in real time |

### Decisions / 결정

1. **Pitch-preserving.** Time is rescaled inside the document (Glissando / Field `startTime`, `duration` ÷ rate), never by
   resampling (`playbackRate` would also shift pitch). Field baking is normalized (dt = 1/steps), so it is reused as is.
   / 리샘플링이 아니라 문서의 시간을 ÷배속 → 음고 유지.
2. **Master tempo behaves like a DAW tempo.** `setManagerTempo` also rescales every start / explicit length / fade and
   every range / shape region by oldRate / newRate (`scaleArrangement:false` = content speed only). Round trips are exact
   (verified 2× → 1×). **Instance tempo** changes only that track's content (its start never moves).
   / 마스터 = 배치도 함께 재스케일, 인스턴스 = 내용만.
3. **Risset.** The runtime clock advances by dt·rate and the bank's ω is multiplied by the rate, because the bank integrates
   phase per *real* sample and pulls it toward the runtime phase; an unscaled ω would be re-corrected every 50 ms.
   Verified: S¹ positions after (T/r s at rate r) = (T s at 1×), ω ratio = r.
4. **Mode switch never jumps.** `patchTempo` first re-syncs `rate` and `bpm` to the effective rate (a stale `bpm` of 120 made
   ×1.5 → ×1.2 in the first self-check run).
5. **Persistence.** `manager.tempo` and `instance.tempo` are saved with the project (`normalizeManagerState`), kept across
   undo/redo as mixer fields (`MANAGER_MIXER_KEYS`), copied by Duplicate.

### Not done yet / 아직 안 한 것

- **Per-studio transport (end goal).** The header Play / editor of each studio still plays at 1×. The same `tempo` object and
  `applyTempoTo*` helpers are meant to be hooked into `audio-engine.js` (Glissando), `field-audio.js` and `risset-audio.js`
  live passes — e.g. `studioParams[studio].tempo` multiplied with the focused instance's tempo.
- Duration-lock mode (tempo from a target length, the Sone-Lock analogue) and tempo automation (curves) are not built.
- `legatoJoin` / `joinGlideMs` are absolute milliseconds and are not tempo-scaled.

### Checks / 점검

`runSelfCheck()`: **74/74** (new: tempo maths + document scaling, manager arrangement rescale, Risset time-scale invariance).
Live: Glissando 2.5 s → 1.25 s at 2× (pitch at start unchanged), Field 3.55 → 1.775 s, Risset clip 8 → 4 s, master × instance
(2 × 2) = 0.625 s, BPM 240 = 2×, reset restores the arrangement, EN / 한국어 labels.

### Tape mode (pitch follows tempo) / 테이프 모드

`tempo.tape = true` (per level: master and/or instance) makes that level's rate a **varispeed**: 0.5× = half speed *and* one
octave down. `tempo.glideSec` makes live changes spool like a tape machine. 
- `core/tempo.js` `splitRates()` → `{ rate, tape, doc, glide }`; `doc = rate / tape` is the pitch-preserving part rendered into the
  document, `tape` is applied by the player. The buffer cache key uses only `doc`, so a tape change never re-renders.
- Glissando / Field: `AudioBufferSourceNode.playbackRate = tape`; live changes use `setTargetAtTime(τ = glide / 3)` (measured
  1 → 0.5 in 1.5 s glide, 1 source, no re-render). Offsets are converted real s → buffer s.
- Risset: baseMidi + 12·log2(tape) with the clock/tape ratio smoothed in log space per track; export uses the static ratio.
- Export WAV renders the final speed (no glide ramp). Measured: 2.5 s → 5 s, start pitch 130 → 65 Hz at 0.5×.
- Master View shifts the drawn pitches by the tape semitones.
- Not done: glide inside the offline export, tape for the studios' own transports (end goal).

---

## Draw Studio (prototype)

UPIC-style drawing studio: a hand-drawn line on a time × pitch canvas is a glissando. Studio id `draw`, order 40,
dev server `flexatone-draw` (port 8021). 손으로 그린 선이 곧 글리산도가 되는 드로잉 스튜디오.

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/draw-studio.js` | studios (pure) | plugin, `getDrawParams` (read-only snapshot) / `editDraw`, `generateVoices`, 6 self-checks |
| `js/studios/draw/draw-engine.js` | studios (pure) | pipeline, signature cache, snap/scales, presets (seeded), canon, erase-cut, SVG points → raw |
| `js/studios/draw/draw-i18n.js` | studios (pure data) | EN/KO strings merged into `I18N` at import, `DRAW_HELP`, demo SVGs |
| `js/studios/draw/draw-audio.js` | audio | live transport, one-stroke audition, offline render, WAV, JSON |
| `js/studios/draw/draw-canvases.js` | ui | canvas + tools (Draw / Line / Select / Node / Erase), wheel, cue |
| `js/studios/draw/draw-panels.js` | ui | workspace DOM, racks, keyboard tools, SVG import (DOM sampling), `HELP_DB` registration |

Shared files (lines added only): `js/main.js` +1 import · `js/ui/workspaces.js` +2 imports, +1 `registerWorkspace('draw')`
block · `index.html` +1 tab button (`btnStudioDraw`, `data-help="app.studioTabs"`) · `.claude/launch.json` +1 entry.

### Pipeline / 파이프라인

`raw {t s, p MIDI, w 0..1}` → transform (stretch · reverse · invert · transpose) → time cleanup → snap → RDP → spline.

- **Time cleanup** (stroke field `reversal`; `timeMode` mirrors it: `'arc'` ⇔ `reversal:'arc'`): `drop` keeps forward points;
  `split` partitions into maximal monotone runs (backward runs time-reversed, every point kept once) → one voice each;
  `arc` re-times by arc length, `t = t₀ + s / arcSpeed`, `s = Σ √((12·Δt)² + Δp²)` (unit: semitone; 1 s = 12 st, so
  `arcSpeed 12` plays a flat stroke at drawn speed).
- **Snap** in MIDI (= log Hz): `lerp(p, snap(p), strength)`; scales are cent-offset arrays (major, minor, pentatonic,
  whole tone) + root.
- **Fit**: x = normalised time, y scaled to the same semitone-equivalent metric so the RDP tolerance
  `ε = 0.04 + 2·smooth^1.5` st is isotropic; `fitStrokeToSpline` gives anchors (≤ 64, ε grows if needed), then each
  segment's quadratic handle is re-fitted by least squares (`c = Σb(y−a)/Σb²`, control at u = ½). The nearest-sample
  handle alone left an RMSE floor of ~0.09 st; with the LS handle smooth 0 → 0.012 st.
- **F0/F1** = first / last point. A flat piece (|Δp| < 1 st) uses F1 = F0 + 12 as a reference only (y stays small).
- **Cache**: signature = JSON of raw, reversal, arcSpeed, smooth, snap fields, transform, direct. Sound fields
  (timbre, baseGain, gainSource, widthDepth, name, colour, mute/solo) are excluded.

### Decisions / 결정

1. **Read-only snapshot.** `getDrawParams()` is memoised on the identity of `appState.studioParams.draw` (each edit, undo
   and load replaces that object); `editDraw` deep-clones. Without it, 20 strokes cost ~1 s per UI render (each syncer
   cloned the doc); now edit + reprocess + render ≈ 20–25 ms, playhead-only frames ≈ 7 ms.
2. **Node tool → direct mode.** First anchor drag bakes transform/snap/simplify into the anchors, which replace `raw`
   (`direct: true`, pink badge; "Re-fit from points" turns it off). Only single-piece strokes (toast otherwise).
3. **Headroom guard.** Master = 0.32, lowered when the worst-case in-phase sum of audible strokes (baseGain · width gain)
   would exceed 0.98. Same value live and offline → Export WAV = what you hear.
4. **Wheel = Glissando semantics** (pitch scroll, Shift/horizontal = time, Ctrl/⌘/pinch = zoom at cursor), not
   "wheel = zoom", to keep the same meaning across studios.
5. **`L` = Line tool inside Draw** (spec). The workspace's capture-phase key handler stops the event, so the header
   loop shortcut `L` does not fire in this studio; loop stays on the header button.
6. **Pressure** is recorded only for `pointerType === 'pen'` with pressure > 0; mice use the Pen width slider.
7. **SVG import** samples `SVGGeometryElement.getPointAtLength` (ui tier), splits sub-paths at jumps, maps all paths
   into one box (Import size × view, centred), and sets `reversal: 'split'` so closed shapes give upper + lower voices.
8. **Bake losses** (toast + help): Glissando voices have no pan; the dense width curve becomes 17 gain points.

### Limits / 한계

- Raster-image contour import (marching squares) not implemented — follow-up.
- Edits during playback apply on the next play / loop pass (same as Field).
- `cutRaw` keeps runs of ≥ 2 points; single leftover points are dropped.
- Up to 32 SVG paths per import.

### Checks / 점검

- `runSelfCheck()`: before **74/74**; after **80/80** with the 6 new Draw checks (later 89/90 once parallel chats added
  Cloud/Space checks — the one failure is `Space studio: stereo offline render …`, not Draw code).
- Browser (port 8021): no console errors; real mouse drag creates a stroke; drop/split/arc on a looping stroke → 1/3/1
  voices; slider drag = 1 undo step; 0 recomputations during playback incl. a timbre edit mid-play; loop wraps to cue;
  tab switching never leaves two studios playing; save → clear → load restores raw exactly; bake 5 pieces → 5 Glissando
  voices, pitch error < 1e-4 st; WAV decodes (48 kHz), peak −5.45 dBFS (Swarm), −6 dB fader → ×0.5012; 20 stacked
  strokes at gain 1.5 → −5.77 dBFS; EN ⇄ KO, 40 help keys, Alt+hover tooltip on all 109 controls; 1100 px no h-scroll.

---

## Cloud Studio (prototype)

Xenakis-style stochastic glissando cloud: an inhomogeneous Poisson process of short glissando grains
`{t0, dur, p0, p1, gain, pan}` whose pitch follows a chosen distribution around time curves.
크세나키스식 확률 글리산도 구름 — 시간 곡선 주변 분포에서 뽑은 짧은 글리산도 입자의 비균질 포아송 과정.

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/cloud-studio.js` | studios (pure) | plugin `cloud` (order 60), `getCloudParams` / `editCloud`, 5 presets, `generateVoices`, 4 self-checks |
| `js/studios/cloud/cloud-engine.js` | studios (pure) | samplers, Λ⁻¹ Poisson times, sieves, envelopes, polyphony cap, SoA bake + signature LRU cache, lane colouring, voice conversion |
| `js/studios/cloud/cloud-audio.js` | audio | look-ahead scheduler + gain/pan strip pool, offline render in 2 s suspend chunks (progress), WAV / JSON, transport |
| `js/studios/cloud/cloud-canvases.js` | ui | offscreen-cached scatter, pitch-aligned histogram vs PDF, time-curve strip editor |
| `js/studios/cloud/cloud-panels.js` | ui | `mountCloudWorkspace`, racks, header actions, HELP_DB registration |
| `js/studios/cloud/cloud-i18n.js` | data | `[key, en, ko]` rows merged into `I18N` (import-time), help rows |

Shared lines added: `js/main.js` (1 import), `js/ui/workspaces.js` (2 imports + `registerWorkspace('cloud')`),
`index.html` (1 tab button), `.claude/launch.json` (`flexatone-cloud`, port 8023).

### Decisions / 결정

1. **Times by Λ⁻¹ inversion, not thinning.** λ(t) is tabulated (2048 cells, piecewise constant) and unit-rate
   arrivals Σ Exp(1) are mapped through the cumulative intensity — exact for the table, no rejection loop, and the
   expected count Λ(T) is reported.
2. **Five PRNG sub-streams** (times, pitch, glide, duration, gain/pan) from one seed: editing the pitch distribution
   keeps the event times. `Math.random` is used only by the UI "New seed" button.
3. **Curves = curve-engine objects + `lo`/`hi`.** value = lo + (hi − lo)·`evaluateCurveObjectY(curve, t/T)`;
   'custom' (breakpoints, editable on the strip) or 10 formula engines. Flat lo = hi is a constant.
4. **Bake → Glissando is exact in pitch.** A log-Hz glide is a straight line in MIDI and a voice with `logScale` maps y
   linearly to MIDI between F0 and F1, so each event is 2 breakpoints (+1 hold point); the jump to the next onset happens
   in the last 10 ms of a ≥ 20 ms silent gap. Greedy colouring in start order uses exactly max-overlap lanes; above 64
   the quietest events are dropped (binned coverage, conservative). A lane whose points exceed the anchor budget is split
   into time chunks (more voices); the budget doubles until the voice count fits 64. Lost: pan, oscillator phase;
   envelopes become gain points (Hann 7 / Tukey 6 / exp-decay 7 per event).
5. **Edit-time bake, cache-only playback.** `cloud-panels.js` render calls `getCloudEvents()` (signature cache); the
   live scheduler receives the new list via `syncCloudLive` and switches from its scheduled horizon. Timbre / view /
   scheduler fields are outside the signature.
6. **Audio graph.** One shared PeriodicWave; per event one Oscillator (`exponentialRampToValueAtTime`, Hz clamped
   20–18 000) into a pooled strip (Gain envelope value-curve → StereoPanner), pool ≤ maxPolyphony + 8. Master =
   0.6 / √(mean overlap) when Auto level is on. Live → `getOutputBus`, WAV → `createOfflineOutput`.
7. **Polyphony cap** drops the quietest (then oldest, then lowest index) of the active set ∪ new event, so at no instant
   do more than `maxPolyphony` events sound.

### Limits / 한계

- Main-thread scheduler: a throttled background tab misses events (counted as "late"); look-ahead and tick are in Advanced.
- Offline render time grows with event count (Ligeti Collapse, 2 016 events / 40 s: 11 s on this machine).
- No limiter by default (shared Output stage setting): Lévy Flights peaks at −1.9 dBFS.
- The Glissando canvas draws a baked voice's silent hold/jump segments too, so the baked view looks busier than the cloud.
- The histogram's theory line ignores clipping to Lowest/Highest; Brownian has no closed-form line.
- Same seed → same audio up to float rounding (max sample diff 1.2e-7 between two renders).
- AudioWorklet grain engine (optional in the brief) not done.

### Checks / 점검

- `runSelfCheck()`: 74 before this work → 107/107 at the end (incl. other chats' new checks); 4 new:
  `Cloud: determinism, signature cache, Poisson counts` · `Cloud: distribution samplers (gauss, cauchy, lévy α=2, brownian)`
  · `Cloud: sieves, polyphony cap, envelopes, event cap` · `Cloud: lanes (greedy optimal) and bake to ≤ 64 Glissando voices`.
- Browser (port 8010; 8023 not startable — 5-server limit): no console errors; 100 ev/s live, 20 s: 1 957 events scheduled,
  0 late, tick 0.27 ms avg / 7.3 ms max (≈ 0.1 ms per event incl. node creation), peak 121 live oscillators; bake count
  unchanged while playing, +1 on a pitch edit mid-play (15 ms for 2 023 events), +0 on a timbre edit; 20 000 events
  generate in 55 ms. Loop wraps to cue; Space / Enter / Esc; tab switch Glissando → Cloud → Risset → Field → Cloud
  never overlaps. Slider drag (5 inputs) = 1 undo step; strip point add = 1 step; save → change → load restores the
  document and hits the same cached events. Gauss Rain bake: 928 events → 37 lanes → 45 voices, every event reproduced
  (max 3e-5 st). WAV decodes (48 kHz, 2 ch); all 5 presets < 0 dBFS; −6 dB fader → ×0.5012. EN ⇄ KO: 82 controls, all
  with help, no raw keys; Alt+hover tooltip; 1100 px layout.

### Next / 다음 단계 (Manager integration candidates)

`params()`: seed, length, density.lo/hi, pitch.center.lo/hi, pitch.width.lo/hi, glide.clusterCollapse.lo/hi,
pitch.levyAlpha, pitch.brownStep, pitch.brownDrift, glide.slopeMean, glide.slopeSpread, glide.upBias, duration.mean,
gain.base, gain.spread, timbre.stereo, maxPolyphony.
`signals()`: instantaneous λ(t), center(t), effective width(t), sounding-event count, onset trigger stream (t0, p0, gain),
mean pitch of sounding events.

## Chaos Studio (prototype)

Chaotic dynamical systems sonified as glissandi: N voices start `spread` apart on the same attractor and the
butterfly effect is heard (voices drift out of unison) and seen (portrait, pitch fan-out, log-distance graph).
/ 카오스계 궤적의 글리산도 소리화 — 초기값이 아주 조금 다른 N개 보이스가 갈라지는 나비효과.

### Files / 파일

| File | Layer | Role |
|---|---|---|
| `js/studios/chaos-studio.js` | studios (pure) | plugin `chaos` (order 50, `workspace:'chaos'`), `getChaosParams` / `editChaos` / `normalizeChaosDoc`, presets, bake → Voices, 10 self-checks |
| `js/studios/chaos/chaos-engine.js` | studios (pure) | system registry (`registerChaosSystem`, 6 flows + 2 maps), allocation-free RK4, reference normalisation, stage A/B bake caches, Benettin λ, divergence, bifurcation |
| `js/studios/chaos/chaos-audio.js` | audio | transport (Field-style), `scheduleChaos` shared by live + offline, WAV, JSON |
| `js/studios/chaos/chaos-canvases.js` | ui | portrait (x–z / x–y / y–z / 3D drag), pitch curves (MIDI), divergence (log d), bifurcation; offscreen layer cache |
| `js/studios/chaos/chaos-panels.js` | ui | `mountChaosWorkspace`, racks, HELP_DB registration, help self-check |
| `js/studios/chaos/chaos-i18n.js` | studios (data) | `Object.assign(I18N.en/ko, …)` + `CHAOS_HELP` data |
| shared | — | `js/main.js` +1 import · `js/ui/workspaces.js` +2 imports, +1 `registerWorkspace('chaos')` · `index.html` +1 tab button · `.claude/launch.json` +`flexatone-chaos` (8022) |

### Decisions / 결정

1. **Two-stage bake cache.** Stage A (trajectory signature: system, params, sweep, seed, N, spread, dt, transient, simTime,
   duration, map rate) integrates; stage B (mapping signature: stage-A id + resolved mapping) only re-maps. Timbre, base
   gain, width and view are in neither (self-checked: 0 recomputations). Both are 6-entry LRUs so self-checks do not evict
   the UI's result. Counters `getBakeCount()` / `getMapCount()` are on the status badge; measured constant during playback.
2. **Own RK4, same formula.** `core/rk4Step` allocates `number[]` per stage; the engine uses a Float64Array RK4 with
   `deriv(s, p, t, out)`. A self-check proves the step equals `rk4Step` to 1e-12 and the global order ≈ 16 on ẍ = −x.
   Non-autonomous Duffing: drive phase θ = ωt is a state variable (`perturbMask` keeps it shared).
3. **Spread after the transient.** The seeded base IC runs through the transient once, then voice i = base + spread·i·uᵢ
   (otherwise voices would already be apart at t = 0). Two pre-roll steps give backward differences for speed/curvature.
4. **Reference normalisation.** One 200 sim-s run per (system, params, sweep, dt) → 2–98 % per source, centre (radius),
   diameter. `diamDims` excludes unbounded state (Duffing θ, pendulum unwrapped angles).
5. **Voice conversion.** Smooth curves: `captureCurveToCustomPoints` (tolerance 0.002, maxAnchors 64) on time segments
   with ≤ 36 extrema each (budget ⌊64/N⌋ segments per voice), because its anchor budget is capped by `ANCHOR_HARD_CAP`
   = 160 and a 0.01 minimum gap. Stepped curves (map *hold*, or 12-TET/scale with slew < 10 ms) are written as exact
   linear anchors (`handles: []`), split at ~240 anchors. Butterfly: 32 voices, mean |spline − baked| = 0.0048 of range.
6. **Live edits.** Playback reads only cached arrays. An edit while playing re-bakes once (edit time) and the audio
   re-schedules from the playhead after 140 ms of quiet (cross-fade), so mapping / slew changes are heard live.

### Doc vs code / 문서와 코드 차이

- `StudioRegistry.getParams` overlays defaults **shallowly** → nested `map / timbre / view` need `normalizeChaosDoc`.
- `captureCurveToCustomPoints` grows `maxAnchors` with extrema (hard cap 160, min gap 0.01) — not a strict 64 cap.
- Duffing with γ = 0.37 (δ 0.3, α −1, β 1, ω 1.2) is periodic here (λ ≈ −0.06); the system default keeps 0.37 as
  specified, the *Driven Bell* preset uses γ = 0.5 (λ ≈ 0.14).
- `bakeVoices` sits around registry.js line 267, not 294.

### Limits / 한계

- Bright → low-pass and stereo width are not carried by Bake to Glissando (toast + help + rack note). Map *glide* and
  hold gain steps are approximated by 33 gain points per segment.
- Thomas (dt 0.02, 600 sim-s) bakes in ~0.3 s and the double pendulum in ~0.27 s; Lorenz default ≈ 0.1 s.
- Rössler / Thomas diverge slowly (λ 0.06 / 0.03): presets use a larger spread or longer simulated time.
- Bake to Glissando of a long Butterfly takes ~0.8 s on the main thread (button click, not playback).
- Not wired: Manager (`MANAGER_STUDIOS`), Tempo Manager on this transport.

### Checks / 점검

`runSelfCheck()`: 117/117 at the end (11 Chaos: RK4 order & parity, determinism, Lorenz bounds, λ ≈ 0.92, spread/d(0),
logistic period-2 / chaos, signature cache, mapping clamp + divergent system, bake to Glissando, bake time, help keys).
Live (on the :8000 server — the 8022 preview could not start: 5-server limit): no console errors; tab cycle
Glissando → Chaos → Risset → Field → Chaos never overlaps; Space / Enter (pause pins cue) / Esc / loop / dbl-click cue;
slider drag = 1 undo step; save → change → load restores; WAV peak −3.3 dBFS (Butterfly), amp fader 0.5 → peak × 0.500;
EN ⇄ KO: 45 help keys resolve in both, no raw keys; 1100 px: no horizontal overflow.

### Next / 다음 단계 (Manager)

`params()`: system (enum), params.* (per system), seed, voices, spread (log), simTime, duration, map.pitch.lo/hi/slewMs,
map.gain.lo/hi, timbre.baseGain, timbre.width, timbre.brightAmt, sweep.from/to.
`signals()`: per-voice pitch / gain / bright at the playhead, mean log-distance log₁₀ d(t), divergence event (t_div),
λ estimate, sweep parameter value, Lorenz wing switch (sign of x) as a trigger stream.

## Tempo Studio (prototype)

**Tempo canons / 템포 캐논** — one subject S(τ) played by several voices at different tempo curves rᵢ(u) (Nancarrow
convergence, Reich phasing, polytempo). Tab "Tempo Studio", id `tempo`, order 70. **Not the Tempo Manager**: the Manager
scales whole tracks; this studio builds relative tempo structure between voices. Same `rate` meaning (× speed, as in
`core/tempo.js` `tempoRate`).

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/tempo-studio.js` | studios (pure) | plugin, `getTempoParams` / `editTempo`, `resolveSubject` (reads a Glissando voice read-only), `getBakePlan`, `segmentToGlissandoVoice`, 6 self-checks |
| `js/studios/tempo/tempo-engine.js` | studios (pure) | doc schema + 5 presets, subject model, s(u) integration / inverse, convergence & phasing, signature-cached bake, Glissando segment curves |
| `js/studios/tempo/tempo-audio.js` | audio | live transport (5 methods), detune / gain curves via `setValueCurveAtTime`, look-ahead pulse scheduler, offline WAV (same scheduler), JSON |
| `js/studios/tempo/tempo-canvases.js` | ui | timeline (time × pitch), score position s(u) with draggable ◆ (Tc, sc), phase matrix + phase-vs-time, subject roll |
| `js/studios/tempo/tempo-panels.js` | ui | `mountTempoWorkspace` — header, voice strip, racks; copies help into `HELP_DB` |
| `js/studios/tempo/tempo-i18n.js` | data | EN/KO strings merged with `Object.assign(I18N.en/ko, …)` + `TEMPO_HELP` |

Shared-file lines added: `js/main.js` 1 import (line 17) · `js/ui/workspaces.js` 2 imports (21–22) + `registerWorkspace('tempo', …)`
block · `index.html` tab button (78–80) · `.claude/launch.json` `flexatone-tempo` :8024 entry.

### Decisions / 결정

1. **Maths.** sᵢ(u) = s0ᵢ + ∫₀ᵘ rᵢ. Constant rates take the analytic path (s = s0 + r·u, inverse = (s − s0)/r). Curves:
   trapezoid on N = 2000 steps (Float64Array), and inside a step the rate is linear, so s(u) is the exact quadratic and the
   inverse is a binary search + stable quadratic root (round trip < 1e-6). Rate floored at 0.01× (r ≤ 0 never reaches the integral).
2. **Silent before entry.** A voice sounds only while s ≥ 0 (and s < L if `loop:false`), so negative s0 = late entry. This is
   what makes a converging canon audible: fastest voice enters last, all meet at Tc.
3. **Convergence.** When enabled, s0 is solved for *every* voice: s0 = sc − ∫₀^Tc r (analytic for constants, from the same
   integral for curves → numeric residual ≤ 1e-6, analytic 0). Converge-mode voices use rᵢ = ρᵢ·r₀. Nancarrow preset:
   3:4:5, r₀ = 0.25, Tc = 30, sc = 25 = 5·L — the accented loop starts of all three voices coincide at Tc (verified).
4. **Phasing** multiplies voice i by (1 + i·ε); Δs(L/ε) = L verified.
5. **Bake / cache.** `bakeTempo(doc, subject)` memoises on a timing signature (length, subject, converge, phasing, per-voice
   id/start/loop/tempo). Timbre, gain, mute/solo, transpose/octave and pulse are excluded → 0 re-bakes (transpose is added at
   playback). Audio curves at 400 pts/s: MIDI (detune in cents → log pitch) and a gain envelope with 10 ms attack / 8 ms
   release at each re-attack, computed in real seconds (score distance ÷ local rate). Bake 4–20 ms for the presets.
6. **Pulse layer.** One click per beat of the subject (beat = 60/bpmRef of score time), accent on the loop start; voice i is
   told apart by timbre only (800·2^(i/3) Hz, band-passed seeded noise or a sine tick). Live: 25 ms timer, 150 ms look-ahead
   over a pre-sorted list. Offline: same `scheduleClick`, all at once.
7. **Bake → Glissando.** One Glissando voice per loop segment (startTime / duration from the tempo mapping, exact). Pitch is
   sampled at 1 kHz and RDP-simplified to ≤ 64 piecewise-linear anchors (no handles = exact linear evaluation);
   `captureCurveToCustomPoints` was not used because its 0.01 minimum anchor gap cannot hold a 10 ms step. `continuous` joins
   re-attacks with a 60 ms glide and flat gain; `steps` uses a 10 ms ramp plus gain dips. > 64 loops → the first 64 in time are
   baked and the UI warns (toast + amber badge). **Lost in the bake:** the pulse layer.
8. **Tempo Manager interaction (assumption).** The Tempo Studio is not a Manager studio (`MANAGER_STUDIOS` untouched) and its
   header transport plays at 1×. If it is added, the effective speed of voice i is `managerRate × rᵢ(u)` (master × instance ×
   voice), i.e. the document time u is divided by the manager rate exactly like Field (`applyTempoTo*`). Stated in the help.
9. **View state** (time zoom) is UI-local, not in the document, so it never pollutes undo.

### Limits / 한계

- Edits made while playing are heard on the next play / loop pass (the pass schedules the whole curve at start).
- The subject from a Glissando voice is resampled (97 points) and has one attack per loop.
- At most 8 voices, 48 notes; Length ≤ 300 s.
- The verification browser pane was hidden, so audio was checked by offline renders and node state, not by ear.

### Checks / 점검

`runSelfCheck()`: baseline **74/74** before this work → **117/117** at the end (other chats added studios meanwhile). New (6):
convergence (analytic < 1e-9, numeric < 1e-6) · integral vs closed form (exp, rel < 1e-6), inverse round trip, monotone, r ≤ 0
guard · phasing Δs(L/ε) = L and loop starts s(u) = kL · signature cache / determinism / bake < 100 ms · bake to Glissando
(≤ 64, timing, pitch, state untouched, overflow, Glissando subject read-only) · i18n + help.
Live: tab cycle Glissando → Tempo → Risset → Field → Tempo (one engine at a time), Play / Enter (cue pinned) / Space / Esc /
loop, bake count unchanged while playing and editing, slider drag = 1 undo step, ◆ drag = 1 undo step (still converges), save →
edit → load restores, bake 22 voices (max pitch error 0.009 st on holds), WAV 40.1 s peak −6.75 dBFS and amp 0.5 → −6.02 dB,
EN ⇄ 한국어 for all labels, Alt-hover help on 121/121 controls, 1100 px without horizontal overflow.

**Manager candidates** — `params()`: length, converge.Tc, converge.sc, converge.r0, phasing.epsilon, pulse.level, and per voice
tempo.ratio / tempo.lo / tempo.hi / start / transpose / baseGain. `signals()`: sᵢ(u), rᵢ(u), pairwise phase φᵢⱼ(u), sync
distance min φ, loop-start / beat trigger streams per voice, current subject note index per voice.

---

## Space Studio (prototype)

Doppler glissandi from sources moving around a fixed listener. What the listener hears at t was emitted at the
retarded time t_e (`t = t_e + |X(t_e) − L| / c`), so pitch, level, pan and brightness all come out of the physics.
움직이는 음원의 지연 시간(retarded time) 물리로부터 음고·음량·패닝·고역 감쇠가 나오는 스튜디오. id `space`, order 80, dev 포트 8025.

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/space-studio.js` | studios (pure) | plugin, `getSpaceParams` (memoised on the saved object) / `editSpace`, `sourceToGlissandoVoice`, `generateVoices`, 4 self-checks |
| `js/studios/space/space-engine.js` | studios (pure) | analytic paths + arc-length tables, speed / pitch profile tables, Newton-in-bisection retarded-time solver, `bakeSpace` (LRU 6, signature cache), presets, seeded random scene, display helpers |
| `js/studios/space/space-audio.js` | audio | osc → lowpass → gain → StereoPanner / HRTF Panner via `setValueCurveAtTime`, transport, crossfaded live re-schedule, stereo offline render / WAV / JSON, 1 async self-check |
| `js/studios/space/space-canvases.js` | ui | top-view scene (rings, heard position, v and v_r arrows, handles, draw tool), observed-pitch piano roll, gain / pan / r lanes |
| `js/studios/space/space-panels.js` | ui | `mountSpaceWorkspace` (header, source strip, racks), registers `space.*` help into `HELP_DB` |
| `js/studios/space/space-i18n.js` | data | EN/KO strings merged with `Object.assign(I18N.en / .ko)`; `SPACE_HELP` entries |

Shared files (lines added only): `js/main.js` 1 import; `js/ui/workspaces.js` 2 imports + 1 `registerWorkspace('space')` block;
`index.html` 1 tab button (`data-help="app.studioTabs"`); `.claude/launch.json` `flexatone-space` (8025); this section.

### Decisions / 결정

1. **Coordinates.** Top view in metres, +y = screen up. Heading 0° faces +y, clockwise positive — the brief's "+z front" is +y here.
   Optional constant source height h enters r. pan = lateral / r (= sin θ in the plane; overhead → 0).
2. **Paths are analytic** (P(u), P′(u)) with a 2048-chord arc-length table for S → u. Velocity = speed · P′/|P′|, so |v| equals
   the requested speed exactly and a listener-centred orbit has v_r = 0 to machine precision (self-check < 1e-6).
   Lines extrapolate past the end, orbit / Lissajous wrap, spiral / drawn paths stop at the end (v = 0).
3. **Solver.** g(τ) is strictly increasing for |v| < c (g′ = 1 + v_r/c ≥ 0.02), so Newton steps are kept inside a shrinking
   bisection bracket, warm-started from the previous sample. Measured residual < 1e-9 s on line / orbit / Lissajous / spiral
   (speed curve, height) / drawn paths at cScale 1 and 0.25. Speeds are clamped to 0.98·c_eff (badge "Supersonic clamp").
4. **Bake in listener time.** Each source is sampled at `bakeRate` over [start + r(0)/c, end + r(T)/c]; arrays
   t, te, fObs, fs, gain, lp, pan, fwd, up, r, vr, x, y, az. Signature = c, cScale, airDist, refDist, bakeRate, listener, and
   per source path / speed / start / duration / f / the 4 effect toggles. Timbre, baseGain, mute/solo, names, view and panMode
   never re-bake (self-check: 0 bakes; cScale → 1; listener → 1).
5. **Effect toggles** (per source) isolate one effect each: Doppler off keeps the arrival delay but f_obs = f_s(t_e);
   distance gain off holds the closest-approach level (fair comparison instead of a jump to 1); air off = 20 kHz; pan off = 0.
6. **Playback = baked arrays only.** Curves are resampled slices → `setValueCurveAtTime`. When the document's sound changes
   while playing (listener drag, slider), the pass is rebuilt from the playhead with a 12 ms crossfade, throttled to 45 ms.
   The bake itself happens at edit time; playing without edits never bakes (verified: 0 bakes over 2.5 s of playback).
7. **Master 0.45 live and offline** (Field uses 0.35 / 0.42), so Export WAV = what you hear before the output stage too.
8. **Presets set refDist = closest approach** (Pass-by 5 m), so a pass peaks at unity distance gain. With refDist 1 m the
   Pass-by peak was −27 dBFS — physically right but too quiet to audition.
9. **Bake → Glissando.** f0/f1 = floor/ceil of the f_obs range (log), 2000 dense samples → `captureCurveToCustomPoints`
   (`samples: 2000`, tolerance 0.0015). Gain points = gain / peak (peak moved into baseGain), ≥ 17 points.
   startTime = arrival time. Pan / HRTF / low-pass are lost: toast `space.bakeLossToast`, help `space.bakeLoss`.

### Doc vs. code / 문서와 코드 차이

- `findMissingI18nKeys()` returns `{ missingInKo, missingInEn }`, not an array — both are empty.
- `encodeWav` (audio-engine.js ~636) already interleaves N channels → no new encoder was written.
- `getOutputBus` stays stereo (GainNode / DynamicsCompressor / WaveShaper chain, default channelCount 2) — measured L/R
  differences survive the output stage.
- `captureCurveToCustomPoints` grows past `maxAnchors` when a curve has many extrema (hard cap 160), so "≤ 64 anchors" is not
  guaranteed; voices are still capped at 64 per bake (`MAX_GENERATED_VOICES`).
- `HELP_EXTRA_BY_ID` maps the older tab ids to `app.studioTabs`; the new tab uses `data-help` instead (help-entries.js untouched).

### Known limits / 한계

- Listener is static; supersonic motion is clamped (no sonic boom / multiple roots).
- Bake fidelity: f_obs ↔ voice spline ≤ 0.07 % on Pass-by / Orbit / Spiral / Sirens; Lissajous Swarm up to 2 % at one fast
  direction turn of the 3:4 figure (0.2 % of its timeline above 0.5 %).
- HRTF works live and offline in Chromium at 44.1 / 48 kHz (Pass-by: −5.7 dB → +4.9 dB R−L). At 22.05 kHz an azimuth of exactly
  ±90° renders ≈ 0 dB (browser HRTF database quirk; sweeps are fine). The audio self-check uses equal power at 16 kHz.
- Spiral / drawn paths stop abruptly at the end (velocity step → small f_obs step) — physically "the source stops".
- No per-source tempo / Tempo Manager hook yet (same as the other studios' own transports).

### Checks / 점검

- `runSelfCheck()`: 74 before → 117 after (5 new Space checks, the rest added concurrently by other studio prototypes), all pass:
  retarded-time residual; Doppler limits (far pass-by within 0.5 % of c/(c∓v)), centred orbit, static, supersonic clamp;
  inverse distance, equal-power L² + R² = 1, pan front / ±90° / heading, air cutoff; signature cache & Glissando voices;
  stereo offline render (approach left, recede right, pan = 1 → left silent).
- Live: Glissando → Space → Risset → Field → Space with each one playing — never two engines at once; Space / Enter / Esc / loop
  wrap / double-click cue; slider drag = 1 undo step, undo / redo exact; save → change → load restores the document;
  listener pointer drag → 1 undo step, re-bake 6–9 ms; Draw tool → 64 points, duration = length / speed.
- Export: RIFF/WAVE PCM 16-bit, 2 ch, 48 kHz; peak 0.045 at 0 dB → ×0.5012 at −6 dB (amp 0.5012); no 0 dBFS overs.
- EN ⇄ 한국어: 72 controls → 34 help keys, all resolve in both languages; Alt+click modal verified; 1100 px without
  horizontal overflow.

**Manager candidates** — `params()`: c, cScale, airDist, refDist, listener.x, listener.y, listener.headingDeg, and per source
speed.value (or from / to), f.hz (or hz0 / hz1), start, duration, path.h, baseGain, path-specific radii / amplitudes.
`signals()`: per source fObs(t), fObs/fs ratio, gain(t), pan(t), lp(t), r(t), v_r(t), azimuth(t); scene max v/c, clamp flag,
closest-approach events (r minimum → "pass" trigger), arrival / departure times t0 / t1.

## Fractal Studio (prototype)

Self-similar glissandi: six pure, seed-deterministic generators (Barnsley FIF, fBm, Weierstrass / Takagi, generalised devil's
staircase, L-system pitch turtle, Nørgård scale canon), progressive refinement, box-counting analysis and a zoom lens.
자기유사 글리산도: 순수·결정적 생성기 6종, 진행적 정밀화, 박스 카운팅 분석, 줌 렌즈.

### Files / 파일

- `js/studios/fractal-studio.js` — plugin (id `fractal`, order 90, `workspace: 'fractal'`), `getFractalParams` / `editFractal`,
  6 presets, Bake → Glissando (`fitBakedVoice`, `getBakeLoss`), 10 self-checks.
- `js/studios/fractal/fractal-engine.js` — pure: generators, `normalizeFractalParams`, `bakeFractal` (signature LRU cache,
  `getFractalBakeCount`), box counting, Hurst estimate, RDP pre-simplification for the Glissando fit.
- `js/studios/fractal/fractal-audio.js` — audio tier: live transport (cue / loop / pause), offline render, WAV, JSON.
- `js/studios/fractal/fractal-canvases.js` / `fractal-panels.js` — UI tier (main canvas + lens, racks, analysis).
- `js/studios/fractal/fractal-i18n.js` — EN/KO strings merged into `I18N` with `Object.assign`; `FRACTAL_HELP` registered into
  `HELP_DB` by the panels file.
- Shared lines added: `js/main.js` (1 import), `js/ui/workspaces.js` (2 imports + 1 `registerWorkspace` block), `index.html`
  (1 tab button), `.claude/launch.json` (`flexatone-fractal`, port 8026).

### Decisions / 결정

- **Edit-time bake.** Every shape-affecting field (mode section, mapping, refinement, gain, voice limit, bake rate) is in the
  signature; timbre and the fit tolerance are not. Playback, redraws and WAV read cached `Float32Array`s (Hz + gain) only.
- **FIF** uses the deterministic Read–Bajraktarević iteration from the polyline, so every depth interpolates the points
  exactly (1e-16 measured) and `d = 0` is the polyline. Theory D solves Σ|dₖ|aₖ^(D−1) = 1.
- **fBm spectral** is accumulated by octave with a rotation recurrence (≈10× faster than `Math.cos` per sample); the phase of
  harmonic k never depends on the octave count, so lower levels are exact prefixes. Midpoint displacement is offered too.
- **Resolution cap:** Weierstrass / fBm levels whose finest wave is shorter than ~3 bake samples are dropped and reported
  (badge + analysis); the zoom lens re-evaluates the function at its own resolution and shows them.
- **Cantor** generalised to odd `m` pieces, (m+1)/2 kept, gaps of total ratio `gap`; plateau edges glide over one bake sample
  (5 ms at 200 pts/s). Canon notes / L-system non-glide steps use explicit 5 ms ramps.
- **L-system:** A–W step forward, X Y Z silent, `+ − |` steer the heading, `[ ]` branch → new voice. The next length is
  counted before building; above 200 000 symbols the expansion stops at the last complete (balanced) iteration. Pitches
  reflect inside Low…High. Branches without a forward letter are counted but silent (analysis shows “♪ sounding”). The
  Binary Tree preset uses `X=F[+FX][-FX]`, `F=FF` (4 iterations → 31 sounding voices ≤ 32).
- **Canon:** layer k = durations × rᵏ, intervals × rᵏ, + k·transpose; each layer fills Length (≤ 4096 notes).
- **Mix:** master = min(0.42/√N, 0.89 / (N · max gain)) with N = max simultaneous voices — L-system siblings start at the same
  pitch and phase and add coherently; the bound keeps the pre-output peak ≤ −1 dBFS (stress: 32 coincident voices → −1.45 dBFS).
- **Bake → Glissando:** RDP with a growing epsilon until ≤ 48 points remain (keeps the meaningful extrema), then
  `captureCurveToCustomPoints(maxAnchors 64, includeTransforms)`; a direct capture of fBm would exceed 64 anchors because
  the capture budget grows with the extremum count (up to 160). Loss is measured in semitones and shown in the Bake card and
  in the bake toast; the help text states that fine detail is smoothed and pan / phase are not part of a Voice.
- The view (lens range) is UI-local, not in the document, so lens zooming never creates undo steps.

### Doc ↔ code differences found / 문서와 코드 차이

- `registry.getParams` merges saved params **shallowly**; nested sections are therefore deep-merged and clamped again in
  `normalizeFractalParams` (old or hand-edited projects stay valid).
- `captureCurveToCustomPoints(maxAnchors)` is a minimum, not a cap: its budget grows to `extrema + 12` (≤ 160). Hence the
  RDP pre-step above.
- `HELP_DB` entries resolve through `closest('[data-help]')`, so a wrapper `data-help` documents its slider / number box.
- `STUDIO_IDS` stays `['glissando','risset','field']`; extra studios work through `STUDIO_SLUG` as stated.

### Known limits / 한계

- Box-counting D is biased low at finite resolution (fBm H = 0.5 → 1.35 vs 1.5; FIF 1.34 vs 1.39), but the ordering holds.
- Glissando fit of very rough curves is coarse by design (fBm H = 0.3: max ≈ 9–12 st, RMS ≈ 2 st with 64 anchors).
- Loss measurement (≤ ~200 ms for 5 canon layers) runs debounced after edits and never while playing.
- No Tempo Manager hook and no Manager integration yet (`MANAGER_STUDIOS` untouched).

### Checks / 점검

- `runSelfCheck()`: 74 before → 117 after (10 new Fractal checks, the rest added concurrently by other prototypes), all pass:
  FIF interpolation / d = 0 polyline; fBm determinism + Ĥ within ±0.1 (H = 0.3 / 0.5 / 0.8); Weierstrass bound & continuity,
  Takagi ∈ [0, 2/3]; Cantor F(0) = 0, F(1) = 1, F = ½ on [⅓, ⅔], monotone (m = 3, 5, 7); L-system Fibonacci 1,2,3,5,8,13,
  bracket balance, voices = branches + 1, length guard; Nørgård 0,1,−1,2,1,0,−2,3; box counting (line ≈ 1.02, D(H=.2) > D(H=.8));
  refinement RMS decreasing (fBm, Weierstrass, FIF); bake cache + Glissando conversion for all presets (≤ 64 voices / anchors,
  state untouched); all presets finite.
- Live: Glissando → Fractal → Risset → Field → Fractal with each playing — never two engines; Space / Enter (pause pins cue) /
  Esc / loop wrap / double-click cue; 0 bakes while playing, timbre edit 0, shape edit 1; slider drag = 1 undo step;
  save → change → load restores the document.
- Export: 48 kHz 16-bit stereo WAV decodes; peaks −2.8 … −12.8 dBFS over the presets; −6 dB fader → exactly −6.00 dB.
- EN ⇄ 한국어: 60–78 controls per mode, every one under a resolving help key in both languages; Alt+hover popup shown;
  1100 px without horizontal overflow.

**Manager candidates** — `params()`: seed, length, lo, hi, fif.depth, fif.d[k], fbm.H, fbm.octaves, weier.a, weier.b,
weier.terms, cantor.gap, cantor.depth, lsys.angleSemitones, lsys.stepSec, lsys.iterations, canon.ratio, canon.stepSemitones,
canon.noteSec, canon.layerTranspose, refine.staggerSec, gain.level, gain.slopeAmount. `signals()`: per voice midi(t), Hz(t),
gain(t), |dm/dt|(t), refinement level, L-system branch onsets (branch-point events), canon note onsets per layer, plateau
on/off (Cantor), estimated D and Ĥ.

---

## Wave Studio (prototype)

Studio id `wave`, order 100, dev port 8027 (`flexatone-wave`). The pitch axis is the medium: 1-D PDEs run on
x ∈ [pLo, pHi] (semitones, MIDI-linear) and the baked field u(x, t) becomes sound. / 음고 축 = 매질, 베이킹된 u(x, t)를 소리로.

### Files / 파일

| File | Tier | Role |
|---|---|---|
| `js/studios/wave-studio.js` | studios (pure) | `WaveStudio` plugin, `getWaveParams` (memoised, read-only) / `editWave`, presets, track → Voice, JSON payload, 11 self-checks |
| `js/studios/wave/wave-engine.js` | studios (pure) | document + `sanitizeWaveParams`, leapfrog solver (`createWaveSim`), Gray–Scott solver (`createGsSim`), `bakeWave` (signature cache) / `simulateWave` (uncached), `buildAmplitude`, `extractRidges` |
| `js/studios/wave/wave-bank.js` | studios (pure DSP) | **added (not in the brief's list)** — `WaveSpectralBank` (self-contained additive bank) + `buildWaveWorkletSource()` (Blob). Separate so the class can be shipped with `toString()` and tested on the main thread |
| `js/studios/wave/wave-audio.js` | audio tier | worklet / oscillator-fallback / ridge passes, chunk streaming, transport, offline render, WAV, JSON, 2 self-checks |
| `js/studios/wave/wave-canvases.js` | UI tier | one canvas: heat map (offscreen, painted once per bake + colour) · profile strip u(x) · medium strip c(x); pointer editing |
| `js/studios/wave/wave-panels.js` | UI tier | `mountWaveWorkspace`, racks, registers `WAVE_HELP` into `HELP_DB` |
| `js/studios/wave/wave-i18n.js` | studios (pure data) | EN/KO strings merged into `I18N` at import, help texts |

Shared files (lines added only): `js/main.js` (1 import), `js/ui/workspaces.js` (2 imports + 1 `registerWorkspace` block),
`index.html` (1 tab button), `.claude/launch.json` (1 entry). `core/*`, `modules/*`, `audio/*` and other studios are untouched.

### Decisions / 결정

1. **Units.** x in semitones, time in model seconds (= piece seconds × `simSpeed`), `speed` in st/s — a pulse on a flat
   medium glides at exactly `speed` (12 = one octave per second). Medium: c(x) = speed · lerp(cLo, cHi, y(x)), y = the `c`
   curve (custom points, evaluated with `evaluateCurveObjectY`). `cLo` / `cHi` / `speed` stay flat numbers for the Manager.
2. **Δt belongs to the solver, not to the bake rate.** The leapfrog runs at Δt = min(CFL, 1)·Δx/c_max (default CFL 0.9 —
   least numerical dispersion); frames at `bakeRate` are linear interpolations between the two leapfrog levels. Default:
   847 steps for 3001 frames, bake ≈ 15–25 ms (Kink Collision, Nx 192: ≈ 70–95 ms).
3. **Dispersion sign (document ≠ brief).** The brief writes `+ β u_xxxx`; with β > 0 that is ill-posed (ω² = c²k² − βk⁴).
   Implemented the stiff-string form u_tt = c²(u_xx − D·u_xxxx) (ω² = c²k²(1 + Dk²)); the stability limit includes it
   (Δt ≤ 2/ω_max), likewise the mass term of Klein–Gordon / sine-Gordon.
4. **Boundaries.** fixed = Dirichlet at the *initial* end values (odd ghost → a reflected pulse is inverted; needed so a
   kink train with u(L) = 2π stays valid), free = even ghost, absorbing = Mur 1st order, periodic = wrap. Gray–Scott:
   fixed / absorbing hold u = 1, v = 0.
5. **Energy badge.** Discrete energy in the weighted norm Σ u_t²/c² + u_x² (half weights at free / fixed ends), which the
   scheme conserves exactly for the linear problem also with graded c(x): measured 3–5·10⁻¹⁵ (wave), 7·10⁻⁴ (sine-Gordon).
   Shown only when the system is conservative (no damping, no drivers, not absorbing, not Gray–Scott).
6. **Gray–Scott units.** Du, Dv in st² per time unit, 100 time units per model second; default Du 0.036, Dv 0.018,
   F 0.03, k 0.057 (pulse splitting fills the 5-octave range in ≈ 30 s). The field shown / sonified is v; “energy” = u·v².
7. **Spectral mode = AudioWorklet additive bank.** Fixed bin frequencies, phase accumulators inside the bank (seeded start
   phases — all-zero phases produce an onset burst), amplitudes linear between frames and inside each 128-sample block,
   equal-power pan by pitch, hard clamp ±0.98. Level: scale = 0.25/√max(1, max_t Σ ā²) (independent of how many bins sound).
8. **Matrix transport = chunk streaming.** The worklet allocates the frames × bins matrix once in its constructor; the main
   thread posts chunks of 256 rows (each a fresh slice whose buffer is *transferred*), starting with the chunk under the
   playhead. Default piece: 12 chunks, 1.5 MB, ≈ 1 ms on the main thread. A sound-only edit while playing re-streams in
   place (no restart); a structural change restarts at the playhead (90 ms debounce). No SharedArrayBuffer needed.
9. **Fallback.** No AudioWorklet (or `sonify.engine = 'oscillators'`): ≤ 64 sine oscillators with gain curves read from
   the matrix (neighbouring bins merged power-preservingly, seeded phases through a 1-harmonic PeriodicWave).
   Export WAV uses the same engine as playback.
10. **Ridge tracking policy.** Peaks above `peakThresh` (parabolic refinement) are matched greedily to predicted track
    positions within `maxJump` st. A track without a peak coasts for `maxGap` s; the prediction starts one history window
    (0.3 s) before the loss with the median velocity, mirrored at walls — the visible peak leaves the true pulse centre
    just before two ridges merge. Frames hidden behind a peak another track owns do not use up the gap (≤ 0.75 s).
    **Crossing: two ridges that merge and separate keep their count** (2 → 2, identity follows the motion); a longer
    overlap ends one track and starts a new one. Result: Single Pulse = 2 tracks over the full 30 s (bouncing glissandi),
    Kink Collision = 2 tracks.
11. **Bake to Glissando.** One voice per track (≤ `maxTracks` ≤ 64): F0 / F1 = lowest / highest pitch, `captureCurveToCustomPoints`
    (tolerance 0.002, ≤ 64 anchors, dense source up to 1600 points so reflection corners stay sharp), amplitude → gain points.
    Measured mean pitch error ≈ 0.01 st, worst 0.04–0.45 st (only at merge / reflection instants, where the level is low).
    Lost (stated in toast + help): stereo position, bin phases, everything below the peak threshold; in Spectral mode the
    cloud is first reduced to its ridges.
12. **Live edits follow the state bus**, not the render loop (rAF is throttled in background tabs): `wave-audio.js`
    subscribes to scope `studio` and calls `refreshWaveLive()` only while a pass is live.
13. **Self-checks never touch the document's cache**: they use `simulateWave` (uncached) or `withIsolatedWaveCache`, so
    running `runSelfCheck()` does not change the bake badge.
14. **Workspace rebuilds.** The static part (strip, canvas, sonification) is built once per language; only the structure-
    dependent racks are rebuilt — the canvas element survives while a pulse is dragged into existence.

### Limits / 한계

- Manager integration is out of scope (`MANAGER_STUDIOS` untouched): no instances, no tempo, no Master View.
- Bin spacing is 47 cents at Nx = 128 over 5 octaves: a travelling pulse is a gliding *cluster* (beating between
  neighbouring bins), not a pure tone — use Ridge mode for single lines.
- The Mur boundary is first order: exact for the plain wave equation near CFL 1, partial for dispersive / massive waves.
- Standing Chord in Ridge mode gives many short tracks (antinodes of a 3-mode sum move); it is meant for Spectral mode.
- The spectral timbre is always sine; the 5-wave timbre applies to ridge voices and baked voices.
- Bake rate is lowered automatically above 2.4 M matrix values (badge shows it). Offline spectral render runs on the main
  thread in yielding slices (≈ 0.2 s per 6 s of audio at Nx 128; worst case 256 bins × 120 s takes several seconds).
- Drivers on Gray–Scott are a simple v feed (not a calibrated source).
- Wheel over the canvas zooms (same as Field), so the page does not scroll there.

### Checks / 점검

- `runSelfCheck()`: **130/130** (117 from the other studios at the time of the run + 13 Wave: CFL clamp → finite, energy over
  10⁴ steps, pulse speed ± 2 %, reflection fixed / free / absorbing, standing-mode period, sine-Gordon collision ± 5 % with
  plateau flip 2π → −2π, Gray–Scott clamp + bounds, ridge tracking + crossing policy, determinism + cache, bank
  allocation-free + phase-continuous, bake to Glissando; audio: offline = worklet (matrix and chunk stream), fallback /
  ridge / peak / stereo). Console: 0 errors.
- Live (worklet): RMS ≈ 0.1–0.2, 0 bakes while playing / looping / seeking; gain edit → 0 bakes, in-place stream; damping
  edit → 1 bake, no restart; mode / engine / length change → restart at the playhead. Tab switches stop the audio both ways.
- WAV: 48 kHz stereo, peak 0.574 (Single Pulse, 6 s), fader 0.5012 → peak ratio 0.5012; band centroids follow the two
  glissandi (285 → 76 Hz falling, 479 → 1696 Hz rising in 2.3 s).
- Verified through another chat's dev server (same folder): `preview_start` refused port 8027 (5-server cap per folder).

**Manager candidates** — `params()`: speed, cLo, cHi, cfl, damping, dispersion, mass, simSpeed, length, pLo, pHi, gs.Du,
gs.Dv, gs.F, gs.k, init[i].x / width / amp / velocity / mode, drivers[i].x / hz / amp / t0 / dur, sonify.gain, ampPower,
floor, stereo, peakThresh, maxTracks, maxJump, maxGap, timbre.*, seed. `signals()`: total energy E(t), spectral centroid
(pitch) and spread of |u|(t), per-bin amplitude aᵢ(t), strongest-ridge pitch / amplitude / velocity (st/s), ridge count
N(t), ridge birth / death / wall-reflection / crossing events, effective CFL, energy error.

---

## Wave Studio — Manager integration

The generic part (Wave in `MANAGER_STUDIOS`, colour, `mgr.short.wave`, instance rules for non-base studios, clip adapter
`audio/studio-clips.js`, blocks in the Master View) was added by the chat that integrated all clip studios. This section
covers what Wave adds on top, through **optional adapter capabilities** any clip studio can opt into.
공통 부분은 전체 클립 스튜디오 통합 작업에서 추가됨. 여기서는 Wave가 선택 기능으로 더한 부분만 기록.

### Optional capabilities in `audio/studio-clips.js` / 선택 기능

| Field | Meaning | Used by the Manager for |
|---|---|---|
| `scalesTime: true` + `render(params, sr, { rate, ampMask })` | the studio renders the pitch-preserving part of the tempo itself and applies shape masks | `varispeed()` uses only the tape ratio; `getBuffer` / `exportCycleWav` pass `{ rate, ampMask }` |
| `key(params)` | what the rendered sound depends on | `docKey` — view-only edits no longer re-render |
| `lines(params)` | pitch lines `[{ key, name, pts: [{ t, m }] }]` in document time | Master View draws lines instead of a block; Shape select can use them |

Helpers: `clipStudioScalesTime`, `clipStudioKey`, `clipStudioLines`; `renderClipStudio(studio, params, sr, opts)` passes
`opts` only to `scalesTime` studios. Studios without these fields behave exactly as before.

### Wave side / Wave 쪽 구현

1. **Pitch-preserving tempo without re-simulation.** `retimeWaveBake(bake, rate)` re-labels the frame rate of the baked
   field (matrix shared): length ÷ rate, same pitches. Amplitude matrix and ridge tracks are computed on the original bake
   and only read faster. Tape mode stays varispeed (`playbackRate`). Measured through `exportCycleWav`: ×1 = 2.00 s, ×2 =
   1.00 s with the energy still at the document pitch (+46 dB vs. the octave above), ×2 tape = 1.00 s one octave up (−44 dB).
2. **Shape masks.** `renderWaveBuffer({ ampMask })`: spectral = the amplitude matrix is multiplied per bin × frame (a copy),
   oscillator fallback = per group curve, ridge = per track gain. A mask muting the upper pitch half removed 43 dB there and
   left the lower half unchanged.
3. **Instances do not disturb the editor.** `resolveWaveDoc(doc)` memoises full params per stored document object (the
   editor and the Manager share one object for the focused instance); documents that are not on screen bake into a separate
   6-entry cache (`bakeWaveDetached`) — 0 editor bakes while two Wave channels played, the bake badge does not move.
4. **Clip length without simulating:** `waveTimelineEnd(params)` (the Manager asks for it on every render of the panel).
5. **Master View:** ridge tracks as lines (`waveMasterLines`), divided by the content rate and shifted by the tape semitones
   like Glissando / Field lines.
6. **Re-render key:** physics signature + sonification + timbre (`waveRenderKey`).
7. **Fix found on the way:** an offline render before the first playback used the oscillator fallback (the worklet module
   was not loaded yet). Offline renders now pick the bank whenever the live pass would (`offlineEngine`).

### Limits / 한계

- The studio's own transport (header Play) still plays at 1× — same as every other studio (see “Not done yet” above).
- A Wave clip is rendered on the main thread in yielding slices (≈ 0.2 s per 6 s of audio at Nx 128); a hot-swap after an
  edit of a long, dense document can take a second or more.
- `inCycle` is true for a new Wave instance (shared default) — adding a 30 s Wave lengthens an auto-length cycle.

### Checks / 점검

- `runSelfCheck()`: **137/137**, Wave 16 (new: Manager helpers — memo / detached bake / re-timing / Master View lines;
  focus swap of two Wave instances; Manager render — tempo ×2, masks in time and pitch, re-render key).
- Live: two Wave channels launched together (−15 / −12 dBFS), still sounding after a studio-tab switch, hot-swap after a
  gain edit (−24 dBFS), focus swap 8 s ↔ 30 s documents, Stop all → silence. Console: 0 errors.

### Click-through verification (Wave + Manager) / 화면 클릭 검증

- **Bug found and fixed:** choosing a studio in the Manager's “＋ …” menu added the instance, but the panel did not
  re-render until the menu lost focus (`renderPanel` defers while a control inside the panel has focus) → `el.blur()` in the
  add handler (`ui/manager-panel.js`). Affects every studio in that menu, not only Wave.
- By real clicks / typing: Alt+click help modal (the control's own action is swallowed), slider drag while playing (0 bakes,
  no restart, 1 undo step), header Export WAV (file saved: RIFF/WAVE 2 ch 48 kHz 16-bit 8.05 s), JSON button, Manager: add
  Wave, Launch, tempo field ×2 (top frequency 2051 Hz = pitch kept) → Tape (4078 Hz = octave up) → reset, Edit (focus swap,
  tab badge), Play cycle (5 channels, position advancing) / Stop all, Shape select on two Wave ridge lines → Confirm → rule
  chip none → solo → mute (−3 dB inside the shape's span, 0 dB after it).
- Observation (existing behaviour, all studios): Esc / Space are ignored while a range slider has keyboard focus
  (`isTyping` treats every INPUT as typing).

---

## Cross-studio parity pass (2026-11-22) / 스튜디오 간 기능 통일

Audit of all ten studios (Glissando, Risset, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave), then the
shared-UX differences were unified through **shared modules** instead of per-studio copies.
열 개 스튜디오를 전수조사한 뒤, 공용 UX 차이를 스튜디오별 복사본이 아닌 **공용 모듈**로 통일.

### What was different → what it is now / 달랐던 점 → 지금

| Feature | Before | Now (shared module) |
|---|---|---|
| Timbre synthesis | Glissando: Mix **and** ƒ(x) (formula / voice curve). Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave: 5-slider Mix only | All nine: Mix \| ƒ(x) with preview and error line — `modules/timbre-spec.js`, `ui/timbre-editor.js`, `audio/studio-fx.js` `createTimbreWave`. Bake to Glissando carries the mode. |
| Cue / playhead look | Glissando, Chaos: amber cue + ▼, white playhead. Field, Draw, Space, Tempo, Fractal, Wave: dashed amber cue, green playhead. Cloud: green cue, red playhead | One look everywhere (amber cue + ▼ flag, white playhead + ▼, dark halo) — `ui/transport-lines.js` (also matches the Manager's white playhead) |
| Canvas wheel | Glissando, Draw: wheel = pitch scroll, ⇧ = time, Ctrl/⌘ = zoom. Field, Cloud, Wave: wheel = time zoom, ⇧ = pitch zoom. Tempo: time zoom only. Chaos: none. Fractal: lens only. Space: scene only | Glissando grammar on every time × pitch canvas — `ui/view-nav.js` `wheelNavigate` |
| Zoom toolbar | Glissando: Pitch − +, Time − +, X+Y − +, Fit. Others: two / one / no pairs, different limits | Same bar everywhere — `createZoomBar`; `F` = Fit All |
| Tremolo | Glissando (per voice), Field (per particle), Risset (output). None in the other seven | Output tremolo rack in Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave — `ui/studio-tremolo.js`, `studioLiveOutput` / `connectStudioOutput` (LFO backend, live = WAV) |
| Moving feature blocks | fixed page layout | every block (`<section>`) has a grip: drag = float (stays while scrolling), corner = resize, double-click / ⤓ = dock; header **Default layout** resets positions only — `ui/rack-layout.js` (localStorage, not in undo / project) |
| Manager: add studio | 3 buttons + a "＋ …" menu for the other seven | one "＋ Studio" button per studio |

### Decisions / 결정

1. **Timbre spec lives inside the existing `timbre` object** (`timbre.mode`, `timbre.func`): every studio already keeps `timbre`
   out of its bake signature and inside its audio key, so ƒ(x) edits never re-bake and live playback follows without new
   plumbing. Only Wave's sanitiser needed an explicit line. Studios keep 32 harmonics (Glissando 64) — same sound as before in Mix.
2. **Field**: the Curvature→Bright boost shapes the Mix only; ƒ(x) plays the function wave as written.
3. **View state added where there was none** is UI-local (Tempo pitch range, Chaos pitch canvas, Fractal main canvas, Space
   time canvases): never in the document, never in undo. Field / Draw / Cloud / Wave keep their view in the document (`history: false`).
4. **Studio tremolo = output stage, not per voice** for the seven new racks (as in Risset): one persistent LFO stage per studio in
   front of the output bus; passes only swap their connect target. Wave's worklet render multiplies the samples
   (`applyTremoloToSamples`). `doc.tremolo` is kept by Space / Wave sanitisers and is part of Wave's Manager render key.
5. **Racks are moved with CSS only** (`position: fixed`), never re-parented, so studios keep rebuilding their DOM; a
   MutationObserver re-applies saved places. Rack key = `data-rack` → id → first `data-help` inside (language-independent).

### Not unified (on purpose or still open) / 통일하지 않은 것

- **Risset**: no 5-wave / ƒ(x) timbre (its worklet bank is a sine → pulse morph with PolyBLEP), no cue / playhead / zoom
  (continuous field without a timeline). Wave *Spectral* mode is always sine (each bin is a partial); the timbre applies to Ridge mode.
- **Per-voice tremolo** only in Glissando / Field; the seven new racks act on the whole output.
- **Screenshot**: full / clean / SVG + Version only in Glissando; other studios save the largest canvas as PNG.
- **Gain units** (amp / dB / sone per voice) and **Piano ⇄ Norm view** (Glissando, Field) are not in the other studios.
- **Edits while playing**: heard at once in Chaos, Space, Wave, Cloud; on the next pass in Glissando, Field, Draw, Tempo, Fractal.
- **Mute / solo per line**: Glissando, Field, Draw, Space, Tempo; not in Cloud (events), Chaos, Fractal, Wave.
- **Presets**: every studio except Field (and Glissando, which uses project files); **seed**: where the studio is stochastic.
- **Tempo Manager on a studio's own transport**: none (all play at 1×) — unchanged.

### Import trajectory (Glissando → Cloud / Tempo / Fractal) / 궤적 불러오기

`studios/trajectory-link.js` (logic), `studios/trajectory-targets.js` (what import means per studio), `ui/trajectory-ui.js`
(button, picker, lock, guard). Cloud = pitch-centre curve + length; Tempo = subject (read live); Fractal = FIF base line + range + length.

- **Link** = `studioParams[studio].trajLink = { voiceId, voiceName, locked, sig }` — in the importing studio's document, so the
  Glissando voice is untouched (Duplicate never copies a link) and undo / project files carry it.
- **Picker**: Glissando instance (Manager) → window (all lines, chosen one highlighted, others at 22 %) + multi-voice grapher cards.
  A voice of a non-focused instance: that instance is focused first.
- **Lock 🔒**: a shape edit (curve, pitch ends, timing — not name / gain / timbre) of a locked voice is taken back (`undo()` + the
  redo entry is dropped; edits without an undo step are restored from a shadow copy) and a dialog asks: **Copy** (default: edit a
  duplicate) · **Change without copying** (→ 🔓 linked editing) · **Cancel**. The blocked edit itself is not replayed.
- **Linked editing 🔓**: after every state event, unlocked links whose `sig` changed are re-imported with `history: false`; the
  stored `sig` makes this self-healing across undo / redo. Tempo addresses its voice by index and is re-pointed when voices are reordered.
- To add a studio: `registerTrajectoryTarget(id, { apply })` + `createTrajectoryImportButton(id)` in its strip.

### Checks / 점검

`runSelfCheck()`: 137 → **140/140** on a fresh load (new: timbre spec; trajectory signature / breakpoints; import → lock → linked
edit → undo). Observed: a *second* `runSelfCheck()` in the same page fails two older checks (Draw signature cache, Space bake
cache) because their caches are already warm — not checked against the pre-change build. Browser (through the :8000 server): no
console errors; all eight studios show the zoom bar and the Mix \| ƒ(x) editor; ƒ(x) changes the offline render and the baked
voice (`timbreMode: 'func'`); tremolo on raises the envelope modulation of the offline render in all seven studios; a rack drag
floats / persists / is reset by Default layout with the document unchanged; Manager adds Fractal / Cloud / Wave from buttons;
import → 🔒 → blocked edit → each of the three choices → linked edit follows in Cloud and Fractal → undo follows back.
Not verified by ear (the preview pane was hidden): live tremolo and live ƒ(x) playback were only checked for errors.

### Import trajectory — Draw / Field / Space added / 드로잉·필드·스페이스 추가

Studios with several lines fill one of them (`studios/trajectory-targets.js`); the link remembers which one.

| Studio | What the import writes | Link field |
|---|---|---|
| Draw | a new stroke (129 raw points, `smooth 0.05`, fixed gain); linked edits replace that stroke; a second import adds another stroke and the link moves to it | `strokeId` |
| Field | active particle: F0 / F1 / start / duration; guiding curve = `engine: 'custom'` + ≤ 32 breakpoints (y between F0 and F1; lowest / highest pitch when the line returns to its start) | `particleId` |
| Space | active source: own pitch f_s(τ) in curve mode (hz0 / hz1 = lowest / highest pitch, custom breakpoints), start, duration | `sourceId` |

- `evalGuidingCurve` (Field engine) now accepts `engine: 'custom'` with `customPoints`; the nine guide tabs show none selected
  and picking one replaces the imported guide. The Field guide is shared by all particles, so the import changes it for all of them.
- `normalizeSpaceDoc` keeps `trajLink`.
- Checked: `runSelfCheck()` 140/140; Draw stroke = voice line (48 → 72), Field particle and guide set and following a linked
  duration edit, Space emitted pitch 130.8 → 523.3 Hz with a 3.1 s render, undo removes import and link together.

## Manager Warp — pitch-space curvature tracks (2026-11-22) / 매니저 곡률 트랙

A **⌇ Warp** button on every Manager track turns that track into a curvature editor: it goes silent and, while its clip
plays in the cycle, its lines bend the pitch space of the other tracks (all of them, or the ones picked under *Bends*).
매니저 트랙의 **⌇ 곡률** 버튼: 트랙이 무음이 되고, 클립 구간 동안 그 선들이 다른 트랙의 피치 공간을 휨.

- Data: `instance.warp` (`core/warp-config.js`: on, depth 0–2, targets, rest start|mean, after hold|return, mode, radius,
  amount, smooth, sieve). Part of the undo snapshot (`setInstanceWarp`, drags coalesce). Old projects get the default (off).
- Maths: `modules/pitch-warp.js` — a displacement table D(t, m) (25 rows/s, MIDI −24…144) with every row forced monotone
  (two notes never swap; only Risset "rotate" wraps on purpose). Lines → anchors Rᵢ → Rᵢ + Dᵢ(t), Fritsch–Carlson between
  them (1 line = transposition, ≥ 2 = intervals stretch); Draw brush = Gaussian per stroke. Stages compose in track order and
  their depth follows the source clip's fades.
- Sources (`audio/warp-sources.js`): Glissando voices · Risset voices on S¹ simulated offline (frame = rotation removed /
  rotate = with it, wrapped in the span) · Field particle lines or the field itself (pitch points advected by v_y of the
  active particle's field) · Draw strokes (global / brush) · Chaos, Tempo, Fractal baked lines · Space observed (Doppler) or
  source pitch · Cloud rules (centre = transposition, width·(1 − collapse) = scale, optional sieve pull — not the grains) ·
  Wave from the precomputed field (u as displacement, or energy density → cumulative map; auto = energy for Gray–Scott),
  time-smoothed — not the ridges.
- Targets: `pitchWarp(sec, hz)` sits next to `ampMask` in every renderer (Glissando scheduleGraph, Field, Draw, Chaos —
  map mode then plays the warped baked curve —, Cloud — grain glides become curves —, Tempo, Space, Fractal, Wave — ridge
  curves, spectral matrix resampled along pitch (bin-quantised, range-limited) —). Risset: the voice bank takes a per-slot
  `frame.shift` (semitones, ≈10 ms smoothing) live and offline. Warps are in cycle time like the shape masks. A looping
  target clip that a warp reaches is unrolled (`renderClipBuffer`): each pass is rendered at its own cycle time (masks
  too, for that clip), up to 180 s / 64 passes, after which the unrolled buffer loops. Without a warp, clips loop one pass. Risset live warps follow the cycle playhead only.
- Mixer: Warp tracks are not audible (also ignored by solo), never rendered or launched; target buffers re-render when a
  source changes (warp key in `docKey`). Master View: targets drawn as heard, sources dashed; the **⌇ Curved grid** toggle (header, on by default) draws
  every semitone line where that pitch is heard (octaves bold, labelled ⌇C4 … at the right), bands tinted by the local
  stretch W(m+1) − W(m) (orange wider, blue narrower), cached per warp + view size (`warpGridImage`). It uses the warps
  aimed at all tracks, else those of the first bent track.
- Checked: `runSelfCheck()` all warp checks pass (pitch-warp maths, Glissando / Risset sources, voice-bank shift); a drone
  rendered under a Draw warp measured within 0.01 st of the warp; undo / redo of the button; cycle WAV export; live Risset
  cycle with a warp, no console errors. One unrelated failing check: "Field studio: local regions modulate the field only
  inside" (Field engine, not touched here).

## Field vector-field layers + shared Locate tool (2026-11-22) / 필드 레이어 + 공용 이동 도구
- Field Studio: the vector field now lives on the absolute pitch × time plane (`studios/field/field-layers.js`), shared by
  every particle. Ordered layers (Main = full range; Local = box/ellipse range, invert, soft/hard edge), blend Add / Multiply
  (amount −1…1) / Replace, ▲▼ order. Regions and force nodes are absolute (sec, MIDI). Old documents convert once on read
  (`migrateFieldDoc`, also applied in `audio/warp-sources.js` field-flow source). Arrow density / size / width in the view.
  Vector field ON/OFF (OFF = particles follow the guiding curve exactly).
- Shared Locate (`ui/locate-tool.js`): the Glissando ✥ Locate / 🧲 Snap prefs (`appState.locateMode`, `locateSnap`) drive a
  capture-phase controller per studio canvas. Field (particle body = start + F₀/F₁, dots = that end's time + pitch), Draw
  (Select / Node tool; body = offset, dots = stretch + pitch taper, transpose-only strokes), Tempo timeline (start +
  transpose, no dots), Space observed-pitch roll (start + emitted pitch, dots = time only). Not applicable: Cloud, Chaos,
  Fractal, Wave, Risset (no individually placed time × pitch objects).
- Live playback: edits re-bake at once. Releasing a Locate drag plays the studio from that object's start
  (`transport.playFrom(sec)` → `start<Studio>Audio(fromSec)`), restarting a running pass; the cue line is not moved.
- Shared icon-button tooltip (`ui/icon-tooltip.js`, CSS `.fx-icon-tip`): hovering any button whose visible text is ≤ 3
  characters (−, +, ✕, S, M, ▲, ⟲, SVG …) or any `[data-tip]` element shows a styled popup after ~0.3 s, in every studio
  and the Manager. Label order: `data-tip` → `title` → `aria-label` → localized symbol name (✕ S M ▲ ▼) → `data-help` title.
  The native `title` tooltip is suppressed while hovering. New icon buttons: give them a `title` (via `t()`) or `data-tip`.

### Warp drives beyond pitch (2026-11-22) / 곡률의 음고 외 적용

`warp.params = { pitch, level, trem, bright }`, each `{ on, sens }` with sens −5…5 (default 1; old `depth` becomes the pitch
sensitivity). Track strip: a chip per parameter, and for each one that is on, a slider + number box.
- pitch: m + k·D (beyond 0…1 two notes may cross — the monotone guarantee holds only there).
- level: + k·D dB (−60…+12), tremolo: k > 0 → depth |k·D|/12, k < 0 → 1 − |k·D|/12, at the target track's tremolo rate
  (0.5–12 Hz, cycle-clock phase) — both folded into the gain hook (`makeGainAt` in manager-mixer.js), so every studio
  incl. Risset (live + offline) gets them with no renderer change. Masks may now be > 1 (Glissando skip test and Wave
  mask clamps relaxed to allow the warp's boost).
- brightness: `brightWarp(sec, hz)` → high-shelf above the 2nd harmonic (`createBrightShelf` in audio-engine.js) in
  Glissando, Field, Draw, Tempo, Space, Fractal, Chaos, Cloud; Wave and Risset (plain partials) get a spectral tilt
  through the gain hook (6 dB/oct per octave of drive around the Wave range centre / the Risset bell centre).
- Math: `createWarpMod` (modules/pitch-warp.js). Checked: all self-checks pass; on a drone under a Draw warp, level k = −1
  went −4.5 → −27.9 dB, tremolo k = 1 swung 0 → 35 dB, brightness k = 1 raised the high-frequency ratio −20 → −7.5 dB.

## Chaos 3-D mapping axes (2026-11-23) / 카오스 3D 매핑 축

Only Chaos Studio has a 3-D state space (checked every studio: the others are 2-D planes or time × pitch).
`doc.axes` = 3 axes A/B/C `{ target: none|pitch|gain|bright, az, el (deg), len, c:[x,y,z] }` in the normalised x/y/z
space (≈ −1…1 over the 2–98 % reference range). A channel assigned to an axis reads
`((s − c) · dir) / len` (reference normalise → fixed range −1…1), overriding its Source menu (which shows "3D axis …").
Defaults are unassigned, so old documents sound the same; presets reset the axes. Engine: `resolveAxes`, `axisDirection`,
`axisValues`, `refFrame` (chaos-engine.js, stage B only — no re-integration). UI: "3D mapping axes" rack (target,
azimuth, elevation, strength = 1/len, position along the axis, x/y/z snap, Reset) and "✥ Edit axes" in the portrait
header: drag the filled tip = angle + strength, the hollow centre = position, one undo step per drag; any projection.
Checked: new self-check (axis along x = source x; turning / shortening changes the pitch), all 147 self-checks pass,
drag + undo tried in the browser.

## Manager Extend tools + takes (2026-11-23) / 매니저 연장 도구 + 테이크

The **⤳ Extend** card (Manager, under the timeline) makes the cycle longer out of what is already in it: method button →
amount (× cycle or seconds) → Extend. Code: `core/manager-extend.js` (pure planners + apply / remove), `core/take-config.js`,
take rendering in `audio/manager-mixer.js`, card and Master View in `ui/manager-panel.js`.
매니저 타임라인 아래 **⤳ 연장** 카드: 이미 있는 것을 재료로 사이클을 늘림 (방법 버튼 → 양 → 연장하기).

- **Take** = a track whose sound is a clip *as it sounded*: `take { on, rev, as, at, len, loop, inner, rate, raw }`. The mixer
  renders the forward clip (`takeContext`: this track's own document / tempo / tremolo, placed at `at` for `len`, carrying
  the id `as` so the shape masks and Warp tracks of that track apply), resamples it to exactly `len` seconds as heard
  (varispeed, loops, range solo / mute gate unless `raw`), reverses it when `rev`, and plays it at tape ratio `rate`. A take
  of a take keeps the first one in `inner`. Risset takes are offline renders. Takes with the same content share one buffer
  (`cachedTake`, bounded to 480 s of audio). `getInstanceDoc()` honours `ctxDoc` on such context objects.
- **Why takes and not document edits:** ten studios have ten document formats, and Warps / masks / tempo act between
  tracks; a reversed or transposed *rendering* is exact for all of them, a reversed document is not possible for most
  (Field physics, Chaos, Cloud, Wave). Cost: a take is frozen audio — after editing the original, remove the extension and
  extend again; memory grows with the number and length of different takes.
- **Only adds:** new tracks carry `ext` (the extension id); the step is logged in `manager.extensions` with the previous cycle
  mode / length and the looping clips whose automatic length had to be written down (`froze`). The cycle becomes Set = new end.
  **Remove last extension** undoes exactly that. Undo / redo carry the log too (`managerSnapshot().ext`), and re-created
  tracks get their mixer fields back (`mix`).
- **Five methods, five definitions of "musical"** (texts: i18n `mgr.extDef.*` / `mgr.extHow.*`):
  `retro` symmetry (palindrome) · `canon` rigid coupling (one just tape ratio for speed, pitch, length, fades; level −3 dB / oct)
  · `swap` compensation (sounding level, fades, tremolo rotate among the tracks; needs `measure.level`) · `arc` co-variation
  (stretto ×0.8 to a climax at 0.618, level / attack / tape ratio rise together, last in first out; raw takes) · `rondo` form
  (solo episodes ↔ refrain = the opening of the cycle). Three of them (`canon`, `swap`, `arc`) are defined by how parameters
  interact; `retro` and `rondo` by symmetry and by form.
- **Limits / 한계:** not checked by ear. Ranges that are added later inside the extension act on takes like on any track.
  A take does not follow later edits of its source. `swap` on a balanced mix changes little in level (the roles then differ
  mostly by fades and tremolo). Constants (0.8, 0.618, −9 dB, 10 s per ritornello pair, −3 dB / oct) are fixed in
  `manager-extend.js`, not exposed in the UI.


### Manager track selection (2026-11-23) / 매니저 트랙 선택

View-only selection (`ui.sel` in ui/manager-panel.js; not saved, not undoable, independent of M / S and sound).
Click a track — the empty part of its strip, its studio badge, its timeline name, or its clip (a click without
dragging) — to select it; click it again to clear; Shift+click adds / removes. Selected tracks: outlined strip and
timeline row, glowing clip, bold lines / blocks / Risset bands in the Master View; the others are faded (strips come
back to full opacity on hover / focus). The Tracks card header shows "n selected · Clear selection".

### Warp time density (2026-11-23) / 곡률 시간 밀도

Fifth drive `params.time` (sens −5…5) with `timeMode` keep | tape and `timeClock` track | voice (core/warp-config.js).
- Rate r(T, m) = 2^(k·D/12) (`createWarpRate`, modules/pitch-warp.js; 1/8…8). Time map Φ(u) = ∫ r, monotone;
  `modules/time-warp.js`: `buildTimeMap`, `resampleTape` (tape: speed and pitch together), `wsolaStretch` (keep: WSOLA,
  N = 2048 @ 48 kHz, hop N/4, ±N/5 search). Self-checks: Φ / Φ⁻¹, tape ×2 = octave up, keep ×2 = same pitch.
- Mixer (`renderTimeWarped`): render the content the clip reaches (loop passes included), with the pitch / level /
  brightness hooks reading real time through Φ⁻¹, then re-time. Track clock reads D at the track's first pitch
  (`trackRefPitch`); voice clock renders every voice solo (`voiceSolos`: Glissando, Field, Draw, Tempo — pulse with the
  first voice —, Space; ≤ 24 voices) on its own first pitch and sums; other studios fall back to the track clock.
  `naturalLength` follows (voice clock: the slowest voice). Risset live: runtime clock × r(T), tape also × r on the
  pitch; Risset export re-times an offline render.
- Master View: heard time / pitch in the Cartesian view, written time in the curved view; the curved-grid toggle adds
  amber time lines per pitch row (curved view: equal heard time; Cartesian: where written seconds land).
- Measured (Glissando under a Draw line, k = 1): keep and tape within 0.1 st of the expected pitch at r = 1…2.5;
  natural length 4 → 2.42 s; voice clock with a brush: the voice inside the brush ends at 2.42 s, the one outside at 3.98 s.

## Trajectory Sends + order tool (2026-11-23) / 궤적 보내기 + 순서 도구

Generalises *Import trajectory* (Glissando → one studio) into sends between any studios, with a Master destination and a
tool that shows and edits the order. / 궤적 불러오기를 스튜디오 간 보내기로 일반화 + 마스터 + 순서 도구.

### Files / 파일
- `studios/trajectory-link.js` (pure): source / target registries, send list (`studioParams._sends`), `buildSendPlan`
  (edges, loop cut, stages, inbound order), `composeTrajectory` (replace / add), `evaluateSends`, Glissando locks, legacy migration.
- `studios/trajectory-targets.js`: receivers (Tempo now writes `subject.curve`; new Glissando receiver).
- `audio/send-sources.js` (new): lines of every other studio (needs `audio/studio-clips.js`, so it lives in layer 3).
- `ui/trajectory-ui.js`: Receive / Send buttons, chip, Send window, lock / guard, evaluation on every state event.
- `ui/send-router.js` (new): ⇄ Sends header button and order window.

### Decisions / 결정
- **Where sends live:** one project-wide list in `studioParams._sends` (saved and undone with the documents; `_` can never be a
  studio slug). The receiving studio's own `trajLink` only records what it was last written with (`sig` = hash).
- **Order = stage, then list.** Stage = longest path over applied edges, so every studio is written after all studios it
  receives from. Studios in the same stage do not depend on each other. Inside one receiver the list order applies; ▲ ▼ in a
  receiver move the send in the list next to its neighbour there (with a Master send this can also change its order in other
  receivers where both meet — shown in the list).
- **Combining:** Replace starts again from the source line (timing included); Add keeps the timing of the line so far and adds
  the source's contour (its pitch − its first pitch) sampled at the same normalised time. An Add with nothing before it = Replace.
- **Loops:** taken in list order; a direct send that would close one is refused (with the path), a Master send skips that
  receiver ("loop" in the tool).
- **Instances:** a send reads from the instance it was made from (stored document when that instance is not in the editor) and
  binds each receiver to the instance in the editor at its first write (`bound`); while another instance of that studio is in
  the editor the edge is "away" and nothing is written, so focusing another instance never overwrites it.
- **Glissando as receiver:** one voice per editor document (engine custom, ≤ 48 breakpoints); its name / colour / gain / timbre
  stay the user's; it is never locked (it follows its sources).
- **One undo step per action:** `editSends` changes the list silently, evaluates (receivers written without history) and
  pushes one snapshot. Re-evaluation after undo / redo is a no-op because the receive records came back with the documents.

### Limits / 한계
- Draw / Field / Space receive one combined line (a stroke / the active particle / the active source), not one per send.
- Risset neither sends nor receives (no line). Wave and Chaos only send.
- Sources are read from baked data; very dense clouds offer only the centre curve (not grains).
- Not checked by ear, nor in Manager playback / video export of receiving studios.

### Checks / 점검
See CHANGELOG 0.12.0.

- Shared parameter help on hover (`ui/param-help.js` resolver + `ui/param-help-entries.js` data; shown by
  `ui/icon-tooltip.js`): hovering a parameter's label or its slider / number / select / checkbox for ~0.45 s shows what that
  one parameter is, in every studio and the Manager, EN / KO. No panel code changes: the on-screen label text is mapped back
  to its i18n key, then `PARAM_HELP["<data-help>><labelKey>"]` → `PARAM_HELP[labelKey]` → `PARAM_HELP["<data-help>><text>"]`
  → the nearest data-help entry (exact when it documents only this parameter, else shown as the group's summary).
  Manager track-header controls (gain, tempo, start) are recognised by `data-field`. Coverage on 2026-11-23: 433 of 446
  visible controls have a parameter-specific text; the rest are the Loudness dB box, the Tempo note table, Risset EQ band
  selectors and the Wave initial-condition type. New parameters: give the label an i18n key and either a one-parameter
  `data-help` entry or a `PARAM_HELP` line.

## Fractal — pitch-preserving Manager tempo (2026-11-23) / 프랙탈 음고 유지 매니저 템포

- `studio-clips.js` Fractal adapter: `masks: true` → `scalesTime: true`; render gets `timeScale: o.rate`. The mixer then
  plays only the tape part as varispeed (`varispeed()` → `r.tape`) and the Master View shifts Fractal lines by the tape
  ratio only. 어댑터를 scalesTime으로 전환 — 문서 배속은 프랙탈이 직접 렌더, 테이프 배속만 varispeed.
- `fractal-engine.js` `retimeFractalBake(bake, r)`: the same bake read r× faster (start, length, sample spacing ÷ r; Hz /
  gain arrays shared), like Wave's `retimeWaveBake`. No re-bake on a tempo change.
- `fractal-audio.js`: `timeScale` option on `scheduleFractal` / `renderFractalBuffer`. Per-voice vibrato / tremolo
  (voice-mod) and the studio output tremolo run on document time, so they speed up with the tempo (Glissando's rule via
  `applyTempoToVoices`). Shape masks and Warp are read in real (channel-local) time, as the scalesTime contract says.
- Checks: new self-check "Fractal: Tempo Manager retime keeps pitch, divides every time by the rate" (158/158 pass).
  Browser: instance 2× → clip 30 → 15 s, measured pitch 65.57 → 65.70 (varispeed would be +12); 0.5× → 60 s, same
  pitch; master 2× with Tape → +12.1 st; real-time mask [5, 7.5) s at 2× is silent (−200 dB) with −14.1 dB on both sides;
  Master View draws the line over 15 s at the same pitch; no console errors.

## Manager Interpolate tool (2026-11-23) / 매니저 보간 도구

Request: "매니저 툴에 interpolation 기능 추가 — 양옆의 범위를 선택하면 그 사이를 매끄럽게 transform". The request did not say
what is transformed, so two readings were built as two methods (the Extend card's pattern).

- **Where:** `core/manager-interpolate.js` (pure; planners + `interpolateRanges(method, regionA, regionB, measure)`), card
  `interpMarkup()` in `ui/manager-panel.js` (after Extend, `data-rack="mgr-interp"`, help keys `mgr.interp`, `mgr.ipMethod`,
  `mgr.ipRange`, `mgr.ipApply`, `mgr.ipRemove`; texts in the panel's own `Object.assign(I18N.…)` block).
- **Ranges:** the existing time ranges (`kind: 'range'`). A = earlier, B = later, gap = [A.t1, B.t0) ≥ 0.1 s. The card picks
  the selected range and its nearest neighbour, else the closest pair; both can be chosen from the two selects.
- **glide:** the panel passes the Master View's heard lines (`geometry().lines`, Warp sources left out) as `measure.lines`.
  `lineEdge` reads pitch + slope (over ¼ of the range, 0.05–0.5 s) where the line leaves A / enters B; `hermitePitch` limits
  the tangents to 3 × the interval (≥ 12 st). Voices are `engine: 'custom'` with 33 spline points, written in document
  seconds (gap × track rate). Tracks without lines (Risset bands, block studios) cannot be glided → error toast pointing to Dissolve.
- **fade:** needs a take that starts inside a clip → new `take.off` (`core/take-config.js` `takeOffset`, `takeLength`;
  mixer `renderTake` trims the buffer, `docKey` includes it; `clipGeometry` shifts the lines). The B take ends on g1:
  k = ⌊gap / window⌋ whole passes, or — window longer than the gap — only the end of the window, unlooped.
- **Undo / remove:** one `dispatch` with history; logged in `manager.extensions` (`method: 'ip-…'`, `prev` = current cycle
  settings so removal leaves the cycle length alone). `removeLastExtension()` removes it; the card's button is enabled only
  while an interpolation is the newest step.
- **Open points:** see the 0.19.0 CHANGELOG entry (Warp double-bend on glide tracks, level bump in the middle of a dissolve,
  flat level of glide voices, not listened to).
- **all (default, 0.19.1):** user follow-up "음고뿐만 아니라 default로는 그 어떤 변수든 interpolate". `planAll` = `collectJoins` +
  `buildJoinTracks(…, layers = true)` (two voices per join: `voiceBase` of each side, `gainPoints` [gA → 0] and [0 → gB], on
  the track made for that side's source) + `planFade` with `skipA` / `skipB` for the tracks that were not joined on a side.
  The panel supplies `measure.voiceGain` (`lineEnvelopeAt`, Glissando voices only). A linear crossfade is used on purpose:
  the layers start together on the same curve, so their sum is the linear interpolation of level and wave mix.

## Manager Modulation (A2 · A3 · A4) (2026-11-23) / 매니저 모듈레이션

Roadmap B (mod matrix) in a render-time form: parameter modulation (A2), sidechain (A3) and triggers (A4) share one
route format. / 로드맵 B를 렌더 시점 방식으로: 파라미터 모듈레이션·사이드체인·트리거가 같은 라우트 형식.

### Files / 파일
- `core/mod-config.js` (pure): route format, targets and units, statuses (self / loop / kind), pulse train, follower,
  peaks, crossings, frame lookup.
- `core/manager-mods.js`: actions (add / set / remove / move, one undo step each) + self-check.
- `audio/mod-sources.js`: signals in cycle time (lines from `audio/send-sources.js`, envelopes from an as-heard render),
  per-target modulation `{ pitch, level, trem, bright, doc, retrig }`, Cloud document rewrite, previews.
- `ui/manager-mods.js`: the card; `ui/manager-panel.js` only hosts it (`.mgr-mods-host`).

### Decisions / 결정
- **Render time, not a live control bus:** the Manager plays rendered clips, so modulation is folded into the same hooks the
  Warp tracks use (`warpOf` → pitch fn, level / tremolo / brightness mod). Rendered clips, live Risset (`getMask` /
  `getWarp`), WAV and video therefore agree. Cache keys include the matrix key, so a route change re-renders its target.
- **No time density from the matrix:** `timeOf` / lengths ask `warpOf(…, { matrix: false })`, so a source's length never
  depends on a route (no recursion through `naturalLength`). Source placement uses `plainLength` (one pass without Warp time).
- **Sound-dependent sources** (envelope, peaks) are the only ones that can loop; checked in list order like Sends. Their
  envelopes are rendered asynchronously (`ensureModEnvelopes`, a source waits for its own envelope sources); Play and
  export await them; live edits re-render the target when an envelope arrives (key goes from "pending" to "ready").
- **Combining:** routes on one parameter add (no replace); trem is clamped 0…1 after adding to the Warp's tremolo.
- **Retrigger** rewrites the target's buffer (length = clip length in buffer seconds, 4 ms fades at each restart); the part
  before the first trigger is untouched. Not for live Risset (no clip).
- **Cloud doc targets:** the four time curves are resampled into a 64-point custom curve with the modulation added at the
  cycle time of each point; amount unit = × the curve range.

### Limits / 한계
- Looping clips modulated only through Cloud curves are not unrolled per pass (the first pass's curve repeats).
- Envelope renders are capped at 180 s per source; Risset sources are rendered offline for their envelope.
- Not checked by ear or in video export.

### Checks / 점검
See CHANGELOG 0.21.0.

