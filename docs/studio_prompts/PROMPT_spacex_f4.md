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
## Space 후속 F4 — Manager 모듈레이션·씬 연동 + 물리 확장(변하는 음속, 초음속)

전제: 확장 C 완료. 두 부분은 독립입니다(F4-a는 Manager 쪽, F4-b는 순수 엔진). 한 챗에 하나씩 권장.

### F4-a. Manager Modulation / Scenes 연동
- `docs/STUDIO_INTEGRATION_LOG.md`의 "Manager Modulation (A2·A3·A4)"와 Space 절 끝의 **Manager candidates**를 읽고, Space(인스턴스와 Space Master 둘 다)를 모듈레이션 매트릭스의 **목적지와 출처**로 등록합니다.
  - `params()`(목적지): `cScale`, `airDist`, 청취자 x/y/z/yaw, 음원별 `baseGain`, 속도 배율, 궤적 변환(이동·회전·배율 — 노드를 직접 흔들지 않고 경로 전체에 거는 변환), 레인 오프셋, `wet`.
  - `signals()`(출처): 음원별 `r(t)`, `v_r(t)`, 방위/고도, `fObs/fs`, 최근접 통과 이벤트(트리거), 도착/이탈 시각.
  - 베이킹이 필요한 파라미터를 모듈레이션하면 재생 중 재베이킹이 생깁니다. **베이킹 없이 걸 수 있는 것**(게인, 컷오프, 방향 회전, wet, 폭)과 **재베이킹이 필요한 것**(음속, 경로)을 구분하고, 후자는 문서 단위 사전 렌더(`applyDocMods` 방식)로만 허용하세요.
- **씬**: 씬마다 Space Master의 상태 스냅샷(위치 프리셋, wet, 출력 모드)을 저장하고 씬 전환 시 지정 시간 동안 보간(위치는 직선이 아니라 청취자 기준 구면 보간 선택 가능). 기본 = 씬은 Master를 건드리지 않음.
- MIDI Learn(`ui/midi-learn.js`)이 새 컨트롤에 동작하는지 확인.
- 자가진단: 등록된 목적지/출처 목록, 베이킹 없는 목적지의 재베이킹 0회, 통과 트리거 시각 = 최근접 시각(±1 표본), 씬 보간의 끝점.

### F4-b. 물리 확장
- **변하는 음속 `c(t)`**(타임라인 오토메이션): 전파 중 음속이 바뀌는 균질 매질에서 지연 조건은 `∫_{τ}^{t} c(t′) dt′ = |X(τ) − L(t)|`. 누적 `C(t) = ∫c`의 표를 만들고 `C(t) − C(τ) = r`을 풉니다(단조성 조건 재검토, 솔버 잔차 자가진단). 주파수 비도 이 식의 미분으로 다시 유도해 수치 미분과 대조. 기본 = 상수 `c`(기존과 비트 동일).
- **초음속**: `|v| ≥ c`에서 지연 시간 해가 여러 개(또는 없음)입니다. 클램프 대신 (1) 모든 근을 찾아 각각을 별도 도착으로 합성(뒤에서 오는 소리가 거꾸로 들리는 구간 포함), (2) 마하 원뿔이 청취자를 지나는 시각에 충격파(N파) 임펄스를 더하는 "Sonic boom" 선택지. 기본 = 기존 클램프. 근 추적의 수치 안정성(근의 생성/소멸 지점)과 `setValueCurveAtTime`으로 표현 가능한지(시간 역행 구간은 버퍼 역재생 필요)를 먼저 검토하고, 무리면 설계 보고서만 내고 멈추세요.
- 시각화: 마하 원뿔, 근별 "들리는 위치" 여러 개.
- 자가진단: 상수 `c`에서 기존과 동일, 계단형 `c(t)`의 해석해 대조, 초음속 직선 통과의 근 개수(원뿔 통과 전 0 → 후 2), 붐 도착 시각 = 해석값.
