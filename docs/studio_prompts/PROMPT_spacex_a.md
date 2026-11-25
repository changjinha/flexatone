# Space Studio 확장 (A·B·C) — 공통 전제 (각 PROMPT_spacex_*.md 앞에 붙는 부분)

당신은 `/Users/changjinha/Documents/Flexatone` (브라우저 네이티브 무빌드 ES 모듈 프로젝트, 스튜디오 10개 + Manager, git 저장소)의 **기존 Space Studio를 확장**합니다. 새 스튜디오를 만드는 작업이 아닙니다. 이 챗에서는 아래 "이번 작업" 섹션의 한 단계(A, B, C 중 하나)만 다룹니다. 세 단계는 순서대로 의존합니다(A → B → C). 앞 단계가 끝났는지는 `CHANGELOG.md` 맨 위와 `git log`로 먼저 확인하세요. 앞 단계가 없으면 멈추고 보고합니다.

## X0. 작업 순서
1. 아래 §X1의 파일을 읽고 계약을 확인합니다. **이 문서와 `docs/STUDIO_INTEGRATION_LOG.md`는 제가 확인한 사실이지만, 코드가 맞습니다.** 차이는 최종 보고에 적습니다.
2. 코드를 바꾸기 전에 **기준선**을 기록합니다: `window.runSelfCheck()` 통과 개수, 그리고 Space 프리셋 전부(`SPACE_PRESETS` 6종)의 베이킹 배열(`fObs, gain, pan, lp, r, vr`) 해시/요약. 이것이 회귀 기준입니다(§X3-1).
3. 5줄 이내 구현 계획을 적고, 답을 기다리지 말고 구현합니다. 단계(A1→A2 …)가 나뉜 작업은 각 단계 끝에 자가진단을 돌려 통과를 확인한 뒤 다음 단계로 갑니다.
4. 구현 → 검증(§X5) → `CHANGELOG.md`/로그 → 로컬 커밋(§X6) → 최종 보고(§X7).
5. 확인하지 않은 것을 확인했다고 쓰지 마세요. 못 한 검증은 "미검증"으로 적습니다. 소리는 들을 수 없으므로 **오프라인 렌더를 수치로 분석**하는 자가진단으로 대신하고, 그 한계를 보고합니다.

## X1. 먼저 읽을 파일 (순서대로)
- `flexatone_architecture_agent_guide.md` — 계층 DAG, 무빌드, **§7 CHANGELOG 필수**, §8 커밋 규칙, §5b 용어(Instance/Track/Clip, Curve/Studio/Audio Engine, Sampler, Warp)
- `docs/STUDIO_INTEGRATION_LOG.md` — "Space Studio (prototype)", "Wave Studio — Manager integration", "Cross-studio parity pass", "Manager Warp", "Trajectory Sends", "Manager Modulation", "Studio tempo · MIDI · Learn · parity · Scenes (B1–B5)"
- `CHANGELOG.md` 위쪽 5개 항목 (현재 버전 확인; **v0.32.0까지 Space는 Rankine 속도 모드 등이 추가됨**)
- Space 전체: `js/studios/space-studio.js`, `js/studios/space/space-engine.js`(경로·속도 표·지연 시간 솔버·`bakeSource`·서명 캐시), `space-audio.js`(`scheduleSpaceSource`, 오프라인 렌더, 라이브 재스케줄), `space-canvases.js`, `space-panels.js`, `space-i18n.js`
- **작업 트리에 다른 세션의 미커밋 변경이 있습니다.** `git status --short`, 그리고 Space 파일의 `git diff`를 읽고, 남의 변경을 되돌리거나 덮어쓰지 마세요.
- Manager/Space 관련: `js/audio/studio-clips.js`(Space 어댑터 = 클립으로 렌더), `js/audio/manager-mixer.js`(트랙 그래프 `chGain → analyser → getOutputBus`, 사이클 시계 `getCyclePosition`/`getTrackTime`, 오프라인 내보내기 약 1425행), `js/audio/output-bus.js`, `js/core/manager-state.js`, `js/audio/scene-player.js`, `js/audio/mod-sources.js`
- 공용 UI: `js/ui/studio-controls.js`, `js/ui/timbre-editor.js`, `js/ui/view-nav.js`, `js/ui/transport-lines.js`, `js/ui/locate-tool.js`, `js/ui/rack-layout.js`, `js/ui/canvas-size.js`, `js/ui/trajectory-ui.js`, `js/studios/trajectory-link.js`, `js/ui/studio-host.js`
- 곡선/엔벨로프: `js/modules/curve-engine.js`(`evaluateCurveObjectY`, `captureCurveToCustomPoints`, 곡선 엔진 15종 + Flow), Glissando의 게인 곡선 편집기(`js/ui/canvases.js`, `js/ui/panels.js`의 `gainPoints`/`customPoints` + 핸들 편집)
- `js/core/math-utils.js`(Fritsch–Carlson 단조 스플라인, `rdpSimplify`, `clamp/lerp/roundTo/deepClone/uid`, `createSeededRandom`), `js/core/sample-library.js`(모노 PCM, 프로젝트에 저장)

## X2. 불변 조건 (프로젝트 규칙)
- **무빌드**: `<script type="module">`, npm/번들러/CDN 금지, 상대 import는 `.js` 확장자. 계층 DAG: `main → ui → audio → studios → modules → core`. 순수 파일(`*-studio.js`, `*-engine.js`, `modules/*`, `core/*`)은 DOM/AudioContext를 import하지 않습니다.
- **순환 import 주의 (특히 B, C)**: `studio-clips.js`가 `space-audio.js`를 import하고, `manager-mixer.js`가 `studio-clips.js`를 import합니다. 따라서 `space-audio.js`는 `manager-mixer.js`/`studio-clips.js`를 **직접 import할 수 없습니다.** 필요하면 `audio/instance-source.js` 같은 작은 모듈에 `setProvider(fn)` 레지스트리를 두고, 한쪽(`manager-mixer.js` 쪽 또는 `main.js`)이 시작 시 등록하세요. `mod-sources.js`의 `configureModSources(...)` 훅이 같은 패턴입니다.
- **공용 모듈 우선 (사용자의 명시 규칙, 스튜디오 간 일관성)**: 다른 스튜디오도 쓸 수 있는 기능(엔벨로프 창, 3D 스플라인 수학, 앰비소닉스, 인스턴스 렌더 공급자 등)은 Space 전용 파일에 묻지 말고 **공용 모듈**(`modules/*`, `audio/*`, `ui/*`)로 만들고 API를 일반적으로 설계하세요. 이번 작업에서 **다른 스튜디오의 동작은 바꾸지 않습니다**; 나중에 채택할 후보만 최종 보고에 적습니다.
- **선택지 정책 (사용자 지시)**: 한 결정에 선택지가 여럿이면 **가장 자연스러운 것을 기본값으로 두고, 나머지는 UI에서 고를 수 있는 기능으로 제공**합니다. 각 단계 문서의 "기본값 표"를 따르세요. 기본값 때문에 기존 Space 동작이 달라지면 안 됩니다.
- **하위 호환(필수)**: 기존 프로젝트 파일·`example/*.json`의 Space 문서가 그대로 열리고 같은 소리(베이킹 배열 ≤ 1e-9 차이)가 나야 합니다. 새 필드는 `normalizeSpaceDoc`이 기본값으로 채우고(멱등), 저장 형식은 옛 필드를 지우지 않습니다. 데이터 계약이 바뀌므로 **MINOR 버전 +1**.
- **Manager 규칙**: 렌더러가 `ampMask`를 받는 곳에는 `pitchWarp`도 받아야 합니다(Space는 이미 `ampMask, pitchWarp, brightWarp, voiceMod`를 받음 — 새 경로에서도 유지). Manager 클립 어댑터 계약(`resolve/length/render/key/lines`, `masks`/`scalesTime`)을 깨지 마세요.
- **재생 중 무거운 연산 금지**: 편집 시점에 한 번 베이킹 + 시그니처 캐시 → 재생은 캐시 조회와 `setValueCurveAtTime`뿐. 서명에 포함되지 않는 편집은 재베이킹 0회(음색/baseGain/mute/solo 등)를 유지하고, **재생 중 베이킹 횟수 증가 없음**을 자가진단으로 보여주세요.
- **결정론**: 같은 문서 → 같은 베이킹(비트 단위). 난수는 `createSeededRandom`.
- **파일 크기**: 한 파일 1,500줄 초과 금지(분할). `space-engine.js`(약 780줄)·`space-panels.js`·`space-canvases.js`에 새 기능을 계속 쌓지 말고 새 파일로 분리(`space-spline.js`, `space-lanes.js`, `space-views.js` 등 — 이름은 자유).
- **이중언어(EN/KO)**: 모든 UI 문자열·토스트·도움말. `space-i18n.js`에서 `Object.assign(I18N.en/.ko, …)`로 병합, 컨트롤마다 `data-help="space.xxx"` + `HELP_DB` 항목. `findMissingI18nKeys()`는 `{ missingInKo, missingInEn }`을 돌려줌 — 둘 다 비어야 함.
- **UI 규칙**: **Alt+클릭은 도움말 인스펙터 전용**(어디에도 바인딩 금지). 적용 불가한 기능은 **버튼을 제자리에 두고 꺼진 상태 + 이유 표시**(제거 금지). 슬라이더 드래그 1회 = 실행 취소 1단계(`coalesceKey` + `endHistoryGesture`). 최소 폰트 11px, 다크 테마, 폭 1100px에서 깨짐 없음, 숫자 입력은 `ui/number-scrub.js` 자동 처리, Delete 키 = `deleteSelection`. 새 단축키는 `ui/shortcut-help.js`에 추가.
- **용어**: Studio Engine(`space-engine.js`) / Audio Engine(`space-audio.js`) / Curve Engine(`curve-engine.js`)을 구분. Manager의 Track/Instance/Clip 용어 사용(코드 식별자는 `channel`).

## X3. 회귀·공통 자가진단 (모든 단계)
1. **회귀**: 작업 전 기준선과 비교해 6개 프리셋의 베이킹 배열 최대 차이 ≤ 1e-9, 오프라인 스테레오 렌더 피크/RMS 차이 ≤ 1e-6. 기존 `example/*.json` 중 Space 문서를 쓰는 것이 로드됩니다.
2. `normalizeSpaceDoc`: 멱등(`normalize(normalize(x))` = `normalize(x)`), JSON 왕복 동일, 옛 문서에 새 필드 기본값.
3. 서명 캐시: 서명 밖 편집 → 재베이킹 0회, 서명 안 편집 → 정확히 1회(음원 수만큼이 아니라 영향받는 음원만).
4. 기존 자가진단 전부 + 신규 전부 통과. 신규 항목 이름은 `space-<단계>-…` 접두.

## X4. 개발 서버
`.claude/launch.json`에 `flexatone-space`(포트 8025)가 이미 있는지 확인(없으면 한 항목만 추가). `preview_start`를 먼저 시도하고, 한 폴더에 dev 서버 5개 상한으로 거절되면 이미 떠 있는 다른 포트(`lsof -nP -iTCP -sTCP:LISTEN | grep -i python`; 모두 같은 폴더)의 `http://localhost:<port>/index.html`로 검증하고 그 사실을 보고하세요. 서버 실행에 Bash를 쓰지 마세요.

## X5. 검증 (모두 수행하고 결과 보고)
1. 콘솔에 SyntaxError/ReferenceError/404 모듈 오류 0건.
2. `window.runSelfCheck()` — 기존 N + 신규 M 전부 통과(기준선 N을 먼저 기록).
3. 탭 전환(Glissando → Space → Risset → Field → Space)에서 소리 겹침 없음, 헤더 트랜스포트(Space/Enter/Esc/루프/큐) 동작, 재생 중 편집 안전.
4. 실행 취소/다시 실행, 저장 → 변경 → 불러오기로 문서 복원, "글리산도 보이스로 베이킹" 동작(손실 항목은 토스트·도움말에 명시).
5. WAV 내보내기: 열리는 파일, 0 dBFS 초과 없음, 출력 단계(페이더)가 반영됨(Export WAV = 들리는 소리).
6. EN ⇄ 한국어, Alt+hover 도움말 전 컨트롤, 폭 1100px 레이아웃, 스크린샷 1~2장(새 UI).
7. **Manager 회귀**: Manager를 열어 기존 Space 인스턴스를 추가·재생·내보내기 해도 이전과 같음(B·C 단계는 특히).

## X6. 문서·커밋
- `docs/STUDIO_INTEGRATION_LOG.md` 맨 끝에 절 하나 추가(`## Space extension <단계> — …`): 파일 표, 결정, 문서와 코드가 달랐던 점, 한계, 점검 결과, Manager `params()/signals()` 후보.
- `CHANGELOG.md`: 맨 위(규칙 아래 `---` 바로 아래)에 새 항목. **쓰기 직전에 맨 위를 다시 읽고 다음 번호**를 쓰세요(다른 세션이 동시에 올릴 수 있음). Data 줄에 스키마 변경과 마이그레이션을 적습니다.
- 커밋: `git status --short`로 확인하고 **내 파일만** `git add <파일들>`(절대 `git add .`/`-A` 금지), 메시지 `v0.MINOR.PATCH: <요약>`. **push는 사용자가 명시할 때만.** 공유 파일(`js/main.js`, `js/ui/workspaces.js`, `index.html`, `manager-mixer.js` 등)은 **편집 직전에 해당 위치를 다시 읽고 줄 추가 위주로** 수정하세요. 남이 수정 중인 파일을 커밋에 섞지 말고, 섞일 수밖에 없으면 보고하세요.

## X7. 최종 보고 형식
- 만든/수정한 파일(공유 파일은 추가한 줄 위치), 신규 자가진단 이름과 개수(전/후).
- §X5 각 항목 통과/실패/미검증, 회귀 비교 수치(§X3-1).
- 문서와 코드가 달랐던 점, 설계 결정과 이유, 기본값 표에서 벗어난 것, 알려진 한계.
- 다른 스튜디오가 채택할 공용 모듈 후보, 다음 단계에 넘기는 사항.

## X8. 하지 말 것
- 범위 밖 리팩터링, 다른 스튜디오 동작 변경, 새 의존성/빌드 도구, 남의 미커밋 변경 되돌리기, push, 한 파일 1,500줄 초과, 오디오 스레드에서의 할당(워클릿 사용 시).

---
# 이번 작업
## Space 확장 A — 3D 스플라인 궤적 + 파라미터 레인(엔벨로프 창)

### A0. 한 줄 목표
음원의 궤적을 **노드마다 xyz 좌표와 곡률을 정의하는 3D 곡선**으로 만들 수 있게 하고, 그 **속도와 다른 변수(음고·음량·밝기·음색·공기 흡수·도플러 세기)를 엔벨로프 창에서 자유롭게** 그릴 수 있게 합니다. 대표 시나리오는 **혜성**: 청취자에게 점점 빨라지며 다가와 스쳐 지나간 뒤 점점 느려지며 멀어지는 음원. 이 단계의 소리 출력은 기존 스테레오/HRTF 그대로입니다(HOA는 B, 타임라인·움직이는 청취자는 C).

### A1. 기본값 표 (선택지 정책: 기본값 + 나머지는 기능)
| 결정 | 기본값 | 다른 선택지(기능으로 제공) |
|---|---|---|
| 경로 종류 | 기존 그대로(`line` 등) | 새 `spline`; 기존 종류 → "스플라인으로 변환" 버튼 |
| 스플라인 차원 | `2d`(z = 기존 `h`) | `3d`(노드별 z) |
| 노드 접선 | `auto`(Catmull–Rom, C1 연속) | `free`(in/out 핸들 직접), 모서리(`curv = 0`) |
| 닫힘 | 열린 곡선 | 닫힌 곡선(순환) |
| 끝 동작 | `stop`(끝에서 정지, 기존 draw와 같음) | `loop`(닫힌 곡선), `pingpong` |
| 시간 모드 | `speed`(속도가 시간을 결정, 지속시간은 결과값) | `fit`(지속시간 고정, 속도 프로파일은 상대값으로 정규화). `pinned`는 C에서 추가 |
| 속도 프로파일 | 기존 `const` | 기존 `curve`·`rankine` + 새 `env`(엔벨로프 창) |
| 레인의 x축(도메인) | 속도 = `path`(곡선 진행도), 나머지 = `time`(음원 시계) | `time` / `path` / `distance`(청취자와의 거리) 모두 선택 가능 |
| 레인 y 스케일 | 속도·게인(dB)·밝기(oct) = 선형, 음고(Hz) = 로그 | 레인마다 lin/log 전환 |
| 편집 뷰 | 상단(XY) 1뷰(기존 화면) | 3뷰(상단 XY · 정면 XZ · 측면 YZ) + 원근 뷰 |

### A2. 데이터 모델 (추가분; 옛 필드는 유지)
```js
source.path.type: … | 'spline'
source.path.spline = {
  dims: '2d' | '3d', closed: false, end: 'stop' | 'loop' | 'pingpong',
  nodes: [{ id, x, y, z,                 // m, 2d 모드에서는 z 무시하고 path.h 사용
            curv: 1,                      // 0..2: 접선 크기 배율. 1 = 표준 Catmull–Rom, 0 = 모서리, >1 = 더 부풀림
            tangent: 'auto' | 'free',
            hin: [dx, dy, dz], hout: [dx, dy, dz] }]   // free일 때의 핸들(노드 기준 상대, m)
}
source.timeMode: 'speed' | 'fit'
source.speed.mode: 'const' | 'curve' | 'rankine' | 'env'
source.speed.env = Lane           // unit m/s
source.f.mode: 'const' | 'curve' | 'env' ;  source.f.env = Lane   // Hz, log
source.lanes = { gain: Lane, bright: Lane, timbre: Lane, air: Lane, dopplerAmt: Lane }
source.timbreB = { …timbre 스펙 }            // timbre 레인의 B쪽 음색(공용 timbre-editor 스펙)
listener.z: 0                                 // 청취자 높이(정지). 회전은 기존 headingDeg만(피치·롤은 C)
doc.view3d = { layout: 'top' | 'quad', az, el, dist }   // 뷰 전용(history: false, 서명 밖)

Lane = { on: false, domain: 'time' | 'path' | 'distance',
         dom: null | [a, b],              // x축 범위. null = 자동(time: [0, 지속시간], path: [0, 1], distance: [rMin, rMax])
         min, max, scale: 'lin' | 'log',  // y 범위와 스케일
         curve: CurveObj }                // curve-engine 객체. 자유 편집은 engine 'custom' + customPoints(x∈[0,1] 단조, y∈[0,1], handles)
```
레인 정의(기본 범위): `speed.env` 0.5–60 m/s · `f.env` 55–3520 Hz(log) · `gain` −24…+12 dB(거리 법칙 위에 곱함) · `bright` −3…+3 oct(로우패스 컷오프에 곱함) · `timbre` 0…1(A↔B 모핑) · `air` 0…2(공기 흡수 양; `airDist`를 나눔, 0 = 흡수 없음) · `dopplerAmt` 0…1(`f_obs = f_s · ratio^amt`). `on: false`인 레인은 중립값(게인 0 dB, 밝기 0 oct, 음색 0, air 1, dopplerAmt 1)이며 기존 동작과 같습니다. 기존 효과 토글(`doppler/distanceGain/airAbsorb/pan`)은 그대로 두고, 토글이 꺼지면 해당 레인도 무시합니다.

### A3. 순수 엔진
1. **3D 스플라인 수학은 공용 모듈** `js/modules/spline3d.js`(순수): 큐빅 Hermite 구간, `auto` 접선 = `curv · (P[i+1] − P[i−1]) / 2`(끝 노드는 한쪽 차분, 닫힌 곡선은 순환), `free` 접선 = `hout`/`−hin`. `position(u)`, `derivative(u)`, **호장 표**(구간당 ≥ 256현, 누적 길이 → `u(s)` 역보간), 전체 길이, 최근접점 투영(노드 삽입용), 노드 삽입/삭제/분할 시 곡선 모양 보존(de Casteljau 등가). C에서 청취자 경로에도 그대로 씁니다.
2. `buildGeometry`를 3D로 일반화: 모든 경로 종류가 `P(u) → {x, y, z}`, `D(u) → {x, y, z}`를 반환(기존 종류는 `z = h`, `Dz = 0`). `stateAt(τ)`는 `{x, y, z, vx, vy, vz}`. 거리는 `|X − L|`(3D, `listener.z` 포함). 방향 성분: `lat`, `fwd`는 기존 헤딩 회전, `up = (z − Lz)/r`. `pan = lat / r`(변경 없음).
3. **운동학(시간 모드)**
   - `speed`: 속도 `v`가 정의하는 대로 `s(τ)`를 적분. 도메인별로
     - `time`: `s(τ) = ∫₀^τ v(τ′) dτ′`
     - `path`: `τ(s) = ∫₀^s ds′ / v(u(s′))`
     - `distance`: `τ(s) = ∫₀^s ds′ / v(r(s′))`, `r(s) = |P(u(s)) − L|` (정지 청취자이므로 기하만으로 결정)
     지속시간 = 경로 끝에 도달하는 시각(결과값, UI에 읽기 전용 표시). `v` 하한 0.05 m/s로 0 나눗셈 방지, 지속시간 상한(예: 600 s)과 `MAX_BAKE_SAMPLES` 초과 시 배지 경고.
   - `fit`: 같은 프로파일을 **상대값**으로 보고 전체가 `duration`에 맞도록 스케일. UI에는 결과 평균/최대 속도와 `max(v)/c`를 표시.
   - 기존 초음속 클램프(`0.98·c_eff`)와 배지 유지. 기존 `const/curve/rankine` 경로의 결과는 **비트 단위로 동일**해야 합니다(회귀).
4. **레인 평가**: 모든 레인은 **방출 시각 τ의 양**(음원 시계, 경로 진행도 `u(τ)`, 방출 위치의 거리 `r(τ)`)으로 평가해 **청취 시간 배열**로 베이킹합니다(`b.gainLane, b.brightOct, b.morph, b.airAmt, b.dop` 등). 도플러: `fObs = fs · (1 / (1 + vr/c))^dop`. 서명에 레인·스플라인·`timeMode`·`listener.z`를 포함. `baseGain`/음색 A·B의 내용/mute/solo는 여전히 서명 밖.
5. `solveEmission`은 3D 거리로 일반화(단조성 조건은 그대로: `|v| < c`). 잔차 `< 1e-9 s` 유지.
6. 프리셋 **`Comet Flyby`** 추가(기존 6종은 그대로): 3D 스플라인(쌍곡선 꼴 7–9 노드, 청취자 위쪽 몇 m를 비스듬히 통과), `speed.mode = 'env'`, 도메인 `distance`, 곡선은 vis-viva `v(r) = sqrt(v∞² + 2k/r)`를 샘플링한 custom points(가까울수록 빠름), `cScale` 0.3 근처, `gain`/`bright` 레인으로 접근 시 밝아짐. 그리고 3D 예시 하나(`Helix` — 청취자 주위를 돌며 올라가는 나선) 추가.
7. "스플라인으로 변환": `line/orbit/lissajous/spiral/draw` → 노드(궤적 오차 ≤ 0.5 m 또는 길이의 0.5%가 되도록 노드 수 적응, 상한 64).
8. `sourceToGlissandoVoice`는 스플라인/레인 음원에도 동작(게인 = 거리 게인 × 게인 레인). 손실 안내(`space.bakeLoss`)에 z·밝기·음색 모핑 추가.

### A4. 오디오 (`space-audio.js`)
- 게인 = `baseGain × 거리 게인 × 게인 레인`, 컷오프 = `lp × 2^brightOct`(800–20000 Hz 클램프), `air` 레인은 베이킹 단계에서 `lp`에 반영.
- **음색 모핑**: `timbre` 레인이 켜진 음원만 오실레이터 2개(A, B; 같은 주파수 곡선)를 equal-power 크로스페이드(`cos/sin` 곡선). 꺼져 있으면 기존처럼 오실레이터 1개(노드 수 증가 없음을 확인).
- HRTF 모드는 이미 `pan/up/fwd` 3축을 쓰므로 3D 궤적의 고도가 반영됩니다. 스테레오 모드는 좌우만.
- 오프라인 렌더·라이브 재스케줄(12 ms 크로스페이드, 45 ms 스로틀)·Manager 어댑터(`ampMask/pitchWarp/brightWarp/voiceMod`)에서 같은 스케줄러를 쓰는 구조 유지.

### A5. 공용 UI — 엔벨로프 창 (`js/ui/envelope-window.js`, 공용 모듈)
- 먼저 Glissando의 게인 곡선 편집기(점 + 베지어 핸들 편집)를 읽고 **재사용 가능한지 판단**하세요. 그대로 떼어 쓸 수 있으면 얇게 감싸고, 결합이 심하면 같은 조작 문법으로 새 공용 컴포넌트를 만듭니다(기존 Glissando 코드는 수정하지 않음). 어느 쪽인지 보고.
- API(예): `createEnvelopeWindow({ title, get, set, x: { label, unit, range, domains?, getDomain, setDomain }, y: { label, unit, min, max, scale }, overlay?(ctx, map), help })` → `{ root, sync(), destroy() }`. 랙에 접힌 미니 미리보기(스파크라인) + 클릭하면 펼쳐지는 큰 편집 창(캔버스 높이 조절은 `ui/canvas-size.js`).
- 기능: 곡선 엔진 프리셋 선택(시작 모양) → "점으로 변환"(`captureCurveToCustomPoints`) → 점 추가/이동/삭제, 핸들 드래그, 구간 곡률, 가로/세로 스냅, 반전(`reverse`)/뒤집기(`inverse`), 초기화, 복사/붙여넣기(레인 간), 축 눈금에 **실제 단위**(m/s, Hz, dB, s, m) 표시, 커서 읽기값. 드래그 1회 = 실행 취소 1단계.
- **오버레이**: 레인 창 뒤에 참고 곡선을 흐리게 표시 — 시간 도메인이면 `r(τ)`(거리)와 최근접 시각 표시선, 경로 도메인이면 노드 위치 눈금, 거리 도메인이면 접근/이탈 구간. 재생 중에는 현재 위치 표시선.
- 도메인을 바꿔도 곡선 모양은 그대로 두고 x축 의미만 바뀝니다(자동 변환 버튼 "모양 유지하며 도메인 변환"은 선택 기능: 현재 운동학으로 리샘플).

### A6. Space UI
1. **경로 랙**: 경로 종류에 `spline` 추가, 차원(2D/3D)·닫힘·끝 동작·"스플라인으로 변환". **노드 인스펙터**(선택한 노드의 x, y, z, 곡률, 접선 모드, 핸들 초기화, 노드 앞/뒤 삽입, 삭제; 숫자 입력).
2. **뷰**: `top`(기존 화면 그대로)과 `quad`(상단 XY · 정면 XZ · 측면 YZ · 원근) 전환. 세 정사영 뷰에서 노드·핸들 드래그(각 뷰는 자기 평면의 두 좌표만 바꿈), 경로 위 더블클릭 = 노드 삽입, Delete = 선택 노드 삭제, 다중 선택(⇧), 휠 줌/팬은 `ui/view-nav.js` 문법. **원근 뷰**는 canvas2D 궤도 카메라(드래그 = 회전, 휠 = 거리), 바닥 격자, 노드에서 바닥으로 내리는 **수직 낙하선**과 바닥 그림자 경로로 깊이를 보여주고, 재생 시 음원·들리는 위치(지연된 위치)·속도 벡터를 그립니다. 편집은 정사영 뷰에서만(원근 뷰는 보기 전용 + 노드 클릭 선택). 뷰 좌표 변환·피킹은 순수 함수(`space-views.js`)로 분리해 자가진단 가능하게.
3. 파면 링은 각 정사영 뷰에서 **구와 그 평면의 단면 원**으로 그립니다(상한 24 유지).
4. **레인 랙**: 속도·음고는 기존 프로파일 랙의 모드 세그먼트에 `env` 추가, 나머지 레인(게인·밝기·음색·공기·도플러 세기)은 새 "Lanes" 랙에 켜기 토글 + 엔벨로프 창. 음색 레인이 켜지면 음색 B 편집기(공용 `createTimbreEditor`) 표시.
5. 시간 모드 세그먼트(`speed`/`fit`), 결과 읽기값(지속시간, 경로 길이, 평균·최대 속도, `max(v)/c`, 최근접 거리와 시각).
6. 관측 곡선 패널의 미니 곡선 스택에 레인 결과(게인 합성, 컷오프) 반영. 스크린샷/클린 차트(`ui/clean-chart.js`)는 기존 선 그대로.
7. 좁은 창에서는 quad 뷰가 2×2 → 세로 적층으로 바뀝니다.

### A7. 자가진단 (최소; 이름 접두 `space-a-`)
- 스플라인: 2노드 직선 길이 = 유클리드 거리(1e-9), `auto` 노드에서 접선 방향 연속(각도 차 < 1e-6), `curv = 0`/`free` 불일치에서만 꺾임, 호장 역보간 `u(s(u)) = u`(1e-6), 노드 삽입 후 곡선 최대 편차 < 1e-6 m, 닫힌 곡선의 시작 = 끝.
- 등가성: 2노드 스플라인(−150,5,0)→(150,5,0)의 베이킹이 기존 `line` Pass-by와 일치(`fObs` 상대 1e-9). 기존 `orbit` → 스플라인 변환의 `fObs` 차이 ≤ 0.5%.
- 3D: 높이 z로 지나가는 직선의 최근접 거리 = `sqrt(d² + z²)`, `up` 부호, 솔버 잔차 < 1e-9(스플라인 3종 × cScale 1/0.3).
- 운동학: `speed` 모드에서 `∫v dτ` = 경로 길이(상대 1e-6)를 세 도메인 모두에서, `fit` 모드에서 지속시간 = `duration`(1e-9)이고 속도 비율이 프로파일과 일치, 속도 상수일 때 `path` 도메인 레인 = `time` 도메인 레인(1e-9).
- 레인: 게인 레인 −6 dB → 게인 ×0.5012, `dopplerAmt = 0` → `fObs = fs`, `= 1` → 기존 식, 밝기 +1 oct → 컷오프 ×2(클램프 안), 레인 `on: false` → 기존과 비트 동일.
- Comet: 최근접 시각에 속도 최대, 접근 구간에서 `r`이 줄수록 `v` 단조 증가, 통과 전 `fObs > fs`·통과 후 `fObs < fs`, 초음속 클램프 미발동.
- 서명: `baseGain`/음색 내용/mute → 0회, 레인 점 이동 → 1회, 노드 드래그 → 해당 음원 1회.
- 뷰: 세계↔뷰 좌표 왕복(1e-9), 세 뷰 각각에서 노드 피킹, 원근 투영의 앞뒤 순서.
- 오디오(비동기): 음색 레인 0→1 오프라인 렌더에서 스펙트럼 중심이 A값 → B값으로 이동, 레인 꺼진 음원의 노드 수 = 기존.
- §X3 공통 항목.

### A8. 완료 기준
1. `Comet Flyby`를 열면 접근하며 빨라지고 음고가 올라가다 통과 순간 급강하, 멀어지며 느려지는 것이 관측 곡선과 오프라인 렌더(순간 주파수)에 나타납니다.
2. quad 뷰에서 노드를 세 평면으로 끌어 3D 곡선을 만들고, 곡률·핸들을 노드마다 바꿀 수 있습니다(재베이킹 < 100 ms, 음원 8개).
3. 속도 엔벨로프의 도메인을 time/path/distance로 바꿔 같은 궤적에서 다른 결과를 듣고 볼 수 있습니다.
4. 기존 프리셋·프로젝트는 소리와 화면이 그대로입니다.
5. §X5 전부 통과.

### A9. 위험/주의
- 호장 표 해상도가 낮으면 속도 리플 → 도플러 음고에 미세한 떨림. 구간당 256현 이상 + 역보간은 선형이 아니라 구간 내 뉴턴 1회 보정을 검토하고, `fObs`의 2차 차분 잡음을 실측해 보고.
- 노드의 꺾임(C0)은 `v_r`의 불연속 = 음고 스텝입니다. 의도된 물리(급선회)이지만 클릭이 나지 않도록 주파수 곡선은 베이킹 표본 사이를 선형 보간합니다.
- `distance` 도메인은 청취자를 옮기면 운동학 전체가 바뀝니다(서명에 청취자 포함 — 이미 그렇습니다).
- 음색 모핑은 오실레이터 수를 두 배로 늘립니다. 음원 상한(기존 값 확인)과 CPU를 보고.
