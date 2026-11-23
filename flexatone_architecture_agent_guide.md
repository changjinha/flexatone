# ARCHITECTURE.md — Glissando Studio (`~/Documents/flexatone`)

> **Purpose:** This document is the single source of truth for AI coding agents (Claude / Claude Code) and human developers working inside `~/Documents/flexatone/`. Read this file before creating, refactoring, or extending any module.

---

## 1. System Vision & Core Paradigm
**Glissando Master Trajectory Studio** is a modular, browser-native continuous pitch & amplitude trajectory synthesizer inspired by **Max/MSP (`[gen~]` / `[mc.]`)** and **Vital's modulation routing**.

Instead of hardcoding synthesis into monolithic screens, the system operates as a **directed signal & control graph**:
1. **Generators & Curve Engines** produce normalized trajectories $y(t) \in \mathbb{R}$ over normalized time $t \in [0, 1]$.
2. **Mappers & Unit Converters** translate normalized trajectories into perceptual/physical domains (`Log Hz`, `Linear Hz`, `MIDI`, `Linear Amp`, `dBFS`, `Sone`).
3. **Gain & Loudness Bus** aggregates per-voice envelopes and psychoacoustic loudness scaling before master output.
4. **Audio & Export Engines** render real-time Web Audio (`AudioContext` + `PeriodicWave`) and offline 48kHz 16-bit PCM WAV files (with future Max/MSP `[jweb]`/`[buffer~]` parity).

---

## 2. Hard Architectural Rules (Non-Negotiable Invariants)

1. **Zero-Build Browser ES Modules Only:**
   - Must run directly via `<script type="module" src="./js/main.js"></script>` on a local static server (`python3 -m http.server` or VS Code Live Server).
   - **NEVER** introduce Node-only imports, CommonJS (`require`), bundlers (Webpack/Vite), or npm dependencies that break static browser loading.
   - Always include explicit `.js` file extensions in relative imports (e.g., `import { clamp } from './math-utils.js';`).
2. **Strict Unidirectional Dependency DAG (No Circular Imports):**
   - Dependencies may only flow downward:
     `main.js` → `ui/*` → `audio/*` → `generators/*` → `modules/*` → `core/*`
   - `core/*` and `modules/*` **MUST NEVER** import from `ui/*` or `audio/*`, nor access `document` / `window` DOM APIs directly.
3. **Reusability of `curve-engine.js`:**
   - The 11-engine curve evaluator (`evaluateCurve(curveConfig, tNorm)`) is domain-agnostic. It MUST remain decoupled from pitch so it can drive **Pitch Trajectories**, **Amplitude Envelopes (`[function]`)**, **Multi-Morph Nodes**, and future **Risset Tone / LFO modulators** identically.
4. **Single-Source State & Pub/Sub Dispatch:**
   - All mutations to `appState` should flow through `dispatch(opts)` in `js/core/state.js` so Undo/Redo history (`pushHistory()`) and scoped UI/Canvas re-renders stay synchronized.
5. **Bilingual Parity (`en` / `ko`):**
   - Any new user-facing UI label, button, or toast message must add keys to both `I18N.en` and `I18N.ko` in `js/core/i18n.js`.

---

## 3. Directory Structure & Module Boundaries

```text
~/Documents/flexatone/
├── ARCHITECTURE.md             # [THIS FILE] System blueprint, contracts, and agent rules
├── CHANGELOG.md                # Version log — one numbered entry per update (see §7)
├── index.html                  # [DONE] Pure HTML layout skeleton & DOM mount IDs
├── styles.css                  # [DONE] Custom scrollbars, range sliders, theme overrides
└── js/
    ├── main.js                 # Bootstrap, DOM event wiring, keyboard shortcuts, module routing
    ├── core/                   # Layer 0: Pure data, math, units, state (ZERO DOM/Audio deps)
    │   ├── i18n.js             # EN / KO translation dictionary & t(key, ...args)
    │   ├── math-utils.js       # Clamp, Fritsch-Carlson spline, Bezier solver, curve fitting
    │   ├── units.js            # Pitch (MIDI↔Hz↔Note) & Loudness (Amp ↔ dBFS ↔ Sone) converters
    │   └── state.js            # appState, Voice/Morph factories, Undo/Redo stack, dispatch()
    ├── modules/                # Layer 1: Vital/Max-style reusable signal/control blocks
    │   ├── curve-engine.js     # 11 mathematical + spline + multi-morph curve evaluator & schemas
    │   ├── timbre-synth.js     # 5-wave additive harmonics + f(x) DFT PeriodicWave generator
    │   └── gain-bus.js         # Per-voice envelope + master Amp/dB/Sone summing & normalization
    ├── generators/             # Layer 2: Multi-voice / spatial trajectory plugins
    │   ├── registry.js         # GeneratorRegistry (register, list, canvas overlay & voice-bake hooks)
    │   ├── risset-tone.js      # [PLANNED] Shepard-Risset continuous glissando / rhythm generator
    │   └── vector-field.js     # [PLANNED] 2D vector field (Vortex/Attractor/Curl) RK4 trajectory tracer
    ├── audio/                  # Layer 3: Web Audio playback, live scrub & WAV rendering
    │   └── audio-engine.js     # AudioContext scheduler, playhead loop, scrub nodes, 48kHz WAV export
    └── ui/                     # Layer 4: Canvas renderers & DOM control racks
        ├── canvases.js         # Main piano-roll/norm canvas (+ generator overlays) & gain canvas
        └── panels.js           # Voice cards (drag-reorder/multi-select), Matrix, Parameter/Timbre racks
```

---

## 4. Core Data Contracts & Interfaces

### 4.1 `Voice` State Object (`js/core/state.js`)
Every voice in `appState.voices` conforms to this schema:
```javascript
{
  id: 'v_xxxxxxx',
  name: 'Voice 1',
  color: '#38bdf8',
  solo: false,
  muted: false,
  startTime: 0.0,          // seconds >= 0
  duration: 2.5,           // seconds >= 0.05
  baseGain: 0.85,          // linear amplitude [0, 1.5]
  gainUnit: 'amp',         // 'amp' | 'db' | 'sone' (for Gain Bus integration)
  f0Midi: 48, f0Hz: 130.81, f0Fine: 0,
  f1Midi: 72, f1Hz: 523.25, f1Fine: 0,
  logScale: true,          // true = perceptual semitone/log Hz, false = linear Hz
  audioTarget: 'pos',      // 'pos' = f(t), 'vel' = normalized derivative f'(t)
  timbreMode: 'mix',       // 'mix' | 'func'
  timbre: { sine: 0.75, tri: 0.25, saw: 0.12, sqr: 0.05, rich: 0.20 },
  timbreFunc: { source: 'formula', expr: 'sin(2*pi*x) + 0.35*sin(6*pi*x)', voiceId: '' },
  engine: 'harmonic',      // 'harmonic' | 'damped' | 'anticipation' | 'ratchet' | 'chirp' | 'bounce' | 'bezier' | 'plateau' | 'polynomial' | 'morph' | 'custom'
  reverse: false,          // f(1 - t)
  inverse: false,          // 1 - f(t)
  customPoints: [{ x: 0, y: 0, handles: [] }, { x: 1, y: 1, handles: [] }],
  morphNodes: [ /* MorphNode objects */ ],
  gainMode: 'points',      // 'points' | 'engine'
  gainPoints: [{ x: 0, y: 0.9, handles: [] }, { x: 1, y: 0.9, handles: [] }],
  gainEngineObj: { /* CurveEngine config + ampMin, ampMax, autoFit */ }
}
```

### 4.2 Unit Conversion Contract (`js/core/units.js`)
- **Pitch:** `midiToFreq(m)`, `freqToMidi(hz)`, `midiToNoteName(m)`, `noteNameToMidi(str)`
- **Gain & Psychoacoustic Loudness:**
  - `ampToDb(amp)` / `dbToAmp(db)` ($20 \log_{10}(a)$, floor at `-96 dBFS`)
  - `ampToSone(amp)` / `soneToAmp(sone)` (Stevens' power law approximation calibrated so `0 dBFS` / reference SPL maps cleanly to `Sone` scale for perceptual multi-voice loudness balancing).

### 4.3 Generator Plugin Interface (`js/generators/registry.js`)
Any future multi-voice or spatial trajectory generator (`risset-tone.js`, `vector-field.js`) must register via `GeneratorRegistry.register(plugin)` using this exact contract:
```javascript
export const ExampleGeneratorPlugin = {
  id: 'risset-tone',               // unique slug
  name: { en: 'Risset Tone', ko: '리셋 톤' },
  schema: [ /* parameter definitions rendered automatically by panels.js */ ],
  defaultParams: () => ({ /* initial parameter values */ }),

  /**
   * Optional: Render visual guides directly onto mainCanvas before voice curves are drawn.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ viewport, timeToX, midiToY, m }} view
   * @param {object} params
   */
  renderOverlay(ctx, view, params) {},

  /**
   * Required: Generate/bake an array of standard Voice objects into appState.voices.
   * @param {object} params
   * @param {object} helpers - { createDefaultVoice, midiToFreq }
   * @returns {Array<Voice>}
   */
  generateVoices(params, helpers) { return []; }
};
```

---

## 5. Planned Extension Playbooks (For Future Claude Sessions)

### Playbook A: Adding Risset Tone / Shepard-Risset Generator (`js/generators/risset-tone.js`)
1. Create `js/generators/risset-tone.js` implementing `GeneratorPlugin`.
2. Parameters: `voiceCount` ($N \in [3, 16]$), `ratio` (default `2.0` octave, supports non-octave stretched ratios), `centerHz`, `bandwidthOct` ($\sigma$ for Gaussian spectral bell), `rateOctPerSec` (ascend/descend speed), `cycleDur`.
3. `generateVoices()` creates $N$ phase-staggered voices sharing the same slope and assigns each voice a Gaussian bell `gainEngineObj` or `gainPoints` so voices fade in smoothly from silence at the bottom edge and fade out at the top edge.
4. Register in `js/main.js` via `GeneratorRegistry.register(RissetTonePlugin)`.

### Playbook B: Adding Vector Field Trajectory Tracer (`js/generators/vector-field.js`)
1. Create `js/generators/vector-field.js` implementing `GeneratorPlugin`.
2. Define 2D velocity fields $\mathbf{V}(t, p) = (v_t, v_p)$ over normalized time-pitch space (presets: `Vortex`, `Attractor/Repeller`, `Curl Wave`, `Harmonic Shear`).
3. Implement `renderOverlay()` to draw directional arrows / streamlines on `mainCanvas`.
4. Implement RK4 numerical integration from user seed points $(t_0, F_0)$ to trace particle paths, downsample them into `customPoints` (`engine: 'custom'`), and emit `Voice` objects via `generateVoices()`.

### Playbook C: Unified Gain & Loudness Bus (`js/modules/gain-bus.js`)
1. Compute instantaneous voice gain `evaluateVoiceGain(voice, tNorm)` normalized across `amp`, `db`, or `sone` modes.
2. Provide `evaluateMasterBusGain(voices, absTimeSec, busConfig)` with optional perceptual loudness compensation ($1 / \sqrt{N}$ or Sone-summed normalization) so multi-voice textures (like 12-voice Risset tones) do not clip Web Audio or WAV exports.

---

## 5b. Terminology: Loudness Manager & Tempo Manager

- **Loudness Manager** = everything that controls level: amplitude / dB / sone (the output strip `ui/output-panel.js`,
  `audio/output-bus.js`, `modules/output-stage.js`, `modules/gain-bus.js`, `core/units.js`, per-instance `gainDb`).
  UI label (`out.title`): "Loudness Manager" / "라우드니스 매니저".
- **Tempo Manager** = everything that controls time, pitch-preserving: `core/tempo.js` (data contract: `{mode:'rate'|'bpm', rate, bpm, refBpm}`),
  `modules/tempo-manager.js` (document time scaling), master tempo `appState.manager.tempo`, per-instance `instance.tempo`.
  Effective rate = master × instance. **End goal:** the same tempo object / helpers on each studio's own transport
  (not wired yet — see `docs/STUDIO_INTEGRATION_LOG.md`).

### Instance / Track / Clip (Manager)

DAW (Ableton Live) conventions: an **Instance** is the data (a running copy of a Studio with its own document, `gainDb`,
tempo); the **Track** is the mixer / timeline strip it plays on (launch, mute / solo, fader, meter, tempo, tremolo); a **Clip**
is its placement `[start, start + length)` on the cycle timeline. UI text and docs say Track. Code identifiers still say
`channel` (`channelRates`, `channelPeakDb`, `activeChannelCount`, `mgr.channels` key, `manager-mixer.js` internals) — they were
not renamed; new code should say `track`. Not to be confused with audio channels (L/R, `numberOfChannels`, `mc~` signal channels),
which keep the word "channel".

### Warp (pitch-space curvature)

A Manager track with **Warp** on (`instance.warp`, `core/warp-config.js`) is silent; its lines bend the pitch space of other
tracks during its clip. Maths: `modules/pitch-warp.js` (monotone displacement tables). Per-studio sources:
`audio/warp-sources.js`. Targets get `pitchWarp(sec, hz)` next to `ampMask` in every renderer; Risset uses `frame.shift`.
Any new studio renderer must accept `pitchWarp` wherever it accepts `ampMask`. Log: `docs/STUDIO_INTEGRATION_LOG.md`.

### Engine naming: Curve / Studio / Audio

"Engine" alone is ambiguous; always say which one (UI text, docs, comments, new identifiers):

| Name | Meaning | Where | Code names (kept) |
|---|---|---|---|
| **Curve Engine** | the 14 curve types that shape y(t), t∈[0,1] | `modules/curve-engine.js` | `voice.engine`, `ENGINE_IDS`, `getEngineLabel`, i18n `engine.*` / `engineName.*` |
| **Studio Engine** | a studio's own algorithm (pure, no DOM / audio) | `studios/<id>/<id>-engine.js`, `risset-core.js` | `createRissetEngine`, `chaos-engine.js`, … |
| **Audio Engine** | whatever makes the sound: Glissando playback, or a studio's synthesis backend (AudioWorklet vs oscillators) | `audio/audio-engine.js`, `*-audio.js` | `risset.engineMode`, `wave.engineSel` |

Identifiers were not renamed (they are saved in project files and other studios are being edited in parallel);
in new code prefer `curveEngine…` / `studioEngine…` / `audioEngine…`.

### Sampler (per-voice sound files)

- A voice may play a region of a sound file instead of the additive wave: Glissando `voice.timbreMode = 'sample'` +
  `voice.timbreSample`; voice-based studios `voice.timbre.mode = 'sample'` + `voice.timbre.sample` (same spec,
  `modules/sample-source.js`). Tape model: playbackRate = f(t) / root. **Always per voice** — never offered where one timbre
  serves a whole studio (Cloud, Chaos, Fractal, Wave), never joined into Glissando legato chains.
  `spec.play = 'pitch'` (pitch only): granular shift (`renderGrainShift`) with the read pointer at `speed` × real time;
  the `SampleTone` records `frequency` / `detune` calls and renders when `stop()` gives the end time — so every source must
  call `stop()` after `start()` (open-ended sources pass `{ tape: true }` to `createToneSource`).
- Files: `core/sample-library.js` (mono PCM outside appState, content-hash ids, saved as `samples` in the project file),
  `audio/sample-voice.js` (`importSampleFile`, cached region AudioBuffers, `createToneSource` = drop-in for
  `createOscillator() + setPeriodicWave()`, `skipSampleRead` for mid-voice starts), `ui/sample-editor.js` (shared panel; the
  shared timbre editor shows it with `binding.sample: true`).
- A new voice-based renderer: create its source with `createToneSource(ctx, { sample, wave })` and call `skipSampleRead`
  when it starts inside a voice; code that only knows Mix / ƒ(x) reads `'sample'` as the Mix.

### Screenshot & Version

- **Screenshot** = the graph on screen saved as a PNG (research, scores, papers). `ui/screenshot.js` (`takeScreenshot`),
  rendering in `ui/canvases.js` (`renderMainScreenshot`). Mode `appState.screenshotMode`: `'full'` (as shown, minus editing aids)
  or `'clean'` (axes and lines only, white page); with `appState.screenshotSvg` the clean mode is saved as a vector SVG
  (`renderMainSvg`, same geometry as the clean PNG).
- **Version** = a restorable backup of the Glissando document (voices), made with every Screenshot; its thumbnail is the screenshot.
  `appState.versions`, `captureVersion` / `restoreVersion` / `toggleVersionGhost` / `removeVersion` / `clearVersions` in `core/state.js`.
  Not a preset and not the undo stack (`documentSnapshot` is internal undo only). Project files used the key `snapshots` before;
  `loadProjectData` still reads it as `versions`.
- Other studios: Screenshot saves the workspace's largest canvas as PNG; no Version is made.

---

## 6. Verification & Self-Check Protocol
Whenever Claude modifies or adds modules in `~/Documents/flexatone/`:
1. Run a local server in `~/Documents/flexatone`: `python3 -m http.server 8000`
2. Open `http://localhost:8000` with DevTools Console open and verify **zero** `SyntaxError`, `ReferenceError`, or `404` module errors.
3. Run `window.runSelfCheck()` in the browser console to validate core math, unit conversions (`MIDI↔Hz`, `Amp↔dB↔Sone`), all 11 curve boundary conditions, and `GeneratorRegistry` integrity.
4. Record the update in `CHANGELOG.md` (see §7).

---

## 7. Version Log — `CHANGELOG.md` (Mandatory) / 버전 로그 (필수)

**Every update must end with a new entry in `~/Documents/flexatone/CHANGELOG.md`. An update is not finished until it is logged.**
모든 업데이트는 `CHANGELOG.md`에 새 항목을 추가해야 끝난 것으로 본다.

1. **When:** after every change to code, styles, HTML, data contracts or docs in this folder — once the change is made and
   checked (§6), before reporting back to the user. One user request = one entry; small fixes in the same request share it.
2. **Where:** add the entry at the **top** of the entry list (newest first), directly under the `---` that follows "Rules".
3. **Version number** `0.MINOR.PATCH`, continuing from the newest entry:
   - `MINOR` +1 (PATCH → 0): new studio / feature / shared module, or any change to a saved data contract (project file, `appState` schema).
   - `PATCH` +1: bug fix, UI / text tweak, refactor, performance, docs only.
4. **Content:** follow the entry format in `CHANGELOG.md` — Added / Changed / Fixed / Removed, Files, Data (schema changes and
   migration, or "none"), Checks (`runSelfCheck()` result, what was verified and what was **not**), Backup (`.backup/<folder>`
   if made), Details (link to the `docs/STUDIO_INTEGRATION_LOG.md` section if one was written). Write EN / KO as in the rest of the docs.
5. **Honesty:** log failing checks and unverified parts as they are; never log a change that was not actually made.
6. **Parallel sessions:** other sessions may edit this folder at the same time. Re-read the top of `CHANGELOG.md` right before
   writing, take the next free number, and never rewrite or renumber someone else's entry.
7. **Naming:** this log is the project's change history. It is not the in-app **Version** (Screenshot backup, §5b).
   `docs/STUDIO_INTEGRATION_LOG.md` stays the detailed record of conflicts and decisions; `CHANGELOG.md` is the short, numbered summary.