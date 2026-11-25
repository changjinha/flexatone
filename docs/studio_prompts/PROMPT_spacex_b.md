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
## Space 확장 B — HOA 공간 출력 + 다른 스튜디오의 소리 가져오기

### B0. 한 줄 목표
(1) Space의 출력단에 **고차 앰비소닉스(HOA)** 를 넣어 헤드폰 바이노럴 모니터링과 **ambiX 다채널 내보내기**를 가능하게 하고, (2) 이 스튜디오의 가장 강력한 쓰임새인 **"다른 스튜디오에서 만든 소리를 음원으로 불러와 공간 속에서 움직이기"** 를 구현합니다. 불러온 소리는 원본 스튜디오 문서를 고치면 **자동으로 따라옵니다**(버튼 없이). 전제: 확장 A 완료.

### B1. 기본값 표
| 결정 | 기본값 | 다른 선택지(기능) |
|---|---|---|
| 출력 모드(`panMode`) | `equalPower`(기존 스테레오) | `hrtf`(기존, 음원별 PannerNode) · `binaural`(HOA → 가상 스피커 → HRTF) |
| HOA 차수 | 3 (16채널) | 1 · 2 · 4 |
| 디코드 가중 | `maxre` | `basic` · `inphase` |
| 내보내기 | 들리는 스테레오 WAV(기존) | ambiX WAV(ACN/SN3D, float32) |
| 음원의 소리 | `synth`(기존 오실레이터) | `import`(다른 스튜디오 인스턴스의 소리) |
| 가져온 소리의 갱신 | **라이브 링크**(원본 편집 → 자동 재렌더 → 핫스왑) | `freeze`(샘플 라이브러리에 고정, 프로젝트에 저장) |
| 가져온 소리의 내용 | 인스턴스 문서의 소리(트랙 효과 없이, 배속 1) | "Manager에서 들리는 그대로"(트랙 페이더·템포·워프 포함) |
| 스테레오 원본 | 모노 합(점음원) | (좌우 분리 2음원은 후속 과제) |
| 가져온 음원의 시간 모드 | `fit`(궤적이 소리 길이에 맞음) | `speed`(A의 기본) |
| 소리가 궤적보다 짧을 때 | `once`(한 번 재생 후 무음) | `loop` |
| 음원 폭(`width` 레인) | 0(점) | 0…1 (HOA 모드에서만 동작) |

### B2. 왜 "베이킹 + 핫스왑"인가 (설계 결정 — 확인 후 다르면 보고)
다른 스튜디오의 소리는 이미 Manager가 **인스턴스 문서를 AudioBuffer로 렌더해 캐시하고, 편집 후 약 0.25 s 뒤 재렌더해 재생 중 핫스왑**하는 방식으로 다룹니다(`manager-mixer.js` 머리말, `studio-clips.js` 어댑터, Glissando/Field/Risset 전용 경로). Space도 같은 렌더 결과를 **버퍼로 받아** 공간화 체인에 넣습니다. 이유: 스튜디오마다 합성 방식이 달라(오실레이터 스케줄, 워클릿, 라이브 엔진) 임의의 스튜디오 그래프를 실시간으로 끌어오는 공통 경로가 없고, 버퍼는 오프라인 렌더·내보내기와도 일치합니다. **공간화(위치·도플러·거리)는 재렌더 없이** 베이킹 배열만 바꿔 100 ms 안에 반영합니다. 즉 "소리 캐시"와 "운동학 캐시"는 서명이 분리됩니다. (Manager 트랙의 **진짜 라이브 신호**를 받는 경로는 C의 Space Master에서 다룹니다.)

### B3. 공간화 체인의 일반화 (`space-audio.js` + 공용 `js/audio/spatial-chain.js`)
임의의 오디오 입력을 음원으로 쓰려면 주파수 곡선 대신 **가변 지연선**이 필요합니다.
```
입력(오실레이터 | 버퍼 | (C) 라이브 트랙)
  → [지연선 DelayNode: delayTime ← D(t)]     // 입력이 synth면 생략(기존 fObs 곡선이 같은 물리)
  → 로우패스(공기 흡수 × 밝기 레인) → 게인(거리 × 레인 × baseGain)
  → 방향 단계: StereoPanner | PannerNode(HRTF) | HOA 인코더
```
- **지연 곡선**: `D(t) = t − t_e(t)` — 베이킹에 이미 있는 `b.t`, `b.te`에서 그대로 나옵니다. 지연선을 통과한 신호의 순간 재생 비율은 `1 − dD/dt = dt_e/dt`로, 기존 `fObs/fs`와 같은 값입니다(자가진단으로 확인).
- 입력 버퍼는 음원 시계 0(문서 시각 `start`)에서 재생을 시작하고, 지연선이 도착 지연을 만듭니다. `maxDelayTime = min(180, max(D) + 1)`.
- `doppler` 토글 off: `D(t) ≡ D(t0)`(상수 지연 → 음고 변화 없음). `dopplerAmt` 레인: `D_eff = D0 + amt · (D − D0)`.
- DelayNode의 a-rate 보간 품질을 **실측**하세요(440 Hz 사인을 Pass-by로 통과시켜 순간 주파수 오차와 THD). 오차가 크면 버퍼 입력에 한해 `playbackRate` 곡선(= `dt_e/dt`) 방식으로 바꾸거나 작은 워클릿 보간 지연선을 쓰고, 선택과 수치를 보고하세요.
- 이 체인 생성 함수는 **입력 노드와 베이킹 배열을 받아 출력 노드를 돌려주는 순수한 그래프 빌더**로 만들고(라이브/오프라인/Manager 어댑터/C의 Space Master가 공유), `ampMask/pitchWarp/brightWarp/voiceMod`가 기존과 같은 자리에 들어가게 합니다(가져온 소리에서 의미 없는 것은 무시하고 이유를 주석으로).

### B4. 앰비소닉스 (공용 순수 모듈 `js/modules/ambisonics.js` + 오디오 `js/audio/hoa-bus.js`)
1. **규약**: ambiX = **ACN 채널 순서, SN3D 정규화**, 좌표 X = 앞, Y = 왼쪽, Z = 위. Space 좌표와의 대응: 베이킹의 `fwd → X`, `−lat(= −pan 방향) → Y`, `up → Z` (청취자 헤딩이 이미 적용된 청취자 좌표계). 음원 방향을 청취자 좌표계로 돌린 뒤 인코딩하므로 음장 회전 행렬(Wigner-D)은 필요 없습니다.
2. `shCoeffs(order, x, y, z) → Float64Array((order+1)²)`: 실수 구면조화, 차수 0–4, 점화식 또는 닫힌 식(검증 가능하게). `orderWeights(order, kind)`(`basic`/`maxre`/`inphase`), `widthWeights(order, width)`: 차수 l에 `exp(−l(l+1)σ²/2)`, `σ = width · π/2`(구면 가우시안 블러; W 성분은 1 유지).
3. **인코딩**: 음원마다 `(N+1)²`개 GainNode(또는 워클릿 1개)로 모노 신호에 계수 곡선을 곱해 N채널 버스에 합칩니다. 계수 곡선은 베이킹의 방향 배열에서 **스케줄 시점에** 계산(차수·가중·폭 변경은 재베이킹 0회). 방향 배열은 정규화된 3성분을 그대로 씁니다(각도 래핑 문제 없음).
4. **디코딩(바이노럴)**: HOA 버스 → 가상 스피커 K개(고정 방향, 구 위에 고르게) → 스피커마다 고정 위치의 `PannerNode(HRTF, rolloff 0)` → 스테레오. 디코드 행렬은 모드 매칭(정규화 의사역행렬, 순수 JS) 또는 구면 설계 표본 디코더 중 **왕복 오차를 실측해 선택**. HRTF 노드 수가 음원 수와 무관하게 K로 고정됩니다. 행렬 곱은 GainNode 격자(K × 채널) 또는 Blob 워클릿 1개 — CPU와 오프라인 일치를 보고 고르세요(워클릿 패턴은 `wave-bank.js`, `output-bus.js` 참고).
5. `equalPower`/`hrtf` 모드는 기존 그래프 그대로(노드 수 불변). `binaural`은 HRTF PannerNode가 없는 환경에서 꺼진 상태 + 이유.
6. 22.05 kHz에서 HRTF ±90° 문제(로그의 "Known limits")가 있으니 자가진단 렌더는 44.1/48 kHz로.

### B5. 내보내기
- 기존 스테레오 WAV: 현재 출력 모드로 들리는 그대로(출력 단계 반영).
- **ambiX WAV**: `(N+1)²`채널 float32, `WAVE_FORMAT_EXTENSIBLE`(채널 마스크 0, IEEE float 서브포맷), ACN/SN3D, 파일명에 `_HOA<N>_ACN_SN3D`. 새 인코더는 새 파일(`js/audio/wav-multichannel.js`)에 — 기존 `encodeWav`는 수정하지 않습니다. 이 파일은 장면 기준(scene-referred) 마스터이므로 **출력 페이더를 적용하지 않습니다**(도움말에 명시, 피크가 1을 넘으면 경고 토스트 + "피크 정규화" 선택 토글, 기본 꺼짐). 같은 이름의 `.json` 사이드카(차수, 정규화, 채널 순서, 청취자, c)를 함께 저장.
- 오프라인 HOA 렌더는 채널 수 N의 `OfflineAudioContext`. 브라우저가 거부하면(채널 상한) 차수를 낮추라는 안내.

### B6. 다른 스튜디오의 소리 가져오기
1. **데이터**: `source.input = { kind: 'synth' | 'import', instId, studio, content: 'doc' | 'heard', trimDb: 0, offset: 0, play: 'once' | 'loop', frozen: null | sampleId }`. `import`일 때 `f`(음고)·음색·음색 레인은 **꺼진 상태 + 이유**("가져온 소리는 자기 음고와 음색을 가집니다").
2. **공급자** `js/audio/instance-source.js`(공용, 오디오 계층): `requestInstanceBuffer({ instId, content, sampleRate }) → { status: 'ready' | 'rendering' | 'missing' | 'cycle', buffer, key, length }` + 변경 구독. 내부 렌더는 Manager가 쓰는 함수들(`renderOfflineBuffer`, `renderFieldBuffer`, `renderRissetBuffer`, `renderClipStudio`, 그리고 "들리는 그대로"는 `mod-sources`가 쓰는 `renderHeard`)을 **재사용**합니다. `manager-mixer.js`에 이미 인스턴스 → 버퍼 함수와 소리 키(`sourceSoundKey`/`docKey`)가 있으니 그것을 **export 한두 줄 + 등록 한 줄**로 노출하세요(순환 import 금지 — §X2). 캐시는 소리 키 기준(LRU), 재렌더는 편집 250 ms 디바운스, 긴 렌더는 진행 배지.
3. **대상**: Manager의 모든 인스턴스(`listInstances()`), 포커스된 인스턴스(= 지금 에디터에 열린 문서) 포함. 인스턴스가 하나도 없는 스튜디오는 "에디터의 현재 문서"를 고를 수 있게(인스턴스를 만들지 않고 `appState.studioParams[studio]`/`appState.voices`를 직접 렌더). **자기 자신과 순환**(Space A가 Space B를, B가 A를 가져옴)은 그래프 검사로 막고 이유를 표시.
4. **다른 스튜디오에서 넘어오는 동선**: (a) Space의 음원 줄에 "＋ 가져오기" 버튼 → 인스턴스 목록(스튜디오 색·이름·길이·상태), (b) 다른 스튜디오 헤더/Manager 트랙에 "⟿ Space로 보내기" 항목 — 기존 궤적 보내기 UI(`ui/trajectory-ui.js`, `ui/send-router.js`)에 **소리 보내기**를 같은 문법으로 추가할 수 있는지 읽고 판단하세요. 가능하면 그 메뉴에 한 항목을 추가(누르면 Space 탭으로 전환하고 새 `import` 음원을 만들어 선택), 구조상 무리면 (a)만 하고 보고.
5. **핫스왑**: 원본 문서 편집 → 재렌더 완료 → 재생 중이면 현재 재생 위치에서 새 버퍼로 크로스페이드(기존 라이브 재스케줄 방식). 궤적·레인 편집은 재렌더 0회.
6. **길이**: 가져온 직후 음원 `duration` = 소리 길이, `timeMode = 'fit'`. 원본 길이가 바뀌면 `fit`인 음원은 따라가고(토스트 없음, 읽기값만 갱신), 사용자가 지속시간을 직접 바꿨으면 유지.
7. **Freeze**: 현재 버퍼를 `core/sample-library.js`에 모노로 저장하고 `frozen = sampleId`로 고정(원본이 바뀌거나 지워져도 유지, 프로젝트 파일에 포함). 크기 상한에 걸리면 안내하고 중단. "링크 다시 켜기"로 되돌림.
8. **원본이 Manager에서도 재생 중일 때**: Space가 Manager 인스턴스로 재생되면 원본 트랙의 건조음과 겹칩니다. 음원 옵션 "Manager에서 원본 트랙 음소거"(기본 꺼짐)는 Manager 재생 시 그 트랙을 임시로 무음 처리하는 표시이며, 구현이 믹서 로직을 크게 건드리면 이번에는 **도움말 안내 + 트랙 뮤트 바로가기 버튼**으로 대신하고 보고하세요.
9. **Manager 어댑터**: `renderSpaceBuffer`가 `import` 음원이 있으면 공급자를 `await`해 같은 체인으로 렌더. Space 인스턴스의 소리 키(`key`)에 가져온 소리의 키를 포함(원본 편집 → Space 클립 재렌더).
10. **글리산도 베이킹**: `import` 음원은 보이스로 변환 불가 — 건너뛰고 개수를 토스트로 알림.

### B7. UI
- **Output 랙**: 출력 모드 세그먼트(스테레오 · HRTF · 바이노럴(HOA)), 차수, 디코드 가중, 가상 스피커 수 읽기값, 헤드폰 권장 안내, `ambiX 내보내기` 버튼. 원근/상단 뷰에 가상 스피커 점 표시 토글(선택).
- **Sound 랙**(음원별): `Synth | Import` 세그먼트. Import면 원본 선택, 상태 배지(준비됨/렌더 중/없음/순환), 내용(`doc`/`heard`), 트림 dB, 오프셋, `once/loop`, Freeze/링크, 파형 미리보기 한 줄.
- A의 Lanes 랙에 `width` 레인 추가(스테레오/HRTF 모드에서는 꺼진 상태 + 이유).
- 관측 곡선 패널: `import` 음원은 음고 선 대신 **도플러 비율**(`dt_e/dt`, 반음 단위)을 그립니다.

### B8. 자가진단 (접두 `space-b-`)
- 구면조화: 정면 음원 → 1차 `[W, Y, Z, X] = [1, 0, 0, 1]`, 왼쪽 → `Y = 1`, 위 → `Z = 1`; 2·3차는 몇 방향에서 닫힌 식과 비교(1e-12); 구 위 수치 적분으로 SN3D 직교성(`∫Y_i Y_j = 4π δ_ij / (2l+1)`, 1e-3).
- 디코드 왕복: 무작위 500방향에서 에너지 벡터 방향 오차와 음량 균일도를 **측정해 임계값과 함께 기록**(목표: 3차 `maxre`에서 방향 오차 ≤ 5°, 음량 편차 ≤ ±1 dB; 못 미치면 스피커 배열을 바꾸고 실측값 보고).
- 폭: `width = 0` → 계수 동일, 커질수록 에너지 벡터 길이 단조 감소, W 불변.
- HOA 오프라인 렌더(48 kHz): 정지 음원의 채널별 RMS 비 = 계수 비(1%), 움직이는 음원에서 몇 시각의 채널 비 일치.
- 바이노럴: 왼쪽 음원 → 왼쪽 귀가 먼저(상호상관 지연 부호)이고 더 큼, 오른쪽은 반대, 정면은 좌우 대칭(±1 dB).
- ambiX 파일: 헤더를 다시 파싱해 포맷 태그 0xFFFE, 채널 수 `(N+1)²`, float32, 프레임 수 확인. 출력 페이더 −6 dB에서도 샘플 값 불변.
- 지연선 도플러: 440 Hz 사인 버퍼를 `import`로 Pass-by 통과 → 순간 주파수가 `fs · dt_e/dt`와 1% 이내(통과 순간 ±50 ms 제외), 같은 장면의 synth 경로와 음고 궤적 일치, `doppler` off → 음고 일정.
- 공급자: 원본 편집 → 재렌더 1회, 궤적 편집 → 0회, 무관한 인스턴스 편집 → 0회; 없는 인스턴스 → `missing`; 순환 → `cycle`; 캐시 키가 `content`별로 분리.
- Freeze: 고정한 소리 = 라이브 렌더(모노 합, 1e-6), 프로젝트 저장/불러오기 후 유지.
- 노드 수: `equalPower` 모드의 그래프 노드 수가 A와 같음.
- Manager: `import` 음원이 있는 Space 인스턴스의 클립 렌더가 무음이 아니고, 원본을 바꾸면 Space 클립 키가 바뀜.
- §X3 공통 항목.

### B9. 완료 기준
1. Glissando(또는 다른 스튜디오)에서 만든 소리를 Space 음원으로 불러와 Comet 궤적으로 움직이면 도플러·거리·방향이 그 소리에 그대로 걸립니다. 원본 스튜디오로 가서 고치고 돌아오면 버튼 없이 반영됩니다.
2. 바이노럴(HOA) 모드에서 위·뒤 방향이 스테레오 모드와 다르게 렌더되며(수치로 확인), ambiX 파일이 외부 디코더 규격에 맞습니다.
3. 기존 프리셋·프로젝트·Manager 동작은 그대로입니다.
4. §X5 전부 통과.

### B10. 위험/주의
- 채널 상한: `ChannelMergerNode` 입력 ≤ 32 → 차수 ≤ 4. 대상 장치 출력은 보통 2채널이므로 모니터링은 항상 스테레오로 디코드합니다(스피커 배열 출력은 후속 과제).
- HOA는 **방향만** 인코딩합니다. 거리감은 게인·공기 흡수·도플러가 담당합니다(반사음/잔향은 후속 과제).
- GainNode 격자 방식은 노드가 많습니다(음원 8 × 16 + 디코드 K × 16). 라이브 CPU와 오프라인 렌더 시간을 실측해 보고.
- 가져온 소리가 길면(수 분) 버퍼 메모리가 큽니다. 캐시 상한(총 초 또는 MB)과 초과 시 동작을 정하고 보고.
- Risset처럼 라이브 엔진을 쓰는 스튜디오도 오프라인 렌더 함수가 있으므로 버퍼로 받을 수 있습니다(길이 규칙은 Manager의 `naturalLength`/`clipLength`를 따름).
