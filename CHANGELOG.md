# CHANGELOG — Flexatone 버전 로그

Every update to Flexatone is recorded here, newest first. / Flexatone의 모든 업데이트를 최신순으로 기록.

> Not to be confused with the in-app **Version** (a restorable Glissando backup made with each Screenshot, `appState.versions`).
> This file is the project's change history. / 앱 안의 **Version**(스크린샷과 함께 저장되는 복원용 백업)과는 별개인, 프로젝트 변경 이력 파일.

## Rules / 기록 규칙

- **Version number** `0.MINOR.PATCH` (prototype stage, `0.x`):
  - `MINOR` +1 — new studio, new feature, new shared module, or a change to a saved data contract (project file / `appState` schema).
  - `PATCH` +1 — bug fix, UI / text tweak, refactor, performance, docs only.
- One entry per update (one user request = one entry). Several small fixes in the same request share one entry.
- Entry format:

```markdown
## [0.MINOR.PATCH] — YYYY-MM-DD — Short title / 짧은 제목
- **Added / 추가:** …
- **Changed / 변경:** …
- **Fixed / 수정:** …
- **Removed / 제거:** …
- **Files / 파일:** `js/...`, `styles.css`, …
- **Data / 데이터:** schema or project-file changes and migration (or "none")
- **Checks / 점검:** `runSelfCheck()` result, what was clicked through, what was not verified
- **Backup / 백업:** `.backup/<folder>` if one was made
- **Details / 상세:** link to the section in `docs/STUDIO_INTEGRATION_LOG.md` when there is one
```

Leave out the lines that do not apply. Write what is true now, including failing checks and things not verified.

---

## [0.21.0] — 2026-11-23 — Manager Modulation: matrix · sidechain · triggers / 매니저 모듈레이션: 매트릭스 · 사이드체인 · 트리거
- **Added / 추가:** **⇆ Modulation** card in the Manager (under Interpolate). One route = a signal of one track → a parameter
  of another track, in cycle time; routes on the same parameter add up. / 한 트랙의 신호 → 다른 트랙의 파라미터.
  - **From / 출처:** *Pitch line* (one of the track's lines or their mean, 0…1 between its lowest and highest pitch),
    *Loudness (sidechain)* (its clip as heard, −60…0 dB → 0…1, attack / release follower), *Triggers* (line onsets,
    a line crossing its centre, loudness peaks above a threshold) as an attack / decay pulse.
  - **To / 대상:** Level (dB), Tremolo depth, Brightness, Pitch (st), **Retrigger** (every trigger restarts the clip),
    Cloud density / width / collapse / centre (× the curve's range; flat curve: density × its value, width / centre
    ±12 st, collapse ±1).
  - Amount, invert, attack / release, a preview of the signal over the cycle (trigger ticks), on / off, ▲ ▼, ×.
    Quick buttons: + Modulate, + Sidechain duck, + Retrigger.
  - Loops: a route that would make tracks follow each other's sound (envelope / peaks) is not applied ("⟲ loop"); the
    earlier route in the list wins. Pitch lines and onsets read documents and never loop.
- **How / 방식:** evaluated at render time and folded into each track's Warp hooks (pitch / level / tremolo /
  brightness), so rendered clips, live Risset, cycle WAV and video hear the same thing. Source envelopes are rendered
  once (22.05 kHz, 10 ms RMS) and awaited before Play / export; until ready a route reads 0 and the target re-renders
  when it arrives. Cloud curves are rewritten in the clip's params before rendering. Retrigger rewrites the clip buffer.
- **Files / 파일:** `js/core/mod-config.js` (new), `js/core/manager-mods.js` (new), `js/audio/mod-sources.js` (new),
  `js/ui/manager-mods.js` (new), `js/audio/manager-mixer.js` (`warpOf` + `withMatrix`, `timeOf` without matrix,
  `renderPass` Cloud doc mods, `retriggerBuffer`, `plainLength`, envelopes before Play / export), `js/core/state.js`,
  `js/ui/manager-panel.js` (card host), `styles.css`
- **Data / 데이터:** `manager.mods = [{ id, on, src: { inst, kind, line, trig, thrDb }, dst: { inst, param }, amount, invert,
  attackMs, releaseMs }]` — saved, undoable, normalised on load (routes to missing tracks dropped). Old projects: none.
- **Checks / 점검:** `runSelfCheck()` 162 / 162 (new: statuses — self, loop through 2 and 3 tracks, retrigger forces a
  trigger source; pulse, follower, peaks, crossings). On `manager_10_launch_garden.json`, rendered with `exportCycleWav`:
  sidechain (Glissando envelope → Tempo track −12 dB): level difference vs −12 × envelope, median error 0.01 dB, 90 % 0.12 dB
  over 560 windows; trigger pulse −20 dB, release 200 ms: −19.2 dB at the hit, −7.4 dB at 200 ms (expected −7.4); Retrigger
  (32 Glissando onsets): every restart identical (correlation 1.0), clip before the first trigger unchanged (1.0); pitch
  route reaches the pitch hook; Cloud density follows the Glissando line (30 → 56.8 ev/s, grains 928 → 1458). Card: quick
  buttons by click, loop status, undo, autosave reload, live cycle playback with routes — no console errors.
  **Not verified:** by ear; video export; Risset as an envelope source in live play; very long cycles (envelope renders ≤ 180 s).
- **Fixed during the work / 작업 중 수정:** a flat Cloud curve (lo = hi) got no modulation (span 0).
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Manager Modulation (A2 · A3 · A4)"

## [0.18.1] — 2026-11-23 — Split layout: window : toolboxes ≈ 2 : 1 / 분할 레이아웃 비율 2:1
- **Changed / 변경:** The default width of the window column is now ⅔ of the workspace (was 58 %), so window : toolboxes ≈ 2 : 1. A width you set by dragging the column line is kept; double-click the line to go back to the new default.
- **Files / 파일:** `js/ui/rack-layout.js`
- **Data / 데이터:** none
- **Checks / 점검:** 1440×900: window 929 px, toolbox column 465 px (Risset, Glissando).

## [0.19.1] — 2026-11-23 — Interpolate: "Everything" is the default / 보간 기본값 = 전체 변수
- **Added / 추가:** Interpolate method **Everything** (first button, the default): every variable moves from the left state to the right state, not only the pitch.
  - Pitch lines are joined by the same Hermite curves as Pitch glide.
  - Each join is two voices on that curve: layer A with all settings of the left line (a Glissando voice is cloned whole; a Field particle lends level, gain unit, timbre and tremolo), layer B with those of the right line. A fades in a straight line from the left line's envelope value to 0, B from 0 to the right line's. Both start in step on the same curve, so level and wave mix pass through the values in between.
  - Layer A sits on a new Glissando track with the left source track's fader, tremolo, mute / solo; layer B on one with the right source's — track settings cross over too.
  - Tracks without pitch lines (Risset, block studios), and every track when one side has no line, are dissolved with takes, so the method never fails for lack of lines.
  - 음고뿐 아니라 음량·음색·트레몰로·트랙 설정까지 모두 옮기는 **전체** 방법을 기본값으로 추가. 음고 선이 없는 트랙은 디졸브.
- **Changed / 변경:** Pitch glide and Dissolve remain as buttons 2 and 3. Join tracks now copy the source track's tremolo.
- **Files / 파일:** `js/core/manager-interpolate.js`, `js/ui/manager-panel.js`
- **Data / 데이터:** none (log method `ip-all`).
- **Checks / 점검:** `runSelfCheck()` 161 / 161 (1 new). Clicked through on port 8011: Glissando → Field with a Risset track in the left range gave 2 join tracks (layers A: sine timbre fading 0.9 → 0, layers B: Field timbre 0 → 0.9) + 1 Risset take; cycle WAV export renders; all three non-silent. **Not verified:** by ear; that the two layers really stay phase-locked in the renderer (assumed from equal start time and curve); clip-studio line sources.
- **Known limits / 한계:** only settings a Glissando voice has are carried numerically or by layer; parameters of other engines (Risset field, Field physics, clip studios) cross over as sound (dissolve), not as parameter values. Envelope values are read for plain Glissando voices only; other sources start / end at 0.9.

## [0.19.0] — 2026-11-23 — Manager Interpolate tool / 매니저 보간 도구
- **Added / 추가:**
  - **Interpolate (Manager card under Extend):** pick a range on each side (made with Select range); the part between them is filled with a smooth transformation from the left state to the right state. Two methods:
    - **Pitch glide** — every pitch line sounding in the left range is joined to a line in the right range by a cubic Hermite curve in semitones (pitch and slope match at both edges; low pairs with low, unequal counts split / merge; at most 24 joins). The joins are voices of new Glissando tracks, one per source track on the left side; a Glissando source lends its voice's timbre.
    - **Dissolve** — for any track: a looped take of the left window carries on and leaves in the second half of the gap; a looped take of the right window, ending exactly on the right range, enters in the first half.
    - Uses the checked tracks (none checked = all). Adds tracks and one range `⇝ n` that mutes what the joined tracks had inside the gap. One undo step; **Remove last** takes it out (same log as Extend).
  - 양옆 구간을 고르면 그 사이를 매끄럽게 변형해 채우는 **보간** 카드 (음고 글라이드 / 디졸브).
  - `take.off`: a take can begin inside its clip (seconds trimmed from the start of the played take).
- **Files / 파일:** `js/core/manager-interpolate.js` (new), `js/core/take-config.js`, `js/audio/manager-mixer.js`, `js/ui/manager-panel.js`, `flexatone_architecture_agent_guide.md`, `docs/STUDIO_INTEGRATION_LOG.md`
- **Data / 데이터:** `take.off` (default 0; older projects load unchanged). Interpolations are logged in `manager.extensions` with `method: 'ip-glide' | 'ip-fade'`, `prev` = the cycle settings at that moment, `froze: []`.
- **Checks / 점검:** `runSelfCheck()` 160 / 160 (2 new: Hermite glide + pairing, dissolve placement). Clicked through on port 8011 with Glissando → Field: glide (1 track, 2 joins, lines meet in the Master View), dissolve on top (2 takes), Remove last, cycle WAV export renders, take levels non-silent. **Not verified:** listening by ear; Risset / clip-studio sources; project save / load round trip with `take.off`; behaviour with a Warp track over the gap.
- **Known limits / 한계:** glide reads the *heard* (already warped) pitch, and the new Glissando track is bent again by any Warp track that covers the gap. Dissolve has both sounds at full level around the middle (track fades are capped at half the clip and 10 s), up to +3 dB. Glide tracks play at one flat level (0.9 × the voice gain), not the level of the lines they join.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Manager Interpolate tool"

## [0.18.0] — 2026-11-23 — Split layout, resizable blocks, Manager UX, shortcut list, Risset voice modulation · regions / 분할 레이아웃·크기 조절·매니저·단축키·리세 보이스 변조·영역
- **Added / 추가:**
  - **Split layout (every studio):**
    - The window (the studio's main canvas, plus the Glissando gain envelope) stays on the left and follows the page.
    - Every toolbox is in the right column. A jump bar on top scrolls to a toolbox and opens it if folded.
    - Above the window only the header (transport / file) and the output line remain.
    - Drag the line between the columns to change the window width.
    - Portrait mode or a window narrower than 900 px keeps the old one-column flow.
    - Nothing moves in the DOM: wrappers become `display: contents`, windows `position: fixed`, toolboxes get a CSS `order`.
  - **Resize handle ◢ on every block:**
    - A toolbox gets a width and height and scrolls inside. A window changes its canvas height and the column width.
    - Works for Manager cards too. Double-click = natural size. "Default layout" resets.
  - **Manager cards** (master view, timeline, extend, ranges, channels) can be floated, folded, pinned and resized like studio toolboxes. Remembered under the scope `manager`.
  - **Keyboard shortcut list:** the ⌨ button next to Help, or the `?` key (`ui/shortcut-help.js`).
  - **Output line folds** with a double-click (title + meter stay).
  - **Advanced randomizer** for the per-voice tremolo / vibrato (shared block, every studio, Risset included):
    - A checkbox, folded by default.
    - Separate rate / depth / phase spreads.
    - Distribution: even, centred (u³) or two groups.
    - Slow rate drift.
    - Band follow as an editable envelope over the frequency band.
    - Off = exactly the previous model (renders match sample for sample).
  - **Risset window:** each dot's brightness shows its voice tremolo and its position shows its vibrato (shown at least ±5 px at full depth).
  - **Risset regions:**
    - S / M per region module.
    - Range sliders appear only while the region is on; rotation sliders only while spatial rotation is on.
    - The harmonic offset grid can be set per region.
- **Changed / 변경:**
  - Manager opens full screen by default (size key `flexatone.mgrSize.v2`).
  - Clicking its name "⧉ Manager" closes it.
  - A click on the studio behind it (or a studio tab) closes it too. Not in Half mode, where the studio is meant to be used beside it.
  - The fold caret sits in the block's left padding again, so titles stay on the left as before.
  - Risset uses the shared voice tremolo · vibrato block.
  - Risset default order: harmonic offset grid above interaction dynamics.
  - In region scope the toolboxes that act on the one voice bank are marked 🌐 shared.
- **Fixed / 수정:** In Risset region scope an in-place grid edit could change the shared grid; it is now copied into the region first.
- **Files / 파일:**
  - New: `js/ui/shortcut-help.js`.
  - Changed: `js/ui/rack-layout.js`, `js/ui/voice-mod-rack.js`, `js/core/voice-mod.js`, `js/studios/risset/risset-voicebank.js`, `js/studios/wave/wave-bank.js`, `js/studios/risset/risset-core.js`, `js/studios/risset/space-regions.js`, `js/studios/risset/risset-panels.js`, `js/ui/manager-panel.js`, `js/ui/output-panel.js`, `js/main.js`, `js/core/i18n.js`, `index.html`, `styles.css`.
- **Data / 데이터:**
  - `voiceMod.adv`, plus per lane `rateSpread`, `depthSpread`, `phaseSpread`, `dist`, `drift`, `env`.
  - Risset `region.solo` / `region.mute`, and region `own` grid keys.
  - All optional; older projects load unchanged.
  - View preferences: `flexatone.winCol.v1`, `flexatone.outFolded.v1`, rack view `size` / `ch`.
- **Checks / 점검:**
  - `runSelfCheck()` 158/158.
  - Advanced off ≡ previous render (max diff 0).
  - Region solo = only that region; mute all = silence.
  - An own grid changes only its region.
  - Split layout checked in all 10 studios at 1440×900.
  - Manager float / dock / close-on-click checked; toolbox and window resize checked; jump bar, output fold and `?` list checked.
  - Not listened to by ear.
  - The vibrato / tremolo dots follow the bank's formulas but not its exact phase.
- **Backup / 백업:** `.backup/2026-11-23-layout-split`

## [0.17.1] — 2026-11-23 — Ask to save before loading a project / 불러오기 전 저장 여부 확인
- **Changed / 변경:** 📂 Load now first asks "Save the current project first?" — Save, then load · Load without saving ·
  Cancel (Esc / click outside = Cancel) — when the current work has changes that are not in a saved project file; with no
  such changes the file picker opens at once, as before. If a slow save uses up the browser's click permission (a file
  picker may only open right after a click), the dialog turns into "Saved. Now choose the project or preset to load" with
  a Choose file… button instead of failing silently. The Cmd/Ctrl+R · F5 reload dialog now uses the same code
  (`openSaveFirstDialog`), unchanged for the user.
  / 📂 불러오기가 먼저 "현재 프로젝트를 먼저 저장할까요?"(저장 후 불러오기 · 저장하지 않고 불러오기 · 취소)를 띄움 — 저장된
  파일에 없는 변경이 있을 때만. 저장이 오래 걸려 클릭 권한이 끝나면 "파일 선택…" 버튼 단계로 바뀜. 새로고침 확인 창도 같은 코드 사용.
- **Files / 파일:** `js/ui/project-file.js` (`openSaveFirstDialog`, `askSaveBeforeLoad`), `js/main.js`, `js/core/i18n.js` (`loadAsk.*`)
- **Data / 데이터:** none
- **Checks / 점검:** `runSelfCheck()` 157 / 157 PASS. In the browser (port 8000, shared; the native file window replaced by a
  click counter, `showSaveFilePicker` by a stand-in): no changes → picker opens directly; after an edit, a real click on
  Load shows the dialog; Cancel and Esc close it without the picker; Load without saving opens the picker; Save, then load
  saves (unsaved flag cleared) and opens the picker; a 6 s save expires the click permission and shows the Choose file…
  step, whose button opens the picker; Cmd+R still shows "Reload Flexatone?" with its three buttons; no console errors.
  **Not verified:** the real OS save / open windows; Safari / Firefox (they download on save and lack
  `navigator.userActivation` in some versions — then the picker is tried directly).
- **Backup / 백업:** `.backup/2026-11-23-load-save-first`

## [0.17.0] — 2026-11-23 — Extend: settings retrograde / 연장: 설정 역행
- **Added / 추가:** Extend method **Retrograde (settings) / 역행 (설정)** ◁. It is placed like the retrograde (mirrored about the cycle end, fades swapped, reflecting again past ×1). Each reflected clip is rendered again with its *score* mirrored in time instead of its audio reversed. Pitch curves, gain envelopes, entries and exits, automation, shape masks, range solo / mute and Warps run backwards. Oscillators, samples, grains, filters and reverb still play forwards, so an attack stays an attack. Risset plays its control frames last-first with the glide velocity negated. Wave's spectral bank reads its amplitude matrix backwards. Every other studio's offline render is recorded and its Web Audio automation / start / stop rescheduled reflected (`audio/time-mirror.js`).
- **Changed / 변경:** The old method is now labelled **Retrograde (tape) / 역행 (테이프)**. A take's button cycles forwards → tape → settings → forwards (◀ / ◁). Takes have a new `mirror` flag.
- **Limits / 한계:** A take of a take, a clip with a Warp time drive, or a looping clip unrolled by a Warp falls back to the tape reversal. Oscillator phases are not reversed, so voices that converge in phase (Chaos at its start) are less coherent mirrored than forwards.
- **Files / 파일:** `js/audio/time-mirror.js` (new), `js/audio/manager-mixer.js`, `js/core/manager-extend.js`, `js/core/take-config.js`, `js/studios/risset/risset-audio.js`, `js/studios/wave/wave-audio.js`, `js/ui/manager-panel.js`, `js/core/i18n.js`
- **Data / 데이터:** `take.mirror` (boolean, default false). Older projects load unchanged.
- **Checks / 점검:**
  - `runSelfCheck()` 157/157, including the new time-mirror check.
  - Offline renders of all 10 studios went through the mirror. The envelope follows the reversed forward render in all of them.
  - A Glissando glide 48→72 with a fade-in comes back as 72→48 with a fade-out.
  - A mirror Extend on the open project rendered a symmetric cycle WAV and was removed again.
  - Not listened to by ear.

## [0.16.0] — 2026-11-23 — Voice tremolo · vibrato in every studio / 모든 스튜디오에 보이스 트레몰로·비브라토
- **Added / 추가:** the per-voice "Voice tremolo · vibrato" block (same model as Risset 0.15.0: own rate / depth / phase per voice from a seeded randomizer, Band follow ± octaves) in Glissando, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal and Wave. It sits above each studio's output tremolo (shared rack `ui/voice-mod-rack.js`, added through `ui/studio-tremolo.js`; Glissando under its voice tremolo). Stored as `voiceMod` in each studio's document (Glissando: studio params).
  / 글리산도·필드·드로잉·클라우드·스페이스·템포·카오스·프랙탈·웨이브에 보이스별 트레몰로·비브라토 블록 추가 (리세와 같은 모델).
- **How it sounds / 동작:** curve studios multiply each voice's pitch and gain curves (resampled to ≥ 24 points per LFO cycle): `voiceModFreqCurve` / `voiceModGainCurve` / `voiceModCentsCurve` in `core/voice-mod.js`. Voice = Field particle, Draw stroke, Space source, Tempo voice, Chaos voice, Fractal voice, Cloud grain, Wave ridge track / spectral bin (group), Glissando legato chain. Chaos and Cloud put the vibrato on `detune` (Chaos map-mode note events unchanged). Wave's worklet / offline spectral bank (`wave-bank.js`) modulates every bin per 128-sample block. Same sound live, in WAV export and in Manager renders (Glissando passes `doc.params.voiceMod`).
- **Fixed / 수정:** Space and Wave normalizers now keep `voiceMod` (it was dropped on edit).
- **Files / 파일:** `js/core/voice-mod.js`, `js/ui/voice-mod-rack.js` (new), `js/ui/studio-tremolo.js`, `js/ui/tremolo-panel.js`, `js/audio/audio-engine.js`, `js/audio/manager-mixer.js`, `js/studios/{field,draw,space,tempo,chaos,fractal,cloud,wave}/*-audio.js`, `js/studios/wave/wave-bank.js`, `js/studios/wave/wave-engine.js`, `js/studios/space/space-engine.js`
- **Data / 데이터:** optional `voiceMod` in every studio document (defaults off); old projects unchanged. Wave render key includes it.
- **Checks / 점검:** `runSelfCheck()` 156/156 PASS. Offline renders of each studio's current document with voiceMod off vs on (tremolo 0.9, vibrato 80 ¢) differ in all ten (relative |Δ| 0.9–1.3; Wave worklet bank and oscillator engine both), the block appears in all nine studios, the edit is kept in all of them. Not verified: by ear, live playback of every studio, Korean text on screen.

## [0.15.0] — 2026-11-23 — Manager UX, slider reset, fold / pin blocks, Risset voice tremolo · vibrato, Risset region scope / 매니저 UX·슬라이더 기본값·블록 접기·고정·리세 보이스 트레몰로·비브라토·리세 영역 범위
- **Added / 추가 (Manager):** Output row = the Loudness Manager strip (Amp / dB / Sone Lock, final fader, meter) moved into the Manager while it is open; track fader unit dB ⇄ sone (loudness ratio, ×2 per +10 dB). One "＋ Add studio ▾" button with a studio menu (was one button per studio). Window size Window / Half (docked right, the studio moves aside and stays usable) / Full, plus drag of the left edge (double-click = default width), saved in localStorage. Track checkbox left of the colour + select-all box: the shared selection; Extend uses only the checked tracks (none = all). A checked Warp track keeps its bend in the extension, an unchecked one is left out (`take.warps`); only Warp tracks checked → every sounding track extended with just those bends. Take clips that carry a bend show ⌇.
  / 매니저: 출력(라우드니스 매니저) 행, 트랙 페이더 dB⇄sone, "스튜디오 추가 ▾" 메뉴, 창·절반·전체 크기와 가장자리 드래그, 트랙 체크박스(공용 선택, 연장은 체크된 트랙만, 곡률은 체크된 것만 유지).
- **Changed / 변경 (Manager):** Space plays / stops the Manager cycle while the Manager is open. New tracks (and Extend tracks) get a colour no other track has (studio colour first, then the farthest hue).
- **Fixed / 수정 (Manager):** editing a track no longer jumps the Manager back to the top (scroll position kept across re-renders).
- **Added / 추가 (all studios):** double-click any slider → its default (`ui/slider-reset.js`: builders register a default, or it is read from the studio's default document; Manager sliders use `data-default`; the output fader keeps its own double-click). Every block (rack): click its title row to fold / unfold; 📌 in the grip pins it under the header while the page scrolls (several pinned blocks of a column stack); both remembered per studio in localStorage, cleared by "Default layout".
  / 모든 스튜디오: 슬라이더 더블클릭 = 기본값, 블록 제목 클릭 = 접기, 📌 = 화면 고정.
- **Added / 추가 (Risset):** "Voice tremolo · vibrato" — tremolo and vibrato computed per voice inside the voice bank (worklet + offline), each voice with its own rate / depth / phase from a seeded randomizer (Randomize 0…1, 🎲 new seed), and *Band follow* (± octaves): the rate follows the voice's place in the frequency band. A looping (time) automation cannot do this — at one moment every voice is at a different place in the band — so it is a parameter of its own. New shared object `core/voice-mod.js` (`voiceMod`). Not in the oscillator fallback engine.
  / 리세: 보이스별 트레몰로·비브라토(시드 랜덤화, 대역 추종). 루핑 오토메이션으로는 대역 추종 불가 → 별도 매개변수.
- **Added / 추가 (Risset):** region scope — with 2+ region modules every toolbox acts on the selected region (banner "M2 …", 🌐 Edit all regions). A region can own voice count, envelope (on / shape / c / σ / skew / γ) and trajectory shape (`region.own`); the Core "Glissando rate" is the region's own speed (`rateHz` / `linkRate`). The duplicate "own speed" slider of the region box is replaced by a note pointing to the Core rate (same value); "↺ Use global" clears the region's own values. Shared by all regions: pitch range, timbre / wave, color, local particles, dynamics, tremolo. A region with its own envelope puts the envelope into each point's gain (bank envelope off).
  / 리세: 영역 범위 — 영역 2개 이상이면 툴박스가 선택 영역에 작동(보이스 수·포락선·셰이프·속도), 중복 "자체 속도" 슬라이더는 코어 글리산도 속도로 정리.
- **Not done / 미완:** per-voice tremolo / vibrato in the other studios (their tremolo still acts on the whole output; Glissando and Field keep their per-voice tremolo). Per-slider help is done by the parallel "small icon button tooltips" session (`ui/param-help.js`), not here.
- **Files / 파일:** `js/ui/manager-panel.js`, `js/core/manager-extend.js`, `js/core/manager-state.js` (`distinctTrackColor`, `warpSourcesFor` filter), `js/core/take-config.js` (`warps`), `js/audio/manager-mixer.js` (`takeContext`, `getTrackWarp`), `js/main.js`, `js/ui/slider-reset.js` (new), `js/ui/studio-controls.js`, `js/ui/panels.js`, `js/ui/timbre-editor.js`, `js/ui/tremolo-panel.js`, `js/ui/output-panel.js`, `js/ui/rack-layout.js`, `js/studios/chaos/chaos-panels.js` (probe only), `js/core/voice-mod.js` (new), `js/studios/risset/risset-voicebank.js`, `risset-core.js`, `risset-panels.js`, `styles.css`
- **Data / 데이터:** Risset doc `voiceMod` (new, defaults off), `regions[i].own` (optional); Manager take `warps` (optional, null = all). Old projects load unchanged. View-only: localStorage `flexatone.mgrSize.v1`, `flexatone.rackView.v1`.
- **Checks / 점검:** `runSelfCheck()` 156/156 PASS. In the browser: add menu, checkboxes, scroll kept after Mute, Window / Half / Full (Half pads the studio by the panel width), Space starts / stops the cycle, 9 tracks → 9 different colours, Extend with checked tracks / checked Warp / unchecked Warp (take.warps as expected), slider double-click in Chaos / Cloud / Risset / Fractal / Glissando / Manager gain, fold and pin in Chaos (pinned canvas stays under the header at scroll 1430 px), Risset offline renders (tremolo in sync vs randomized, vibrato changes output), region scope edits (voices / rate / envelope go to M2, globals unchanged; engine plays M2 with its own 5 voices). Test edits were undone. Not verified: by ear, Korean texts on screen, the oscillator fallback, Safari / Firefox.
- **Backup / 백업:** `.backup/2026-11-23-manager-ux`

## [0.14.0] — 2026-11-23 — Cross-studio parity: edit while playing, play-from, Delete, shared segments, Cloud on the shared transport / 스튜디오 통일: 재생 중 편집·지정 위치 재생·Delete·세그먼트 공용화·Cloud 재생 통합
- **Added / 추가:**
  - Edit while playing in Field, Draw, Tempo and Fractal: an edit that changes the sound re-schedules from the playhead ~140 ms after the edits settle (cross-fade). One rule in `audio/live-transport.js` (`spec.editKey` + `soundKey(doc)`); view / selection edits and the studio output tremolo do not restart. Chaos, Space, Wave and Cloud keep their own, finer follow code. / Field·Draw·Tempo·Fractal에서 재생 중 편집이 플레이헤드부터 반영됨 (편집이 멈춘 뒤 약 140ms, 크로스페이드). 보기·선택 변경과 출력 트레몰로는 재시작하지 않음.
  - Shift + double-click on a studio timeline plays from there and leaves the cue where it is — in all eight workspace studios (`cueOrAudition` in `ui/locate-tool.js`); plain double-click still moves the cue. Fractal, Chaos, Cloud and Wave got `playFrom` in `ui/workspaces.js`. (Alt was not usable: Alt + click is the help inspector.) / 타임라인 Shift + 더블클릭 = 큐는 두고 그 자리부터 재생 (8개 스튜디오 공통).
  - Delete / Backspace deletes the selected object in Field (active particle), Tempo (active voice), Space (active source) and Draw (selected strokes) — one handler in `ui/studio-host.js` calling the workspace's `deleteSelection`, the same action as the ✕ button. Off while typing, while the Manager is open or a send window is open. / Delete·Backspace = 선택 대상 삭제 (Field 입자, Tempo 성부, Space 음원, Draw 획).
  - Field has the shared studio output tremolo rack (live and WAV / Manager render), next to its per-particle tremolo, which is unchanged. / Field에 공용 스튜디오 출력 트레몰로 랙 추가 (입자별 트레몰로는 그대로).
  - Fractal, Chaos, Cloud and Wave show the ✥ Locate / 🧲 Snap buttons switched off with the reason in the tooltip; Chaos and Wave show a switched-off ⤵ Receive button with the reason. / 이동·스냅 버튼(Fractal·Chaos·Cloud·Wave)과 받기 버튼(Chaos·Wave)을 꺼진 채로 이유와 함께 표시.
  - `createStudioControls().segment` — one segmented-button builder for Cloud, Chaos, Fractal, Tempo, Space and Wave. / 세그먼트 버튼 공용 빌더.
- **Changed / 변경:**
  - Cloud plays through `createLiveTransport` (its event player reports its nodes through `dynamicNodes`); a loop restart now cross-fades instead of cutting. The transport also waits for the new end when a timeline grows while playing. / Cloud가 공용 재생 모듈 사용. 재생 중 길이가 늘면 새 끝까지 재생.
  - Colour rules: segment default = sky (was violet in Cloud / Chaos / Fractal where no colour was named), slider default = the app accent (Fractal sliders were violet), select text = slate-200 everywhere. Segment rows wrap in narrow cards. / 색 규칙 통일: 세그먼트·슬라이더 기본색 = 하늘, 선택 상자 글자 = slate-200.
  - Keys typed in any studio select no longer bubble to other handlers (was Wave only). The global shortcuts already ignored selects, so this is a guard, not a visible change. / 모든 스튜디오 선택 상자에서 키 입력 전파 차단 (기존에도 전역 단축키는 선택 상자를 무시했음).
- **Fixed / 수정:** Cloud main canvas threw `x is not defined` on every frame while playing (the sounding-event highlight was never drawn); already present before 0.10.1. / Cloud 재생 중 매 프레임 렌더 오류 수정.
- **Not done / 하지 않은 것:** Locate for Fractal / Chaos / Cloud and trajectory Receive for Chaos / Wave — nothing there to move or replace, so the buttons explain it. Wave pulses / drivers were already draggable. Fractal and Wave have no "selected object", so Delete does nothing there. Glissando has no Shift + double-click audition. / Fractal·Chaos·Cloud의 이동 도구, Chaos·Wave의 받기는 적용 대상이 없어 사유 표시로 대체.
- **Files / 파일:** `js/audio/live-transport.js`, `js/ui/{studio-controls,studio-host,locate-tool,trajectory-ui,workspaces}.js`, `js/studios/{field,draw,tempo,fractal}/*-audio.js`, `js/studios/cloud/cloud-{audio,canvases,panels}.js`, `js/studios/{field,draw,tempo,space,chaos,fractal,wave}/*-panels.js`, `js/studios/*/*-canvases.js` (double-click line only)
- **Data / 데이터:** Field document may carry `tremolo` (studio output tremolo, optional; old projects load unchanged). / Field 문서에 선택 필드 `tremolo`.
- **Checks / 점검:** new project in the browser. Edit while playing: Field / Draw / Tempo / Fractal re-schedule on a sound edit, not on a view or tremolo edit. Shift + double-click plays from the clicked time with the cue unchanged in all 8 studios; plain double-click moves the cue (Cloud). Delete + undo in Field / Tempo / Draw; Space keeps its last source. Cloud: play, pause pins the cue, resume, stop, play-from, loop wrap, stop at the end, seed edit while playing, no render errors. Switched-off buttons present with tooltips. `runSelfCheck()` 155 / 156 — the failing one is "Risset A-1: voice bank is self-contained", in files this entry did not touch (another session is working on Risset). Not verified: by ear (cross-fades, Field output tremolo sound), Field WAV / Manager render with the tremolo on, Korean UI, real keyboard / mouse input (events were dispatched from script). In an autosaved test project with sends into Field, scripted Field edits were taken back — not investigated. / 새 프로젝트에서 스크립트로 확인. 귀로 듣는 확인, 한국어 UI, 실제 키보드·마우스 입력은 미확인.
- **Backup / 백업:** `.backup/2026-11-23-parity/before_parity.tgz`

## [0.13.0] — 2026-11-23 — Save As window + reload dialog / 다른 이름으로 저장 + 새로고침 확인 창
- **Added / 추가:** Cmd/Ctrl+R and F5 open an app dialog (Save and reload · Reload without saving · Cancel) when the document has changes not in the last saved/loaded file; with no such changes the browser reloads as usual. "Save and reload" runs the Save button (choose where to save), then reloads; cancelling the save window keeps the dialog open. The browser's own reload button and tab close cannot be caught (browsers do not allow a custom leave-page dialog), so those still rely on autosave.
  / 마지막 파일 저장·불러오기 이후 변경이 있을 때 Cmd/Ctrl+R·F5를 누르면 앱 확인 창(저장 후 새로고침 · 저장하지 않고 새로고침 · 취소) 표시. 변경이 없으면 그대로 새로고침. 브라우저 새로고침 버튼·탭 닫기는 브라우저 정책상 가로챌 수 없어 자동 저장에 맡김.
- **Changed / 변경:** Save opens a Save As window to choose the folder and file name in Chrome / Edge (`showSaveFilePicker`; the next save starts in the same folder); Safari / Firefox still download. Cancelling shows no toast. New skips its confirmation when there are no unsaved changes.
  / 저장 시 Chrome/Edge에서 폴더·파일 이름 선택 창 표시(다음 저장은 같은 폴더에서 시작), Safari/Firefox는 기존처럼 다운로드. 새로 버튼은 변경이 없으면 확인 없이 시작.
- **Files / 파일:** `js/ui/project-file.js` (new), `js/core/autosave.js` (`markFileSaved`, `hasUnsavedFileChanges`; baseline stored in IndexedDB key `fileBaseline`), `js/main.js`, `js/core/i18n.js`, `js/ui/help-entries.js`
- **Data / 데이터:** none in the project file. "Changed" compares voices, studio documents, versions and Manager with key order ignored; view settings (studio tab, zoom, viewport) do not count.
- **Checks / 점검:** `runSelfCheck()` 156/156 PASS. In the browser (save window stubbed): Cmd+R with changes → dialog; with none → normal reload; Esc and picker-cancel keep/close correctly; Save and reload → reloads, and the restored document counts as saved; undo back to the saved state counts as saved. Not verified: the real OS Save As window, Safari/Firefox download path, Korean dialog text on screen.

## [0.12.0] — 2026-11-23 — Trajectory Sends + Send / Receive order tool / 궤적 보내기 + 보내기·받기 순서 도구
- **Added / 추가:** **Send** — any studio's pitch line can be sent to another studio, or to **Master** (= every studio that can
  receive, except the source). Sources: Glissando voices, Field particles, Draw strokes, Cloud centre c(t), Chaos / Tempo /
  Fractal / Space / Wave baked lines, plus *Mean of all lines* when a studio has two or more. Receivers: Cloud, Tempo, Fractal,
  Draw, Field, Space and now **Glissando** (one voice written by the sends, ⤵ badge on its card). Each send has a mode:
  **Replace** (the receiving line becomes this line) or **Add** (its motion, pitch − first pitch, is added on top).
  Studio strips: ⤵ Receive + ⤴ Send + receive chip (Chaos and Wave: ⤴ Send). / 모든 스튜디오의 선을 다른 스튜디오나 마스터로 보내기.
- **Added / 추가:** **⇄ Sends** (header, left of Manager) — the order tool: a flow diagram (studios in columns by stage,
  arrows numbered by receive order; dashed = via Master, red = loop, grey = off), the receive order of every studio (▲ ▼,
  Replace / Add, on / off, × remove, ⊘ skip one studio of a Master send, 🔒 for Glissando sources; "overridden by a later
  Replace" shown) and the whole send list. / 흐름도 + 스튜디오별 받는 순서 + 전체 목록.
- **Rules / 규칙:** a studio is evaluated after every studio it receives from (A → B, A → C, B → C: C takes the B that already
  took A); inside one studio sends apply in list order; a send that would close a loop is refused (direct) or skipped for that
  studio (Master), the later one in the list is cut. A send writes only into the instance that was in the editor when it first
  received, and reads its source from the instance it was made from.
- **Changed / 변경:** "Import trajectory" is now ⤵ Receive (the same window, any source studio). Tempo has a third subject
  source, *Received line* (`subject.source = 'curve'`). Lock / guard of sent Glissando voices unchanged.
- **Files / 파일:** `js/studios/trajectory-link.js` (rewritten: sends, plan, evaluation), `js/studios/trajectory-targets.js`
  (Tempo curve, Glissando target), `js/audio/send-sources.js` (new), `js/ui/trajectory-ui.js` (rewritten), `js/ui/send-router.js`
  (new), `js/main.js`, `js/studios/tempo/tempo-engine.js`, `js/studios/tempo-studio.js`, `js/studios/tempo/tempo-i18n.js`,
  `js/studios/chaos/chaos-panels.js`, `js/studios/wave/wave-panels.js`, `styles.css`
- **Data / 데이터:** `studioParams._sends = { list: [{ id, from: { studio, line, name, inst }, to, mode, on, except, bound, locked, sig }] }`;
  receive record `studioParams[x].trajLink = { sends: [ids], sig, …line ids }`; Tempo `subject.curve`, `subject.curveLen`.
  Old projects: a `trajLink = { voiceId, locked }` becomes a locked Glissando → studio send on load, and the studio keeps what
  it shows (not re-imported until the voice changes).
- **Checks / 점검:** `runSelfCheck()` 156 / 156 (send checks: master expansion, loop cut, stages, inbound order, compose,
  Glissando → Cloud / Tempo / Fractal, chain Glissando → Cloud → Draw, Master incl. Glissando, undo = one step). In the browser
  on `manager_10_launch_garden.json`: Send window (Glissando → Cloud) by clicks; A → B, A → C, B → C (add) + Chaos → Master;
  order Chaos (1) → Glissando (2) → Cloud (3) → Fractal (4); ▼ reorder inside Fractal by click; voice +5 st → Cloud +5 and
  Fractal ends 39 → 43 (= A + contour of B, as expected); one undo reverts all three; Fractal → Cloud refused (loop
  Cloud → Fractal); lock guard dialog; old-project migration; autosave reload keeps the sends; no console errors.
  **Not verified:** by ear; Manager playback / video export of studios that receive; Field / Space / Wave as sources by click.
- **Backup / 백업:** `.backup/2026-11-23-sends`
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Trajectory Sends + order tool"

## [0.11.0] — 2026-11-23 — Sampler: pitch-only playback / 샘플러: 음높이만 재생
- **Added / 추가:** Per-voice Sampler **Playback: Tape | Pitch only**. Pitch only: the voice's pitch curve changes only the
  pitch; the file is read at **Speed ×** its own speed (0 = freeze at the region start, up to 4×), so a glide no longer
  shortens or stretches the sound. Granular shift (Hann grains, 50 % overlap, **Grain ms** 20–250, default 70) with a
  WSOLA-style alignment of every grain (±15 ms, coarse-to-fine search) — without it the overlapping grains pulled the pitch
  by ~2 % (440 Hz came out at 448.5 Hz). Works in every studio that has the Sampler (Glissando, Draw, Tempo, Space, Field)
  and in the Manager, with no change to the studios: the sample source records the `frequency` / `detune` calls and renders
  the grains when `stop()` sets the end time. Scrub audition stays Tape (open-ended).
  / 보이스별 샘플러에 **재생 방식: 테이프 | 음높이만** 추가. 음높이만: 음고 곡선은 음높이만 바꾸고 파일은 **속도 ×** 원래
  속도로 읽음(0 = 정지, 최대 4배). 그레인 시프트 + 그레인 정렬(WSOLA식). 샘플러가 있는 모든 스튜디오와 매니저에서 동작.
- **Files / 파일:** `js/modules/sample-source.js` (`renderGrainShift`, `sampleRegionKey`, spec fields), `js/audio/sample-voice.js`
  (recorded params, pitch-only `SampleTone`), `js/audio/audio-engine.js` (scrub stays tape), `js/ui/sample-editor.js`,
  `js/core/i18n.js`, `js/ui/help-entries.js`, `flexatone_tutorial.md`, `flexatone_architecture_agent_guide.md`
- **Data / 데이터:** sample spec gains `play: 'tape' | 'pitch'` (missing = `'tape'`, so 0.10.0 projects sound the same),
  `speed` (0–4, default 1), `grainMs` (20–250, default 70). Region buffers are now cached by `sampleRegionKey` (file, region,
  loop, fades, gain) so switching the play mode does not rebuild them.
- **Checks / 점검:** `runSelfCheck()` **154 / 154 PASS** (new: pitch-only octave up keeps the length, 440 Hz ± 6, even level,
  speed 0.5 doubles the length, speed 0 keeps sounding; offline pitch-only tone with a frequency curve ends at the region
  length; a second `stop()` does not throw). Grain renderer on test tones: 440.00 / 330.00 / 165.00 Hz exactly for ratios
  2 / 1.5 / 0.75, 277.09 Hz for 277.2 on a 5-harmonic tone, level steady within 1 %, ≈ 130 ms per 10 s of audio. In the
  browser (port 8000, shared): imported WAV → Sample → Pitch only clicked in the Glissando panel; 1.5 s one-shot under a
  C3→C5 glide ends at 1.497 s (Tape: 1.623 s); heard 137.1 / 273.4 Hz where the curve is 137.3 / 273.3 Hz; speed 0.5 lasts to
  the voice end; started at 0.6 s it still ends at ≈1.5 s and follows the curve (211.0 vs 211.1 Hz); live Play starts in
  17 ms, no console errors. Tempo (frequency + detune-cent curve path): pitch-only and tape give the same pitch (175 / 196 /
  175 Hz) and level. **Not verified:** by ear (grain artefacts on noisy or percussive files, best Grain ms per material);
  Draw / Space / Field in pitch-only mode (same code path as Glissando and Tempo, not rendered separately); main-thread cost
  for many long pitch-only voices at Play (≈ 13 ms per second of voice); Safari / Firefox.
- **Backup / 백업:** `.backup/2026-11-23-sampler-pitch`

## [0.10.2] — 2026-11-23 — Shared live transport for the studios / 스튜디오 공용 실시간 트랜스포트
- **Changed / 변경:** play / stop / pause-at-playhead / loop / playhead clock / end-of-timeline handling, which Field, Draw,
  Fractal, Chaos, Tempo, Space and Wave each carried as a copy (100–160 lines per studio), now live once in
  `audio/live-transport.js` (`createLiveTransport`, `fadeOutPass`). A studio only declares what a pass is (`plan`, `schedule`,
  `output`, level) plus its own extras as hooks: Tempo's look-ahead pulse pump, Chaos / Space / Wave re-scheduling while
  playing, Wave's worklet set-up, edge fades and node release. Exported names are unchanged (`startFieldAudio`, `toggleWavePause`, …).
  / 7개 스튜디오가 각자 복사해 갖고 있던 재생·정지·일시정지·루프·플레이헤드 코드를 `audio/live-transport.js` 하나로 통합. 스튜디오는 패스 내용과 고유 동작(훅)만 정의. export 이름은 그대로.
- **Changed (behaviour, small) / 동작 변화(작음):**
  - Re-scheduling while playing (loop restart, edit while playing in Chaos / Wave) now cross-fades the way Space already did:
    the old pass holds until the new one starts, then fades — before, the old pass faded at once and left a gap of about 20 ms.
    / 재생 중 재스케줄 시 Space와 같은 크로스페이드로 통일 (이전: 약 20 ms의 틈).
  - `startFractalAudio`, `startChaosAudio`, `startWaveAudio` accept `fromSec` like the other studios (nothing calls it yet).
    / Fractal·Chaos·Wave의 start도 fromSec을 받음 (아직 호출하는 곳은 없음).
- **Not changed / 그대로:** Cloud (event player with its own scheduler), Risset (`createRissetEngine`), Glissando (`audio-engine.js`), the Manager mixer.
- **Files / 파일:** `js/audio/live-transport.js` (new), `js/studios/{field,draw,fractal,chaos,tempo,space,wave}/*-audio.js`
- **Data / 데이터:** none
- **Checks / 점검:** `runSelfCheck()` 153/153 PASS, no console errors. In the browser (AudioContext running, state read back):
  all seven studios — play from cue, playhead advances, Pause pins the cue, resume from the cue, Stop clears the playhead;
  Field / Draw / Fractal / Chaos — play from a given second; Field — stops at the end without Loop, wraps to the cue with Loop;
  Chaos / Space / Wave — a slider edit while playing keeps playing from the playhead with the new bake (Space restart count +1,
  Wave stays on the worklet). Signal present on the output bus (Field 0.38, Tempo 0.17, Wave 0.44 peak; Space 0.01 in the
  first 4 s, same as the build before the change). Not verified: listening by ear (click-free cross-fade), Draw stroke audition,
  Tempo pulse timing, Locate-drop audition, Manager playback beyond the self-check.
  / 셀프체크 153/153. 7개 스튜디오의 재생·일시정지·정지, 끝 처리·루프(Field), 재생 중 편집(Chaos·Space·Wave)을 브라우저에서 상태값으로 확인. 귀로 듣는 확인, Draw 획 미리듣기, Tempo 펄스 타이밍, 이동 도구 재생은 미확인.
- **Backup / 백업:** `.backup/2026-11-23-transport/before_transport.tgz`

## [0.10.1] — 2026-11-23 — Cleanup / refactor pass (no feature change) / 정리 · 리팩토링 (기능 변화 없음)
- **Changed / 변경:** the slider + number box, toggle, select and labelled-row builders that eight studios each carried as a copy
  (Field, Draw, Chaos, Cloud, Tempo, Space, Fractal, Wave) now come from one module, `ui/studio-controls.js`
  (`createStudioControls`, `STUDIO_BTN`); canvas sizing (`sizeCanvas`, ten copies incl. Risset) comes from `ui/canvas-size.js`.
  Per-studio differences are kept as options (undo coalesce keys, select classes, Wave's narrow / compact sliders).
  / 8개 스튜디오가 각자 복사해 쓰던 슬라이더·토글·선택·라벨 행 생성 코드를 `ui/studio-controls.js` 하나로, 캔버스 크기 맞춤을 `ui/canvas-size.js` 하나로 통합. 스튜디오별 차이는 옵션으로 유지.
- **Removed / 제거:** 44 unused imports (mostly `computeAdditiveCoefficients`, `toPeriodicWaveArgs`, `TIMBRE_WAVES` left from the
  timbre unification); 43 exports that nothing referenced (e.g. `setBusConfig`, `tIn`, `sumSones`, `dbToSone`, `formatHz`,
  `formatTempo`, `scaleRange`, `resolveChannelRate`, `clipStudioMasks`, `lookupVoice`, `listenerFrame`, `destroyOutputPanel`);
  a few unused locals; the unused CSS rule `.mgr-select`. JS: 55,907 → 55,333 lines.
  Kept on purpose although unreferenced: diagnostics used from the console (`getWaveStreamStats`, `getWaveChunkCheck`,
  `lastWaveEngine`, `lastRissetEngine`, `getSpaceRestartCount`, `getLiveBake`, `getReferenceCount`, `clearWaveBakeCache`),
  `stopAudition`, `isAutosaveHealthy`, `onPlayheadTick`, the new sample-library exports, and the enums `SCOPES`, `TIMBRE_MODES`, `SCENE_LAYERS`.
  / 미사용 import 44개, 참조 없는 export 43개, 미사용 CSS 1개 제거. 콘솔 진단용 함수와 열거형 상수는 일부러 남김.
- **Files / 파일:** `js/ui/studio-controls.js` (new), `js/ui/canvas-size.js` (new), `js/studios/*/*-panels.js`, `js/studios/*/*-canvases.js`,
  `js/studios/*/*-audio.js` (imports only), `js/core/{units,math-utils,tempo,state,i18n,manager-state}.js`, `js/modules/*`, `js/audio/*`, `js/ui/*`, `js/main.js`, `styles.css`
- **Data / 데이터:** none
- **Checks / 점검:** `runSelfCheck()` 153/153 PASS; no console errors on load or while switching through all ten studios.
  Old vs new build compared with `.backup/2026-11-23-refactor/probe.html` + `probe.js`: the visible DOM of every studio
  (tags, classes, help keys, ranges, values) is identical apart from live read-outs (bake ms, Risset phase), canvas sizes are
  identical, and one slider edit + undo behaves the same in the eight studios. Not verified: live audio playback by ear
  (only imports / unused exports changed in audio files), the Manager and video export beyond the self-check, Korean UI.
  / 셀프체크 153/153, 콘솔 오류 없음, 리팩토링 전후 DOM·캔버스 크기·슬라이더/실행 취소 동일. 실제 소리 재생, 매니저·동영상 내보내기(셀프체크 외), 한국어 화면은 미확인.
- **Backup / 백업:** `.backup/2026-11-23-refactor/before_refactor.tgz`

## [0.10.0] — 2026-11-23 — Per-voice Sampler / 보이스별 샘플러
- **Added / 추가:** A third timbre mode, **Sample**, next to Mix and ƒ(x). A Sampler voice plays a region of a sound file
  instead of the additive wave; its pitch curve sets the playback speed like tape (rate = f(t) / root, one octave up = twice
  as fast). The setting is **per voice**: it is edited on the active voice only (Glissando Group Apply and Draw multi-select
  do not copy it), and in Glissando a Sampler voice never joins a legato chain. Panel: sound-file list + Load (or drop a
  file), waveform with a draggable region (drag edges, double-click = whole file), Root note with Detect (YIN), Loop region
  (equal-power loop crossfade), Fade ms, Gain dB. Starting playback in the middle of a voice skips what tape playback would
  already have read (corrected for the k-rate playbackRate). Files are mixed to mono, resampled to 48 kHz, cut at 60 s.
  / 믹스·ƒ(x) 옆에 세 번째 음색 모드 **샘플** 추가. 샘플러 보이스는 가산 파형 대신 사운드 파일의 구간을 재생하고, 음고 곡선이
  테이프처럼 재생 속도를 정함. 설정은 **보이스 단위**(활성 보이스만 편집, 그룹 적용·다중 선택으로 복사되지 않음, 글리산도
  레가토 체인에 들어가지 않음). 파형에서 구간 드래그, 루트 추정, 구간 반복(크로스페이드), 페이드, 게인.
- **Studios / 스튜디오:** Glissando (voice), Draw (stroke), Tempo (voice), Space (source; the Doppler frequency becomes the
  playback rate), Field (particle; its pitch-tracking low-pass opens 16× wider for samples). The Manager plays them through
  the same renderers. **Not offered** in Cloud, Chaos, Fractal, Wave (one studio-wide timbre — a Sampler there would apply to
  every voice) and Risset (no timbre editor). / 클라우드·카오스·프랙탈·웨이브(스튜디오 전체 음색)와 리세에는 제공하지 않음.
- **Files / 파일:** new `js/core/sample-library.js`, `js/modules/sample-source.js`, `js/audio/sample-voice.js`,
  `js/ui/sample-editor.js`; changed `js/modules/timbre-spec.js`, `js/ui/timbre-editor.js`, `js/core/state.js`,
  `js/core/autosave.js`, `js/audio/audio-engine.js`, `js/studios/{draw,tempo,space,field}/*-audio.js`,
  `js/studios/{draw,tempo,space,field}/*-panels.js`, `js/studios/trajectory-link.js`, `js/ui/panels.js`, `index.html`,
  `js/core/i18n.js`, `js/ui/help-entries.js`, `flexatone_architecture_agent_guide.md`, `flexatone_tutorial.md`
- **Data / 데이터:** Glissando voice: `timbreMode: 'sample'` + `timbreSample { id, root, t0, t1|null, loop: 'off'|'loop',
  xfadeMs, gainDb }`; studio voices: `timbre.mode: 'sample'` + `timbre.sample` (same object). Project file: new top-level
  `samples: [{ id, name, sampleRate, length, peak, pcm16 }]` (base64 16-bit mono) with only the files the project refers to.
  Autosave keeps the files under their own IndexedDB key (`samples`), written when the library changes, not with every
  project save. `PROJECT_VERSION` unchanged: old projects load as before; older builds read a sample voice as Mix.
- **Checks / 점검:** `runSelfCheck()` **153 / 153 PASS** (3 new: sample spec / region / loop crossfade / YIN / read offset;
  library 16-bit round trip and dedupe; offline render at rate 2 ends at half the length). In the browser (port 8000, shared
  with another chat): a WAV imported through the real file input, root detected as 57 (220 Hz test tone); region dragged on
  the waveform; one-shot ends at 1.044 s vs 1.045 s computed, loop lasts to the voice end; heard 219.2 Hz where the curve is
  220 Hz; playback started at 0.5 / 1.5 / 2.2 s matches the full render within 1 sample (correlation 0.9997–0.9999); a
  synth voice placed legato after a sample voice stays in its own chain and both sound; save → drop file → load restores
  it; refresh restores voice + file from autosave; Draw, Tempo, Space, Field render with a sample on their first voice (the
  other voices stay synth); the Sample tab shows in Glissando / Field / Draw / Space / Tempo only; Tempo: file choice,
  Undo, Redo, live Play with no console errors. **Not verified:** anything by ear; Safari / Firefox (AudioBufferSourceNode
  `detune` used by Tempo); very long or many files (memory, project size ≈ 128 KB per second of audio); Manager video export
  with sample voices; scrub audition of sample voices (implemented as a looping read, not tried).
- **Backup / 백업:** `.backup/2026-11-23-sampler`

## [0.9.0] — 2026-11-23 — New project button / 새 프로젝트 버튼
- **Added / 추가:** 📄 New button in the header (before Save). It asks for confirmation, then reloads into the default document (same path as `?new`), replacing the autosaved copy. Tooltip and help entry (`app.newProject`) in EN/KO.
  / 헤더에 📄 새로 버튼 추가(저장 앞). 확인 후 기본 문서로 다시 시작(`?new`와 같은 경로)하며 자동 저장본도 대체. 툴팁·도움말(`app.newProject`) EN/KO.
- **Files / 파일:** `index.html`, `js/main.js`, `js/core/i18n.js`, `js/ui/help-entries.js`
- **Data / 데이터:** none
- **Checks / 점검:** `runSelfCheck()` 150/150 PASS. In the browser: Cancel keeps the work; OK starts a default 1-voice project and the next refresh keeps it. Not verified: the Korean label on screen (key parity check passes).

## [0.8.0] — 2026-11-23 — Autosave & restore on refresh / 자동 저장 · 새로고침 복원
- **Added / 추가:** The current project is autosaved in the browser (IndexedDB, at most ~0.8 s after each change, plus a synchronous localStorage copy on `pagehide`) and restored automatically on the next load with the toast "Restored your last session." Open with `?new` to skip the restore once and start from the default document. A leave-page warning appears only when the browser refused to store the project (private mode, blocked storage, full quota).
  / 현재 프로젝트를 브라우저에 자동 저장(IndexedDB, 변경 후 최대 약 0.8초 + 페이지 이탈 시 localStorage 동기 저장)하고 다음 로드 시 자동 복원("이전 작업을 복원했습니다" 토스트). `?new`로 열면 복원을 한 번 건너뛰고 기본 문서로 시작. 저장이 불가능할 때만 이탈 경고 표시.
- **Files / 파일:** `js/core/autosave.js` (new), `js/main.js`, `js/core/i18n.js` (`toast.restored`)
- **Data / 데이터:** none — the stored object is the same as the "Save project" file (`serializeProject()`); undo history is not kept across a refresh. Stored per browser origin; with several tabs open, the last one to save wins.
- **Checks / 점검:** `runSelfCheck()` 150/150 PASS. In the browser: add voices → refresh → restored (3 voices, toast shown); add a voice and refresh immediately → restored via the unload copy; studio choice restored; `?new` starts fresh and drops the parameter. Not verified: Safari/Firefox, private mode (warning path), very large projects.

## [0.7.1] — 2026-11-23 — Curved grid: curved view vs Cartesian view / 곡률 격자: 곡률 보기 ↔ 직교 보기
- **Changed / 변경:** the Master View **⌇ Curved grid** toggle now switches the frame the notes are drawn in.
  On = curved view: notes are drawn as written and the grid bends instead — each curved semitone line marks where that heard
  pitch lies in the written space (W⁻¹(t, h)), so a note sounds the pitch of the line it sits on; orange/blue bands keep the
  meaning widened/narrowed. Off = Cartesian view: every note (targets, takes, Risset bands and live dots) is translated to the
  pitch it is heard at on a flat grid. Risset bands/dots are now bent by their track's Warp in the Cartesian view (before they
  were never bent). Shape select always uses the Cartesian view (masks act on heard pitch); the hover readout shows
  written → heard in the curved view. / 켜짐 = 음은 쓰인 그대로, 격자가 휨. 꺼짐 = 모든 음을 들리는 음고로 번역해 평평한 격자에.
- **Added / 추가:** Export video → Look → **View**: Cartesian (as heard) or Curved (as written); starts from the Master View's
  current toggle, then kept for the session. The curved-grid and inverse-warp caches now hold a few views so the live view
  and video frames don't rebuild each other. / 동영상 내보내기에 보기 선택 (직교·곡률) 추가.
- **Files / 파일:** `js/ui/manager-panel.js` (`warpInverse`, `warpGridImage`, `drawScene`, `masterCurvedView`),
  `js/ui/manager-video.js` (View option), `js/core/i18n.js` (help text, `mgrVid.view*`)
- **Data / 데이터:** none
- **Checks / 점검:** loaded `example/manager_07_warped_chorale.json`, toggled the grid on/off in the Master View; no console
  errors. Export video dialog preview checked in both views. Not verified: a full recording, the curved grid on the white
  background, folding warps (sensitivity > 1).

## [0.7.0] — 2026-11-23 — Manager Extend tools + takes / 매니저 연장 도구 + 테이크
- **Added / 추가:** **⤳ Extend** card in the Manager (under the timeline): pick one of five methods (buttons), pick how much
  (×¼ ×½ ×1 ×2 of the cycle, or seconds), press Extend; **Remove last extension** restores what was there. Every method states
  what it takes "musical" to mean (shown under the buttons) / 방법마다 "음악적임"의 정의가 다름:
  1. **◀ Retrograde** — symmetry and closure (palindrome A | A⁻¹). Every clip returns as a time-reversed take of the sound it
     made, mirrored about the cycle end; fades swap; more than ×1 keeps reflecting, less brings back only the last part.
  2. **⏦ Tape canon** (parameter interaction: rigid coupling) — speed, pitch, length, tremolo rate and fade times locked to one
     just ratio ρ, level −3 dB per octave of distance. ρ = the just ratio nearest to cycle ÷ amount (×2 → 1:2, ×1.5 → 2:3, ×½ → 2:1).
  3. **⇄ Role exchange** (compensation) — tracks ranked by how loud they sound (measured level + fader) pass their sounding
     level, fades and tremolo one rank up; the set of levels is unchanged, the quietest comes to the front.
  4. **↗ Tension arc** (co-variation in time) — entries in a geometric stretto (gap × 0.8) toward a climax at 0.618 of the
     extension, each louder (−9 → 0 dB), with a shorter fade-in, each round a just tape ratio higher (1 → 3:2 → 2:1); then
     last in, first out.
  5. **❖ Ritornello** (a formal criterion) — return and contrast: solo episodes (one track alone, +2 dB) alternate with a
     refrain (the opening seconds of the cycle, all tracks), about one pair per 10 s.
- **Added / 추가:** **Take** (`instance.take`, `core/take-config.js`): a track that plays a clip *as it sounded* at a place in
  the cycle (shape masks, range solo / mute, Warps, tremolo, tempo, loops), optionally reversed (◀ Retro badge on the track;
  click flips the direction), at a tape ratio (`rate`), or without the range rules (`raw`). Risset takes play from an offline
  render instead of the live engine. Master View draws takes mirrored / transposed. Takes of the same clip share one buffer.
  `mixer.measureClipLevels()` measures how loud each clip sounds before its fader.
- **Changed / 변경:** undo / redo now restores the mixer fields of a track it re-creates (redo of Duplicate used to lose
  start / gain), and carries the Extend log with its cycle length and pinned loop lengths.
- **Files / 파일:** `js/core/take-config.js` (new), `js/core/manager-extend.js` (new), `js/core/state.js`, `js/core/manager-state.js`,
  `js/audio/manager-mixer.js`, `js/ui/manager-panel.js`, `js/core/i18n.js`, `styles.css`, `flexatone_tutorial.md`,
  `docs/STUDIO_INTEGRATION_LOG.md`
- **Data / 데이터:** `instance.take { on, rev, as, at, len, loop, inner, rate, raw }`, `instance.ext`, `region.ext`,
  `manager.extensions[]` (`{ id, method, seconds, from, to, prev, froze: [{ id, length }] }`). Old projects load unchanged.
- **Checks / 점검:** `runSelfCheck()` 150 / 150 (3 new checks for the five methods). On presets 06–10: retrograde — rendered
  cycle against its own mirror image, correlation 1.0000, residual −75 … −112 dB at ×1 (a ×½ extension differs only by the
  30 ms fade at its cut edge); tape canon — extension = the original resampled by ρ (correlation 0.999–1.000, level −1.8 / −3.0 dB
  as defined); role exchange, tension arc (level rises to the original level at the climax, then falls), ritornello — rendered
  with no errors, peaks −3.7 … −6.5 dBFS. Undo / redo / Remove, save → load, live playback (Risset takes, tape-ratio takes) and
  the buttons in the panel tried in the browser, no console errors. **Not verified:** any of it by ear; video export of an
  extended cycle; very long extensions (memory: every take is a rendered buffer).
- **Backup / 백업:** `.backup/2026-11-23-extend`
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Manager Extend tools + takes"

## [0.6.1] — 2026-11-23 — Five 30–60 s Manager presets / 30–60초 매니저 프리셋 5개
- **Added / 추가:** `example/manager_06_convergence_canon.json` (40 s), `manager_07_warped_chorale.json` (36 s),
  `manager_08_doppler_weather.json` (45 s), `manager_09_bloom_and_collapse.json` (60 s, one shot),
  `manager_10_launch_garden.json` (32 s loop). Together they use all ten studios and the Manager controls: clip start /
  length / loop / fades, launch-only tracks, mute, range solo / mute, shape region, fixed cycle, master tempo (BPM, Tape +
  glide), instance tempo, track tremolo (rate sweep, beat sync), Warp tracks (Glissando lines, Cloud rules; pitch /
  brightness / tremolo; all tracks or chosen targets). / 10개 스튜디오와 매니저 제어를 고루 쓰는 프리셋 5개.
- **Changed / 변경:** `flexatone_tutorial.md` §13 lists the new presets.
- **Files / 파일:** `example/manager_06…10_*.json`, `flexatone_tutorial.md`
- **Data / 데이터:** none (project files only; no code change)
- **Checks / 점검:** each file loaded through `loadProjectData` + `ensureManager`, cycle lengths 40 / 36 / 45 / 60 / 32 s,
  `exportCycleWav` rendered every track and the mix with no console errors (mix peaks −3.7 … −6.5 dBFS); warps probed
  numerically (07: G3 → D3, G5 → D6 at 18 s; 09: 38…86 → about 60…64 by 55 s); range solo, Risset track tremolo and the shape
  mask measured in the render; live cycle playback started for all five. **Not verified:** the musical result by ear, video export.

## [0.6.0] — 2026-11-22 — Version log started / 버전 로그 시작
- **Added / 추가:** `CHANGELOG.md` (this file); rule in `flexatone_architecture_agent_guide.md` §7 to log every update here.
- **Data / 데이터:** none
- **Note / 비고:** Entries below 0.6.0 were reconstructed from `docs/STUDIO_INTEGRATION_LOG.md` and `.backup/`; their
  numbers were assigned afterwards. / 0.6.0 이전 항목은 통합 로그와 백업에서 재구성했으며 번호는 소급 부여.

## [0.5.0] — 2026-11-22 — Field vector-field layers + shared Locate tool / 필드 레이어 + 공용 이동 도구
- **Added / 추가:** Field layers on the absolute pitch × time plane (Main / Local, blend Add / Multiply / Replace, order);
  vector field ON/OFF; shared Locate / Snap controller (`ui/locate-tool.js`) for Field, Draw, Tempo, Space; play from the
  dragged object's start; shared icon-button tooltip (`ui/icon-tooltip.js`).
- **Files / 파일:** `js/studios/field/field-layers.js`, `js/ui/locate-tool.js`, `js/ui/icon-tooltip.js`, `audio/warp-sources.js`, `styles.css`
- **Data / 데이터:** old Field documents convert once on read (`migrateFieldDoc`).
- **Backup / 백업:** `.backup/2026-11-22-field-toggle`
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Field vector-field layers + shared Locate tool"

## [0.4.0] — 2026-11-22 — Manager video export / 매니저 동영상 내보내기
- **Added / 추가:** Master View "Export video" (MP4 or WebM, real-time, with the cycle mix; layers can be left out).
- **Files / 파일:** `js/ui/manager-video.js`, `js/ui/manager-panel.js`, `js/ui/manager-mixer.js`, `js/core/i18n.js`, `styles.css`
- **Backup / 백업:** `.backup/2026-11-22-playhead-video`

## [0.3.0] — 2026-11-22 — Manager Warp (pitch-space curvature tracks) / 매니저 곡률 트랙
- **Added / 추가:** ⌇ Warp on every Manager track (silent track whose lines bend other tracks' pitch space); `pitchWarp(sec, hz)`
  in every renderer; Curved grid in Master View.
- **Files / 파일:** `js/core/warp-config.js`, `js/modules/pitch-warp.js`, `js/audio/warp-sources.js`, renderers of all studios
- **Data / 데이터:** `instance.warp` (old projects get the default, off).
- **Checks / 점검:** warp self-checks pass; one unrelated failing check at the time ("Field studio: local regions modulate the field only inside").
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Manager Warp"

## [0.2.0] — 2026-11-22 — Cross-studio parity pass + Import trajectory / 스튜디오 간 기능 통일 + 궤적 불러오기
- **Changed / 변경:** timbre Mix | ƒ(x), cue / playhead look, wheel navigation, zoom bar, output tremolo, movable blocks,
  "＋ Studio" buttons unified through shared modules in all studios.
- **Added / 추가:** Import trajectory (Glissando → Cloud / Tempo / Fractal, then Draw / Field / Space).
- **Files / 파일:** `modules/timbre-spec.js`, `ui/timbre-editor.js`, `ui/transport-lines.js`, `ui/view-nav.js`,
  `ui/studio-tremolo.js`, `ui/rack-layout.js`, `studios/trajectory-targets.js`
- **Checks / 점검:** `runSelfCheck()` 140/140 after the import step.
- **Backup / 백업:** `.backup/before_unify_2026-11-22.tgz`
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Cross-studio parity pass", "Import trajectory"

## [0.1.0] — 2026-11-21 — Studios ported into Flexatone / 스튜디오 모듈화
- **Added / 추가:** Glissando plus the Risset, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave studios and the Manager,
  ported from single-file prototypes into ES modules.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` (per-studio sections)
