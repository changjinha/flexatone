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
## Space 확장 C — 타임라인·움직이는 청취자 + Manager의 Space Master

### C0. 한 줄 목표
(1) Space에 **타임라인**을 주어 **청취자와 음원의 위치·방향·파라미터를 시간에 따라 오토메이션**하고(청취자도 3D 곡선을 따라 움직임), (2) Manager에 **Space Master**라는 전용 자리를 만들어 **최종 출력에 공간 효과를 입히는 마스터 트랙**처럼 쓸 수 있게 합니다. Space는 "스튜디오 추가" 목록에 그대로 남고(일반 인스턴스), Space Master는 그와 별개의 자리입니다. 전제: 확장 A, B 완료. 세 단계(C1 → C2 → C3)로 나누어, 단계마다 자가진단 통과 후 다음으로 갑니다.

### C-기본값 표
| 결정 | 기본값 | 다른 선택지(기능) |
|---|---|---|
| 청취자 | 정지(기존) | 경로를 따라 이동(스플라인) |
| 청취자 방향 | 고정 요(yaw = `headingDeg`) | 레인(yaw/pitch/roll) · 진행 방향을 봄 · 지정한 음원을 봄 |
| 음원의 시간 모드 | A/B의 기본(`speed`/`fit`) | `pinned`(노드에 시각을 고정, 구간 속도는 결과값) |
| 타임라인 표시 | 접힌 상태(기존 화면 유지) | 펼치면 트랙 편집 |
| Space Master | 꺼짐(믹서 그래프는 지금과 동일) | 켜짐 |
| Master 라우팅 | 트랙마다 음원 하나 | 전체 믹스를 음원 하나로 · 트랙별 우회(dry) |
| 새 트랙의 초기 위치 | 정면 호(±60°, 8 m)에 고르게, 정지 | 프리셋(원형 배치, 느린 공전, 좌→우 통과) |
| Master의 음원 시계 | 트랙의 클립 시간(템포에 잠김) | 사이클 시간(전체 믹스 음원은 항상 이것) |
| Master 출력 모드 | 스테레오(equalPower) | HRTF · 바이노럴(HOA) |
| Dry/Wet | 100% wet | 0…100% |

---
### C1. 움직이는 청취자 (순수 엔진)
1. **데이터**: `listener = { x, y, z, headingDeg, pitchDeg: 0, rollDeg: 0, move: { on: false, path: { spline… }, speed: {…}, timeMode, start: 0, duration }, orient: { mode: 'fixed' | 'lanes' | 'velocity' | 'lookAt', lookAt: sourceId, yaw: Lane, pitch: Lane, roll: Lane } }`. `move.on = false`이면 기존과 비트 동일(회귀).
2. **지연 시간 방정식**: 청취 시각 `t`에서 `g(τ) = τ + |X(τ) − L(t)| / c − t = 0`. `L(t)`는 `t`에서 고정이므로 `|v_S| < c`이면 `g`는 여전히 단조 → 기존 뉴턴 + 이분 구조 유지.
3. **주파수 비**: `R = X(τ) − L(t)`, `n̂ = R/|R|`로 두면 음함수 미분에서
   `dτ/dt = (1 + n̂·v_L(t)/c) / (1 + n̂·v_S(τ)/c)`, `f_obs = f_s(τ) · (dτ/dt)^dop`.
   청취자 속도도 `0.98·c_eff`로 클램프(배지). 이 식을 **풀린 `τ(t)`의 수치 미분과 대조**하는 자가진단을 반드시 넣으세요.
4. **방향**: 청취자 좌표계 = yaw → pitch → roll 회전 행렬(직교성 자가진단). `velocity` 모드는 진행 방향을 정면으로(속도 0이면 직전 값 유지), `lookAt`은 지정 음원의 **들리는 위치**(지연된 위치)를 정면으로.
5. **지연선 `D(t) = t − τ(t)`** 는 그대로 성립(B의 체인 재사용). 베이킹 구간의 시작/끝 시각도 청취자 이동을 반영해 다시 구합니다.
6. A의 `distance` 도메인 속도는 청취자가 움직이면 기하만으로 풀리지 않습니다. 이 경우 `ds/dτ = v(|P(u(s)) − L(τ)|)`를 베이킹 주기로 전진 적분(RK4)하세요(방출 시각의 청취자 위치 기준 — 도움말에 명시).
7. 서명에 청취자 경로·방향 레인 포함. 청취자 노드 드래그 → 전 음원 재베이킹(음원 8개에서 < 150 ms 목표, 실측 보고).

### C2. 타임라인
1. **노드 시각 고정(`timeMode: 'pinned'`)**: 스플라인 노드에 `t: null | 초`. 고정된 노드들의 `(t_i, s_i)`를 **단조 큐빅(Fritsch–Carlson, `math-utils`)** 으로 이어 `s(τ)`를 만듭니다(속도 ≥ 0, 연속). 첫/마지막 노드는 자동 고정(시작 = 0, 끝 = 지속시간), 사이의 고정되지 않은 노드는 호장 비율로 지나갑니다. 시각이 뒤집히면 저장하지 않고 경고. 이 모드에서 속도는 결과값(엔벨로프 창에 읽기 전용 곡선으로 표시). 청취자 경로에도 같은 모드.
2. **타임라인 패널**(Space 작업 공간 아래, 접기 가능; 시간축은 문서 시간 0…`length`, 헤더 트랜스포트의 큐·플레이헤드·루프와 `ui/transport-lines.js`·`ui/view-nav.js` 공유):
   - **음원 트랙**: 클립 블록(`start`, 지속시간) 드래그/리사이즈, 그 아래 켜진 레인을 **문서 시간으로 투영한 미리보기 곡선**(편집은 엔벨로프 창; `time` 도메인 레인은 타임라인에서 직접 점 편집 가능). `pinned` 음원은 노드 핀을 블록 위 마커로 보여주고 좌우로 끌어 시각을 바꿉니다.
   - **청취자 트랙**: 이동 클립, yaw/pitch/roll 레인, 방향 모드.
   - **전역 트랙**: 마스터 트림(dB) 레인, `airDist` 레인, 마커(이름 붙은 시각), 루프 구간(헤더 루프와 연동).
   - 스냅(마커·클립 경계·격자), 다중 선택 이동, 드래그 1회 = 실행 취소 1단계.
3. **전역 오토메이션 범위**: `c`/`cScale`은 **오토메이션하지 않습니다**(전파 중 음속이 바뀌면 지연 시간 방정식이 달라짐 — 후속 과제). `airDist`와 마스터 트림은 청취 시각 기준으로 적용.
4. Manager의 Scenes·Modulation과 **중복 구현하지 말 것**: 먼저 `core/manager-scenes.js`, `audio/scene-player.js`, `core/manager-mods.js`, `audio/mod-sources.js`, Manager의 사이클 타임라인 UI를 읽고, 재사용 가능한 조각(시간 눈금 그리기, 클립 드래그 문법, 범위 선택)을 가져다 쓰세요. Space 타임라인은 **Space 문서 안의 시간**만 다룹니다.
5. 재생헤드에 따라 3뷰·원근 뷰의 청취자 아이콘(방향 표시)과 음원이 함께 움직입니다. 청취자 경로는 음원과 같은 스플라인 편집기로 편집(청취자를 선택하면 경로 랙이 청취자 경로를 보여줌).
6. 프리셋 2개: `Fly-through`(정지 음원 4개 사이를 청취자가 지나감), `Chase`(청취자가 `lookAt`으로 혜성을 따라 봄).

### C3. Manager — Space Master
**개념**: Manager의 각 트랙 출력(페이더 뒤)을 Space의 음원 입력으로 받아, Master 문서에 정의된 궤적대로 공간화한 뒤 출력 버스로 보냅니다. 트랙 = 음원. 믹서의 현재 그래프는 `source → gates → chGain → analyser → getOutputBus(ctx)`이고, Master가 켜지면 `analyser →` 다음이 **Space Master 입력**으로 바뀝니다(Loudness Manager/출력 페이더·분석 탭은 그 뒤에 그대로).

1. **데이터(프로젝트에 저장, 실행 취소 가능)** — 권장안: `_sends`, `_tempo`처럼 문서와 분리된 키 `appState.studioParams._spaceMaster = { on: false, wet: 1, mode: 'tracks' | 'mix', routes: { [instId]: { sourceId, bypass: false } }, doc: <Space 문서> }`. `doc.sources[i].input = { kind: 'track', instId }` 또는 `{ kind: 'mix' }`. 이 구조가 기존 저장/실행 취소/인스턴스 포커스와 충돌하는지 코드를 읽고 판단하고, 더 안전한 대안(예: `appState.manager.spaceMaster`)이 있으면 그쪽으로 하고 이유를 보고하세요. **특수 Space 인스턴스로 만드는 방식은 권장하지 않습니다**(인스턴스를 순회하는 모든 곳 — 사이클 길이, 씬, Extend/Interpolate, 내보내기 — 에서 걸러내야 함).
2. **편집 동선**: Space 탭 헤더에 문서 전환 칩 `Studio | Master`. `getSpaceParams`/`editSpace`가 유일한 문서 접근점인지 확인하고, 그 한 곳에서 대상 문서를 바꾸세요(Master 편집 중에는 헤더에 눈에 띄는 "MASTER" 배지). Master 문서에서 음원 줄은 Manager 트랙 목록과 동기화됩니다(트랙 추가 → 기본 위치의 음원 자동 생성, 삭제 → 음원 제거, 복제 → 음원도 복제, 이름·색은 트랙을 따름). 음원 수동 추가는 `mix` 음원과 일반 음원(synth/import) 모두 가능.
3. **Manager UI의 전용 자리**: 마스터 영역(Master View 카드 근처, 트랙 목록 위)에 **Space Master 스트립**: 전원, Dry/Wet, 라우팅 모드(트랙별/전체 믹스), 출력 모드·차수, `Space에서 편집 ↗`, `ambiX로 사이클 내보내기`. 각 트랙 스트립에는 작은 **⌖ 칩**(공간화 켬/우회, 음원 색 점). "스튜디오 추가" 목록과 일반 Space 인스턴스는 변경 없음.
4. **오디오** `js/audio/space-master.js`(오디오 계층):
   - 트랙마다 B의 공간화 체인(지연선 → 로우패스 → 게인 → 방향 단계)을 만들고 입력에 트랙의 `analyser` 출력을 연결. 방향 단계의 합 → (HOA면 디코드) → `getOutputBus(ctx)`. Dry 경로는 `1 − wet`.
   - 믹서 쪽 변경은 **작은 훅**으로: 트랙 출력의 연결 대상을 고르는 함수 한 곳, 그리고 클립이 (재)시작되는 시점(`ctx` 시각, 클립 내 오프셋, 재생 배속)을 알려주는 콜백. `manager-mixer.js`는 다른 세션도 고치는 공유 파일이므로 편집 직전에 다시 읽고 최소한으로 추가하세요. 순환 import 금지(레지스트리/훅 패턴).
   - **음원 시계**: 기본은 트랙의 **클립 내용 시간**(클립 시작 = 음원 시계 0, 루프하면 다시 0). **요구 사항: 템포를 바꿔도 공간 운동이 소리에 잠겨 있어야 합니다**(배속 2에서 실시간 `t`의 위치 = 배속 1에서 `2t`의 위치). 지연선 길이는 실시간 초로 환산. `mix` 음원과 "사이클 시간" 옵션은 `getCyclePosition()`의 사이클 시계를 따르고 사이클 루프에서 되감깁니다. 프리 런치(씬 포함) 트랙은 런치 시각이 시계 0.
   - 궤적 편집 → 해당 트랙 체인의 곡선만 재스케줄(크로스페이드), 켜기/끄기·wet 변경은 클릭 없이 램프.
   - **꺼져 있으면 노드를 하나도 추가하지 않습니다**(그래프가 지금과 동일 — 회귀 자가진단).
5. **오프라인**: Manager의 사이클 내보내기(약 1425행의 오프라인 믹스)에서 Master가 켜져 있으면 같은 체인 빌더로 파트마다 공간화합니다. 스테레오 내보내기 = 들리는 그대로, 추가로 ambiX 사이클 내보내기(B의 인코더).
6. **에디터 미리듣기**: Space 탭에서 Master 문서를 재생하면 `track` 음원을 B의 `import` 경로(인스턴스 버퍼)로 렌더해 들려줍니다(Manager를 재생하지 않아도 편집 가능). 같은 체인·같은 베이킹이므로 Manager에서 듣는 것과 공간 운동이 일치합니다.
7. Master 문서에도 C1·C2(청취자 이동, 타임라인)가 그대로 동작합니다. 타임라인의 시간축은 `mix`/사이클 시계 음원에는 사이클 시간, 트랙 시계 음원에는 클립 시간임을 트랙 머리에 표시.
8. Warp 트랙(무음)·뮤트된 트랙·범위 뮤트: 소리가 안 나는 트랙은 체인만 유지하고 비용이 없게. 트랙 수 상한에서의 CPU(HOA 3차, 트랙 12개)를 실측 보고.

### C4. 자가진단 (접두 `space-c-`)
- 청취자: `move.on = false` → A/B와 비트 동일; 솔버 잔차 < 1e-9(청취자·음원 모두 이동); `dτ/dt` 해석식 vs 수치 미분(상대 1e-4); 정지 음원으로 다가가는 청취자 `f_obs = f_s (1 + v_L/c)`; 같은 속도로 나란히 가는 음원·청취자 → `f_obs = f_s`; 회전 행렬 직교; yaw +90°에서 오른쪽 음원이 정면; `velocity`/`lookAt` 모드의 정면 방향.
- pinned: 고정 노드를 정확한 시각에 통과(위치 오차 < 1e-3 m), `s(τ)` 단조, 속도 연속·비음수, 뒤집힌 시각 거부.
- 타임라인: 클립 드래그 = `start` 변경 1단계, 마커 스냅, 루프 구간 ↔ 헤더 루프, 전역 트림 −6 dB 구간의 렌더 레벨, 접힌 상태에서 기존 레이아웃과 동일.
- Master 데이터: 트랙 추가/삭제/복제 시 `routes`·음원 동기화, 고아 정리, 저장/불러오기·실행 취소 복원, `normalize` 멱등.
- Master 오디오: 꺼짐 → 믹서 노드 수·오프라인 사이클 렌더가 작업 전과 동일(1e-7); `wet = 0` → 꺼짐과 동일(1e-6); 음원 하나를 정면 기준 거리에 정지시키면 스테레오 모드에서 레벨 보존(±0.5 dB); 왼쪽 정지 음원 → 왼쪽 채널 우세; 움직이는 음원의 오프라인 사이클 렌더에서 도플러 비 일치(1%).
- 시계 잠금: 배속 2의 위치(t) = 배속 1의 위치(2t)(베이킹 조회 수준에서 1e-9).
- ambiX 사이클 내보내기: 채널 수·헤더.
- Manager 기존 자가진단 전부 통과(회귀), §X3 공통 항목.

### C5. 완료 기준
1. 청취자가 곡선을 따라 움직이며 정지·이동 음원 사이를 지나가는 장면이 재생·내보내기 됩니다(도플러에 청취자 속도 반영).
2. 타임라인에서 음원/청취자 클립, 노드 시각, 레인을 한 화면에서 조정할 수 있습니다.
3. Manager에서 Space Master를 켜면 각 트랙이 공간 속 음원이 되어 최종 출력이 공간화되고, 끄면 이전과 완전히 같습니다. 사이클 WAV 내보내기에 반영됩니다.
4. §X5 전부 통과(Manager 회귀 포함).

### C6. 위험/주의
- 이 단계는 큽니다. 시간이 모자라면 **C1 → C3 → C2** 순으로 우선하고(타임라인 UI의 일부를 뒤로), 하지 못한 것을 "하지 않은 것"에 정확히 적으세요. 반쯤 된 UI를 켜 둔 채 끝내지 마세요(꺼진 상태 + 이유).
- 라이브 트랙에 지연선을 걸면 **인과적 지연**이 생깁니다(거리 34 m ≈ 0.1 s). 이는 물리이지만 리듬 정렬이 필요한 음악에서는 문제일 수 있으므로 Master에 "도착 지연 보정"(가장 가까운 음원의 최소 지연을 전 트랙에서 빼기) 토글을 기본 켬으로 두고 도움말에 설명하세요.
- Risset 등 라이브 엔진 트랙은 버퍼가 아니라 실시간 신호입니다. Master는 `analyser` 뒤의 신호를 받으므로 그대로 동작해야 합니다(확인 후 보고).
- 사이클 루프 경계에서 지연선에 남은 꼬리와 곡선 재스케줄의 이음매를 확인(클릭 없음을 오프라인 렌더의 불연속 검사로).
- 템포 테이프 모드(바리스피드)는 트랙 소리의 음고를 이미 바꿉니다. 공간 도플러는 그 위에 곱해집니다.
