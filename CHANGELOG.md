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

## [0.58.0] — 2026-11-25 — Load adds to the current work (Add / Replace) / 불러오기가 현재 작업에 추가 (추가 / 교체)
- **Added / 추가:** the Load dialog now always opens (also for a file with one studio) and asks **Add to the current work** (default) or **Replace the current work**. Add puts the ticked studios of the file next to the current tracks as new tracks: the current tracks, Manager tempo / cycle, output settings, current studio and file name stay; the file's focused tracks keep their documents as stored track documents (a studio the current work does not have goes into the editor); the new tracks keep their Space Master sources and places (Space Master turns on if the file had it on); regions, Modulation routes, Scenes, Sends, studio tempo and automation lanes of the file are added; colours that are already in use are replaced by free ones; loading the same file twice gives the second copy new ids everywhere they are referenced (Warp targets, Mods, Scenes, regions, `trk_<id>` sources). The "Previous" button takes the work before the load back, as before.
  불러오기 창이 항상 열리고(스튜디오 하나인 파일도) **현재 작업에 추가**(기본) / **현재 작업 교체**를 묻습니다. 추가는 체크한 스튜디오를 현재 트랙 옆에 새 트랙으로 넣고 현재 트랙·매니저 템포·사이클·출력·현재 스튜디오·파일 이름은 그대로 둡니다. 새 트랙은 스페이스 마스터 위치를 유지하고, 같은 파일을 두 번 불러오면 새 id를 받습니다. '이전 작업' 버튼으로 되돌릴 수 있습니다.
- **Fixed / 수정:** loading only some studios of a file (Replace) no longer drops the project-wide `_` settings of the file (Space Master, Sends, studio tempo, automation, monitor → Space links). "Previous" now also removes the Space Master sources of tracks it takes away and gives restored tracks their old sources back.
  일부 스튜디오만 불러올 때 파일의 프로젝트 전체 설정(`_` 키)이 사라지던 문제 수정. '이전 작업'이 스페이스 마스터 음원도 트랙에 맞춰 되돌림.
- **Files / 파일:** `js/core/state.js` (`appendProjectStudios`, `filterProjectStudios`, `mergeProjectStudios`), `js/ui/project-file.js` (`askLoadStudios` `modes`), `js/main.js` (`onLoadFile`), `js/core/i18n.js`, `js/ui/help-entries.js` (`app.loadMode`).
- **Data / 데이터:** none (project file unchanged).
- **Checks / 점검:** `runSelfCheck()` 238 pass / 1 fail — new check "Load → Add" passes; the failing one is "Projection ↔ audio: Glissando path = rendered pitch" (audio, not touched here; other sessions had uncommitted changes in the folder). Clicked through in the browser: `example/islands_1.json` added onto a 35-track work → 48 tracks, unique ids, 6 Space Master spline paths kept, toast shown; added a second time → 61 tracks, 47 sources (renamed); Previous swaps back. Replace mode not clicked through (unchanged code path apart from the `_` key fix).

## [0.57.2] — 2026-11-25 — Presets Islands 7–9: mixes of parts of 4, 5 and 6 / 프리셋 Islands 7–9: 4·5·6의 부분을 섞은 작품
- **Added / 추가:** `example/islands_7.json`, `islands_8.json`, `islands_9.json` (3 min each), built from the layers of islands 4 · 5 · 6 (fragments, Space Master paths, tremolo, Warps, Modulation), cut into windows, moved in time and put together again. Track names start with their source (`4·`, `5·`, `6·`). The three fundamentals G# · C# · E make a C# minor chord. At most four layers sound clearly at once, at least two are audible.
  4·5·6의 레이어(조각·경로·트레몰로·곡률·모듈레이션)를 창으로 잘라 시간을 옮겨 다시 조합. 트랙 이름 앞이 출처. 기음 G#·C#·E = C#단3화음. 뚜렷한 레이어 최대 4개, 들리는 레이어 최소 2개.
  - **7 Collage:** sections of each source in its own time (4 → 5 → 6 → 4 → 5 → 6), handed over layer by layer (zigzag); finale from 142 s with layers of all three.
  - **8 Braid:** four strands (low, long, middle, fast), each switching between layers of 4, 5 and 6 at its own pace (7–46 s); cross-source Modulation (fast strands duck the long ones, the low strand brightens them); Warp events one at a time.
  - **9 Cut-up:** excerpts from anywhere in 4 · 5 · 6 moved in time, three overlapping chains (12 s → 2.5 s in every minute), a long sustained excerpt underneath now and then, Warp bursts / dives / lurches moved onto the cut points.
- **Changed / 변경:** `flexatone_tutorial.md` §13 — Islands 7 · 8 · 9.
- **Files / 파일:** `example/islands_7.json` … `islands_9.json` (new), `flexatone_tutorial.md`.
- **Data / 데이터:** none (existing project format); Risset and Field tracks muted and out of the cycle as in 1–6; output limiter on (−1 dBFS).
- **Checks / 점검:** all three load with `loadProjectData` in the built-in browser and render with `exportCycleWav` without errors; every Warp target, Modulation end and Space Master source points to an existing track. Mix (180 s, limiter on): RMS −19.7 / −17.2 / −18.1 dB, peaks 0.90 / 0.93 / 0.92, no clipped samples, quietest second −28.9 / −30.5 / −30.6 dB, quietest quarter-second −34 / −35 / −36 dB. A first build of 9 had a 0.5 s silence at 106 s: tape time Warps move a track's read position, which drifted into the gaps between moved excerpts — 9 has no time Warps now. Schedules (from the mixer, envelope ≥ 0.2 = audible, ≥ 0.5 = clear): never fewer than 2 audible; clearly sounding 3–4 layers 81 / 73 / 83 % of the time, 5 never (one 50 ms moment in 7 inherited from islands_4 has 0–1 clear layers). Share of the time each source sounds (4 / 5 / 6): 7 — 38 / 52 / 52 %, 8 — 64 / 84 / 82 %, 9 — 49 / 88 / 86 %. Not listened to.

## [0.57.1] — 2026-11-25 — Presets Islands 1–6: fading, layered sample pieces from 19–21 / 프리셋 Islands 1–6: 19–21에서 만든 페이드로 변하는 샘플 레이어 작품
- **Added / 추가:** `example/islands_1.json` … `islands_6.json` (3 min each). 1 · 2 · 3 are duplicates of `manager_19` · `20` · `21` (same fundamentals G#1 · C#1 · E1), rebuilt with the first minute of 20 as the reference: no range-solo cuts; every fragment is a Sampler voice (Glissando) or stroke (Draw) with its own fades; the additive-synth tracks (Risset, Grid, Chaos, Cloud, Fractal, Wave) are replaced by the user's sf-5 / sf-6 (three new samples: sf-5 whole, sf-6 112–120 s, sf-6 156–178 s). Layers in different bands, small level differences, different Space Master places (conical helix, 3-D Lissajous, trefoil knot, loxodrome, figure-eight, swoop, star polygon — height used); every fragment is moved earlier by its own extra travel time to the listener; Warp tracks drive brightness, pitch, time, level and tremolo.
  19·20·21의 복제본(같은 기음)을 20번 첫 1분을 기준으로 다시 짬: 구간 솔로 컷 없음, 조각마다 페이드가 있는 샘플러 보이스·획, 신스 트랙은 sf-5 / sf-6으로 대체. 레이어마다 다른 대역·약간 다른 레벨·다른 공간 경로(높이 포함), 조각마다 전달 지연만큼 앞당김, 곡률 트랙.
  - **1 Relay:** six layers, 2–6 s fragments in three zigzag streams — two or three sound at once, never one alone.
  - **2 Four answers:** A darts (short, fast, irregular tempo + Warp time), B long Risset-like space (sf-6 Shepard descent, EQ drift, tremolo that fades in and out), C phrases in fifths answering A, D swells; Modulation: A ducks C and B, C shakes D, D's pitch brightens B.
  - **3 Never still:** at most four layers; a Risset tone that keeps turning, curvy glissandi, Warp pitch lurches.
  - **4 · 5 · 6:** duplicates of 1 · 2 · 3 with 8 · 8 · 9 of ten "aggressive" ideas (sidechain pumping, retrigger stutter, fast close paths with sound ×0.3, time-warp jolts, square tremolo gating, density accelerando, dynamic contrast, brightness bursts, tape dives, spatial antiphony).
- **Changed / 변경:** `flexatone_tutorial.md` §13 — Islands table and the ten ideas.
- **Files / 파일:** `example/islands_1.json` … `islands_6.json` (new, 6.4–7.2 MB, 8 samples each), `flexatone_tutorial.md`.
- **Data / 데이터:** none (existing project format). Risset and Field tracks are present but muted and out of the cycle, because the Manager always creates them.
- **Output / 출력:** the presets switch on the output limiter (ceiling −1 dBFS) in `prefs.output`.
- **Checks / 점검:** all six load with `loadProjectData` in the built-in browser and render with `exportCycleWav` without errors. Mix (180 s, limiter on): RMS −18.5 / −19.0 / −19.1 / −20.0 / −20.9 / −20.6 dB, peaks 0.89–0.93, no clipped samples, quietest second −26…−31 dB (no gaps). Track levels calibrated by rendering each track alone (islands_1 re-measured: −24.0 … −27.0 dB as targeted); tracks whose peak would pass 0.9 were lowered (dart layer, close passes). Schedules (from the generator): islands_1 never fewer than 2 audible layers and never more than 3 clearly sounding; islands_2 3–4 layers 70 % of the time; islands_3 / 6 never more than 4. Warp A/B (islands_1 brightness Warp on / off): the target's brightness differs by ±1–1.5 dB per 15 s window. `runSelfCheck()` not run (no code changed). Not listened to. (H.264 + AAC MP4), saves reliably; Space Master video uses the Manager cycle / 동영상 내보내기를 오프라인 렌더로 (H.264 + AAC MP4), 확실한 저장, 스페이스 마스터 동영상은 매니저 사이클 사용
- **Fixed / 수정:** an exported MP4 had **no picture** and almost no sound (`Flexatone_space_1280x720_183.5s.mp4`: audio track only, 369 KB for 183 s). Causes: (1) real-time capture — when the tab is not in front, no frames are painted, so MediaRecorder wrote no video track; (2) in the Space Studio showing the Space Master the recording played the Space Studio's own transport, not the Manager cycle; (3) a plain `video/mp4` fallback can hold VP9 / Opus that QuickTime cannot show.
  캡처된 MP4에 영상이 없고 소리도 거의 없던 문제: 실시간 캡처가 백그라운드 탭에서 프레임을 못 받음, 스페이스 마스터인데 스튜디오 트랜스포트를 재생, 'video/mp4' 대체 시 VP9/Opus.
- **Changed / 변경:** new `js/ui/video-encode.js` — every frame is drawn for its own time and encoded with WebCodecs (H.264 High + AAC-LC; 16-bit PCM `.mov` if AAC is missing) into an MP4 written by the app (moov at the end, 64-bit offsets). Independent of the wall clock and of tab visibility (yields through a MessageChannel, not timers). The studio video (`ui/studio-video.js`) has **Method: Render (offline, default) / Live recording**; the Manager Master View video renders offline whenever WebCodecs exists (its spectrum strip stays empty there).
  프레임마다 그 시각을 그려 WebCodecs로 인코딩, 앱이 MP4를 직접 작성. 탭이 뒤에 있어도, 실시간이 아니어도 됨. 스튜디오 동영상: 방식 = 렌더(기본) / 실시간 녹화.
- **Changed / 변경:** Space Studio showing the Space Master: the video's sound is the Manager cycle (`exportCycleWav`, as tuned in the Manager) and the views follow its time from 0 for one cycle.
- **Fixed / 수정:** saving — the save window opens on the Record click (Chrome / Edge `showSaveFilePicker`, starts in Downloads) and the file is written there when the render ends; elsewhere a download as before. Before, a download fired minutes after the click could be lost.
- **Files / 파일:** `js/ui/video-encode.js` (new), `js/ui/studio-video.js`, `js/ui/manager-video.js`, `js/main.js` (`renderNow`), `js/core/i18n.js`.
- **Checks / 점검:** built-in browser: 4 s Glissando render (frames differ over time, AAC decodes); 5 s Space Master render (sound −25.8 dB RMS); 45 s Manager Master View render with the pane hidden (1350 frames). That file, probed with ffprobe: h264 High 1280×720 30 fps 1350 frames + AAC-LC 48 kHz stereo, full ffmpeg decode without errors, frame at 20 s correct. `runSelfCheck()` not re-run after this change. Not checked: QuickTime itself, Safari / Firefox (no WebCodecs H.264 → Live recording), 4K at 60 fps.

## [0.56.0] — 2026-11-24 — Export tracks: one WAV per track, two or more in one folder / 트랙 따로 내보내기: 트랙마다 WAV, 2개 이상은 폴더 하나로
- **Added / 추가:** **🎚 Export tracks** (`js/ui/track-export.js`) — in the header's Export ▾ menu (next to WAV / MP4) and in the Manager toolbar.
  - **Manager cycle (Space Master included):** every audible track of the cycle rendered alone over the whole cycle — fader, fades, range masks and, when the track is routed there, the Space Master spatialisation — so all files start together in a DAW. Opening it from the Space Studio while it shows the Space Master picks this scope.
  - **This studio:** one file per Space source (soloed scene), Glissando voice, Field particle, Draw stroke, Chaos / Fractal line (the existing stem renders of `audio/instance-render.js`); Risset, Cloud, Tempo, Wave and Grid give one file.
  - **Two or more files → one folder:** by default a `.zip` holding one folder (every browser); "Save into a folder…" (Chrome / Edge, `showDirectoryPicker`) writes the folder into a place you choose. One file → a plain WAV. Folder name editable (default `<file>_<scope>_tracks_<date>`), files numbered `01_<name>.wav`.
  - Options: output stage (fader + limiter, **off by default** so the files add up to the mix), bit depth 16 / 24 (default) / 32-bit float, the full mix as `00_Mix.wav`. Progress in % in the dialog and in the floating badge (🎚), Cancel / Stop.
  매니저 사이클(스페이스 마스터 공간화 포함, 사이클 전체 길이로 정렬) 또는 이 스튜디오의 음원·보이스·선마다 WAV 하나. 2개 이상이면 폴더 하나(.zip, 또는 크롬·엣지에서 폴더에 직접 저장). 출력 단계·비트 깊이·믹스 포함 옵션, 진행률 %.
- **Added / 추가:** `core/zip-store.js` — minimal ZIP writer (stored, UTF-8 names, folder entries, CRC-32). `encodeWav` now also writes 24-bit PCM and 32-bit float (16-bit stays the default everywhere else).
- **Changed / 변경:** `exportCycleWav({ only, outputStage })` can render a subset of tracks and skip the output stage (defaults unchanged).
- **Files / 파일:** `js/ui/track-export.js` (new), `js/core/zip-store.js` (new), `js/audio/manager-mixer.js`, `js/audio/audio-engine.js`, `js/ui/studio-video.js` (badge icon), `js/ui/manager-panel.js`, `js/main.js`, `js/core/i18n.js`, `js/ui/help-entries.js`, `index.html`, `styles.css`.
- **Data / 데이터:** none.
- **Checks / 점검:** `runSelfCheck()` 238 / 238 pass. Browser: Space Studio (1 source) → one WAV; preset 12 loaded, Manager scope lists 8 tracks, 3 chosen → one .zip (38.9 MB) with one folder and three 24-bit WAVs of the same cycle length, all non-silent, CRCs correct; Glissando (2 voices) → .zip; a ZIP with Korean names passes `unzip -t` and Python `zipfile`. Not checked: listening, "Save into a folder" (needs a real click in Chrome), Space Master spatialised stems against the live mix, files over 4 GB (refused).

## [0.55.1] — 2026-11-24 — Sampler legato: no restart or fade at curve joins; transport playhead on the Sampler monitor / 샘플러 레가토: 곡선 접점에서 재시작·페이드 없음, 샘플러 모니터에 재생 위치
- **Fixed / 수정:** back-to-back Sampler voices (e.g. a split curve) restarted the file at the join with a fade-out and
  fade-in, because Sampler join defaulted to Restart and restarted voices were separate chains (two 5 ms fades → a gap).
  Now the default is **Continue if pitches meet** (one source reads on), and a voice that does start anew (Restart, pitch
  apart, other sample settings) stays in the legato chain while Legato Join is on: its new source starts just before the
  join and is crossfaded in (equal power, as long as the region's own fade-in) — no gap, no double fade.
  샘플러 잇기 기본값 = 음고가 이어질 때만 이어서. 새로 시작하는 보이스도 레가토 연결이 켜져 있으면 교차 페이드로 이어짐.
- **Added / 추가:** while the document plays, a sky-blue playhead on the Sampler monitor shows where the active voice is
  reading in the file (follows joins, restarts, loops, tape speed and pitch-only speed); hidden when that voice is not
  sounding or the transport stops. Glissando only (the other studios' players do not report a read position yet).
  재생 중 샘플러 모니터에 활성 보이스가 읽는 위치를 하늘색 플레이헤드로 표시 (글리산도).
- **Changed / 변경:** projects saved with Sampler join = Restart keep it (now crossfaded); new projects start on Continue.
  Without Legato Join a restarted voice still fades out and in as before.
- **Files / 파일:** `js/audio/audio-engine.js`, `js/ui/sample-editor.js`, `js/ui/panels.js`, `js/core/state.js`,
  `js/core/i18n.js`, `js/ui/help-entries.js`, `flexatone_architecture_agent_guide.md`
- **Data / 데이터:** none (default of the `sampleJoin` pref changed)
- **Checks / 점검:** `runSelfCheck()` 238 / 238 pass (Sampler join check: reads per chain, restart without Legato Join stays
  apart). Offline render of a split curve with a constant-level file, RMS in 4 ms windows around the join: Continue
  0.533 → 0.554 (no dip), Restart 0.53 → 0.61 → 0.55 (was 0.53 → 0.33), with a 40 ms envelope 0.53 → 0.58 → 0.53; without
  Legato Join it still dips (0.08) as intended. Transport playhead: hidden before the voice, 25 % → 71 % while it plays,
  hidden after stop; read positions continue (0.99 s at the join) or restart (0.02 s) by mode. Not listened to.
- **Backup / 백업:** `.backup/2026-11-24-sampler-legato/`

## [0.55.1] — 2026-11-24 — Header "Export" button with WAV / MP4 below it / 헤더 "내보내기" 버튼 아래에 WAV / MP4 선택
- **Changed / 변경:** the header's Export WAV button is now **⬇ Export ▾**; under it a small menu offers **🔊 WAV** (the previous offline WAV export, unchanged) and **🎬 MP4** (the studio video window of 0.55.0). Works in every studio, closes on a click outside or Esc. The 🎬 button in the ③ Send & export box stays.
  헤더의 WAV 내보내기 버튼을 "⬇ 내보내기 ▾"로 바꾸고, 아래 메뉴에서 WAV(기존 그대로) / MP4(동영상 창)를 고름. 모든 스튜디오에서 동작.
- **Files / 파일:** `index.html`, `js/main.js`, `js/core/i18n.js`, `js/ui/help-entries.js`.
- **Data / 데이터:** none.
- **Checks / 점검:** `runSelfCheck()` 238 / 238 pass; in the browser (Space Studio) the menu opens under the button, MP4 opens the video window and closes the menu. WAV item not re-run (same handler as before).

## [0.55.0] — 2026-11-24 — Video export in every studio, Space name size, loaded file name in the header / 모든 스튜디오에 동영상 내보내기, 스페이스 이름 크기, 헤더에 불러온 파일 이름
- **Added / 추가:** **🎬 Export video** in the ③ Send & export box of every studio (`js/ui/studio-video.js`). Lists every canvas the studio shows (main monitor, Space top / front / side / 3-D views, gain envelope, timeline …); tick the ones to record. Layout presets (grid, focus, rows, columns), then drag a tile in the preview to move it and its corner to resize it (snaps to ¼ / ⅓ / ½), or type x / y / w / h in %; fit per tile (keep proportions / fill / stretch), bring to front, gap. **States**: view-only settings a studio registers (`registerVideoStates`) — Space: name size, waves, views (top / quad); applied while the dialog is open, put back when it closes. Overlays: monitor names, title (studio · file), time code, borders, background. Output: 720p … 4K, 24 / 30 / 60 fps, MP4 or WebM, length = until playback ends or fixed seconds, start from the cue or 0, sound = master output after the limiter.
  모든 스튜디오 ③ 보내기·내보내기에 동영상 내보내기: 모니터 선택, 자유 배치(끌기·모서리 크기 조절·% 입력), 스튜디오 보기 상태(스페이스: 이름 크기·파동·뷰), 오버레이, 크기·fps·형식·길이.
- **Added / 추가:** progress in % is always shown while a video is made — bar, % and status in the dialog plus a floating badge at the top of the window with Stop (and Show when the dialog is minimised). The Manager's Master View video export uses the same badge and now shows its %.
  동영상을 만드는 동안 진행률(%)을 항상 표시: 창의 막대·%·상태 + 화면 위쪽 떠 있는 배지(정지, 최소화 시 보기). 매니저 동영상 내보내기도 같은 배지와 % 표시.
- **Added / 추가:** Space Studio **Names** slider in the scene toolbar (`view3d.nameSize`): 0 = names hidden, 0.5 = the previous size (11 px, default), 1 = 22 px; top, front, side and 3-D views (`drawSourceName` in `space-scene3d.js`). Double-click = 0.5.
  스페이스 스튜디오 장면 툴바에 이름 크기 슬라이더: 0 끔 · 0.5 기존 크기(기본) · 1 두 배.
- **Added / 추가:** the name of the loaded project / preset file at the right end of the header (`js/ui/file-name-chip.js`); also set by Save, kept across a reload, cleared by New project; an amber dot = changes not in that file yet.
  불러온 프로젝트·프리셋 파일 이름을 헤더 오른쪽 끝에 표시 (저장 시 갱신, 새로고침 후 유지, 새 프로젝트에서 지움, 주황 점 = 저장 안 된 변경).
- **Files / 파일:** `js/ui/studio-video.js` (new), `js/ui/file-name-chip.js` (new), `js/ui/studio-monitors.js`, `js/ui/manager-video.js`, `js/ui/project-file.js`, `js/main.js`, `js/audio/output-bus.js` (`getMasterOutput`), `js/studios/space/space-panels.js`, `space-scene3d.js`, `space-canvases.js`, `space-engine.js`, `space-i18n-ext.js`, `index.html`, `styles.css`.
- **Data / 데이터:** Space document `view3d.nameSize` (0–1, absent = 0.5). Browser storage `flexatone.fileName` (view only). No project-file migration.
- **Checks / 점검:** `runSelfCheck()` 238 / 238 pass. In the browser: Space dialog found the four views + timeline; a 12.8 s 1280×720 MP4 was recorded with name size 1 (progress 0 → 100 % in dialog and badge), name size went back to 0.5 on close; Glissando picks main monitor + gain envelope + timeline; tile drag changes x; file chip sits at the header's right end and survives a reload. Not checked: listening to the recorded file, the Manager export run end-to-end (module loads), Safari / Firefox formats, minimise during a long recording.
- **Limits / 한계:** the picture is each monitor at its on-screen resolution (a small monitor looks soft in 4K); DOM-only blocks (voice card list) are not canvases and cannot be recorded; recording is real time.

## [0.54.3] — 2026-11-24 — Presets 19–21 become three-minute pieces: retrograde and tape takes, guests, nine cut rules that change faster and faster / 프리셋 19–21을 3분 작품으로: 역행·테이프 테이크, 게스트, 점점 빨리 바뀌는 아홉 가지 컷 규칙
- **Changed / 변경:** `example/manager_19_root_cuts.json`, `manager_20_fifth_cuts.json`, `manager_21_third_cuts.json` (the short cut versions of 0.54.2 are replaced). Cycle 180 s, 35 / 36 / 35 tracks.
  - **Material / 소재:** the original (0 – C s; C = 54 / 48 / 56), then its retrograde (reversed take of every track, Space path mirrored left ↔ right), then tape takes of the same tracks at 2:3, 5:4, 4:5, 3:2 (path turned 180° and 2 m higher) with one guest track from each of the other two projects. Takes use the Extend tool's take structure (`take.rev`, `take.rate`, `raw`), written directly into the file; no `extensions` log, so "Remove last extension" does not apply.
  - **Cuts / 컷:** 146 / 146 / 144 range solos and 18 silences (range with every track muted). The length rule changes nine times in sections of 60, 40, 27, 18, 12, 8, 6, 5, 4 s: cuts of 3–8 s centred on a Doppler turn; accelerando 4 → 0.5 s; 3:2 lattice; Fibonacci groups; 0.75 s pulse with every fourth silent; 5:4 lattice; 0.3 s pulse; accelerando to 0.125 s; 0.25 s on / off. Track choice in sections 1–4: Doppler (38 / 38 / 42 cuts: of the three strongest, the largest contrast to the cut before) or contrast alone, rotating level → timbre → pitch → place (angle between the two sources seen from the listener). Sections 5–9 cycle through 5, 4, 3, 2, 2 tracks so the rhythm comes forward.
  - **Moving bands / 움직이는 띠:** shape regions whose border moves — 18–28 s an edge rising from MIDI 48 to 72 between two tracks, 34–44 s a middle band closing from 24 to 4 semitones between two others. They are inside the takes, so they return mirrored in the retrograde.
  3분(180초): 원본 → 역행 테이크 → 테이프 테이크(2:3·5:4·4:5·3:2) + 게스트. 구간 솔로 약 146개와 무음 18개, 컷 길이 규칙이 60 → 4초 간격으로 아홉 번 바뀜. 경계가 움직이는 음역 띠 2곳.
- **Data / 데이터:** no schema change.
- **Files / 파일:** `example/manager_19…21_*.json`, `flexatone_tutorial.md` (§13).
- **Checks / 점검:** in the browser: all three load (takes kept by the normalizer, 35 / 36 / 35 Space Master sources); every track rendered solo over the 180 s and measured for the selection; final mix renders in about 60–80 s, peaks −8.0 / −7.4 / −8.7 dBFS, section levels −28 … −36 dB RMS; every cut sounds (below −52 dB: none in 19 and 21, three 0.25 s pulses at 176–177 s in 20); the last 0.1 s of every silence is below −60 dB; live cycle playback started and stopped; no console errors. Known: range solos act before the Space Master, so each cut is heard 0.03–0.17 s late depending on the track's distance and the start of a silence carries the tail of the cut before — the fastest pulses are not perfectly even. Cuts whose track measured below −48 dB were replaced by the loudest track of that moment (named `level`); 20 got an extra tape take of the Risset track as a bed for its last seconds. Not checked: by ear; the pitch / timbre measures are spectral peak and centroid ÷ peak below 2 kHz, a rough stand-in for what is heard.

## [0.54.2] — 2026-11-24 — Presets 16–18: Space Master paths differ in shape, tilt and height; cut versions 19–21 / 프리셋 16–18: 스페이스 마스터 경로의 모양·기울기·높이 다양화, 컷 버전 19–21
- **Changed / 변경:** `example/manager_16_root.json`, `manager_17_fifth.json`, `manager_18_third.json` — the Space Master scene no longer uses only circles and lines at one height. Paths are 3-D node splines: tilted orbits, polar orbits over the head, vertical figure-eights, arches that swing over the head, spirals that rise or sink, clover paths, lines that climb; static sources at different heights; sources inside the Space Studio tracks at different heights. Speed of sound ×0.5 in 16 and 17 (18 stays ×0.4) so the Doppler shift is easier to hear. Track gains re-balanced for the new distances.
  스페이스 마스터 경로를 3D 노드 스플라인으로: 기울어진 궤도, 극궤도, 수직 8자, 아치, 나선, 클로버, 높이가 변하는 직선. 16·17의 음속 ×0.5.
- **Added / 추가:** `example/manager_19_root_cuts.json`, `manager_20_fifth_cuts.json`, `manager_21_third_cuts.json` — copies of 16–18 in which the long range solos are replaced by 24 / 20 / 29 range solos of 0.5–4 s, one track each. About 70 % of the cuts take a track among the strongest Doppler shifts at that moment (|radial velocity| / c from the Space bake; of the top three, the one that contrasts most with the cut before); the others take the largest contrast to the cut before, rotating level → timbre → pitch (measured on each track's solo render). Two 8 s passages (at 30 % and 72 % of the cycle) divide the pitch range into 2, 3 or 4 bands, or middle / outside, with shape regions; each band lets one track through. Track fades are at most 0.25 s. Everything else is unchanged.
  16–18의 복사본: 0.5–4초 구간 솔로(도플러가 큰 트랙 위주, 나머지는 음량 → 음색 → 음고 대비), 음역 띠 구간 2곳, 트랙 페이드 ≤ 0.25초.
- **Data / 데이터:** no schema change (regions only).
- **Files / 파일:** `example/manager_16…21_*.json`, `flexatone_tutorial.md` (§13).
- **Checks / 점검:** in the browser: Space bake of every master source read back (height ranges up to −7 … +16, distances, Doppler up to 1.6 % / 1.5 % / 3.6 % in the masters); 16–18 mix peaks −5.1 / −6.4 / −4.6 dBFS, tracks re-measured solo; 19–21 load with 44 / 40 / 50 regions, mix peaks −6.6 / −9.6 / −9.3 dBFS, no window of 0.25 s below −55 dB except one in 19 (32.5 s), one in 20 (42.75 s) and the first of 21; live cycle playback started and stopped; no console errors. Three cuts that rendered silent (the chosen track had ended, or — Field track of 21 at 28.5–31.5 s — was silent in the mix for a reason not found) were replaced by hand and are named `fill`. Not checked: by ear; whether the height differences are audible in each pan mode; band regions act on voice pitch (for the noise samples that is their nominal pitch, not their spectrum).

## [0.54.1] — 2026-11-24 — Three Manager presets with all eleven studios, the Sampler and harmonic-series pitch / 열한 스튜디오 전부 + 샘플러 + 배음 음고의 매니저 프리셋 3개
- **Added / 추가:** `example/manager_16_root.json` (54 s), `manager_17_fifth.json` (48 s), `manager_18_third.json` (56 s). Each uses all eleven studios (Glissando, Grid, Risset, Draw, Tempo, Space, Field, Chaos, Cloud, Fractal, Wave), the per-voice Sampler in five of them (Glissando, Draw, Tempo, Space, Field), Risset region modules with their own settings (`own`: grid ratio, voice count, clock, tremolo, timbre; rotation), Manager range and shape regions over several tracks, the Modulation matrix and a Space Master scene with a place or path for every track. Pitch material is the harmonic series of one fundamental (2:1, 3:2, 5:4; no scales): G#1, C#1 and E1, so the G# of the organ recording is the fundamental, the fifth (harmonic 3) and the third (harmonic 5).
  열한 스튜디오 전부, 다섯 스튜디오의 보이스별 샘플러, 각자 설정을 가진 리세 영역 모듈, 여러 트랙에 걸친 매니저 구간·모양 영역, 모듈레이션, 스페이스 마스터. 음고는 한 기음의 배음만 사용(G#1 · C#1 · E1).
- **Data / 데이터:** no schema change. The five sound files supplied by the user are embedded as excerpts (`samples`, 32 kHz mono 16-bit, 4.4–8 s each, 29.9 s in all), which makes each file about 2.6 MB.
- **Files / 파일:** `example/manager_16…18_*.json`, `flexatone_tutorial.md` (§13 table).
- **Checks / 점검:** in the browser: all three load with the five samples, 11 tracks, the Sampler spec on every intended voice, the Risset `own` settings and the Grid stack kept; cycle export of the mix and of every track soloed, no console errors; mix peaks −3.8 / −5.1 / −5.3 dBFS, tracks −30 … −37 dB RMS; live cycle playback started and stopped for each. `runSelfCheck()` 238 / 238 with a project without Sampler voices; with one of these presets loaded, "Projection ↔ audio: Glissando path = rendered pitch" fails (it renders the first Glissando voice, here a Sampler voice, and expects the curve's pitch) — the check, not the preset. Not checked: by ear; the audible effect of each modulation route and region one by one; Tempo voices restart the sample only once per voice, so they are set to loop.

## [0.54.0] — 2026-11-24 — Space: trajectory transform toolbox for lines loaded from Glissando / 스페이스: 글리산도에서 불러온 궤적의 변형 툴박스
- **Added / 추가:** Space toolbox **Trajectory transform** (① Generate, switch it on in the module tray or with "⤧ Transform" in the Path toolbox). Without a linked path it shows a loader (Glissando first, any studio that offers a line or a curve) and stays off with the reason. With one: rotate about x / y / z (⟲ / ⟳ 90°, "Stand up" = 90° about x so pitch becomes height), size (all axes alike → proportions kept), stretch per axis with 🔗 Keep proportions on (the three move by the same factor, limited so the ratio really stays) or off (each axis alone), 1 : 1 : 1, mirror x / y / z, ⇤ Reverse (node times mirrored so they still rise), position (centre, "On the listener", "Onto the floor"), extent read-out, Reset. The transform is part of the link's mapping, so the path keeps following the Glissando line with the same rotation and size; "Break link" keeps the transformed nodes. / 스페이스 툴박스 **궤적 변형**: 불러오기(글리산도 우선), x / y / z 회전, 세우기, 비율 유지 크기, 축별 늘이기(🔗 비율 유지 켜기 / 끄기), 거울, 역방향, 위치, 초기화. 변형은 링크의 일부라 원본을 계속 따름.
- **Changed / 변경:** Size, rotation (yaw) and centre of a linked path moved from Path → "Path from a studio" into the new toolbox (same values; the Path box shows a one-line summary and the "⤧ Transform" button).
- **Files / 파일:** `js/studios/space/space-curve-link.js` (map fields, `setCurveStretch`, `resetCurveXf`, `curveXfActive`, reverse in `resolveCurveLink`), `space-panels.js` (`buildPathXfRack`, `xfSummary`), `space-i18n-ext.js`, new `space-checks-xf.js`.
- **Data / 데이터:** `path.link.map` gains `rx, ry, sx, sy, sz, keep, flip[3], rev` (identity by default). Older links map bit-identically; their signature changes once, so they are re-read once on load (same nodes).
- **Checks / 점검:** `runSelfCheck()` 238 / 238 PASS (new: "space-xf: trajectory transform …"). In the browser (Space, port 8025): loaded Glissando Voice 1 from the toolbox (27 nodes), Stand up → 3-D path in the Front view, Onto the floor, keep-proportions stretch (x 2 → all 2), free stretch (y 0.5 only), mirror y + reverse; no console errors; test edits undone. **Not verified:** listening; pointer drags of the sliders (set through their inputs); Korean layout of the toolbox in a narrow column.
- **Not done / 하지 않은 것:** transforms of a hand-made (unlinked) spline path — the toolbox stays off there with the reason; on-canvas rotate / scale handles.

## [0.53.0] — 2026-11-24 — Play range / trim / split / 🔗 and ADSR in every studio / 모든 스튜디오에 재생 구간·자르기·🔗·ADSR
- **Added / 추가:** Shared Locate hooks (`ui/locate-tool.js` adapter `trim` / `split`): ⌘ (Ctrl) + drag a line along x trims / extends its nearer end along its curve, double-click a line splits it into linked 🔗 pieces. Wired in **Field** (particles; extension follows the end tangent; linked pieces share ONE baked trajectory and are not felt twice by coupling), **Draw** (strokes; the play range cuts the processed pieces, extension = end tangent; linked strokes share the drawn line), **Space** (sources; trim of the heard span only — lengthen with Duration), **Tempo** (voices; trim of the audible window only — lengthen with Loop / tempo; linked pieces count as one line for phasing / convergence). Each has the 🔗 checkbox + play-range tag on its line cards (`ui/line-link.js`) and the ◌ Unplayed parts toggle; unplayed parts are drawn faint. Bake to Glissando keeps the play range. ADSR block in the shared timbre editor, applied by every studio scheduler (`applyAdsrToCurve` next to `voiceModGainCurve`: Field, Draw, Space, Tempo, Chaos, Cloud — per grain, Fractal, Wave — ridges, Grid); ↻ Restart at joins stays off there with the reason (their lines do not join). Generated studios (Cloud, Chaos, Fractal, Wave, Grid) keep Locate off; the reason now also covers trim / split / 🔗.
- **Changed / 변경:** convention outside Glissando: an object keeps its whole curve span and `clip` = which part plays (Field physics and Space propagation never re-bake on a trim). Studio edit functions (`editField`, `editDraw`, `editSpace`, `editTempo`) sync linked pieces (`syncLinkedAfterEdit`). Tempo bake: `gain` is windowed, `gainAll` keeps the whole window for drawing.
- **Files / 파일:** `js/core/line-clip.js`, `js/core/adsr.js`, `js/ui/line-link.js` (new), `js/ui/locate-tool.js`, `js/ui/timbre-editor.js`, `js/modules/timbre-spec.js`, `js/studios/{field,draw,space,tempo}*` (studio, engine, audio, canvases, panels, doc), `js/studios/{chaos,cloud,fractal,wave,grid}/*-audio.js`, `js/studios/grid/grid-engine.js`, `js/studios/grid/grid-i18n.js`, `js/studios/projections.js`, `js/core/i18n.js`, `js/ui/help-entries.js`, `js/audio/audio-engine.js` (self-check).
- **Data / 데이터:** optional `clip` / `link` on Field particles, Draw strokes, Space sources, Tempo voices; optional `timbre.adsr` in every timbre spec. Old projects unchanged.
- **Checks / 점검:** `runSelfCheck()` 237 / 237 PASS (new: "Play range in every studio …"). In the browser: every studio mounts without console errors and shows the ADSR block; Field ⌘-drag trim + double-click split + undo on the canvas, shared bake, mass sync, faint drawing seen; Field offline render silent outside the play range; Draw / Space / Tempo split windows meet, Space frequency sync, Tempo pieces meet with other voices unchanged. Not heard by ear; Draw / Space / Tempo gestures tested through their functions, not by pointer.
- **Not covered / 미적용:** Risset (own voice bank, no shared timbre editor); Wave's spectral-bin mode (plain sines, no timbre). In Draw, moving a linked stroke moves the other pieces too (the drawn points are the shared shape).

## [0.52.0] — 2026-11-24 — Timeline automation: toolbox parameters as envelope lanes under a module / 타임라인 오토메이션: 모듈 아래 엔벨로프 레인으로 툴박스 파라미터
- **Added / 추가:** ◆ Automation button in the shared Timeline monitor (every studio that uses it; Space keeps its own timeline). With a module selected (Timeline lane or Module List card; in Glissando the active voice) it opens, under the button, the toolboxes applied to that module (switched-on toolboxes of the signal flow), then the parameters (sliders) of the chosen toolbox. Picking one opens an envelope lane under the module in the Timeline. Lane gestures: double-click = add node, click the line = curve that segment (its ◇ handle sets the curvature), two-finger click (context click) = remove a node / straighten a ◇, drag = move node or curvature. The selected node's time / value (and the segment's curvature) show under the Timeline, follow the drag live, and can be typed or stepped with ▲ / ▼ (Shift ×10). Lane chips: ● read on/off, ◉ show/hide, × delete. Help entry `app.automation`.
- **Playback / 재생:** while playing, lanes that are on write their value at the playhead about 3× per second, with no undo steps. A lane is bound to the document number its slider writes (found once by a probe: `alpha`, `fif.d.0`, …), so a Glissando lane drives its own voice even when another voice is active; sliders that write more than one value (e.g. coupled x₁ / x₂) are driven through the slider instead (Glissando: only while that voice is active). Heard wherever an edit while playing is heard (Draw, Field, Fractal, Grid, Tempo, any studio at tempo ≠ 1); Glissando's normal player reads its voices when Play starts, so there the values move but the sound changes only from the next Play.
- **Files / 파일:** new `js/core/automation.js` (model, curvature maths, self-check), `js/ui/automation.js` (picker, lane drawing, gestures, readout, playback driver); `js/ui/studio-monitors.js` (Timeline rows, pointer / double-click / context-click), `js/core/state.js` (`withoutHistory`).
- **Data / 데이터:** `studioParams._automation = { [studio]: { lanes: [{ id, mod, tool, toolTitle, pid, label, min, max, step, on, show, path, nodes: [{ t, v, c }] }] } }`, saved with the project. Old projects load unchanged.
- **Checks / 점검:** `runSelfCheck()` 236 / 236 PASS (new: "Automation: segment curvature, handle round trip, …"). In the browser: picker in Glissando and Fractal, double-click add, click-to-curve, ◇ drag, node drag with live readout, typing + ▲ / ▼, context-click remove, Fractal playback moved `fif.d[0]` along the envelope with the undo index unchanged. Not heard by ear; not tried in Draw / Field / Grid / Tempo / Cloud / Chaos / Wave / Risset.
- **Not yet / 미적용:** automation in Glissando's normal player and WAV export (needs the engines to evaluate parameters over time); toggles / selects are not automatable (sliders only); the Space Studio's own timeline has no automation lanes.

## [0.51.2] — 2026-11-24 — Sampler: drag the fades on the waveform; play speed in Tape mode too / 샘플러: 파형에서 페이드 드래그, 테이프에도 재생 속도
- **Added / 추가:** on the Sampler waveform the bottom half still chooses the region (drag, edges, double-click = whole
  file); the top half now sets the fades: drag left of the region's middle for the fade-in, right of it for the fade-out.
  It turns the envelope on, keeps fade-in + fade-out inside the region, and amber dots mark where the fades end. Double-click
  in the top half does nothing. 파형 아래쪽 반 = 구간 (그대로), 위쪽 반 = 페이드 (왼쪽 페이드인 · 오른쪽 페이드아웃, 엔벨로프 자동 켜짐).
- **Added / 추가:** Speed × now works in both playback modes. Tape: a rate multiplier on top of the pitch curve (×2 = twice
  as fast and an octave up; at least ×0.05). Pitch only: the read speed, as before (0 = freeze). The Grain field shows only
  in Pitch only. The ▶ player uses it (Pitch only at a speed other than 1 is rendered as grains first, up to 15 s).
  속도 ×가 두 재생 방식 모두에 적용: 테이프 = 음고 곡선 위의 배율 (×2 = 두 배 빠르고 한 옥타브 위, 최소 ×0.05), 음높이만 = 읽기 속도.
- **Changed / 변경:** a Tape voice whose saved Speed is not 1 (set earlier while it was Pitch only) now plays at that
  speed. The scrub preview of a Pitch-only voice ignores its read speed (it previews pitch only).
  예전에 음높이만에서 속도를 바꾼 뒤 테이프로 돌린 보이스는 이제 그 속도로 재생됨.
- **Files / 파일:** `js/ui/sample-editor.js`, `js/audio/sample-voice.js`, `js/modules/sample-source.js`, `js/core/i18n.js`,
  `js/ui/help-entries.js`
- **Data / 데이터:** none (the existing `speed` field; sampler join and render keys already include it)
- **Checks / 점검:** `runSelfCheck()` 236 / 236 pass (sampler audio check extended: tape ×2 = rate 2 and twice the mid-voice
  skip, speed 0 keeps a positive rate, forced tape ignores read speed). Built-in browser: top-half drags set fade-in 500 ms /
  fade-out 400 ms on a 2 s file, the fade-in stops at region − fade-out, bottom half still sets the region, double-click only
  in the bottom half, cursors; Speed field in both modes, Grain only in Pitch only; player position moves at ×2 in Tape
  ×2. Not listened to; the pointer events carried exact positions (the Modules panel covered the waveform for real drags).
- **Backup / 백업:** `.backup/2026-11-24-sampler-groups/*.pre-speed.js`

## [0.51.1] — 2026-11-24 — Sampler panel follows the language switch / 샘플러 패널이 언어 전환을 따름
- **Fixed / 수정:** the per-voice Sampler panel (Glissando timbre section and the shared timbre editor of the voice studios)
  now re-reads its labels, button texts, tooltips, the "choose a file" entry and the empty-waveform text when the language is
  switched; before, they kept the language they were built in until reload.
  샘플러 패널의 라벨·버튼·툴팁·파일 선택 첫 항목·빈 파형 문구가 언어 전환 즉시 바뀜 (이전엔 새로고침 전까지 그대로).
- **Files / 파일:** `js/ui/sample-editor.js`
- **Data / 데이터:** none
- **Checks / 점검:** built-in browser, Glissando with a Sampler voice: EN → KO → EN, every label and tooltip switched, no
  console errors. In the other studios the panel relabels on that studio's next render; checked by code, not clicked through.
- **Backup / 백업:** `.backup/2026-11-24-sampler-groups/sample-editor.pre-lang.js`

## [0.51.0] — 2026-11-24 — Glissando: play range inside a curve, trim / extend along the shape, linked pieces, timbre ADSR / 글리산도: 곡선 안의 재생 구간, 모양대로 줄이기·늘리기, 링크된 조각, 음색 ADSR
- **Added / 추가:** Play range of a line inside its own curve (`voice.clip = { u0, u1, ext }`). Locate + ⌘ (Ctrl) + drag a line along x trims / extends its nearer end *along the curve* (the curve does not move; pointer y is ignored); past the curve's ends, Extend = Shape (the engine's formula where defined, else straight) or Straight (end tangent). Locate + double-click a line, or grapher ✂ Split (at the cue), cuts it into two pieces that together play the same. Unplayed parts are drawn faint and dotted; grapher ◌ Unplayed parts hides them (pref `clipGhost`). Pieces share `voice.link = { id, on }`: curve-shape edits (engine, parameters, F₀ / F₁, scale, audio target, regions) are copied between linked pieces; the card's 🔗 checkbox unlinks (separate line) or re-links (takes the others' shape). Cards show the play range (e.g. 48–76%). Timbre toolbox: ADSR envelope (`voice.adsr`) with ↻ Restart at joins (default off = joined voices with the same ADSR get one envelope over the whole run; on = new attack at the join). Generator ☑ Timbre copies the ADSR. Help entries `gliss.clip`, `gliss.adsr`.
- **Changed / 변경:** `evaluateCurveObjectY` maps played time → curve u through the clip (all studios evaluate lines through it); the gain envelope and regions are read on the whole curve. Duplicate drops the link (a copy is its own line).
- **Files / 파일:** new `js/core/line-clip.js`, `js/core/adsr.js`; `js/core/state.js`, `js/modules/curve-engine.js`, `js/modules/gain-bus.js`, `js/audio/audio-engine.js`, `js/ui/canvases.js`, `js/ui/panels.js`, `js/core/i18n.js`, `js/ui/help-entries.js`, `js/studios/glissando-studio.js`, `index.html`.
- **Data / 데이터:** voice fields `adsr` (always), `clip` and `link` (optional; absent = old behaviour). Old projects load unchanged.
- **Checks / 점검:** `runSelfCheck()` 233 / 233 PASS (new: "Play range: trim / extend …, ADSR runs"). In the browser: ✂ Split at the cue, link sync / unlink / re-link, ⌘-drag trim on the body and ⌘-drag extend from the end dot, undo, double-click split, faint tail drawn, ADSR curves from `sampleChainCurves` (continuous vs restart). Not heard by ear.
- **Not yet / 미적용:** the other studios evaluate their lines through the same curve code, but their own documents have no trim / split / 🔗 UI yet, and the shared timbre editor of the other studios has no ADSR block yet (their live engines would each need it).

## [0.50.0] — 2026-11-24 — Voice-source split D-1 · D-2: one seam for every tone, shared Pulse kernel / 음원 분리 D-1 · D-2: 모든 톤에 하나의 이식점, 공용 펄스 커널
- **Changed / 변경:** (D-1) Grid, Cloud, Chaos, Fractal and Wave (ridge mode) create their voice tones with `createToneSource(ctx, { wave })` (`audio/sample-voice.js`) instead of calling `createOscillator()` + `setPeriodicWave()` themselves — the same seam Glissando, Draw, Tempo, Space and Field already use for the Sampler. No sample spec is passed yet, so they still get a plain oscillator: **no change in sound** (D-6 will pass the studio's sample). Wave's spectral bins stay plain sines on purpose (a bin is not a timbre).
  (D-1) 그리드·클라우드·카오스·프랙탈·웨이브(리지)가 보이스 톤을 공용 이식점 `createToneSource`로 만듦. 아직 샘플을 넘기지 않으므로 소리는 그대로.
- **Changed / 변경:** (D-2) Risset's sine → PolyBLEP pulse waveform moved out of the voice bank into the shared source kernel `modules/sources/pulse-kernel.js` (`PulseKernel`, self-contained). The bank delegates its waveform to it (`waveSample` / `polyBlep` stay as aliases), and the worklet source is now composed from the bank + its kernels (`modules/sources/kernel-source.js`, `RISSET_KERNELS`). Bit-identical output.
  (D-2) 리세의 사인 → 펄스 파형을 공용 음원 커널로 분리, 뱅크는 커널에 위임, 워클릿 소스는 뱅크 + 커널로 조립. 출력은 비트 단위로 동일.
- **Added / 추가:** (D-2) timbre spec mode **`'pulse'`** (`{ mode: 'pulse', pulse: { morph, duty } }`, `modules/timbre-spec.js`): native PeriodicWave coefficients from the same kernel (`pulseCoefficients`), memoised so the PeriodicWave cache hits, part of the audio key, kept by the studio normalisers. **No UI yet** — nothing sets it; the shared timbre editor shows the Mix tab for it (Pulse tab: ROADMAP D-3). Glissando voices have no Pulse mode, so "Bake to Glissando" turns a pulse spec into its Mix.
  (D-2) 음색 스펙 모드 `'pulse'` 추가 (같은 커널의 PeriodicWave 계수). 아직 UI 없음, 글리산도로 베이킹하면 믹스.
- **Files / 파일:** new `js/modules/sources/pulse-kernel.js`, `js/modules/sources/kernel-source.js`; changed `js/studios/{grid,cloud,chaos,fractal,wave}/*-audio.js` (one import + the tone line each), `js/audio/sample-voice.js` (self-check), `js/studios/risset/risset-voicebank.js`, `js/studios/risset/risset-audio.js` (self-check), `js/modules/timbre-spec.js`, `js/ui/timbre-editor.js` (Pulse → Mix tab), `docs/ROADMAP_PLANS.md` (section D added, D-1 / D-2 marked done)
- **Data / 데이터:** timbre spec may carry `mode: 'pulse'` + `pulse: { morph, duty }` (nothing writes it yet). Older builds read it as the Mix. No migration.
- **Checks / 점검:** `runSelfCheck()` **235 / 235 PASS** (4 new: tone seam = plain oscillator, bit-identical; Pulse kernel self-contained / morph 0 = sine / DFT of the kernel = its PeriodicWave coefficients within 0.01 / sine near Nyquist; Pulse timbre-spec mode; the Risset self-contained check now builds a bank from the composed source alone and renders a pulse block). Before / after offline renders of each studio's default document at 24 kHz: Fractal, Grid, Wave (spectral and ridge), Risset (sine and pulse morph 0.8 / duty 0.3) **bit-identical**; Chaos and Cloud within 9e-8 of the baseline, the same as two runs of the unchanged code (1.2e-7, multi-threaded render). No console errors on load. **Not verified:** anything by ear; live Play in each studio (only offline renders and the worklet self-check); Manager renders of these studios beyond the self-checks.
- **Backup / 백업:** `.backup/2026-11-24-source-split`
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Voice-source split D-1 · D-2"

## [0.49.0] — 2026-11-24 — Signal flow: editable patch between the toolboxes / 시그널 플로우: 툴박스 사이의 편집 가능한 패치
- **Added / 추가:** `core/signal-flow.js` — the patch model: nodes = toolbox keys + the monitors (`SRC`) + the output (`DST`); cords `[from, to]`; default = serial in the order of the switched-on toolboxes, or the user's own cords (`custom`). A box may have **several inputs and several outputs** (parallel branches); loops, duplicates, self-cords are refused (`addEdge` → reason); a switched-off toolbox is **bypassed** (`effectiveEdges`); `stagesOf` / `parallelGroups` = boxes of one stage run side by side. `ui/signal-flow.js` — storage per studio (localStorage, like the module tray), the **port editor** (click a port → checkboxes of sources / targets, "Serial" resets) and the **patcher** drawing (vertical, Max style: drag bottom ● → top ●, click a cord to cut it, boxes in a row = parallel, unpatched boxes dashed).
- **Changed / 변경:** the Chain toolbox (④ Utility) is now the **Signal flow** toolbox (same rack key `tool-chain`, so saved tray state stays) and is editable; the ports on every signal toolbox now list **all** their inputs / outputs ("◀ in · A, B +1") from the flow; a small **⇄** button on every signal toolbox (not on the Utility one) opens / closes its ports. Port click opens the editor instead of jumping.
- **Files / 파일:** `js/core/signal-flow.js`, `js/ui/signal-flow.js`, `js/ui/rack-layout.js` (`layoutChain`, ⇄ button), `js/ui/studio-monitors.js` (Signal flow toolbox), `styles.css`
- **Data / 데이터:** none in the project file — the flow and the open / closed ports live in `localStorage` (`flexatone.signalFlow.v1`, `flexatone.flowPorts.v1`), per studio, in this browser.
- **Checks / 점검:** `runSelfCheck()` 233/233 (1 new: serial default, multi in / out, parallel stages, loop / duplicate / self / SRC-in / DST-out refused, bypass, normalisation). In the browser (Grid Studio, 8 toolboxes): patched Monitors → two boxes → one box (state "parallel", the box shows both inputs), ⇄ closes and reopens its ports, a drag from ● to ● added a cord and a click cut it, a loop was refused (`cycle`).
- **Not done / 안 한 것:** **the sound engines do not follow the flow yet** — it is a patch record (most toolboxes are parameter sets of one studio engine, only the studio tremolo is a real series stage); wiring it into the DSP needs a per-toolbox decision. Not in the saved project / Manager scenes; no undo for cord edits; Manager toolboxes (cards) have no ports; the loop message was checked in the core only, not seen on screen; nothing was verified by ear.

## [0.48.1] — 2026-11-24 — Master View reads the studios' projections / 마스터 뷰가 스튜디오의 투영을 읽음
- **Changed / 변경:** `clipGeometry` in `ui/manager-panel.js` no longer has Glissando / Field / clip-studio special cases: it calls `projectStudio` and cuts each path into monotone pieces (`monotonePieces`), then applies the same tempo / tape / warp / take maps as before. Glissando and Field register their own projections (`studios/projections.js`: audible voices / particles, same sampling as before), the clip studios register through `audio/clip-projections.js` (their `studio-clips.js` adapters). A studio without a projection is a block. The Send-source fallback of 0.46.0 was removed.
- **Files / 파일:** `js/ui/manager-panel.js`, `js/studios/projection.js`, `js/studios/projections.js`, `js/audio/clip-projections.js`, `js/audio/send-sources.js`, `js/audio/projection-parity.js`
- **Checks / 점검:** `runSelfCheck()` 230/230 then; the Master View of a 9-track project draws lines for Glissando, Tempo, Draw, Chaos, Cloud (screenshot); every instance's projection has as many pieces as its adapter has lines. **Not verified:** pixel equality with the old drawing (the old code was replaced, not diffed), Space / Field / Risset bands in the Master View on screen, warp-curved view.

## [0.48.0] — 2026-11-24 — Module tray, signal chain, Send to Space Studio / 모듈 트레이, 신호 체인, 스페이스 스튜디오로 보내기
- **Changed / 변경:** monitors are back on the **left**, toolboxes on the right (0.47.0 had swapped them). The voice list of every studio is now called **Module List / 모듈 리스트** (Glissando grapher, Field, Draw, Tempo, Space, shared list).
  모니터는 다시 왼쪽, 툴박스는 오른쪽. 모든 스튜디오의 보이스 목록 이름 = 모듈 리스트.
- **Added / 추가:** **module tray** (the jump bar, now in every layout, and a tray in the Manager): every toolbox is a chip; only switched-on toolboxes are shown. A studio opens with its strip + the first ① toolbox; Manager with Master View / Cycle timeline / Tracks. × on a chip or ⏻ on a box switches off (view only, values stay); “All on” / “Minimal”. **Chain ports** ◀ in / out ▶ on every switched-on ①②③ toolbox (click = jump). New ③ toolbox **Send to Space Studio**: one click creates a Space source that imports this studio (`@<studio>`, same length, pass-by path, selected) + **Live link** (length follows); Space Studio shows who sends in. New group **④ Utility** with the **Chain** toolbox (patch view with cords; off modules as chips).
  모듈 트레이(스튜디오·매니저), 체인 포트, 스페이스 스튜디오로 보내기 툴박스(실시간 연결), ④ 유틸리티의 체인 툴박스.
- **Moved / 이동:** the “⤴ Space Studio” button of Send & export moved into the new Send to Space Studio toolbox.
- **Fixed / 수정:** rack keys no longer come from the grip's own help key (`app.rackMove#n`), so fold / pin / position / on-off stay with the right box. Saved fold / pin / position of unnamed boxes from before is dropped once.
- **Files / 파일:** `js/ui/rack-layout.js`, `js/ui/tool-groups.js`, `js/ui/studio-monitors.js`, `styles.css`, `js/core/i18n.js`, `js/ui/help-entries.js`, `js/studios/draw/draw-i18n.js`, `js/studios/tempo/tempo-panels.js`, `js/studios/space/space-panels.js`
- **Data / 데이터:** `studioParams._toSpace = { [studio]: { auto } }` (project, undoable). View prefs in localStorage: `flexatone.modActive.v1`.
- **Checks / 점검:** browser at 1600 px: tray on / off in Chaos, Draw, Space, Glissando, Manager; Send to Space from Chaos created the source (30 s, import @chaos) and Space showed it as incoming; ports and Chain view followed. `runSelfCheck()` 230 / 230 (one earlier run had 4 failures from another session's in-progress `audio-engine.js` ADSR edit; clean after reload). Not checked: hearing the imported sound in Space, Live-link length sync after an edit.

## [0.47.0] — 2026-11-24 — Toolbox groups + monitors on the right in every studio / 툴박스 묶음 + 모든 스튜디오의 오른쪽 모니터
- **Changed / 변경:** split layout swapped: the monitors (main monitor → voice list → timeline → other views) are on the right and follow the page; the toolboxes are on the left in signal order: studio strip, **① Generate** (voices, pitch trajectories), **② Process** (timbre, tremolo, vibrato, gain, space), **③ Send & export**. Group titles fold a whole group; ▲ / ▼ move a toolbox inside its group; the jump bar shows the groups. The column line is dragged left to widen the monitors.
  분할 레이아웃 좌우 교체: 모니터(주 모니터 → 보이스 목록 → 타임라인 → 기타 뷰)는 오른쪽, 툴박스는 왼쪽에 신호 순서로 — 스튜디오 띠, ① 생성, ② 처리, ③ 후처리. 묶음 제목 클릭 = 묶음 접기, ▲/▼는 묶음 안에서만, 바로가기 줄도 묶음 표시.
- **Added / 추가:** every studio now has a **Voices** monitor (multi-voice graph) and a **Timeline** monitor by default — shared `ui/studio-monitors.js`, fed by the Send sources (`listSourceLines`). Studios with their own list (Glissando grapher, Field, Draw, Tempo, Space) or timeline (Space) keep theirs, no duplicate. Risset shows the reason it has no lines. New shared toolbox **Send & export** in ③: Send…, Send to Space Studio, Export curves (JSON: t, MIDI, Hz, slope st/s, curvature).
  모든 스튜디오에 보이스(다중 보이스 그래프)·타임라인 모니터 기본 탑재, 공용 ③ 후처리 툴박스(보내기 · 스페이스 스튜디오로 · 곡률 내보내기).
- **Files / 파일:** `js/ui/tool-groups.js` (new), `js/ui/studio-monitors.js` (new), `js/ui/rack-layout.js`, `js/main.js`, `styles.css`
- **Data / 데이터:** none (view preference `flexatone.toolGroupFold.v1` in localStorage only)
- **Checks / 점검:** all 11 studios switched in the browser at 1600 px: groups, monitor order and the Send & export box checked; group fold, Send-to-Space window and the curvature math checked; narrow (one-column) layout checked. `runSelfCheck()` 230 / 230 pass. Playback playhead on the shared timeline not watched live.
- **Backup / 백업:** `.backup/2026-11-24-tool-groups`

## [0.46.0] — 2026-11-24 — Projection contract: every studio onto the Master's time × pitch grid / 투영 규약: 모든 스튜디오를 마스터의 시간×음고 격자로
- **Added / 추가:** `studios/projection.js` — the contract. A studio answers "what do you sound like as curves in (time, MIDI)?" (`Path = {key, name, domain: 'euclid'|'phase', pts:[{t, m, a?}]}`, `m = NaN` = break). The Master only works on the *monotone pieces* of a path (`monotonePieces`: t never decreases → single-valued m(t)), so reversed / looped / spiralling time and multi-valued pitch fit a rigid grid. Helpers: `splitAtBreaks`, `monotonePieces`, `cutAtWrap` (S¹), `retime` (rate / semitones, keeps written `t0` / `m0`), `pitchesAt`, `gridify` (rasterise onto the Euclidean grid, per-column weight = amplitude), `validatePath`, `registerProjection` / `projectStudio` / `projectionKind`. A studio without a projection is a block (the first version fell back to the Send source lines; removed in 0.48.1 because a Send line is not what is heard — Cloud sends its centre curve).
- **Added / 추가:** `studios/projections.js` — Risset's own projection in phase space (`rissetPaths`: voices as wrap-cut paths, `domain: 'phase'`; Send offers no line for Risset). `audio/projection-parity.js` — self-checks that the picture equals the audio.
- **Changed / 변경:** `audio/send-sources.js` imports the two new files (one line).
- **Files / 파일:** `js/studios/projection.js`, `js/studios/projections.js`, `js/audio/projection-parity.js`, `js/audio/send-sources.js`
- **Data / 데이터:** none
- **Checks / 점검:** `runSelfCheck()` 230/230 (5 new): monotone pieces / breaks / S¹ wrap / retime, grid weight conservation (flat, steep, chord, gap, reversed), every Send-source studio projects valid paths on its default document, Risset pieces stay on the circle, **Glissando path = offline-rendered pitch within 15 cents at rates 1, 2, 0.5, 1.5**. All 11 studios (Glissando, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave, Grid, Risset) project on default documents.
- **Not done / 안 한 것:** the Master View still draws through its own `clipGeometry` in `ui/manager-panel.js` (not migrated to `projectStudio`, so a new studio still needs an entry there unless it has a Send line); Risset's paths are not drawn in the Master View (it still shows the band); the mask feedback (Master → studio) is not yet expressed through the contract; Space / Wave / Cloud etc. were only checked on default documents, not against their audio; nothing was verified by ear.

## [0.45.0] — 2026-11-24 — Grid: brush details, selections, Pull, Restore / 그리드: 브러시 상세 설정, 영역 선택, 당기기, 원상태 복원
- **Added / 추가:**
  - **Brush details** (Space brush rack → ⚙): hardness (a core at full strength), aspect (time : pitch), angle, which axis moves (both / time / pitch), smoothing, "only inside the selection", and "Default brush". Every stroke keeps the settings it was drawn with.
    브러시 상세 설정: 단단함·비율·각도·움직이는 축·손떨림 보정·“선택 영역 안에서만”·기본 브러시.
  - **Selection tools in the Editor monitor's toolbox**: pitch band (time = whole range), time band (pitch = whole range), box (both free), lasso (closed outline by hand). A click deselects; Esc too. The selection lives in the original space; the Result shows where the space carries it. Keys B / S / V.
    Editor 모니터 툴박스의 영역 선택: 음고 띠 (x 전체 고정), 시간 띠 (y 전체 고정), 박스 (둘 다 자유), 올가미.
  - **Pull** (✋): drag to carry the selected part of the space — *Move* (rigid, with a soft edge) or *Elastic* (the grabbed point moves, the outline stays). Stored as a new space effect **Pull (region)**; grabbing the same selection again continues the last pull.
    당기기: 선택 영역을 잡아당겨 변형 (이동 / 탄성).
  - **Restore** (↺): no selection = the whole space back to flat (every effect removed); with a selection = a new **Restore (region)** stage at the end of the stack undoes everything above it inside the selection (copies fade out there). Undoable.
    원상태 복원: 기본 = 전체, 선택이 있으면 그 영역만.
- **Changed / 변경:** the shared warp module gains regions (`sanitizeRegion`, `regionWeight`), brush details on liquify strokes, and the tool-made warps `pull` / `restore` (not offered in the ＋ menu). The shared stack editor shows their op count with "Remove last" / "Clear all".
- **Files / 파일:** `js/modules/space-warp.js`, `js/ui/warp-stack-ui.js`, `js/studios/grid-studio.js`, `js/studios/grid/grid-engine.js`, `grid-canvases.js`, `grid-panels.js`, `grid-i18n.js`, `grid-checks.js`, `js/ui/shortcut-help.js`
- **Data / 데이터:** `studioParams.grid.tool` gains `mode`, `hardness`, `aspect`, `angle`, `axis`, `smooth`, `clip`, `sel`, `feather`, `pullMode` (missing = defaults). Liquify ops may carry `hardness` / `aspect` / `angle` / `axis` / `mask`; defaults are not written, so older strokes are byte-identical. New stage types `pull`, `restore`. No migration.
- **Checks / 점검:** `runSelfCheck()` **225 / 225** (new: "Space warp: brush details, regions, Pull, Restore", "Grid: tools, selections, Restore, Pull"). Built-in browser on port 8028, synthetic pointer events: box, time band and lasso selections, click-to-deselect, Esc, Pull (move) on a time band, Restore selection (lines back at their original pitch), Restore all, a brush with all details set; no console errors. **Not verified:** by ear; Elastic pull and the pitch band by hand (self-checks only); real mouse / pen feel of smoothing.
- **Parity / 공용성:** the Draw Studio's Warp brush uses the same module and reads the new stroke fields, but its panel does not offer the details yet (its files were being edited by another session).

## [0.44.1] — 2026-11-24 — Double-click a monitor to go full screen / 모니터 더블클릭으로 전체화면
- **Added / 추가:** double-clicking a free part of a monitor (toolbar gaps, legend, margin) turns its full screen on and off,
  like ⛶. Where a double-click already has a job it keeps it: on or over a canvas (cue, Grid painting, resets), on controls, on
  the fold title row, the grip and the resize handle. `data-no-fs` opts any other element out.
  모니터 빈 곳(툴바 틈·범례·여백) 더블클릭 = 전체화면 켜기/끄기. 캔버스(큐·칠하기)·컨트롤·접기 제목 줄·손잡이는 기존 동작 유지.
- **Files / 파일:** `js/ui/rack-layout.js`, `js/ui/shortcut-help.js`, `flexatone_tutorial.md`, `flexatone_architecture_agent_guide.md`
- **Data / 데이터:** none
- **Checks / 점검:** built-in browser, all 11 studios, synthetic double-clicks at real points: an empty spot of the monitor
  enters full screen and, in full screen, leaves it; a double-click on the canvas or a button never toggles (in or out of full
  screen); no console errors. Only the overlay fallback runs in the embedded browser; real OS full screen was not checked.

## [0.44.0] — 2026-11-24 — Grid Studio rebuilt: it bends the space; Draw gets object effects / 그리드 = 공간 변형, 드로잉 = 객체 효과
- **Changed / 변경:**
  - **Grid Studio is now the space-warp studio.** It has no lines of its own: it shows the lines of a source studio (default Glissando, read-only) on the time × pitch grid and deforms that grid. Editor = original space + lines, Result = deformed grid + the lines as the space carries them (= the sound). The source voices are never edited.
    - Space effects: liquify (brush in the Editor), lens, twirl, wave, turbulence, pixelate, mirror, glitch, halftone, chromatic copies; ten space presets.
    - A Glissando voice keeps its own timbre and envelope ("Source voice"), or every line plays the Grid timbre.
  - **Draw Studio: object effects.** The same warps as a stack per stroke — only that stroke moves, the axes stay. New Warp tool (W) = a liquify brush for the active stroke.
- **Added / 추가:** `js/modules/space-warp.js` (warp registry + maps, shared), `js/ui/warp-stack-ui.js` (shared stack editor).
- **Removed / 제거:** the raster version of the Grid Studio (painting tools, fine matrix, stage cache, `GridBank` worklet, Tier 2 matrix effects, image import): `grid-effects.js`, `grid-bank.js`, `grid-tools.js`. Blur and Noise have no line-based form and are gone with it.
- **Files / 파일:** `js/modules/space-warp.js`, `js/ui/warp-stack-ui.js`, `js/studios/grid-studio.js`, `js/studios/grid/*`, `js/studios/draw/draw-engine.js`, `draw-canvases.js`, `draw-panels.js`, `js/ui/shortcut-help.js`, `docs/STUDIO_INTEGRATION_LOG.md`.
- **Data / 데이터:** `studioParams.grid` has a new shape (`source`, `space`, `range`, `sound`, …); a raster document saved with 0.33.0 loads as the default Grid document (its rasters are dropped — no migration). Draw strokes gain `fx` (missing = none) and the document gains `liq`; older Draw documents load unchanged.
- **Checks / 점검:** `runSelfCheck()` **222 / 222** (Space warp ×3, Grid ×9, Draw ×6 unchanged). Clicked through on port 8028 with no console error — see the log. **Not verified:** by ear; the rebuilt Grid in the Manager UI (self-checks only); sources other than Glissando / demo lines.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Grid Studio rebuilt as the space-warp studio + Draw object effects".

## [0.43.0] — 2026-11-24 — Full-screen button on every studio monitor; "window" is now "monitor" / 모든 스튜디오 모니터에 전체화면 버튼, "윈도우" → "모니터"
- **Added / 추가:** ⛶ at the lower-right corner of every studio monitor (the main canvas, and second views such as the Glissando
  gain envelope or the Space timeline) shows that monitor alone on the whole screen; Esc or ⛶ again goes back. The canvas grows to
  the screen height and keeps working; layout and values are unchanged. Where the browser refuses full screen (or does not answer
  within 0.5 s, as in embedded views) the monitor fills the browser view instead.
  모든 스튜디오 모니터 오른쪽 아래 ⛶ — 그 모니터만 전체화면 (Esc / ⛶로 복귀). 브라우저가 거부하면 브라우저 화면 전체로 대체.
- **Changed / 변경:** the studio canvas block is called **monitor** (KO **모니터**) in UI text, help and docs instead of
  "window" / "윈도우". Real windows / dialogs (Manager window, Send window) and signal windows (STFT, look-ahead) keep the word.
  Code identifiers (`fx-win`, `data-window`, `winCol`) were not renamed.
- **Files / 파일:** `js/ui/rack-layout.js`, `styles.css`, `js/ui/shortcut-help.js`, `js/ui/trajectory-ui.js`,
  `js/ui/screenshot-mode-chip.js`, `js/ui/manager-panel.js`, `js/ui/help-entries.js`, `js/core/i18n.js`,
  `js/studios/risset/risset-panels.js`, `js/studios/cloud/cloud-panels.js`, `flexatone_tutorial.md`,
  `flexatone_architecture_agent_guide.md`
- **Data / 데이터:** none
- **Checks / 점검:** in the built-in browser (1024×768, a copy of the tree with Grid restored from HEAD because Grid is being
  reworked in this folder): every studio shows ⛶ on its monitor(s); enter → monitor 1024×768 and the main canvas grows to the
  screen (e.g. Cloud 508×420 → 880×678, Tempo 626×260 → 998×702); leave → original size restored; Esc leaves. Only the overlay
  fallback was exercised (the embedded browser never answers the Fullscreen API); real OS full screen in Chrome / Safari was not
  checked. Grid: Editor + Result share one monitor, so only part of the extra height reaches the Result canvas.

## [0.42.0] — 2026-11-24 — Tempo keeps pitch in every studio; Tape mode removed / 모든 스튜디오에서 템포는 음고 유지, 테이프 모드 제거
- **Changed / 변경:** Draw, Chaos, Cloud, Tempo and Space render the tempo themselves (`timeScale`, like Fractal / Wave / Grid),
  so a tempo changes only the speed — in the header ⏱ studio tempo, the Manager tracks and WAV export. Masks and warps are read
  in real time; per-voice vibrato / tremolo run on document time (they speed up with the tempo). Space: the whole scene runs
  faster / slower and every heard frequency, Doppler included, stays; an imported sound keeps its own speed.
  드로잉·카오스·클라우드·템포·스페이스가 템포를 직접 렌더 — 속도만 바뀌고 음고는 그대로.
- **Removed / 제거:** tempo Tape mode (pitch follows speed) and its Glide: the checkbox in the ⏱ studio tempo panel, the Tape
  button + glide field on the Manager master / track tempo, and their help / i18n keys. Sampler Tape playback, Warp time mode
  Tape, takes and the tape canon are unchanged. 템포 테이프 모드·글라이드 제거 (샘플러·곡률·테이크·테이프 카논은 그대로).
- **Files / 파일:** `js/studios/{draw,chaos,cloud,tempo,space}/*-audio.js`, `js/audio/studio-clips.js`, `js/audio/tempo-player.js`,
  `js/core/tempo.js`, `js/core/studio-tempo.js`, `js/modules/tempo-manager.js`, `js/ui/studio-tempo-ui.js`, `js/ui/manager-panel.js`,
  `js/core/i18n.js`, `flexatone_tutorial.md`
- **Data / 데이터:** tempo `tape` / `glideSec` are still written but always load as `false` / `0`. Projects that used Tape
  (`example/manager_08_doppler_weather.json`, `manager_14_tape_weather.json`) now play at the same speed without the
  transposition. 테이프를 쓰던 프로젝트는 같은 속도로, 이조 없이 재생.
- **Checks / 점검:** `runSelfCheck()` — see the session report; new check "Clip studios: tempo ×2 halves the clip at the same pitch".
  Not listened to by ear.

## [0.41.1] — 2026-11-24 — Five more Manager presets: 8–9 studios each, every track placed in the Space Master / 매니저 프리셋 5개 추가 (스튜디오 8–9개, 트랙별 공간 배치)
- **Added / 추가:** `example/manager_11_contrary_motions.json` (48 s), `manager_12_fusion_threshold.json` (45 s),
  `manager_13_beats_and_shadows.json` (50 s), `manager_14_tape_weather.json` (58 s, one shot), `manager_15_orbits.json` (40 s loop).
  Each uses 8–9 studios and a **Space Master** scene in which every track has its own place or path (orbits of different
  periods and directions, spirals, Lissajous figures, lines; equal-power / HRTF / Binaural HOA). They are built on
  independent listening phenomena running against each other rather than on a harmony: endless rise against endless fall,
  rhythm fusing into pitch, beats turning into roughness, Doppler from motion alone, polymeter in time and in space.
  Manager options used: Warp in brush / field / rules mode (pitch, level, tremolo, brightness; chosen targets), the Modulation
  matrix (sidechain, pitch → parameter, onset → retrigger, Cloud and Space document targets), shape and range regions,
  master Tape tempo + an instance on its own tape, track tremolo (rate sweep, beat sync), fixed cycles and loops.
- **Changed / 변경:** `flexatone_tutorial.md` §13 lists the new presets.
- **Files / 파일:** `example/manager_11…15_*.json`, `flexatone_tutorial.md`, `CHANGELOG.md`
- **Data / 데이터:** none (project files only; no code change)
- **Checks / 점검:** `runSelfCheck()` 227 / 227 before loading. Each file loaded (`loadProjectData` + `ensureManager`), cycle
  48 / 45 / 50 / 58 / 40 s; `exportCycleWav` of the mix and of every track alone with no console errors, mix peaks −3.7 … −4.2 dBFS;
  left / right balance of the solo renders moves as the paths say (e.g. a crossing track +3 → −3 dB, static tracks 0 dB);
  live cycle playback started for 13 and 15. **Not verified:** by ear; the individual effect of each modulation route and Warp
  (only that the render runs); HOA quality.

## [0.40.2] — 2026-11-24 — Slider double-click → default, everywhere / 모든 슬라이더 더블클릭 → 기본값
- **Fixed / 수정:** the Glissando panel's static sliders (F0 / F1 MIDI, Start, Duration, Base gain, the five timbre mixes) had no default registered, so double-click did nothing. They now return to a new voice's values (`createDefaultVoice`); in `End` mode the Duration slider returns to start + default length. An audit of every studio (11) and the Manager found no other slider without a default (only the sampler's playhead seek bar, which is a position, not a parameter).
- **Added / 추가:** manual — `tutorial/00_공통개념.md` §10 "공통 조작", shortcut row in `flexatone_tutorial.md` §11.
- **Files / 파일:** `js/ui/panels.js`, `tutorial/00_공통개념.md`, `flexatone_tutorial.md`, `CHANGELOG.md`
- **Data / 데이터:** none
- **Checks / 점검:** browser audit (set to an end value → double-click → value changed) over all 11 studios + Manager; Glissando sliders verified against the voice state (F0 108→48, F1 108→72, Duration 300→2.5, gain 1.5→0.85, saw 1→0.12). Not verified: sliders that only appear in rarely-opened dialogs.

## [0.42.0] — 2026-11-24 — Space: playback modes (Light · Full · Pre-render) / 스페이스 재생 모드
- **Added / 추가:** a **Playback** switch in the Output rack — how the studio plays the scene while you work. Exports and Manager clips are always rendered in full.
  - **Light (default):** the live graph, tuned not to stutter. In Binaural (HOA) the room's reflections go through their own six first-order virtual loudspeakers (on the axes) instead of the full set; reflections more than 50 dB below the loudest source are not scheduled; the tone filter of every voice is updated once per render quantum (≈ 3 ms) instead of per sample. The direct sound keeps the chosen order. / 가볍게(기본): 반사는 1차(가상 스피커 6개), 들리지 않는 반사 생략, 필터는 3 ms마다 갱신.
  - **Full:** the live graph with everything at the chosen order (the previous behaviour). / 전체: 이전과 같은 실시간 그래프.
  - **Pre-render:** the scene is rendered in the background and played as one buffer; after an edit the Light graph plays until the new render is ready. / 미리 렌더: 뒤에서 렌더해 버퍼 하나로 재생.
- **Files / 파일:** `js/studios/space/space-engine.js` (`PLAYBACK_MODES`, `playbackMode`), `space-audio.js` (light scheduling, `prerenderStatus`, `onSpacePrerender`, pre-rendered pass), `js/audio/hoa-bus.js` (`getCompactDecoder`), `space-panels.js`, `space-i18n-ext.js`, `space-checks-f3.js`.
- **Data / 데이터:** optional document field `playback` ('full' | 'prerender'; absent = 'light'). It shapes the live graph only and is not part of the render key.
- **Checks / 점검:** `runSelfCheck()` 229 / 229. Load of the live graph rendered offline, as a fraction of real time: Hall preset 0.22 (Full) → 0.145 (Light); 4 sources + first-order reflections + reverb in Binaural 0.44 → 0.22. Pre-render in the browser: status "rendering" for ≈ 4.5 s on the Hall preset while the Light graph kept playing, then the buffer took over without a stop.
- **Not verified / 미확인:** listening — in particular whether the six-loudspeaker reflections and the 3 ms filter steps are audibly different from Full; the actual CPU load of live playback (the figures are offline render times of the same graph).
- **Limits / 한계:** Pre-render plays the stereo monitor (no live multichannel array output); with Light, what you hear differs slightly from the export in the direction detail of the reflections.

## [0.41.0] — 2026-11-24 — Space: loops keep going, calmer re-scheduling, clipping warning, cheaper monitor reverb / 순환 지속·재스케줄 완화·클리핑 경고
- **Changed / 변경:**
  - **Looping / ping-pong spline paths keep going until the end of the scene** (the Time axis length) instead of stopping after Duration — in "Fit duration" the Duration is one lap. New switch next to "At the end": Until the scene ends (default) · For Duration (the previous behaviour). **Saved scenes with a looping path now sound longer.** / 순환·왕복 경로는 장면 끝까지 계속 (기본). 이전 동작은 "지속시간만큼".
  - **Editing while playing**: the playing pass is re-scheduled once an edit has rested for 110 ms (at the latest every 450 ms during a long drag) instead of up to 22 times a second. Every re-schedule rebuilds the graph and restarts the oscillators, which was heard as tearing and, with many voices, as drop-outs. Measured: 30 edits in 1.5 s → 2 re-schedules (before: one per edit). / 재생 중 편집: 편집이 멈춘 뒤 한 번만 다시 스케줄.
  - **Reverb on headphones** (Binaural, Array monitor): one stereo convolver straight to the output instead of a first-order field decoded through every virtual loudspeaker. Hall preset, offline: 0.275 → 0.20 of real time. ambiX and array feeds keep the first-order diffuse field. / 헤드폰 모니터의 잔향을 스테레오 컨볼버 하나로.
- **Added / 추가:** a **clipping warning** in the Output rack when the voices of the scene can add up to more than full scale and the Limiter is off (`spaceLevelBound`, a worst-case bound). / 클리핑 경고.
- **Files / 파일:** `js/studios/space/space-motion.js` (`life`), `space-engine.js` (`spline.run`), `space-audio.js`, `space-panels.js`, `space-i18n-ext.js`, `space-checks-a.js`.
- **Data / 데이터:** `path.spline.run`: 'scene' (default, also for saved documents) | 'duration'.
- **Checks / 점검:** `runSelfCheck()` 226 / 226. In the browser: a looping path with Duration 6 s in a 12 s scene still plays at 7.5 s; drag simulation as above. Measured while looking for the crackle (offline renders of a sine, curvature spikes): Equal power and Binaural (HOA) are clean; **HRTF mode has spikes 15 × larger on a moving source** (the browser's HRTF panner switching between measured directions); a 4-source scene with first-order reflections and reverb peaks at 1.18 (clips without the limiter).
- **Not verified / 미확인:** listening — whether what was heard as crackling is one of these three causes.

## [0.40.1] — 2026-11-24 — Space: the views stay in the window in the "3 views + 3-D" layout / 3D 뷰에서 윈도우가 사라지던 문제
- **Fixed / 수정:** switching the Space views to "3 views + 3-D" moved the whole view rack to the end of the toolbox column (it looked as if the window had vanished). The split layout (`ui/rack-layout.js`) takes the rack with the largest canvas as the studio's window; the four quad views are each smaller than the observed-pitch canvas, so that rack became the window instead. The scene rack is now marked `data-window="1"` and the pitch / lanes rack `data-window="0"`. / quad 배치에서 뷰 랙이 툴박스 열 끝으로 밀리던 문제: 장면 랙을 윈도우로 명시.
- **Files / 파일:** `js/studios/space/space-panels.js`.
- **Checks / 점검:** in the browser, Top ↔ 3 views + 3-D in both directions and after a reload: the view rack stays the window (left column, same position). `runSelfCheck()` not affected (layout only).

## [0.40.0] — 2026-11-24 — Voice checkboxes, batch S/M, timbre Group Apply, sampler envelope / player / join / 보이스 체크박스 · 일괄 S/M · 음색 그룹 적용 · 샘플러 엔벨로프·플레이어·잇기
- **Changed / 변경:**
  - Glissando grapher: the **Multi-select button is gone**. Every voice card starts with a **checkbox**: tick = add to the selection, untick = remove (no mode, no modifier key). A plain card click still selects only that voice; Ctrl/⌘ and Shift clicks still work. Ticking a second voice switches group edit on, as Multi-select did. / 다중 선택 버튼 제거, 카드 맨 앞 체크박스로 선택.
  - **S / M on a selected voice act on the whole selection** (2+ selected): S solos exactly the selection and turns every other solo off (again = all solos off); M mutes the selection whatever else is muted (all muted already = unmute); **double-click M** = only the selection stays muted, every other voice is unmuted (one undo step). On a single voice double-click M mutes only that voice. / 선택된 보이스의 S·M은 선택 전체에. M 더블클릭 = 선택만 뮤트.
- **Added / 추가:**
  - **Timbre Group Apply** (👥 in the Additive Timbre header, needs 2+ selected): a window lists the different timbres the selected voices use (Mix / f(x) / Sample, with a small picture and the voices using each) and copies the chosen one onto all of them; **Import sound file…** (or drop) makes a new file the Sampler timbre of all of them (root detected; the active voice's Sampler settings kept when it is one). Each voice gets its own copy. / 음색 그룹 적용: 선택된 보이스들의 음색 중 고르기 + 사운드 파일 가져오기.
  - Sampler **Envelope** (checkbox): sine fade-in / cosine fade-out over the region (Fade in / Fade out ms, scaled down together when longer than the region; drawn on the waveform). With **Loop**, **Overlap fades**: on (default) = each pass's fade-out lies over the next pass's fade-in (the loop is shorter by the fade-out; dashed on the waveform); off = it fades out, then fades in. With loop + envelope the old crossfade field is not used (greyed). / 엔벨로프와 루프 페이드 겹치기.
  - Sampler **player**: ▶ / ■ and a playhead bar under the waveform play the region (with envelope and loop) on its own at the root note, through the output stage; the playhead is drawn on the waveform. ■ when stopped = back to the start. Region / envelope edits while playing continue from the same place. No shortcuts. / 샘플러 플레이어 (재생·정지·플레이헤드).
  - **Sampler join** (Glissando, next to Legato Join, saved with the project): *Restart each voice* (default, the old behaviour) · *Continue if pitches meet* (next voice starts where the previous ends, within 0.3 semitone of its end pitch) · *Always continue*. Joined voices are played by one source, so the file reads on instead of starting again; only voices with the same sample settings join, independent of Legato Join; a pitch step becomes a glide of Junction glide ms. / 샘플러 잇기: 새로 재생 · 음고가 이어질 때만 이어서 · 항상 이어서.
- **Files / 파일:** new `js/ui/timbre-group-dialog.js`; changed `index.html`, `js/ui/panels.js`, `js/ui/sample-editor.js`, `js/modules/sample-source.js`, `js/audio/audio-engine.js`, `js/core/state.js`, `js/main.js`, `js/core/i18n.js`, `js/ui/help-entries.js`, cache keys in `js/audio/manager-mixer.js` and `js/audio/instance-render.js`.
- **Data / 데이터:** sample spec gains `envOn` (false), `fadeInMs` (50), `fadeOutMs` (200), `loopOverlap` (true); pref `sampleJoin` ('restart'). Old projects sound the same.
- **Checks / 점검:** `runSelfCheck()` → 223, 222 pass. New: envelope (length, fade in / out, fit, overlap keeps the level at the wrap, no overlap dips) and Sampler join (chain rules for the three modes, never with synth voices, independent of Legato Join; offline render: the continued read is > 2.5× louder after the join on a rising-level file, no dip at the join). The one failure is `space-f3: room in sound` from the parallel Space F3 work, not this change. In the browser: checkbox select / deselect, batch S, batch S again, batch M, M again, double-click M, single-voice M; Group Apply copies a Mix timbre and imports a dropped WAV into both voices (root 57 for 220 Hz); envelope / overlap controls; player plays, loops, stops, resets; Sampler join setting stored; EN / KO texts.
- **Not done / 하지 않은 것:** Sampler join exists in Glissando only (the other studios have no legato chains); the Sampler panel's own labels still keep the language they were built in until reload (as before).
- **Not verified / 미확인:** listening; a real OS file picker in the Group Apply window (tested with a dropped file).
- **Backup / 백업:** `.backup/2026-11-24-sampler-groups`.

## [0.40.0] — 2026-11-24 — Space follow-up F4: changing speed of sound, supersonic sources, Space in the modulation matrix / 스페이스 후속 F4
- **Added / 추가:**
  - **Speed of sound over time** (Medium rack): an envelope draws the c scale against time. Arrival condition `C(t) − C(τ) = |X(τ) − L(t)|` with `C = ∫ c dt` (piecewise-linear c on a 2 ms grid, exact integral and inverse); frequency ratio `(c(t) + n̂·v_L) / (c(τ) + n̂·v_S)`. Off (default) = the constant c and the classic baker. / 시간에 따른 음속 c(t).
  - **Faster than sound**: Clamp (default) · All arrivals · + Sonic boom. With the clamp off a general baker, parametrised by the emission time, cuts the arrival time A(τ) into monotone pieces; each piece is an arrival with its own pitch, direction and level — including the one that is heard **backwards**. "+ Sonic boom" plays an N-wave at every cone crossing. The top view shows the Mach cone and every place the source is heard at. / 초음속: 모든 도착(거꾸로 들리는 도착 포함), 소닉 붐, 마하 원뿔 표시.
  - **Manager Modulation**: a Space track offers, per source, distance, radial speed, azimuth, elevation, Doppler shift and an approach gate as signals; the trigger "crossing" on the approach gate fires at the closest approach. New document targets for Space tracks: `space.c`, `space.yaw`, `space.air`, `space.width` (written into the clip's document before it is rendered — the clip re-bakes, the live graph is never touched). Level, tremolo, brightness and pitch remain the bake-free targets. / 매니저 모듈레이션: 스페이스 신호 6종과 문서 대상 4종.
- **Fixed / 수정:** the listener's orientation envelopes (Facing → Envelopes, extension C) were clamped to −60 … 24° because they were normalised as gain lanes; their angle range is kept now.
- **Files / 파일:** new `js/audio/space-mod.js`, `js/studios/space/space-checks-f4.js`; changed `js/studios/space/space-engine.js` (`soundSpeed`, `bakeGeneral`, `bakeArrivals`, `boomBake`, `superMode`, `SUPER_MODES`), `space-lanes.js` (`cscale`), `space-audio.js` (extra arrivals, `scheduleBoom`), `space-panels.js`, `space-canvases.js`, `space-i18n-ext.js`, `js/core/mod-config.js` (four targets), `js/audio/mod-sources.js` (Space lines, Space document targets).
- **Data / 데이터:** optional document fields `cEnv` (envelope) and `supersonic` ('multi' | 'boom'); absent = as before. Modulation routes may use the params `space.c` / `space.yaw` / `space.air` / `space.width` and lines `<source>:r|vr|az|el|shift|approach`.
- **Checks / 점검:** `runSelfCheck()` → 226, all pass. Constant c through the general baker = the classic baker (f 1e-8, τ 1e-9); a step in c against the closed form; the frequency ratio = the numeric dτ/dt; Mach 2 pass: 0 arrivals before the cone and 2 after, cone crossing at t_pass + d·√(M² − 1) / v within 0.2 ms, the shock is the loudest sample of the render at that time; closest-approach trigger within one bake sample. Stereo regression against the stored renders: 0 / 0 / ≤ 6e-8; older presets bake bit-identically. By hand: the two controls in the Medium rack, a render and playback with the clamp off.
- **Not done / 하지 않은 것 (from the brief):**
  - **Scenes**: no Space Master snapshot per scene, no interpolation between scenes.
  - **Space Master as a modulation target** (wet, output mode) and the targets listener x / y / z, per-source speed factor, path transform, lane offsets: a route addresses a Manager track and a time curve of its document; these need new time-varying document fields first.
  - Signals "arrival / departure time" (the trigger "onset" of the pitch line is the arrival).
  - **MIDI Learn** on the new controls was not checked.
  - Imported sounds on a backwards arrival (a buffer cannot be played in reverse here: those arrivals are silent for imports); the heard-position marker and "Look at source" still use the constant-c solver under c(t); the Mach cone is drawn in the top view only.
- **Not verified / 미확인:** listening; the modulation card with a real Space track in the Manager (the signal list was read through the module with the editor document).
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space follow-up F4".

## [0.39.0] — 2026-11-24 — Space follow-up F3: room — early reflections + reverb / 스페이스 후속 F3
- **Added / 추가:**
  - **Room rack** with a quality switch: Off (default) · Ground · Box 1st order · Box 2nd order. Reflections are **image sources**: mirrored position and velocity, baked through the same retarded-time solver, so each has its own delay, Doppler shift, direction, distance law and air absorption. Ground = one image per source (open field; the comb filter sweeps as the source passes); Box = 6 images, 24 with the second order. Per-surface absorption, reflection low-pass, floor height, box size and centre. The box is drawn in every view. / 방 랙: 끔 · 지면 · 상자 1차 · 상자 2차. 반사 = 영상 음원 (고유의 지연·도플러·방향).
  - **Reverb**: one diffuse reverb from a generated, seeded impulse response (RT60, level, pre-delay, damping, seed). Send law "Room level" (default: the reverb does not follow the distance law, so the direct-to-reverb ratio falls with distance) or "Follows direct"; a send amount per source. In the HOA modes (binaural, array, ambiX export) the reverb is a first-order diffuse field. The tail is rendered after the scene. / 잔향: 시드로 생성한 임펄스, 보내기 법칙 2종, HOA에서는 1차 확산장.
  - Presets **Open Field** (ground only) and **Hall** (box + reverb). / 프리셋 2종.
- **Changed / 변경:** `bakeSource(src, doc, kinOverride)`; `getSpaceTimeline().endSec` includes late reflections and the reverb tail when a room is active.
- **Files / 파일:** new `js/studios/space/space-room.js`, `space-checks-f3.js`; changed `space-engine.js`, `space-audio.js`, `space-panels.js`, `space-scene3d.js`, `space-canvases.js`, `space-i18n-ext.js`.
- **Data / 데이터:** optional document field `room` (absent = off) and optional source field `send`. The room is not part of the physics signature; documents without it bake and render as before.
- **Checks / 점검:** `runSelfCheck()` → 223, all pass. Image position / delay / level / radial speed against closed forms; comb of a ground reflection at (k + ½)·c / Δr and k·c / Δr within 2 % of 1 ∓ r / r′; α = 1, room off and reverb level 0 are sample-identical to the dry render (< 1e-9); RT60 of the impulse within 10 % (0.5 / 1.8 / 4 s); reverb deterministic. Stereo regression against the stored renders: 0 (equal power, HRTF), ≤ 7.5e-8 (binaural); older presets bake bit-identically. **Cost** (Sirens preset, 2 sources, ≈ 20 s rendered offline at 48 kHz): off 0.28 s · ground 1.5 s · box 1st 2.6 s · box 2nd 8.4 s; in Binaural (HOA) off 1.7 s · box 1st 8.2 s. Image bake: 19 / 123 / 603 ms.
- **Found on the way / 발견:** an oscillator runs at its default 440 Hz until its frequency automation takes hold (up to one render quantum after it starts). Inaudible alone, but it shifted the phase between a source and its reflection and made the comb notches 4 × too shallow. With a room on, the frequency is now set from the first sample; without a room nothing is changed, so older renders stay identical.
- **Not done / 하지 않은 것:** the room in the **Space Master** (neither live nor in the cycle export — the rack says so); a send *lane* (the send is one amount per source); a reflection path through a wall for a source outside the box (the reflections fade out, the direct sound is unchanged, the rack names the source); live CPU load with many sources × reflections was not measured (offline times only); a hard cap of 600 image bakes per document.
- **Not verified / 미확인:** listening.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space follow-up F3".

## [0.38.0] — 2026-11-24 — Space follow-up F2: loudspeaker arrays + user HRIR / 스페이스 후속 F2
- **Added / 추가:**
  - **Output mode "Speaker array"**: the HOA scene decoded to real loudspeakers. Layouts: quad, 5.1 and 7.1 (LFE channel silent), cube, octagon ring, custom table (azimuth / elevation). Decoders: mode matching (default; rings use the sectoral harmonics only) and AllRAD (virtual loudspeakers → VBAP; selected automatically for 5.1 / 7.1), optional "Even loudness" (constant energy per direction). The order is limited to what the array carries, with a note. A read-out measures the mean / max direction error and the loudness spread of the chosen decoder. / 출력 모드 "스피커 배열": 배치 프리셋·사용자 표, 모드 매칭 / AllRAD, 음량 균일화, 차수 자동 제한, 실측 품질 표시.
  - **Loudspeaker table**: per loudspeaker distance (delay compensation), trim (dB) and output channel (routing). **Test tone**: a pink-noise burst from each loudspeaker in turn. / 스피커 표(거리·트림·출력 채널), 테스트 톤.
  - **Export array WAV** (always available): one channel per loudspeaker, 32-bit float, with a JSON sidecar listing the channel order, routing, delays and decoder quality. / 배열용 다채널 WAV 내보내기.
  - **Device handling**: with fewer output channels than the array needs (a stereo device), live playback of the Array mode is a headphone monitor — the array's own loudspeakers through HRTF. With enough channels the feeds go straight to the device. / 채널이 모자란 장치에서는 배열의 헤드폰 모니터로 재생.
  - **User HRIR**: a bundle of stereo WAV files (direction in the file name: SADIE II, MIT KEMAR or `az…_el…`) replaces the browser HRTF with one ConvolverNode per (virtual) loudspeaker. Sets are kept outside the project (memory + IndexedDB, id = content hash); the project stores the id only and falls back to the browser HRTF where the set is missing. / 사용자 HRIR (스테레오 WAV 묶음), 프로젝트에는 id만 저장.
- **Files / 파일:** new `js/modules/speaker-arrays.js`, `js/audio/hrir-store.js`, `js/studios/space/space-checks-f2.js`; changed `js/audio/hoa-bus.js` (`createArrayBus`, decoder / HRIR options of `createBinauralSpeakers`, energy normalisation in `speakerCurves`), `js/studios/space/space-engine.js` (`PAN_MODES` + 'array', `isHoaMode`, `normalizeSpatial`, `arraySettings`), `space-audio.js` (`arraySetup`, `arrayLiveSupport`, `hoaMonitorOptions`, `renderSpaceArray`, `exportSpaceArray`, `playArrayTest`), `space-panels.js`, `space-i18n-ext.js`, `js/audio/space-master.js` (Array mode = HOA monitor).
- **Data / 데이터:** `panMode` may be 'array'; `spatial.array` and `spatial.hrir` exist only when set — a document that never used them keeps exactly `{ order, weighting }`.
- **Checks / 점검:** `runSelfCheck()` 215 → 219, all pass. Stereo regression against renders stored before the change: equal power and HRTF identical (0), Binaural (HOA) within 7.5e-8 (two renders of the same code differ by up to 6e-8); the six older presets bake bit-identically. Measured decoder quality (mean / max direction error, loudness spread): quad, octagon, cube with mode matching 0° / 0° / 0 dB; 5.1 AllRAD 8.2° / 21.4° / 3.4 dB; 7.1 AllRAD 1.5° / 3.6° / 1.8 dB; 5.1 mode matching 67° / 180° / 19 dB (unusable — hence AllRAD by default there). By hand: Array mode, 5.1, distance → delay 140 samples, 6-channel export, test tone and playback on the monitor.
- **Not verified / 미확인:** **live multichannel output — this machine's device has 2 channels, so the direct path (`ctx.destination.channelCount`) has never run**; listening; a real HRIR set from files (the checks use a synthetic set; the file dialog and WAV decoding path were not exercised); HRIR persistence across a restart (IndexedDB).
- **Not done / 하지 않은 것:** SOFA files; a multichannel-WAV HRIR bundle (no direction metadata); the analyzer / limiter / loudness lock on the multichannel path (only the fader level at the start of playback is applied — the stereo output stage was left untouched); Space Master on a multichannel device (it uses the headphone monitor); HRIR resampling is linear.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space follow-up F2".

## [0.37.0] — 2026-11-24 — Space follow-up F1: paths from other studios, stems, stereo split, groups / 스페이스 후속 F1
- **Added / 추가:**
  - **Path from a studio** (Path rack): a curve of another studio becomes the spline path of a source and keeps following it. Chaos offers the phase-space trajectory (x, y, z, time) of every voice; every studio that can Send a pitch line offers it as a flat time × pitch curve. Mapping rack: axis choice / flip, fit (sphere · each axis · fixed units), size, rotation, centre; "Use from … to" takes a part of a long curve (scale and centre stay those of the whole); time = shape only (default) or node times from the original; node budget 16 / 32 / 64; "Break link" keeps the nodes. / 다른 스튜디오의 곡선을 경로로 (카오스 위상 공간 궤적, 그 밖의 스튜디오는 시간 × 음고 선). 매핑·사용 구간·시간 모드·링크 끊기.
  - **Groups (formation)**: a source can follow another source's path at an offset — in the frame of the motion (forward / right / up, the formation turns with the path) or along the room axes. Doppler and distance are those of the displaced point. Ungroup copies the lead's path. / 그룹(편대): 다른 음원의 경로를 오프셋으로 따라감.
  - **Stems**: an import can play one line / voice of an instance (`<target>#<key>`); "Split into stems" makes one source per line (≤ 16, by level), on an arc in pitch order, as a group. Glissando, Field, Draw, Chaos, Fractal. / 스템: 선·보이스 하나만 가져오기, 스템으로 분리(최대 16).
  - **Stereo split**: channel L / R / L + R of an imported sound; "Split L / R" makes a pair 4 m apart across the direction of travel (−3 dB each). Default stays the mono sum. / 스테레오 분리.
- **Files / 파일:** new `js/studios/space/space-curve-link.js`, `space-groups.js`, `space-checks-f1.js`, `js/studios/chaos/chaos-space-curve.js`; changed `js/studios/space/space-engine.js` (`normalizeGroup`, group kinematics, `input.channel`), `space-audio.js` (channel split, stem targets), `space-panels.js`, `space-i18n-ext.js`, `js/audio/instance-source.js` (`baseTarget`, `stemOf`, `stemTarget`, `listInstanceStems`), `js/audio/instance-render.js` (`stemDoc`, `stems`), `js/main.js`.
- **Data / 데이터:** Space sources gain `group` (null by default), `input.channel` ('mix'), `path.link` (absent by default); an import target may be `<target>#<stem key>`. Older documents load unchanged; documents without these fields bake bit-identically.
- **Checks / 점검:** `runSelfCheck()` 212 → 215, all pass; the six older presets bake bit-identically (SHA-256). By hand in the browser: Chaos voice 1 linked as a path (whole curve ±23 m with 64 nodes, 6 % of it ±0.42 m), Chaos editor document split into 8 stems (sum of stems vs whole −143 dB for Chaos, −146 dB for Field; 8 stems of 30 s render in ≈ 0.9 s), stereo split, ungroup, live playback starts. **Not verified:** listening; Glissando / Draw / Fractal stem sums (the editor documents had one line); a link whose origin is a non-focused Manager instance; links of a Space instance that is not in the editor are only updated when it is opened.
- **Not done / 하지 않은 것:** more than 64 nodes per path; stems for Cloud, Risset, Tempo, Wave, Grid, Space (no single-line render); per-stem progress display (the status badge of each source shows "rendering…"); a link does not lock the nodes (hand edits last until the original changes).
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space follow-up F1".

## [0.36.0] — 2026-11-24 — Space extension C: moving listener, node time pins, timeline, Space Master in the Manager / 스페이스 확장 C: 움직이는 청취자·노드 시각 핀·타임라인·매니저의 스페이스 마스터
- **Added / 추가:**
  - **Moving listener:** the listener can travel along its own node spline (same editors as a source: "Move listener", "Edit listener path"), with pitch / roll and a facing mode — fixed, envelopes (yaw / pitch / roll against time), direction of travel, or look at a source (its heard position). The retarded time is solved against L(t); the Doppler ratio includes the listener's velocity. 청취자 이동·피치·롤·바라보는 방향 모드.
  - **Time mode `Node times`:** nodes carry a time pin; the speed between pins is a result (monotone cubic). 노드 시각 고정 모드.
  - **Timeline** (collapsible): one row per source and for a moving listener — drag a block = start, its right edge = duration, a diamond = node time pin, double-click = cue. 타임라인.
  - **Space Master** (Manager): a dedicated strip next to the Master View (Space stays in "Add studio" as an ordinary track). On = the output of every track (after its fader) is a source of one master Space scene: delay line (Doppler + arrival delay) → air low-pass → distance gain → stereo / HRTF / Binaural (HOA) → output. Dry / wet, delay compensation, per-track bypass. "Edit in Space ↗" switches the Space tab to the master document (chip `Studio | Master`); its sources follow the track list. The cycle WAV export includes it. 매니저의 스페이스 마스터 (전용 스트립, 트랙 = 음원, 사이클 내보내기 반영).
  - Presets **Fly-through** (moving listener) and **Chase** (listener looks at the comet, Binaural HOA).
- **Changed / 변경:** `manager-mixer.js` gains a track output router (`setTrackRouter`, `rerouteTracks`; 3 call sites) — with no router, or the master off, the graph and the export are as before; the Space workspace files read their document through `space-doc.js` (studio document or Space Master); `main.js` imports `audio/space-master.js`; `manager-panel.js` shows the strip (1 markup function, 2 actions).
- **Files / 파일:** new `js/audio/space-master.js`, `js/studios/space/space-master-doc.js`, `space-doc.js`, `space-timeline.js`, `space-checks-c.js`; changed `js/studios/space/space-engine.js`, `space-audio.js`, `space-canvases.js`, `space-scene3d.js`, `space-panels.js`, `space-i18n-ext.js`, `js/studios/space-studio.js`, `js/audio/manager-mixer.js`, `js/ui/manager-panel.js`, `js/main.js`.
- **Data / 데이터:** Space document: `listener.pitchDeg`, `rollDeg`, `listener.move { on, path, speed, timeMode, start, duration }`, `listener.orient { mode, lookAt, yaw, pitch, roll }`, `timeMode: 'pinned'`, node `t`, `input.kind: 'track'`, `input.bypass`, `view3d.timeline`. New project key `studioParams._spaceMaster = { on, wet, compensate, doc }` (saved and undoable like `_sends`). Older documents load unchanged.
- **Checks / 점검:** `runSelfCheck()` 207 → 212, all pass (4 × `space-c: …` pure, 1 audio). Moving listener: f_obs = f_s(1 + v_L / c) to 1e-9, analytic dτ/dt vs numeric derivative < 1e-3 (measured 4e-5), residual < 1e-9, motion off = bit-identical; frame orthonormal; pins passed within 1e-3 m. Older presets still bake bit-identical. Run by hand in the browser (not registered checks): cycle export with the master off = identical to before (max difference 0), wet 0 = 2.4e-7, every track placed hard left → right channel silent; live: 4 tracks routed while the cycle plays, re-routed on a mode change, 0 chains after switching off; the strip and "Edit in Space" work. **Not done / 하지 않은 것:** timeline global tracks (master trim, airDist lanes), markers, loop region, snapping, lane previews; ambiX export of the cycle; per-track chips in the Manager strips (bypass is in the Space Sound rack); a source clock locked to the clip / tempo (the master clock is the cycle position, real seconds). **Not verified:** listening; the live follower (50 ms control rate) at loop boundaries; many tracks in Binaural mode (CPU); project save → load of `_spaceMaster` through the file dialog; Launch / Scenes with the master on.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space extension C"

## [0.35.0] — 2026-11-24 — Space extension B: HOA output (binaural, ambiX) + importing the sound of other studios / 스페이스 확장 B: HOA 출력 + 다른 스튜디오의 소리 가져오기
- **Added / 추가:**
  - **Import (Space → Sound rack):** a source can play the sound of any Manager instance, or of the document open in another studio's editor, from its moving point — Doppler, arrival delay, distance level, air absorption and direction all act on it. **Live link:** editing the original re-renders it (0.25 s after the edit) and swaps it in while playing; moving the path never re-renders the sound. Content `Document` / `As heard in Manager`, trim, offset, once / loop, **Freeze** (mono copy in the sample library, saved with the project), "Fit path to sound". 다른 스튜디오의 소리를 음원으로 가져오기 (라이브 링크, 고정).
  - **Output mode `Binaural (HOA)`:** every source is encoded in higher-order Ambisonics (order 1–4) and decoded to 16 / 24 / 32 / 50 virtual loudspeakers (fixed HRTF panners), weighting max-rE / basic / in-phase. **Source width** lane (spherical Gaussian blur of the encoding). 바이노럴(HOA) 출력, 음원 폭 레인.
  - **Export ambiX:** (order + 1)² channels, ACN / SN3D, 32-bit float `WAVE_FORMAT_EXTENSIBLE`, plus a JSON sidecar; scene-referred (no output fader, no tremolo), optional peak normalise. ambiX 내보내기.
  - **Shared modules:** `modules/ambisonics.js` (real SH up to order 4, weights, width, sampling decoder), `audio/hoa-bus.js` (binaural virtual speakers, ambiX bus), `audio/wav-multichannel.js` (float WAV), `audio/instance-source.js` + `audio/instance-render.js` (instance → AudioBuffer with a registered renderer, cache, debounce, cycle guard).
- **Changed / 변경:** the Space clip adapter has a `key` (physics + sound + the keys of the sounds it imports), so view edits no longer re-render a Space track in the Manager and an edit of an imported original does; Bake to Glissando skips imported sources (toast); `manager-mixer.js` exports `instanceRenderApi` (2 existing functions); `main.js` imports `audio/instance-render.js`.
- **Files / 파일:** new `js/modules/ambisonics.js`, `js/audio/hoa-bus.js`, `js/audio/wav-multichannel.js`, `js/audio/instance-source.js`, `js/audio/instance-render.js`, `js/studios/space/space-checks-b.js`; changed `js/studios/space/space-audio.js`, `space-engine.js`, `space-lanes.js`, `space-panels.js`, `space-i18n-ext.js`, `js/studios/space-studio.js`, `js/audio/studio-clips.js`, `js/audio/manager-mixer.js`, `js/main.js`.
- **Data / 데이터:** Space document gains `spatial: { order, weighting }`, `panMode: 'binaural'`, per source `input: { kind, target, content, trimDb, offset, play, frozen }` and the `width` lane. Older documents load unchanged (`input.kind = 'synth'`).
- **Checks / 점검:** `runSelfCheck()` 202 → 207, all pass (2 × `ambisonics: …`, 3 × `space-b: …`). Measured: SN3D orthogonality to 2e-3, decoder direction error ≤ 5° and loudness spread < 1 dB for orders 1–4, ambiX channel levels = SH coefficients within 1 %, binaural left / right level and arrival order, imported 440 Hz tone follows f_obs / f_s within 1 %, live link = 1 render per edit of the original and 0 for path edits. Older presets still bake bit-identical. In the browser: a Glissando instance imported into the Comet path (ready in < 1 s), binaural offline render 0.87 s for an 18 s scene, ambiX order 3 export (16 ch), Manager cycle export with a Space track that imports the Glissando track. **Not verified:** listening (HRTF quality, coloration of the virtual-speaker decode), external decoders reading the ambiX file, order 4 in every browser, `As heard` content with warps / takes, live CPU with many sources.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space extension B"

## [0.34.0] — 2026-11-24 — Space extension A: 3-D node splines, time modes, envelope lanes / 스페이스 확장 A: 3D 노드 스플라인·시간 모드·엔벨로프 레인
- **Added / 추가:**
  - **Path type `spline`** (Space): a curve through nodes, each with its own x / y / z, curvature (0 = corner … 2) and tangent mode (auto Catmull–Rom or free Bézier handles); 2-D or 3-D; end = stop / loop / ping-pong; "Convert to spline" for every older path type. 노드마다 xyz·곡률·접선을 가진 스플라인 경로, 기존 경로 → 스플라인 변환.
  - **Views:** Top only (as before) or Top + Front (X–Z) + Side (Y–Z) + an orbit-camera perspective view; nodes and handles are dragged in the three flat views, double-click the curve = insert a node (shape kept), Delete = remove, tool `＋ Node` = append. 3뷰 + 원근 뷰, 노드·핸들 드래그.
  - **Time modes** (spline): `speed` (default — the duration is the result of the speed) / `fit` (duration fixed, the speed profile is relative).
  - **Speed / pitch mode `Envelope`** and **lanes** (gain dB, brightness oct, timbre A → B, air absorption, Doppler amount), each drawn against **time, path progress or distance to the listener**. 속도·음고 엔벨로프와 레인 5종, x축 = 시간 / 경로 / 거리.
  - **Shared `ui/envelope-window.js`** (any studio can mount it): point + handle editing on the same piecewise-Bézier data as Glissando custom curves, value range with units, x range, curve-engine shapes, reverse / invert / copy / paste. 공용 엔벨로프 창.
  - **Shared `modules/spline3d.js`**: Hermite node splines, arc-length table, shape-preserving node insert.
  - Presets **Comet Fly-by (3-D)** (speed envelope against distance, vis-viva shape) and **Helix (3-D)**; listener height `listener.z`.
- **Changed / 변경:** the Space engine works in 3-D (distance, radial speed, elevation use z); wavefront rings are drawn as the cross-section of the sphere with each view plane; Delete removes selected nodes before it removes a source.
- **Files / 파일:** new `js/modules/spline3d.js`, `js/ui/envelope-window.js`, `js/studios/space/space-lanes.js`, `space-motion.js`, `space-views.js`, `space-scene3d.js`, `space-i18n-ext.js`, `space-checks-a.js`; changed `js/studios/space/space-engine.js`, `space-audio.js`, `space-canvases.js`, `space-panels.js`, `js/studios/space-studio.js`; docs `docs/studio_prompts/space_ext_*.md`, `PROMPT_spacex_*.md`, `README.md`.
- **Data / 데이터:** Space document gains `listener.z`, `view3d`, and per source `path.spline`, `timeMode`, `speed.env`, `f.env`, `lanes`, `timbreB`; `speed.mode` / `f.mode` accept `'env'`, `path.type` accepts `'spline'`. `normalizeSpaceDoc` fills them (idempotent); older documents load unchanged.
- **Checks / 점검:** `runSelfCheck()` 192 → 202, all pass (10 new: `spline3d: …`, 8 × `space-a: …` pure, 1 audio). Regression: the 6 older presets bake **bit-identical** (SHA-256 of 14 arrays before / after). In the browser: node drag = 1 undo step, insert / undo, WAV export (2 ch, peak 0.38), Bake to Glissando, 0 bakes during 2 s of playback, re-bake of 8 spline sources 75 ms, no console errors, EN / KO keys complete. **Not verified:** listening (only numeric checks of offline renders), Manager playback of a spline document, project save → load through the file dialog (only the JSON round trip of the document), 1100 px layout.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Space extension A"

## [0.33.0] — 2026-11-24 — Grid Studio (prototype): painted raster + image effects as sound / 그리드 스튜디오
- **Added / 추가:**
  - **Grid Studio** (`grid`, order 110): a painted time × pitch raster (≤ 4 layers, ≤ 200 000 cells) whose image effects are the matching sound operations.
    - Two windows, always together and the same size: **Editor** (the painted grid, every tool) and **Result** (after the effect stack = what you hear; read-only). One view, shared zoom / pan / playhead / cue / cross-hair; stacked or side by side (`\`); resize lock 🔒 / 🔓.
    - Tools: brush, eraser, line, rectangle, ellipse, fill bucket, gradient, eyedropper, select (rectangle / ellipse / lasso, feather), mask paint, liquify; symmetry, snap, `[` `]` size; PNG / JPG import.
    - Effect registry (`GridEffectRegistry`, a new effect = one object, cards generated from its schema). Tier 1: Blur (Gaussian / motion / perspective = chorus → cloud), Noise (level, colour in dB / oct, follow, grain), Glitch (granular pitch / time jumps), Halftone (random tremolo), Chromatic Aberration (exact just-ratio copies, R / G / B), Liquify (stored strokes → curvature). Tier 2: Pixelate, Posterize, Sharpen, Bloom, Levels, Threshold, Mirror, Edge.
    - Stage-cached pipeline: only the stages after an edit are recomputed; timbre / gain / pan / output-stage edits recompute nothing. Preview resolution while dragging, full resolution 150 ms after the last change.
    - Audio Engine: `GridBank` AudioWorklet (one voice per layer × chromatic channel on the same matrix, sparse, partial budget, coloured noise bus, mip-mapped wave tables from the shared timbre editor), in-place update while playing, oscillator fallback, offline render = live, automatic headroom.
    - Bake to Glissando Voices (ridge tracking of the Result, ≤ 64, the loss is listed), JSON / WAV export, 10 presets.
    - Manager: Grid tracks (pitch-preserving tempo, shape masks, Warp pitch / bright, Master View lines), trajectory Send source.
  - `js/modules/ridge-tracker.js` — shared ridge tracker for any time × pitch matrix.
- **Changed / 변경:** `MANAGER_STUDIOS` gains `'grid'`; the shortcut list gains the Grid keys.
- **Files / 파일:** new `js/studios/grid-studio.js`, `js/studios/grid/` (`grid-engine`, `grid-effects`, `grid-tools`, `grid-layout`, `grid-bank`, `grid-audio`, `grid-canvases`, `grid-panels`, `grid-i18n`, `grid-checks`), `js/modules/ridge-tracker.js`; lines added in `js/main.js`, `js/ui/workspaces.js`, `index.html`, `js/audio/studio-clips.js`, `js/core/manager-state.js`, `js/ui/shortcut-help.js`, `.claude/launch.json`, `docs/STUDIO_INTEGRATION_LOG.md`.
- **Data / 데이터:** new `appState.studioParams.grid` (rasters as `{ enc: 'rle8', rows, cols, data }`); nothing existing changes. Window lock / sizes are in `localStorage` (`flexatone.grid.dual.v1`), not in the project.
- **Checks / 점검:** `runSelfCheck()` 163 at the start → **192 / 192** (173 others, 10 of them added by other sessions meanwhile, + 19 Grid). Clicked through on port 8028 with no console error: tab switching, transport keys, edit while playing (0 bakes while only playing), undo (slider drag and stroke = 1 step each), project save / load, bake, WAV (peak −2.7 dBFS, fader −6.02 dB), EN ⇄ KO + help for every control, lock / unlock / re-lock, 1100 px, Manager add / launch / tempo ×2.
  - Over target: Focus Pull (perspective blur) edit → sound ≈ 480 ms (target 400); slider drag on the 6-effect preset ≈ 27 fps (target 30).
  - **Not verified:** by ear, pen pressure, the oscillator fallback in a browser without AudioWorklet, a real drag of the shared ◢ handle.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Grid Studio (prototype)".

## [0.32.0] — 2026-11-24 — Quantum & fluid-dynamics profiles: Flow curve engine, Wave Schrödinger / Diffusion, Space Rankine vortex / 양자·유체 프로파일
- **Added / 추가:**
  - **Curve engine 15 `Flow` (shared, all studios):** Poiseuille `1−(1−t)ⁿ`, Blasius boundary layer (f‴+½ff″=0, RK4 table), Rankine vortex (core / 1/r, end-normalised, overshoot 1/a) and Stokes' 2nd problem (damped ripple settling on the target).
  - **Wave Studio `schrod` equation:** unitary Crank–Nicolson Schrödinger solver, field = |ψ|². Potentials: none / harmonic / finite barrier / curve; fixed ends = infinite well, absorbing = complex absorbing potential. Presets: Infinite Well Revival, Quantum Oscillator (coherent state), Gaussian Wave Packet, Quantum Tunnelling.
  - **Wave Studio `diffusion` equation:** u_t = ν·u_xx + G with an oscillating wall (Stokes' oscillating layer) or a pressure gradient (Poiseuille start-up). Presets: Stokes' Oscillating Layer, Poiseuille Start-up.
  - **Space Studio speed mode `Rankine` + preset `Rankine Vortex`:** orbit sources move at v(r) of a Rankine vortex (Γ, core a) → differential rotation, Doppler glissandi beat.
- **Changed / 변경:** Wave document gains `qm` and `dif` objects (sanitised, part of the bake signature); Space source `speed` gains `gamma`, `core` and mode `rankine`. Momentum of Schrödinger packets is lattice-corrected so the measured group velocity matches.
- **Files / 파일:** `js/core/state.js`, `js/core/i18n.js`, `js/modules/curve-engine.js`, `js/ui/param-help-entries.js`, `js/ui/option-inspector.js`, `js/studios/wave/*`, `js/studios/wave-studio.js`, `js/studios/space/*`, `js/studios/space-studio.js`, `js/audio/warp-sources.js`
- **Data / 데이터:** additive only — old documents load with defaults (`qm`, `dif`, `speed.gamma/core`, `flowKind…`).
- **Checks / 점검:** `runSelfCheck()` 185 checks, all pass except the existing `Grid: Glitch … no amplitude step at event edges` (Grid work in progress, untouched by this change). New checks cover Blasius table, Schrödinger norm / spreading / revival / coherent state / tunnelling, Stokes decay e^(−y/δ), Poiseuille parabola, Rankine profile. Presets and the Flow tab were opened in the browser without console errors; sound output of the new presets was not listened to.

---

### Flow engine: per-kind parameters
- The Flow engine now shows only the parameters of the chosen fluid kind (`showWhen` in the schema, `schemaVisible()` in the curve engine; used by the Glissando, Tempo, Field and Cloud racks).
- New parameters — Poiseuille: Couette share β, wall slip s; Blasius: streamwise warp w, stream function f(η) toggle; Rankine: outer decay exponent m, Lamb–Oseen blend; Stokes: own η span, wavenumber ratio κ, damping ratio ζ. Defaults reproduce the previous curves.

## [0.31.0] — 2026-11-24 — Studio tempo, MIDI files (MPE) and MIDI Learn, cross-studio parity, Manager Scenes / 스튜디오 템포·MIDI 파일(MPE)·MIDI Learn·스튜디오 통일·매니저 씬
- **Added / 추가:**
  - **B1 Studio tempo (⏱ chip next to the cue in the header):** the Tempo Manager on each studio's own transport.
    - Modes × / BPM / **Length** (duration lock: the content plays in exactly that many seconds).
    - **Tape** (pitch follows the speed) and **Follow the Manager** (master × this studio's focused track, on by default).
    - At a tempo other than 1×, the header transport renders the studio the way the Manager does and plays it from one buffer (`audio/tempo-player.js`).
      - Pitch is kept in Glissando, Field, Fractal and Wave.
      - Draw, Chaos, Cloud, Tempo and Space are varispeed, as in the Manager.
      - The playhead stays in document seconds, so cue, loop, pause and play-from work unchanged.
      - Edits while playing re-render and cross-fade from the playhead; Export WAV uses the tempo.
    - Risset scales its live clock (pitch kept).
  - **B2 MIDI files (🎹 MIDI → File):**
    - **Export:** the studio on screen, or the Manager's audible tracks (cycle time, heard pitch, one MIDI track each), as a `.mid` file. Three formats:
      - **MPE**: lower zone, ±48, one note per channel;
      - **multi-channel pitch bend**: ±2 … ±96, channels 1–16 except 10;
      - **notes only**: nearest semitone, for notation.
    - **Import:** a `.mid` file becomes Glissando voices whose curves follow the pitch bends. Each import is one undo step. Three targets:
      - add voices;
      - replace all voices;
      - a new Glissando track in the Manager.
    - The reader handles tempo maps, running status, SMPTE division, RPN bend ranges and the MPE zone message.
    - Notes that continue where another stopped (legato, re-struck wide glides) can be joined into one glide.
  - **B3 MIDI input + Learn (🎹 MIDI → Device):**
    - Connect a Web MIDI input, press Learn, click any slider, number box, checkbox, select or button, then move a knob or press a key.
    - CC and pitch bend sweep the control between lo and hi (invert optional). A note clicks a button, toggles a checkbox or sets a slider by velocity.
    - A mapping made inside a studio acts only while that studio is shown. Mappings are kept in this browser (localStorage), not in the project.
  - **B4 Parity:**
    - **Axes + lines screenshots in every studio.** The 📸 mode chip in the header switches Full → Axes + lines → SVG. The studio's pitch lines are drawn on white axes, time in seconds and pitch as note names (`ui/clean-chart.js`); Risset has no lines and saves the full window.
    - **Lines rack (S / M / gain per line)** for Chaos voices, Fractal voices and Wave ridges (`core/line-mix.js`, `ui/line-mix-rack.js`). It is saved in the document, so playback, WAV and the Manager hear it.
    - **Field presets:** Default, Vortex choir, Gravity wells, Pure glide, Storm, Mirror.
  - **B5 Manager Scenes (▶ Scenes card, under Modulation):**
    - A scene is a set of tracks launched together: it starts its tracks and stops the other launched ones.
    - Switch: at once, or at the end of the playing scene (a queued scene shows its countdown).
    - Follow: next scene once, or loop.
    - Length: 0 = auto, the longest track (a continuous Risset counts as 8 s).
    - **⇥ Write to cycle** turns the list into an arrangement with range solos (the tool Extend → Ritornello uses); **↶ Undo write** puts the arrangement back.
- **Changed / 변경:**
  - Tempo contract: mode `length` with `lockSec` (`tempoRate(cfg, naturalSec)`); the Manager does not offer it yet.
  - Wave's sanitiser keeps `lineMix`; the Wave render keys include it.
- **Files / 파일:**
  - New:
    - `js/core/studio-tempo.js`, `js/audio/tempo-player.js`, `js/ui/studio-tempo-ui.js`
    - `js/core/midi-file.js`, `js/ui/midi-window.js`, `js/ui/midi-learn.js`
    - `js/core/line-mix.js`, `js/ui/line-mix-rack.js`, `js/ui/clean-chart.js`, `js/ui/screenshot-mode-chip.js`, `js/studios/field/field-presets.js`
    - `js/core/scene-config.js`, `js/core/manager-scenes.js`, `js/audio/scene-player.js`, `js/ui/manager-scenes.js`
  - Changed:
    - `js/core/tempo.js`, `js/core/state.js`, `js/ui/studio-host.js`, `js/ui/screenshot.js`, `js/ui/manager-panel.js`, `js/main.js`, `styles.css`
    - `js/studios/risset/risset-audio.js`
    - `js/studios/{chaos,fractal,wave}/*-audio.js`, `*-panels.js`, `js/studios/wave/wave-engine.js`, `js/studios/field/field-panels.js`
- **Data / 데이터:**
  - `studioParams._tempo[studio]`: per-studio tempo + `follow`; saved and undoable, kept outside the studio document.
  - `lineMix` in Chaos / Fractal / Wave documents.
  - Field `preset`.
  - `manager.scenes`, `sceneQuant`, `sceneFollow`, `sceneWrite` (arrangement before the first write); range regions may carry `scene`.
  - All optional: older projects load unchanged.
- **Checks / 점검:**
  - `runSelfCheck()` 167/167 (new: studio tempo, MIDI round trip, line mix, Field presets, scenes). No console errors.
  - B1, Export WAV at ×2 halves the length (+0.05 s tail) in each of these studios:
    - Glissando 4 → 2.05 s
    - Field 3.55 → 1.875 s
    - Draw 4.5 → 2.325 s (varispeed)
    - Fractal / Wave / Cloud 30 → 15.1 s
  - B1 transport and Risset:
    - Field at ×2 through the header stopped after 1.82 s (expected 1.775), and Loop wrapped.
    - The Risset clock ran exactly ×2 (shape / automation clocks 0.1 → 0.2 per measured interval).
    - Cloud takes about 2 s to render before playing.
  - B2, round trip of two Glissando glides (48→72, 79→55):
    - MPE: max error 0.006 semitones, 2 notes.
    - Multi-channel ±2: 0.15 semitones, 26 re-struck notes joined back into 2 lines.
    - Notes only: 0.5 semitones (quantised).
    - Import through the window: add / replace / new Manager track all worked.
  - B3: with simulated messages, note 60 toggled Loop (header) and CC 7 swept a Glissando slider 1 / 16 / 9.
  - B4:
    - Chaos RMS 0.159, M on voice 1 → 0.134, S on voice 2 → 0.050.
    - Fractal M → 0.
    - Wave ridge M → 0.109 → 0.077.
    - Storm preset: 6 particles.
    - Axes + lines SVG: 6 polylines.
  - B5:
    - Scene switch launched exactly its tracks; "at the scene's end" switched after 2.0 s on a 2.35 s scene.
    - Write gave ranges 0–2.03 and 2.03–4.37 s with a fixed cycle, and Undo write restored it.
  - Not verified:
    - Listening by ear.
    - A real MIDI device (the Web MIDI permission flow).
    - Opening the exported `.mid` in a DAW or MPE synth.
    - Follow over a long session.
- **Limits / 한계:**
  - Studio tempo:
    - Tape glide is not animated on studio transports.
    - Studio-specific live highlights (e.g. Cloud's sounding events) do not show while the tempo player plays.
    - The Manager offers no Length mode.
  - Multi-channel export with ±2 re-strikes every 1.5 semitones (use MPE for glides).
  - Writing scenes to the cycle and the arrangement fields are not in the undo history; use ↶ Undo write. Importing as a Manager track takes two undo steps.
  - Line S / M follows line numbers, so they shift when the number of lines changes.
- **Details / 상세:** `docs/STUDIO_INTEGRATION_LOG.md` → "Studio tempo · MIDI · Learn · parity · Scenes (B1–B5)"

## [0.30.0] — 2026-11-24 — Glissando: generator toolboxes, multi-select, group edit modes / 글리산도: 생성기 툴박스 · 다중 선택 · 그룹 편집 방식
- **Added / 추가:** Generate Voices has a ☑ toolbox list (Curve Engine, Pitch & Timing, Additive Timbre, Gain Envelope, Tremolo): the checked toolboxes are copied from the active voice, as set at the moment of generation, onto every new voice. / 보이스 생성 패널에 툴박스 체크 목록 — 체크한 툴박스는 생성 직전의 활성 보이스 설정 그대로 새 보이스 전체에 복사.
- **Added / 추가:** Multi-Voice Grapher header: ☑ Multi-select (a click adds / removes a card), Select all, a selection badge, and a Group edit mode — Active only / Sync / Ratio / Offset — for toolbox edits and Locate on several voices (`appState.groupEditMode`, saved with the project). / 다중 보이스 그래퍼 머리줄: 다중 선택, 모두 선택, 선택 배지, 그룹 편집 방식(활성만 / 동기화 / 비율 / 덧셈).
- **Changed / 변경:** Locate: dragging a line of the selection moves the whole selection (Ratio scales the start times); the start / end dots follow the group edit mode. A click on a selected line keeps the selection. / 이동 도구: 선택된 선을 끌면 선택 전체가 이동, 시작·끝 점은 그룹 편집 방식을 따름.
- **Files / 파일:** `js/core/state.js`, `js/core/i18n.js`, `js/studios/glissando-studio.js`, `js/ui/panels.js`, `js/ui/canvases.js`, `js/ui/help-entries.js`, `index.html`

## [0.29.0] — 2026-11-24 — Risset: time speed per region / 리세: 영역별 시간 흐름 속도
- **Added / 추가:** `timeRate` is a region own key. With a region selected (2+ regions) the Core "Time speed" slider and its ×0…×4 presets set that region's own clock: its glissando phase, trajectory shape, rotation, automation lanes, interaction dynamics, own local flicker and colour controller step by real time × its speed; the other regions keep the shared speed. A region with own time but no own lanes reads the shared lanes at its own clock (its own fixed values still win). / 영역 선택 중 시간 흐름 속도 = 그 영역 자체 시계.
- **Changed / 변경:** region slots now carry ω per real second (region motion × its speed) and the control frame scales only the classic field by the shared speed; slot matching / finite differences use the real step. Time scrub (drag / inertia) moves an own-speed region by its share (speed ÷ shared speed). The "shared by all regions" note no longer lists the time speed. / 영역 슬롯 ω는 실제 초 기준.
- **Files / 파일:** `js/studios/risset/risset-core.js`, `js/studios/risset/risset-panels.js`
- **Data / 데이터:** `regions[].own.timeRate` (0 … 4, optional; old files unchanged)
- **Checks / 점검:** `runSelfCheck()` 162/162. Offline render (3 s, M1 0–0.5 / M2 0.5–1, rate 0.1 Hz): M2 at ×3 advances 0.30 vs M1 0.10 per second, ω 0.15 vs 0.05; M2 ×3 / ×0 change M2 (1.01 / 0.95); M1 solo is identical (0) to the baseline with the envelope in point gains (0.00032 vs no own settings, the same envelope-in-gain effect as before). In the UI, ×2 with M2 selected wrote `own.timeRate = 2` only to M2, shared speed stayed 1. Not listened to; test region removed.
- **Limits / 한계:** a region that uses the shared voices (no own spacing, no own flicker) still takes the shared local flicker and dynamics drift at the shared speed.

## [0.28.0] — 2026-11-24 — Risset: timbre and EQ per region / 리세: 영역별 음색·EQ
- **Added / 추가:**
  - **Per-region timbre:** waveform morph / duty, spectral tilt, flutter and oscillator sync can be a region's own.
    - The voice bank reads each sounding slot's waveform and weighting from its region (frame `regWave`, `regWeight`).
    - Oscillator sync couples each region's slots to that region's own mean field (`regSync`).
  - **Per-region parametric EQ:** once a region has its own bands, the EQ is applied per sounding point. The gain is the region's (or the shared) band response at the point's frequency, and the post-bank filter chain is switched off meanwhile (`eqNodesFor`).
  - A region's own spectral tilt wins over the shared tilt lane, like its other own values.
- **Changed / 변경:**
  - With per-region sync, regions without their own sync settings also sync only among their own slots.
  - Shared by all regions now: only the time speed, the pitch frame and the output level.
- **Files / 파일:** `js/studios/risset/risset-core.js` (`regionTimbreOf`, `regionsOwnEq`, `eqNodesFor`), `js/studios/risset/risset-voicebank.js`, `js/studios/risset/risset-audio.js`, `js/studios/risset/risset-panels.js`
- **Data / 데이터:** `region.own.waveMorph`, `waveDuty`, `spectralTilt`, `flutterDb`, `oscSyncHz`, `eqNodes` (optional).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - Renders, region B's own setting changes the sound, and A alone with / without it is identical (0):
    - waveform (0.17)
    - tilt (0.29)
    - sync (1.04)
    - EQ +12 dB bell (0.87)
  - UI: "+ Bell node" in scope M2 added a band only to M2 (shared EQ kept 3 bands, M2 has 4). The test region was removed.
  - Not listened to by ear.
- **Limits / 한계:**
  - Per-region EQ weights each voice at its fundamental (exact for sine voices); with the pulse waveform the harmonics are not filtered individually.
  - While it is on, the shared EQ is applied the same way instead of by Biquad filters.

## [0.27.0] — 2026-11-23 — Risset: colour control and loop automation per region; time speed / 리세: 영역별 색채 제어·루핑 오토메이션, 시간 흐름 속도
- **Added / 추가:**
  - **Per-region loop automation:** a region with its own lanes (or loop length) computes its effective values from them, its own speed being the base of a rate lane. Envelope / shape / local / rate lanes move only that region.
  - **Per-region harmonic colour control:** a region with its own controller analyses its own sounding points (R · H · C, at most 60 times a second) and drives its own actuator. In scope, the colour readout shows that region's analysis.
  - Regions with their own automation or colour put their envelope into the point gains (like own envelope keys), so envelope actuators act per region.
  - **Time speed (×, 0 … 4, Core toolbox, presets ×0 … ×4):** the field's own clock runs this much faster or slower. Glissando, trajectory shape, automation, dynamics, local flicker and colour control scale together, and so do the bank's glide speeds. 0 = time stands still. Shared by all regions; live and WAV.
- **Changed / 변경:**
  - Harmonic colour and Loop automation are 🎯 in region scope.
  - Shared now: timbre / waveform, EQ and the time speed.
- **Files / 파일:** `js/studios/risset/risset-core.js` (`timeRateOf`, per-region `computeEffective` / colour state), `js/studios/risset/risset-panels.js`
- **Data / 데이터:**
  - `timeRate` (default 1).
  - `region.own.autoLanes`, `autoLoopSec`, `colorCtl` (optional).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - Renders: B's own envCenter lane changes the sound (0.40); B's own colour control on vs off differs (0.17).
  - A alone with or without B's settings differs by 0.00013 (≈ −78 dBFS; the envelope moves from the bank into the point gains, numerically not bit-identical).
  - Time speed ×2 and ×0 each change the render.
  - UI: the colour checkbox in scope M2 set only M2's `own.colorCtl`; the ×2 preset set `timeRate` 2. Test settings were removed.
  - Not listened to by ear.

## [0.26.0] — 2026-11-23 — Risset: output tremolo and local flicker per region; time drag with a held pointer and inertia / 리세: 영역별 출력 트레몰로·로컬 명멸, 포인터 고정 시간 드래그·관성
- **Added / 추가:**
  - **Per-region output tremolo:** when a region has its own tremolo, the tremolo moves into the voice bank.
    - Each sounding slot is shaped by its region's tremolo, or the shared one for regions without their own, from a 64-point one-cycle gain table on the bank clock (frame `regTrem` + `slotRegion`).
    - The post-bank LFO node is switched off meanwhile (`tremoloNodeCfg`).
  - **Per-region local flicker (A_local):** a region with its own local settings runs its own particles per voice and steps them with its settings and automation values.
    - Own keys: localMode, localRateHz, localThreshold, fadeMeanMs, fadeDevMs, fadeCurve, fadeDist, bandMin, bandMax, bandMinHz, bandMaxHz.
  - **Risset time drag with a held pointer:** the window drag uses pointer lock, so the cursor stays put and the time axis moves without the screen edge as a limit (falls back to the plain drag where pointer lock is not allowed).
  - **Inertia:** released while moving, the field keeps the extra speed, which decays to 0 (τ ≈ 0.45 s), so it settles back to the normal Glissando speed.
- **Changed / 변경:**
  - Local flicker and Tremolo are 🎯 in region scope. Only colour and automation (plus timbre / EQ in the core) stay 🌐.
  - The scope banner and own-values list are updated.
- **Files / 파일:** `js/studios/risset/risset-core.js` (`regionsOwnTremolo`, `tremoloNodeCfg`, per-region particles), `js/studios/risset/risset-voicebank.js`, `js/studios/risset/risset-audio.js`, `js/studios/risset/risset-panels.js`, `js/ui/option-inspector.js`
- **Data / 데이터:** `region.own.tremolo` and the local keys above (optional).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - Renders with regions A 0–0.5 / B 0.5–1:
    - B's own tremolo changes the sound (0.51), and A alone is identical (0).
    - B's own local flicker changes it (0.68), and A alone is identical (0).
    - A shared tremolo with B's own set to off differs from the shared tremolo on both (0.51), as expected.
  - Drag: 8 moves then release gave +6.15 s during the drag and +2.34 s of inertia that faded out.
  - Not listened to by ear; pointer lock was not tested with a real mouse (synthetic events use the fallback).
- **Limits / 한계:** The bank tremolo's phase runs on the bank clock (not the transport); sweep / fade-in are not used in Risset either way.

## [0.25.0] — 2026-11-23 — Risset: voice tremolo · vibrato and interaction dynamics per region / 리세: 영역별 보이스 트레몰로·비브라토와 상호작용 동역학
- **Added / 추가:**
  - **Per-region voice tremolo · vibrato:** with region scope on, a region's voice tremolo · vibrato (all settings, the advanced randomizer included) is its own. The voice bank picks each sounding slot's modulation from the region it belongs to (frame `mods` + `slotRegion`; random draws per slot follow that region's seed).
  - **Per-region interaction dynamics:** each region with its own voice layout (Base MIDI / span, or its own count / grid) runs its own dynamics state around its own grid, with its own settings (or the shared ones while it has none). The voices move inside the region, and the window draws them moving.
  - With dynamics now running inside regions, the shared dynamics also affects regions that use the default layout; before, they ignored it.
- **Changed / 변경:**
  - The Voice tremolo · vibrato and Interaction dynamics toolboxes are 🎯 in the region toolbox list.
  - The scope banner lists them under "this region". ↺ Use global / the own-values list include them.
  - "Reset" in Dynamics also resets the regions' states.
  - Output tremolo, local particles, colour, EQ, timbre and automation stay shared (🌐).
- **Files / 파일:** `js/studios/risset/risset-core.js` (`stepRegionDynamics`, `regionVoicePositions`, per-region mods in the control frame), `js/studios/risset/risset-voicebank.js`, `js/studios/risset/risset-panels.js`
- **Data / 데이터:** `region.own.voiceMod`, `region.own.dyn` (optional; older projects load unchanged).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - Renders with regions A 0–0.5 and B 0.5–1:
    - B's own tremolo / vibrato changes the sound (max diff 0.90), and A alone is identical with or without it (0).
    - B's own dynamics changes it (0.98), and A alone is identical (0).
  - UI: toggling tremolo in scope M2 set only M2's `own.voiceMod`; Dynamics 1st order set only M2's `own.dyn`.
  - The test region was removed; the document is as before.
  - Not listened to by ear.
- **Limits / 한계:** A region's dynamics treat mass and buoyancy as 0 and use a fixed critical-band width (1/40 of the ring); the shared dynamics still use the A-4 masses.

## [0.24.0] — 2026-11-23 — Cloud multi-module, Risset time drag and region toolbox list, Manager add-studio in the track list / 클라우드 다중 모듈·리세 시간 드래그·영역 툴박스 목록·매니저 스튜디오 추가 위치
- **Added / 추가:**
  - **Cloud modules (same model as the Risset region modules):** "+ Module" splits the cloud into up to 6 pitch bands. M1 = the cloud as it was; M2 … = new bands centred in their range.
    - Each module owns density, pitch distribution, sieve, glide, duration, gain, polyphony and seed, plus on / S / M / gain.
    - Grain layouts: **Base MIDI / span** (default; the band is the module's pitch range), **Squeezed cloud** and **Window on the cloud**.
    - **Sync the Pitch range** (on by default): Pitch min / max show and move the band. When off they are locked, and touching them opens a popup that explains and offers Turn on sync / Use Squeezed cloud.
    - **Region scope:** with 2+ modules every toolbox acts on the selected module. The scope banner, 🎯 / 🌐 toggle, ↺ Use shared and 🌐 chips on shared toolboxes (length, timbre, tremolo) work as in Risset.
    - **Multi-module grapher** under the window (select, ☑, gain, S, M, ＋ / −); silent modules are dim.
    - **📍 Locate:** drag band edges or whole bands on the window; the bands are drawn on the window too.
    - Playback, WAV, Bake to Glissando and Manager renders use the merged cloud (`cloud/cloud-modules.js`).
  - **Risset time drag:** dragging sideways on the window moves the field along the time axis — left = later, right = earlier.
    - Phase, trajectory shape clock, automation clock and unlinked regions move together; the readout shows the offset.
    - A frozen field (rate 0) still scrubs φ.
  - **Risset region toolbox list:** every toolbox is listed by name — 🎯 acts on the selected region, 🌐 shared by all regions. A click points the toolboxes at the region and jumps to that toolbox, opening it if folded.
- **Changed / 변경:** Manager: ＋ Add studio moved from the top bar into the Tracks header.
- **Files / 파일:**
  - New: `js/studios/cloud/cloud-modules.js`.
  - Changed: `js/studios/cloud/cloud-engine.js`, `js/studios/cloud-studio.js`, `js/studios/cloud/cloud-panels.js`, `js/studios/cloud/cloud-canvases.js`, `js/studios/cloud/cloud-audio.js`, `js/studios/risset/risset-panels.js`, `js/ui/option-inspector.js`, `js/ui/manager-panel.js`.
- **Data / 데이터:** Cloud `modules` ([] = one cloud) and `activeModule`; older projects load unchanged.
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - Cloud with 2 modules: M1 keeps the original 928 events, M2 adds 898, all inside its band C#3–F#6.
  - Scoped edit: distribution "uniform" went only to M2. Synced Pitch max 90 moved M2's top edge.
  - Sync off showed the veil and popup. Muting M1 dims its row and removes its events.
  - Risset: a 200 px drag moved the shape clock by +4.02 s and the phase by +0.12. The list shows 10 toolboxes with the correct 🎯 / 🌐.
  - Manager: Add studio is in the Tracks header, not the bar.
  - Test modules / regions were removed; the documents are as before.
  - Not listened to by ear.
- **Limits / 한계:**
  - Cloud modules share one grain envelope (the shared Gain → envelope).
  - In Risset, local particles, dynamics, voice tremolo · vibrato, tremolo, colour and automation remain shared by all regions (one voice bank).

## [0.23.0] — 2026-11-23 — Risset regions: base MIDI / span layout with Core sync / lock, S / M only in the grapher / 리세 영역: 기준 MIDI·스팬 배치·코어 동기화/잠금, S·M은 그래퍼에만
- **Added / 추가:**
  - **New region voice layout, Base MIDI / span (default):** the region is a field of its own — its bottom edge is its base MIDI and its height its span.
    - Its voices and harmonic offset grid are laid out in that span. An equal grid divides it evenly; ratio, fixed-step and pattern grids keep their intervals in semitones.
    - The previous "Spread evenly" is now **Squeezed ring**; "Window on the field" is unchanged.
  - **Sync the Core's Base MIDI / Span** (checkbox in the region toolbox, shown with that layout, on by default):
    - The Core's Base MIDI and Span show the selected region's range live and edit its edges.
    - When sync is off they are locked under a veil. Touching them opens a window that explains why and offers ↔ Turn on sync, Use Squeezed ring, or Close.
    - The classic field (one full-range region) is unaffected.
- **Changed / 변경:**
  - S / M were removed from the region module tabs; they live in the multi-region grapher.
  - A region that does not sound (muted, another soloed, or off) is drawn dim, both as its grapher row and as its band on the window.
- **Files / 파일:** `js/studios/risset/space-regions.js`, `js/studios/risset/risset-core.js` (`regionOffsets`, `regionPitchRange`), `js/studios/risset/risset-panels.js`
- **Data / 데이터:**
  - `region.layout` gains `'pitch'` (new default for regions without one; `'fit'` / `'window'` kept).
  - New `region.syncCore` (default true).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162.
  - M2 0.3–0.7 with 8 voices: positions 0.346 … 0.696 in steps of 0.05.
  - Sync on: the Core shows span 38.4 st and base 52.8; span 24 moved the region's top to 0.55, and the global span stayed 96.
  - Sync off: veil and popup shown; "Turn on sync" switched it on.
  - Tab S / M gone; a muted region's row is at 42 % opacity.
  - The test regions were removed again, and region 1 was set to layout `pitch`, not muted.
  - Not listened to by ear.

## [0.22.0] — 2026-11-23 — Manager landscape layout, compact tracks, range select without the playhead, overlap interpolation / 매니저 가로 레이아웃·간결한 트랙·구간 선택·겹침 보간
- **Added / 추가:**
  - **Manager landscape layout (default):** the Master View, the cycle timeline and the track list are on the left; Extend, Interpolate, Modulation and the ranges are on the right.
    - Each column scrolls by itself; drag the line between them to change the width.
    - ⇄ in the bar switches to portrait, the previous single column. Remembered in `flexatone.mgrLayout.v1`.
  - **Compact tracks:** each track shows its controls up to the gain (and meter).
    - ▸ More opens the rest: tempo, cycle, start, length, loop, fades, tremolo.
    - Open all / Close all in the Tracks header.
  - **Interpolate with overlapping ranges:** the overlap itself is filled, from the state just before it to the state just after it.
  - **Interpolate Overwrite / Add:** Overwrite (default) mutes what the joined tracks had in the filled part, as before. Add only layers the transition on top.
  - **Risset multi-region grapher:** ＋ Module and − buttons (the same as the region toolbox).
- **Changed / 변경:** While Select range is on, a drag on the Master View or on the ruler draws a range and no longer moves the playhead.
- **Files / 파일:** `js/ui/manager-panel.js`, `js/core/manager-interpolate.js`, `js/ui/rack-layout.js`, `styles.css`, `js/studios/risset/risset-panels.js`
- **Data / 데이터:** none (view preferences only); Interpolate has a new `mode` option (`'replace'` | `'add'`).
- **Checks / 점검:**
  - `runSelfCheck()` 162/162; the overlap check replaces "overlapping ranges have no gap".
  - 1440×900: left column 949 px, right column 481 px. Strips show up to the gain.
  - A Master View drag in range mode made a range and the cue stayed.
  - Ranges 1.8–3.5 and 3–5.2 gave "overlap · 3.0 → 3.5". Add added 4 tracks and no mute range; Overwrite added 4 tracks and 1 mute range. Both were removed again, and the test ranges deleted.
  - The Risset grapher's ＋ adds a module; the test modules were removed.
  - Not listened to by ear.

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

## [0.20.0] — 2026-11-23 — Manager edges, Risset region Locate · even spread · grapher, voice lists under the window with gain / 매니저 가장자리·리세 영역 Locate·고른 분포·그래퍼·보이스 목록 게인
- **Added / 추가:**
  - **Manager:** both side edges resize it in every mode, including full screen. The opposite side stays where it is. Double-click an edge, or drag it back to the screen edge, to restore the mode's width.
  - **Risset 📍 Locate** (window toolbar): drag a region band's edge to move that edge, or drag inside a band to move it whole. Clicking a band selects its region.
  - **Risset region voice layout:** Spread evenly (new default) or Window on the field (the previous behaviour), with an explanation in its help.
  - **Risset multi-region grapher** (two or more regions), under the window: one row per region with select, on, S / M and gain.
  - **Voice lists under the window:** in the split layout every studio's voice list sits right under the window and stays foldable (Glissando grapher, Field particles, Draw strokes, Tempo voices, Space sources, Risset regions).
  - **Per-voice gain:** each of those lists now has a gain slider per voice (`ui/voice-gain.js`, same value as Base Gain; Risset: region gain).
- **Changed / 변경:**
  - Picking a region (tab, grapher row or Locate) or adding one always points the toolboxes at it, even after 🌐 Edit all regions.
  - Regions spread their N voices over their own range by default. Existing regions change sound; choose Window on the field to keep the old one.
- **Fixed / 수정:** A pinned Manager card (📌) used the main page's header offset and collapsed to 2 px in the card column, so scrolling no longer matched the content. It now pins to the top of the Manager's scroll area at full height.
- **Files / 파일:**
  - New: `js/ui/voice-gain.js`.
  - Changed: `js/ui/manager-panel.js`, `js/ui/rack-layout.js`, `styles.css`, `js/studios/risset/space-regions.js`, `js/studios/risset/risset-core.js`, `js/studios/risset/risset-panels.js`, `js/ui/panels.js`, `js/studios/{field,draw,tempo,space}/*-panels.js`, `index.html`.
- **Data / 데이터:**
  - Risset `region.layout` ('fit' | 'window', default 'fit').
  - Manager size preference: `anchor` and `offset`.
- **Checks / 점검:**
  - `runSelfCheck()` 158/158.
  - Spread evenly: 8 voices in M2 0.3–0.7 sit at 0.05 spacing; before, they were spread over the whole range.
  - Locate: dragging the top edge 0.7 → 0.8 and dragging inside moved the band by −0.05.
  - Manager: left edge to 400 px, right edge to a 700 px width keeping its left, double-click restores, pin / unpin scroll checked.
  - Gain sliders change Base Gain and undo cleanly.
  - Not listened to by ear.

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

## [0.18.1] — 2026-11-23 — Split layout: window : toolboxes ≈ 2 : 1 / 분할 레이아웃 비율 2:1
- **Changed / 변경:** The default width of the window column is now ⅔ of the workspace (was 58 %), so window : toolboxes ≈ 2 : 1. A width you set by dragging the column line is kept; double-click the line to go back to the new default.
- **Files / 파일:** `js/ui/rack-layout.js`
- **Data / 데이터:** none
- **Checks / 점검:** 1440×900: window 929 px, toolbox column 465 px (Risset, Glissando).

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
