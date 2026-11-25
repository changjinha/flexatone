# Flexatone 새 스튜디오 프로토타입 — 공통 전제 (모든 스튜디오 프롬프트 앞에 붙는 부분)

당신은 `/Users/changjinha/Documents/Flexatone` (브라우저 네이티브 무빌드 ES 모듈 프로젝트, Glissando / Risset / Field 스튜디오 보유)에 **새 스튜디오 1개를 프로토타입**으로 추가합니다. 이 챗에서는 아래 "이번 작업" 섹션의 스튜디오 **하나만** 다룹니다. 다른 챗이 다른 스튜디오를 같은 폴더에서 동시에 작업 중일 수 있으니 **공유 파일 수정 규칙(§5)을 엄수**하세요.

## 0. 작업 순서
1. §1의 파일을 읽어 계약을 확인합니다. 이 문서에 적힌 사실은 제가 확인한 것이지만, **코드를 짜기 전에 직접 한 번 더 확인**하세요. 문서와 코드가 다르면 코드가 맞습니다. 그 차이는 최종 보고에 적습니다.
2. 5줄 이내로 구현 계획을 먼저 적고, 사용자의 답을 기다리지 말고 바로 구현합니다.
3. 구현 → §6 검증 → 최종 보고(§7) 순서입니다.
4. 확인하지 않은 것을 확인했다고 쓰지 마세요. 검증 못 한 항목은 "미검증"으로 보고합니다.

## 1. 먼저 읽을 파일 (순서대로)
- `flexatone_architecture_agent_guide.md` — 계층 규칙(DAG), 무빌드 원칙
- `js/studios/registry.js` (1–80행 계약 typedef, `bakeVoices` 약 294행) — StudioPlugin 계약
- `js/studios/field-studio.js` — **참고 구현 1순위** (문서 getter/`editX`, 베이킹, `particleToGlissandoVoice`, 자가진단)
- `js/studios/field/field-audio.js`, `field-panels.js`, `field-canvases.js`, `vector-field-engine.js` — 오디오/UI/엔진 3분할 패턴
- `js/ui/studio-host.js`, `js/ui/workspaces.js` — 작업 공간 마운트와 트랜스포트
- `js/core/math-utils.js` — 재사용: `createSeededRandom`, `rk4Step`/`integrateRK4`, `fitStrokeToSpline`, `rdpSimplify`, `clamp/lerp/smoothstep/roundTo/deepClone/uid`
- `js/modules/curve-engine.js` — `evaluateCurveObjectY`, `captureCurveToCustomPoints`, 곡선 엔진 14종(파라미터 곡선 입력으로 재사용 가능)
- `js/audio/output-bus.js`(`getOutputBus`, `createOfflineOutput`), `js/audio/audio-engine.js`(`ensureAudioCtx`, `encodeWav`, `triggerDownload`)
- `docs/STUDIO_INTEGRATION_LOG.md` — 기존 스튜디오 결정 사항 (특히 Output stage, Tempo Manager 절)
- Risset의 워클릿이 필요하면 `js/studios/risset/risset-voicebank.js` (Blob 워클릿 패턴)

## 2. 확인된 사실 (이 프로젝트의 불변 조건)
- **무빌드**: `<script type="module">`로 직접 로드. npm/번들러/CommonJS/CDN 금지. 상대 import는 `.js` 확장자 필수.
- **계층 DAG**: `main → ui → audio → studios → modules → core`. 순수 파일(`<id>-studio.js`, `<id>-engine.js`)은 `document`/`window`/`AudioContext`/ui/audio를 import하지 않음. 오디오·UI 파일은 폴더 안에 있어도 각각 audio/ui 계층이며 `ui/studio-host.js`/`workspaces.js`만 import함.
- **플러그인 계약** (`StudioRegistry.register`): `{ id(slug), name:{en,ko}, description?, order, status:'ready', usesVoiceEditor:false, schema:[], workspace:'<id>', defaultParams(), generateVoices(params, helpers) }`. 문서(파라미터)는 `appState.studioParams[id]`에 저장 → 프로젝트 저장/불러오기/실행 취소 자동 적용. `helpers`는 `{ createDefaultVoice, midiToFreq, startIndex, … }` (Field의 `generateVoices` 사용 방식 참고).
- **스튜디오 id**: `STUDIO_SLUG = /^[a-z][a-z0-9-]{1,31}$/` 이므로 `core/state.js`의 `STUDIO_IDS`를 **수정하지 않아도** 등록됩니다.
- **Manager 통합은 이번 범위 밖**: `core/manager-state.js`의 `MANAGER_STUDIOS`는 하드코딩이며, 이번 프로토타입에서는 건드리지 않습니다. 대신 순수 엔진이 나중에 `params()/signals()`를 선언하기 쉽게 파라미터를 평평한 숫자 필드로 유지하세요.
- **Voice 계약**: `createDefaultVoice(index, overrides)`; 곡선은 `engine:'custom'` + `customPoints`(x∈[0,1] 단조), 게인은 `gainMode:'points'` + `gainPoints`. **Voice에는 pan 필드가 없음.** 한 번에 생성 가능한 보이스 상한 `MAX_GENERATED_VOICES = 64`. `captureCurveToCustomPoints(curve,{tolerance,maxAnchors,includeTransforms})`로 조밀 샘플을 적응형 스플라인으로 근사(Field가 `maxAnchors 64`로 사용).
- **베이킹**: UI의 "글리산도 보이스로 베이킹"은 `StudioRegistry.bakeVoices(id, { mode: 'replace'|'append' })`.
- **출력 단계**: 모든 라이브 경로는 `getOutputBus(ctx)`에, 오프라인 렌더는 `createOfflineOutput(ctx)`에 연결. `ctx.destination`에 직접 연결 금지. 내부 자가진단 렌더는 `outputStage:false`.
- **스튜디오 간 오디오 배타**: 탭 전환 시 `stopAllAudio()`가 모든 워크스페이스의 `transport.stop()`을 호출 → 자체 오디오는 반드시 `transport` 5개 메서드로 정지 가능해야 함.
- **재생 중 무거운 연산 금지**: Field/Risset처럼 "에디팅 시점에 한 번 계산(베이킹) + 시그니처 캐시 → 재생은 캐시 조회만". 같은 입력이면 같은 결과(결정론, 시드 PRNG).
- **이중언어**: 모든 UI 문자열·토스트는 `en`/`ko` 둘 다 필요. 모든 컨트롤에 `data-help="<id>.xxx"`를 달고 도움말(en/ko)을 등록. 숫자 입력은 `ui/number-scrub.js`가 자동 처리(`input[type=number]`).
- **자가진단**: `registerSelfCheck(name, (a)=>{ a.ok/equal/near }, { group:'studio' })`. 브라우저 콘솔 `window.runSelfCheck()`가 전체를 돌리며 **작업 시작 전 통과 개수를 기록**하고, 끝났을 때 `기존 N개 + 신규 M개` 전부 통과여야 함.
- **Voice 외 오디오 형태**: 스튜디오가 자체 스테레오/워클릿 오디오를 가져도 되지만, 그 경우 "Bake to Glissando"에서 손실되는 정보(pan, 위상 등)를 UI에 명시(토스트/도움말).

## 3. 파일 구성 (새 파일만 `js/studios/` 아래에 만든다)
```
js/studios/<id>-studio.js          # 순수: 플러그인 등록, 문서 getter/editX, generateVoices, 자가진단
js/studios/<id>/<id>-engine.js     # 순수: 알고리즘·베이킹·캐시 (DOM/Audio 없음), 시드 PRNG
js/studios/<id>/<id>-audio.js      # 오디오 계층: 재생/오프라인 렌더/WAV, transport 객체 export
js/studios/<id>/<id>-canvases.js   # UI: 캔버스 렌더·포인터 조작
js/studios/<id>/<id>-panels.js     # UI: mount<Id>Workspace(root, hooks) → { render(scopes), destroy(), fit() }
js/studios/<id>/<id>-i18n.js       # EN/KO 문자열 + HELP 항목을 기존 사전에 병합(§5)
```

## 4. 공통 UX 요구 (Field 스튜디오와 동일한 문법)
- 상단: 스튜디오 헤더/상태 배지(베이킹 상태 등), 주요 액션(랜덤 시드 재생성, 프리셋, `⇪ 글리산도 보이스로 베이킹`, 내보내기 JSON/WAV).
- 본문: 메인 캔버스(시간 가로 × 음고 세로, 가능하면 Glissando와 같은 piano-roll 좌표) + 우/하단 파라미터 랙(섹션 카드 `bg-slate-900/90 border border-slate-800 rounded-xl p-3`, Tailwind 클래스는 기존 파일을 그대로 따라 한다).
- 헤더 공용 트랜스포트(Space/Enter/Esc/루프, 큐 지점 더블클릭) 동작. 재생헤드 표시.
- 슬라이더+숫자 입력 조합은 `field-panels.js`의 `slider()` 패턴 복사(드래그 1회 = 실행 취소 1단계: `coalesceKey` + `endHistoryGesture`).
- 파라미터 변경 → 시그니처 변경 시에만 재베이킹. 베이킹 횟수/상태 배지로 노출(재생 중 횟수 증가 없음을 검증 가능하게).
- 다크 테마 일관성, 가독성 있는 최소 폰트 11px.
- **공용 모듈을 반드시 사용** (스튜디오마다 따로 만들지 않는다 — 2026-11-22 통일 작업 이후의 규칙):
  - 음색: `ui/timbre-editor.js` `createTimbreEditor` (믹스 | ƒ(x)) + `audio/studio-fx.js` `createTimbreWave` + 베이킹 시 `modules/timbre-spec.js` `timbreSpecToVoiceFields`.
  - 큐·플레이헤드: `ui/transport-lines.js` `drawCueLine` / `drawPlayheadLine`.
  - 줌·스크롤: `ui/view-nav.js` `wheelNavigate`(휠 = 음고, ⇧ = 시간, Ctrl/⌘ = 줌) + `createZoomBar`.
  - 트레몰로: `ui/studio-tremolo.js` `createStudioTremoloRack` + `studioLiveOutput` / `connectStudioOutput` (`doc.tremolo`).
  - 랙은 `<section>`으로 만들면 자동으로 이동 손잡이가 붙음 (`ui/rack-layout.js`).
  - 단일 선을 쓰는 스튜디오는 `studios/trajectory-link.js` `registerTrajectoryTarget` + `createTrajectoryImportButton`.

## 5. 공유 파일 수정 규칙 (동시 작업 충돌 방지)
기존 파일은 **아래 항목 외 수정 금지**. 이미 있는 줄은 지우거나 재정렬하지 말고 **줄 추가만** 합니다 (Edit 도구로 해당 위치에 삽입, 파일 전체 덮어쓰기 금지).
1. `js/main.js`: 상단 import 구역에 `import './studios/<id>-studio.js';` 1줄.
2. `js/ui/workspaces.js`: `<id>` mount와 transport import 1~2줄 + `registerWorkspace('<id>', {...})` 블록 1개.
3. `index.html`: `#studioTabs` 안에 탭 버튼 1개 (`data-studio="<id>"`, `data-i18n="studio.<id>"`, 기존 버튼 마크업 복제).
4. i18n: `studio.<id>` 탭 라벨과 모든 신규 키는 `<id>-i18n.js`에서 **기존 사전에 병합**합니다. 먼저 `js/core/i18n.js`의 `I18N`이 `export const I18N = {en:{…}, ko:{…}}`로 변경 가능한지 확인(동결 아님). 가능하면 `Object.assign(I18N.en, {...}); Object.assign(I18N.ko, {...});`로 병합하고, 이 모듈은 `main.js`에서 탭이 그려지기 전에 import되어야 합니다(플러그인 파일이 이 모듈을 import하도록). 불가능하면 `i18n.js` 맨 끝에 한 블록만 추가. `findMissingI18nKeys()`가 빈 배열이어야 함. `LANG_TEXT_MAP`(1636행 부근)이 있으면 필요한지 확인.
5. 도움말: `ui/option-inspector.js`의 `HELP_DB`는 변경 가능한 객체이므로 `-panels.js`(ui 계층)에서 `HELP_DB['<id>.xxx'] = { en, ko }` 형태로 등록(기존 `E(title, summary, detail, formula)` 형식 참고).
6. `.claude/launch.json`: 이 챗 전용 dev 서버 항목 1개 추가(아래 포트).
7. `docs/STUDIO_INTEGRATION_LOG.md`: 맨 끝에 `## <Id> Studio (prototype)` 절만 추가(파일, 결정 사항, 한계, 점검 결과).
`core/state.js`, `core/manager-state.js`, `modules/*`, `audio/*`, 기존 스튜디오 폴더의 **로직은 수정 금지**. 재사용이 필요한데 export가 없으면, 파일을 고치지 말고 새 파일에 복사하거나 최종 보고에 "필요한 작은 export 추가"를 제안으로 적으세요.

## 6. 검증 절차 (모두 수행하고 결과를 보고)
1. dev 서버: `python3 .claude/devserver.py <PORT>` (launch.json에 항목 추가 후 `preview_start`로 실행). 브라우저 콘솔에 SyntaxError/ReferenceError/404 모듈 오류 0건.
2. `window.runSelfCheck()` — 기존 전부 + 신규 전부 통과. 작업 전 기준 개수를 기록해 둘 것.
3. 탭 전환: Glissando → 새 스튜디오 → Risset → Field → 새 스튜디오 시 소리 겹침 없음, 레이아웃 정상.
4. 재생/정지/루프/큐/Space/Esc, 재생 중 파라미터 편집 안전, **재생 중 베이킹 횟수 불변**.
5. 실행 취소/다시 실행(슬라이더 드래그 1회 = 1단계), 프로젝트 저장 → 변경 → 불러오기로 문서 복원.
6. "글리산도 보이스로 베이킹" → Glissando 탭에서 보이스 확인(개수 ≤ 64, 곡선이 원본과 일치).
7. WAV 내보내기: 파일이 열리고 피크가 0 dBFS를 넘지 않으며 출력 페이더(-6 dB 등)가 반영됨(Export WAV = 들리는 소리).
8. EN ⇄ 한국어 전환 시 모든 라벨/토스트/도움말 번역, Alt+hover 도움말이 모든 컨트롤에서 나옴.
9. 좁은 창(폭 1100px)에서 레이아웃 깨짐 없음. 스크린샷 1~2장.

## 7. 최종 보고 형식
- 만든/수정한 파일 목록(공유 파일은 몇 번째 줄을 추가했는지).
- 자가진단 개수(전/후)와 신규 항목 이름.
- §6 각 항목의 통과/실패/미검증.
- 문서와 코드가 달랐던 점, 설계 결정과 이유, 알려진 한계, 다음 단계 제안(특히 Manager 통합 시 `params()/signals()` 후보 목록).

## 8. 하지 말 것
- 요청 범위를 넘는 리팩터링, 기존 스튜디오 동작 변경, 새 의존성, 새 빌드 도구.
- 재생 중 메인 스레드에서의 무거운 연산, 오디오 스레드 내 메모리 할당(워클릿 사용 시).
- 한 파일 1,500줄 초과(분할).
- 커밋/푸시(이 폴더는 git 저장소가 아님).

---
# 이번 작업
## Grid Studio — 스튜디오 id `grid`, dev 포트 `8028`, order 110

### G0. 우선 규칙 (위 공통 전제와 충돌하면 **이 섹션이 우선**)
위 공통 문서는 프로젝트 초기(스튜디오 3개) 기준으로 쓰였습니다. 지금 프로젝트는 스튜디오 10개 + Manager가 이미 있고 git 저장소입니다. 아래가 최신 사실입니다. 코드를 짜기 전에 직접 확인하세요.

1. **git 저장소입니다.** `flexatone_architecture_agent_guide.md` §6(검증) → §7(`CHANGELOG.md` 항목, 새 스튜디오 = MINOR +1) → §8(로컬 커밋: 먼저 `git status --short`, **내 파일만 스테이징**, 메시지 `v0.MINOR.PATCH: …`)을 따릅니다. **push는 사용자가 명시할 때만.** 공통 문서 §8의 "커밋/푸시 금지"는 무시.
2. **가장 가까운 참고 구현은 Field가 아니라 Wave Studio**입니다: `js/studios/wave/` (`wave-bank.js` = 자기완결 가산 사인 뱅크 클래스를 `toString()`으로 Blob 워클릿에 싣는 패턴, 제어 행렬 청크 스트리밍, 오프라인=실시간 일치, 리지 트래킹 → 보이스 베이킹). 포인터 편집은 `js/studios/draw/`, 시드 이벤트는 `js/studios/cloud/`. 해당 `docs/STUDIO_INTEGRATION_LOG.md` 절("Wave Studio (prototype)", "Wave Studio — Manager integration", "Cross-studio parity pass", "Manager Warp", "Trajectory Sends")을 읽으세요.
3. **공용 모듈 우선 규칙**(스튜디오마다 따로 만들지 않기 — 사용자의 명시적 요구). 아래 파일이 실제로 있는지 `ls`로 확인하고 전부 사용:
   - 음색 `ui/timbre-editor.js`(`createTimbreEditor`, Mix | ƒ(x)) + `audio/studio-fx.js`(`createTimbreWave`) + 베이킹 시 `modules/timbre-spec.js`(`timbreSpecToVoiceFields`). **샘플 모드는 제공하지 않음**(스튜디오 하나가 음색 하나를 쓰는 구조 — 가이드 "Sampler" 절).
   - 큐·플레이헤드 `ui/transport-lines.js`, 줌·스크롤 `ui/view-nav.js`(`wheelNavigate`: 휠=음고, ⇧=시간, Ctrl/⌘=줌 + `createZoomBar`), 스튜디오 트레몰로 `ui/studio-tremolo.js`, 이동 가능한 랙 `ui/rack-layout.js`(랙을 `<section>`으로 만들면 자동), 컨트롤(슬라이더/토글/셀렉트/세그먼트·색 규칙) `ui/studio-controls.js`, 캔버스 크기 `ui/canvas-size.js`, 재생 `audio/live-transport.js`(play/stop/pause/loop/재생 중 편집), Delete 키 = 워크스페이스의 `deleteSelection`, 이동 도구 `ui/locate-tool.js`, 단축키 목록 `ui/shortcut-help.js`(새 키를 여기에 추가), 스크린샷 `ui/screenshot.js`(가장 큰 캔버스 PNG).
   - 공용 기능이 이 스튜디오에 적용될 수 없으면 **버튼은 제자리에 두고 꺼진 상태 + 이유 표시**(예: 보이스 단위 트레몰로/비브라토 `voice-mod-rack`은 보이스가 없으므로 꺼짐). 기능을 제거하지 말 것.
   - **Alt + 클릭은 도움말 인스펙터가 전역으로 사용** — Alt 제스처를 어디에도 바인딩하지 말 것.
4. **Manager 통합은 Phase B에 포함**(아래 §G12). 지금은 `MANAGER_STUDIOS`에 10개가 있고 Wave가 마지막으로 완전 통합됨. 가이드의 규칙: **새 스튜디오 렌더러는 `ampMask`가 들어가는 모든 곳에 `pitchWarp`도 받아야 함.**
5. **동시 작업/서버 상한**: 다른 챗이 같은 폴더를 동시에 편집합니다. 공유 파일은 편집 직전에 해당 위치를 다시 읽고 **줄 추가만**. 한 폴더에 dev 서버는 5개 상한 → `launch.json`에 `flexatone-grid`(8028) 항목을 추가하고 `preview_start`를 먼저 시도, "Maximum 5 dev servers" 거절 시 이미 떠 있는 다른 포트(`lsof -nP -iTCP -sTCP:LISTEN | grep -i python`, 모두 같은 폴더를 서비스)의 `http://localhost:<port>/index.html`로 검증하고 보고서에 그 사실을 적을 것.
6. **용어**: Studio Engine(`grid-engine.js`) / Audio Engine(`grid-audio.js`, 워클릿) / Curve Engine(`curve-engine.js`)을 구분해서 쓰고, 새 식별자는 `studioEngine…`/`audioEngine…` 접두를 선호. Manager의 Track/Instance/Clip 용어를 사용.

---

### G1. 한 줄 목표
**마우스로 칠하는 시간×음고 격자(raster)에 Procreate식 이미지 효과를 걸고, 각 효과가 *대응하는 소리 연산*으로 번역되는 스튜디오.** 그림을 번지게 하면 소리가 코러스처럼 퍼지고, 그림에 노이즈를 얹으면 노이즈가 나고, 그림이 글리치되면 음고가 짧게 튀는 식으로, **"이미지 연산 = 스펙트로그램 위의 같은 연산"** 이 되도록 만듭니다.

**해석(결정 사항 — 틀렸다면 최종 보고에 이유와 함께 알려 주세요)**: "격자"는 픽셀 격자(래스터)로 해석했습니다. 가로 = 시간 열(column), 세로 = 로그 음고 행(row), 셀 값 = 진폭 0..1. (컨트롤 포인트 메시가 아님. 메시는 Liquify 내부 자료구조로만 사용.)

### G2. 설계 원칙 3가지
1. **Result = what you hear.** 화면 왼쪽에 **Editor 윈도우**(칠하는 기본 직교(Cartesian) 격자 = 원본)와 **Result 윈도우**(효과 스택을 통과한 *최종 출력이 어떻게 나올지*)를 **항상 함께, 같은 비율로** 띄웁니다(레이아웃 세부는 §G5-A). Result는 소리를 오프라인 렌더해 STFT한 스펙트로그램과 닮아야 합니다(자가진단으로 상관 측정). 모든 효과는 Result에서 *시각적으로도* 해당 효과처럼 보여야 합니다(블러는 번지고, 노이즈는 잡음 입자, 크로매틱은 R/G/B 세 장이 어긋남, 할프톤은 점 패턴).
2. **두 영역(domain)**: 효과는 `matrix`(소리 합성 전, 미세 진폭 행렬에 적용) 또는 `bank`(합성 단계, 정확한 주파수 비율이 필요한 것)로 분류합니다. `matrix` 효과는 스택 순서대로 적용, `bank` 효과(Noise의 노이즈 버스 부분, Chromatic Aberration)는 항상 마지막이며 UI에 별도 구역("출력 단계 효과")으로 고정 표시해 순서에 대한 오해를 막습니다.
3. **효과 레지스트리**: `GridEffectRegistry.register({ id, name:{en,ko}, domain:'matrix'|'bank', params:[…스키마], defaults(), apply(ctx) , preview?(ctx) })` 형태로, 새 효과 추가 = 객체 1개 추가가 되도록(사용자가 "등등" 계속 추가할 예정). UI 카드는 스키마로 자동 생성.

### G3. 데이터 모델 (`appState.studioParams.grid`)
```js
{
  grid:   { pLo: 36, pHi: 96, rowsPerSemi: 2, colsPerSec: 8, length: 16 },   // 편집 격자: 기본 셀 = 0.5 반음 × 125 ms
  render: { binsPerSemi: 8, frameRate: 200, quality: 'draft'|'normal'|'high', maxActive: 600, seed: 1 },
  layers: [{ id, name, color, muted, solo, gain, pan,
             raster: { enc: 'rle8', data: '…' },       // 8비트 양자화 + RLE(희소 래스터는 매우 작음), 해상도 상한 셀 수 ≤ 200k
             maskRaster: null | {…},                    // 효과용 레이어 마스크(선택)
             timbre: {…},                               // 공용 timbre-editor 스펙
             stack: [{ id, type, on: true, mix: 1, mask: 'none'|'selection'|'layerMask', params: {…} }],
             liquify: { ops: [...] }                    // §G6-6 (스택 항목으로 두어도 됨)
          }],                                           // 최대 4 레이어
  selection: {...}, view: {...}, tool: {...}, tremolo: {...}   // view/tool/selection은 history:false
}
```
- 래스터 직렬화 크기·undo 비용(1회 스냅샷 크기 × 히스토리 깊이)을 **실측해서 보고**하세요. 너무 크면 diff 타일 방식을 제안.
- 해상도 변경 시 리샘플(면적 평균 / 최근접 선택). 기본 격자를 바꿔도 소리 길이/음역이 유지.

### G4. 처리 파이프라인 (순수 `grid-engine.js`)
```
raster (rows × cols, Float32 0..1)
  → upsample to FINE MATRIX M[frame][bin]   (bin = 1/binsPerSemi 반음 간격 고정 주파수, frame = 1/frameRate 초, 선형 보간 + 셀 가장자리 부드럽게)
  → matrix 효과 스택 (순서대로, 마스크/mix 반영)
  → (활성 bin 목록 / maxActive 상한: 진폭 큰 순 유지)
  → bank 효과 (Noise 노이즈 부분, Chromatic Aberration)
  → 합성 (가산 뱅크)
```
- **고정 주파수 가산 뱅크 + 진폭 행렬**이 핵심 아이디어: 미세 bin(기본 1/8반음 = 12.5 cents)을 쓰면 *블러 = 행렬 스무딩*이 곧 "피치가 퍼진 코러스"가 되고, *Liquify = 행렬 리샘플*이 곧 "곡률 변화"가 되어 이미지 연산을 그대로 쓸 수 있습니다. 합성 시 bin 주파수는 변하지 않으므로 Wave 뱅크 구조를 그대로 재사용 가능.
- **단계별 캐시**: `key_i = hash(layer.raster, stack[0..i] 시그니처, render 설정)`. 스택 중간 효과만 바꾸면 그 지점부터만 재계산, 소리(음색/게인/팬) 변경은 재계산 0회. 베이킹 횟수·재계산 단계를 배지로 표시.
- **프리뷰 해상도**: 슬라이더 드래그 중에는 낮은 해상도(frameRate/4, binsPerSemi/2)로 Result 캔버스만 갱신(≥30 fps), 손을 떼거나 150 ms 정지 시 전체 해상도 베이킹 후 오디오에 핫스왑. 무거운 연산은 `setTimeout`/`requestIdleCallback` 슬라이스로 쪼개거나 Blob Worker로 이동(Wave 클립 렌더의 yielding slices 방식 참고). 기본 문서(16 s, 480 bin, 효과 5개)에서 **편집 → 소리 반영 지연 < 400 ms** 를 실측해서 보고.
- 결정론: 같은 시그니처 → 같은 행렬(비트 단위). 모든 난수는 `createSeededRandom(seed + 효과별 salt)`.
- 메모리: 행렬은 `Float32Array` 재사용 풀(할당 최소화), 레이어 4개·60 s에서도 상한 안에 들어오도록 `quality`별 `frameRate`/`binsPerSemi` 자동 하향.

### G5. 편집 도구 (캔버스, `grid-canvases.js`)
#### G5-A. 듀얼 윈도우 레이아웃 (필수 요구)
- **왼쪽 영역에 두 윈도우를 동시에 상시 표시**: ① **Editor**(기본 Cartesian 격자: 가로 = 시간, 세로 = 음고, 셀 격자선·건반 눈금·스냅 가이드, 모든 편집 도구가 여기서만 작동) ② **Result**(같은 좌표계에서 효과 스택 통과 결과 = 최종 출력 예상도, **읽기 전용**이지만 재생헤드·큐·커서 십자선은 표시). 오른쪽 영역은 랙(효과 스택·레이어·음색 등).
- **같은 비율(same aspect ratio) 보장**: 두 윈도우는 항상 **동일한 폭·높이·플롯 영역(plot rect)** 과 동일한 눈금 여백을 가집니다. 기본 배치는 **세로 적층**(위 Editor, 아래 Result — 시간축이 세로로 정렬되어 같은 시각이 같은 x 위치). 보기 전환 토글로 **가로 나란히**(왼쪽 Editor | Result)도 지원하되 어느 쪽이든 두 윈도우의 크기·종횡비가 같아야 합니다. 구현은 하나의 레이아웃 컨테이너가 두 캔버스에 같은 `metrics`(width/height/plotX/plotY/plotW/plotH)를 계산해 주도록 하고, `ui/canvas-size.js`의 크기 조절(리사이즈 핸들)이 **두 윈도우에 동시에 적용**되게(비율 유지). **리사이즈 동기화 락 버튼**을 별도로 둡니다(아래 항목).
- **리사이즈 락 버튼(🔒/🔓)**: 두 윈도우 사이(또는 리사이즈 핸들 옆)에 토글 버튼을 둡니다. **기본 = 잠금(동기화)**: 어느 핸들을 끌어도 두 윈도우가 동시에 같은 크기로 변합니다. **풀림(🔓)**: 핸들이 윈도우마다 독립 동작하여 한쪽만 키우거나 줄일 수 있습니다(이때만 `metrics`가 달라질 수 있음 — 자가진단은 잠금 상태에서만 동일성을 요구). 풀린 상태에서 락 버튼을 다시 클릭하면 **즉시 다시 동기화**됩니다: 가장 마지막에 조정한 윈도우의 크기를 기준으로 다른 쪽을 맞추고(애니메이션 없이 한 번에), 이후 다시 연동 리사이즈. 락 상태·풀림 중 각 윈도우 크기는 문서가 아닌 UI 상태로 저장(세션 복원 시 락 상태 유지). 풀린 동안은 버튼에 "동기화 해제됨" 표시(색/아이콘)와 툴팁·`data-help`·EN/KO 도움말 필수. 뷰 상태(줌·팬·범위)는 락과 무관하게 항상 동기화. 가로 나란히 배치에서도 동일하게 동작(높이 기준 동기화, 풀림 시 개별 높이).
- **뷰 완전 동기화**: 줌·팬·스크롤(`view-nav`), 시간/음고 범위, 재생헤드·큐(`transport-lines`), 마우스 커서 위치 십자선(Editor에서 움직이면 Result에도 같은 (시간, 음고) 위치에 표시, 반대도 동일 — 단 Result에서의 *편집*은 불가), 선택 영역 윤곽선 표시를 한 `view` 상태로 공유. 어느 쪽 윈도우에서 휠/드래그로 팬·줌을 해도 둘이 함께 움직입니다.
- 각 윈도우 우상단에 작은 라벨(`Editor` / `Result`, EN/KO)과 색상 맵 선택. Result에는 "처리 중…" 진행 표시(프리뷰 해상도 → 전체 해상도로 갱신될 때 부드럽게 교체)와 효과별 오버레이 토글(크로매틱 반음 오프셋 텍스트, 글리치 이벤트 틱, 리퀴파이 메시).
- **Split(비교 슬라이더)는 보조 옵션**으로 남김: 한 윈도우 안에서 Editor와 Result를 가르는 슬라이더를 켜면 두 윈도우 중 Result 쪽에서만 동작(선택 사항, Phase B 가능).
- 좁은 창에서는 가로 나란히 → 세로 적층으로 자동 전환(두 윈도우 비율은 계속 동일). Screenshot(`ui/screenshot.js`)은 기본으로 Result 윈도우를 저장하고, 옵션으로 Editor / 둘 다(합성)를 선택.
- 키보드: `Tab` = 포커스 윈도우 전환은 만들지 않음(Result는 편집 불가이므로 필요 없음). 단축키 목록(`shortcut-help.js`)에 레이아웃 토글 키(예: `\`) 추가.

#### G5-B. 편집 도구
- **Brush**(크기·경도·불투명도·흐름, 모양 round/square, 펜 압력 있으면 불투명도), **Eraser**, **Line**(Shift = 수평/반음 스냅), **Rect/Ellipse fill**, **Fill bucket**(임계값 flood), **Gradient**(선형/방사), **Eyedropper**, **Select**(사각/올가미/타원 + 페더, 점선 애니메이션) — 선택은 효과의 마스크로 사용 가능, **Mask paint**(퀵 마스크).
- 대칭 옵션(시간/음고 미러), 스냅 가이드(반음 줄, 스케일 하이라이트, 셀 격자선은 확대 시에만).
- 크기 조절은 `[` `]` 키(휠은 `view-nav`가 사용), 도구 단축키 `B E L R O G I S M`(충돌 시 `ui/shortcut-help.js` 목록 확인), Delete = 선택 영역 지우기(`deleteSelection`).
- **이미지 가져오기**: PNG/JPG 드롭/선택 → 휘도로 변환(반전 옵션) → 격자 해상도에 맞춰 리샘플 → 새 레이어 또는 현재 레이어에 합성. (ui 계층에서 canvas로 디코드, 엔진엔 Float32 배열만 전달.)
- 두 윈도우 보기(§G5-A), 색상 맵(그레이/히트/레이어색), 피아노 건반 눈금, 시간 눈금, 재생 헤드·큐는 공용 `transport-lines`.

### G6. 효과 사양 — Tier 1 (필수, 사용자가 요청한 6종)
모든 효과 공통: `on`(눈), `mix`(건/웻 0..1), `mask`(없음/선택영역/레이어마스크), 초기화 버튼, 파라미터는 `studio-controls` 컨트롤 + `data-help`. 단위는 소리 쪽 단위(cents, ms, 반음)로 표시.

**1) Blur — 이미지 번짐 = 음고(·시간) 번짐 (코러스)**
- 모드: `gaussian` / `motion` / `perspective`.
- 가우시안: `sigmaCents`(0–400), `sigmaMs`(0–500). 미세 bin 행렬에 분리형 가우시안 컨볼루션. **커널은 L2 정규화**(`Σk²=1`, `normalize:'power'|'peak'|'sum'` 선택, 기본 power) → 번질수록 한 줄이 흐려지되 *음량은 유지*, 퍼짐이 클수록 코러스/앙상블처럼 들림.
- `shimmer`(0..1): 클러스터가 정적인 비팅이 되지 않도록 bin별 느린 랜덤 진폭 워블(0.1–2 Hz, 시드). 0이면 순수 정적 컨볼루션.
- 모션: 방향 `angle`(시간-음고 평면) + 길이(`lengthMs`, `lengthSemi`), `trail: 'both'|'after'|'before'`(꼬리 방향: 앞으로 번지면 프리-에코 부풀림). 음고 성분이 있으면 한 줄이 **미끄러지는 잔상 글리산도**로 들림.
- 퍼스펙티브: 초점 `(t0, p0)`, `shape: 'radial'|'tiltShift-pitch'|'tiltShift-time'`, `inner`(선명 영역 반지름), `falloff γ`, `maxSigmaCents/Ms`. σ(x,y)는 초점에서 멀수록 커짐. 공간가변 커널은 구간별 σ 양자화(예: 8단계) 후 레벨 간 보간으로 구현해도 됨. 초점 주변 음고는 순음, 가장자리는 코러스 구름.
- 큰 σ에서 계산 비용이 폭증하지 않게(분리형 + 박스 3패스 근사 허용, 정확도 오차 측정).

**2) Noise — 노이즈 레벨·색 (white / pink / brown …)**
- `levelDb`(−80..0, 레이어 출력 기준), `color` = 기울기 dB/octave 슬라이더 (−9 brown … −3 pink … 0 white … +3 blue … +6 violet; 프리셋 버튼 5개), `follow`(0..1: 0 = 그림과 무관한 전대역 노이즈 바닥, 1 = 칠한 음고 주변에만 좁은 대역 노이즈 — "노이지한 톤"), `bandCents`(follow>0의 노이즈 대역폭 5–200), `grain`(0..1: 셀별 랜덤 진폭 = 이미지 그레인, 거친 AM 질감), `seed`.
- 구현 제안: 노이즈 바닥 = 워클릿 내부 시드 PRNG + 색 필터(핑크 = 3-pole Kellet류, 브라운 = leaky 적분, 블루/바이올렛 = 미분 계열; 임의 기울기는 1차 필터 혼합); `follow` 부분 = bin별 **FM 지터 사인**(랜덤워크 주파수 편차 → 대역 노이즈)으로 톤과 노이즈의 배분 `√(1−n)`, `√n`. 대안이 더 낫다면 근거와 함께 변경 가능.
- 결과 캔버스: 입자형 그레인(전대역은 바탕 거친 점, follow는 선 주위).

**3) Glitch — 음고가 중간중간 랜덤하게, 아주 짧게(그래뉼러) 튐**
- 이벤트 = 시드 포아송: `rate`(0–30/s), `durMs` min/max(3–80 ms, 그래뉼러 스케일), `jump` 분포 `uniform|gauss|octave|interval(JI 목록)|toPainted`(= 현재 칠해진 다른 음고로 점프, "랜덤한 곳으로"), `rangeSemi`(±0–36), `timeJumpMs`(다른 시각의 프레임을 읽는 타임 글리치 0–2000), `bandFraction`(이벤트마다 랜덤 대역 폭 0..1 — 전체가 아니라 일부 음고만 튐), `stutter`(같은 그레인 반복 1–8), `probability`, `fadeMs`(≥2 ms, 클릭 방지).
- 행렬 연산 = **타일 복사/변위**: 이벤트 구간·대역의 행렬 타일을 (Δ행, Δ프레임)만큼 옮겨 덮어쓰고 가장자리를 해닝으로 크로스페이드. 고정 주파수 bin이라 위상 불연속 클릭이 없음.
- Result 캔버스: 픽셀 블록 변위(데이터모싱) + 이벤트 틱 마커(시드 재굴림 버튼 `🎲`).

**4) Halftone — 랜덤 트레몰로 (길이/무음이 랜덤)**
- 이미지 할프톤(점 크기 ∝ 밝기)을 *진폭에 따른 듀티비* 로 번역: `periodMs`(점 주기 20–400 → 트레몰로 2.5–50 Hz), `dutyFrom: 'amplitude'|'fixed'`(`duty` 0..1), `jitter`(0..1: **켜진 길이**의 랜덤 변동), `silenceJitter`(0..1: **무음 길이**의 랜덤 변동, 켜짐과 독립 분포), `dropout`(확률적 완전 무음), `angle`(스크린 각도 → 음고 행마다 게이트 위상 오프셋 = 대각 리듬 패턴/아르페지오 느낌), `shape: 'round'|'square'|'line'`(엣지 곡선), `edgeMs`(≥2), `scope: 'perBin'|'perBand'|'layer'`(독립 게이트 단위; `bandSemi`), `compensate`(게이트 평균 음량 보정), `seed`.
- 길이 분포: 켜짐/꺼짐 각각 `lognormal` 기본(평균 = 주기·duty / 주기·(1−duty), CV = jitter), 게이트는 프레임(200 Hz) 해상도에서 엣지 램프로 생성.
- Result 캔버스: 실제 점 스크린(원형 점) 미리보기, 확대하면 점 크기가 듀티비.

**5) Chromatic Aberration — 같은 *비율*의 배음 구조를 순정 음정 위에 복제해 퍼져 들리게 (신스 쪽)**
- **핵심 제약: 정확한 주파수 비율.** 채널 c의 bin 주파수 = `f_bin × ratio_c` (정수 bin 이동이 아님). 따라서 `bank` 영역 효과로 구현: 같은 진폭 행렬을 *주파수 표만 다르게* 읽는 뱅크 3개(R/G/B). 모든 부분음 사이 비율이 원본과 수학적으로 동일하게 보존됨(1e-9 상대 오차).
- 채널 3개 `{ ratio:[p,q] 또는 프리셋, cents(정밀 보정, 기본 0), gain, timeMs(채널 시간 오프셋: 행렬 읽기 인덱스 이동), pan(−1..1), wave: 'layer'|'sine'|'tri'|'saw'|'square'|'pulse', harmonics 1..8, on }`.
- 비율 프리셋: 1:1, 9:8, 6:5(단3도), 5:4(장3도), 4:3, 3:2(순정 5도), 8:5, 5:3, 7:4, 2:1, 3:1, 5:1 + 아래 방향(역수, 예 2:3 = 5도 아래) + 사용자 p:q. 기본: R = 2:3, G = 1:1, B = 3:2 (G가 원음, 좌우로 5도 퍼짐), pan R −0.8 / G 0 / B +0.8, `timeMs` ±8 ms → "퍼져 들림".
- 상호연동 옵션 `link`(대칭 연결: R = 1/B). 총 동시 사인 수가 `maxActive` 예산을 넘으면 진폭 낮은 bin부터 줄임(채널 수만큼 곱해짐).
- Result 캔버스: R/G/B 틴트 3장이 `12·log2(ratio)` 반음(예 3:2 = 7.02)만큼 **세로로 정확히** 어긋남. 반음 값 텍스트 표시.
- (Phase B 후보) `harmonics>1`의 신스형 파형은 밉맵 웨이브테이블 또는 하모닉 합.

**6) Liquify — 곡률 조정 (선을 밀어 휘게 함)**
- 도구: `push`(드래그 방향으로 이동), `twirl`(CW/CCW), `pinch`, `bloat`, `smooth`, `reconstruct`(복원). 크기·압력·세기·`momentum`(Procreate식 잔류). 드래그 경로를 따라 변위장 D(x,y)(시간 s, 음고 반음) 누적.
- **비파괴**: 스트로크 목록(`ops`)을 문서에 저장하고 재생(replay)해 변위장을 만든다(메시 해상도 = 미세 행렬의 1/4). 전체 세기 `amount` 슬라이더(0 = 항등), `lockTime` 토글(켜면 음고 방향만 변위 → 리듬 유지한 순수 곡률).
- 합성: 역방향 매핑 `Result(x) = Src(x − D(x))`, 미세 bin에서 쌍선형 보간 → 줄이 매끄럽게 휘어 **연속 글리산도**로 들림. 에너지 보존(국소 야코비안 보정 `|det J|` 선택, 기본 켬).
- 변위장을 보기 오버레이(메시 격자)로 토글.

### G7. 효과 — Tier 2 (Phase B, 저렴한 `matrix` 효과, 같은 레지스트리로)
`pixelate`(시간·음고 셀 양자화 = 계단형), `posterize`(진폭 레벨 양자화), `sharpen`(언샤프 마스크 = 블러의 역, 퍼진 코러스를 다시 모음), `bloom`(임계 → 블러 → 가산 = 배음/후광), `levels/curves/invert/threshold`, `mirror`(시간/음고 대칭), `edge`(그래디언트 크기 = 온셋 윤곽). 아이디어 목록(구현 안 함, 보고서에 "후속 후보"로만): clone, smudge, gradient-map(색→음색 매핑), ripple/distort, emboss.

### G8. 오디오 (`grid-audio.js`, `grid-bank.js`)
- `grid-bank.js`: Wave의 `WaveSpectralBank` 패턴(자기완결 클래스, import 없음, `toString()`으로 워클릿), 확장점:
  - 뱅크 인스턴스 = (레이어 × 크로매틱 채널). bin 주파수 표만 다르고 진폭 행렬은 공유(채널별 시간 오프셋 = 읽기 인덱스 이동).
  - **희소 처리**: 블록마다 활성 bin 목록(a0 또는 a1 > ε)만 합성. 희소 합성 결과 = 밀집 합성 결과(오차 < 1e-6, 자가진단).
  - 파형: 레이어 음색(공용 `timbre-editor`)을 단일 사이클 테이블로 룩업(앨리어싱 방지를 위해 옥타브별 밉맵 또는 나이퀴스트 이하 하모닉만 합), 크로매틱 채널은 `wave` 오버라이드.
  - 위상 누산기는 진폭 변화에도 리셋하지 않음(위상 연속), 블록 내 선형 진폭 보간, 출력 소프트 클립 ±0.98 또는 레이어 합 정규화.
  - `process()` 안 할당 0(재사용 버퍼), 청크로 제어 행렬 전달(`port`), 재생 중 편집 시 현재 플레이헤드 이후 구간 핫스왑(`live-transport`, Wave 방식).
- 노이즈 버스 + FM 지터 사인(§G6-2)도 같은 워클릿 안(시드 PRNG, 오프라인과 결정적으로 동일).
- **예산**: `maxActive`(동시 사인 상한) 초과 시 진폭 순으로 컷, CPU 지표(블록당 처리 시간)와 활성 수를 배지로 표시. `quality`: draft(2 bins/semi 가까운 저해상도·낮은 frameRate), normal(기본), high. **WAV 내보내기는 라이브와 같은 예산/설정을 사용**(내보낸 소리 = 들리는 소리). 실측: 기본 문서 실시간 재생 시 블록 처리 시간 / 활성 수, 최악 케이스(크로매틱 3채널 + 블러 큰 σ) 수치를 보고.
- AudioWorklet 불가 환경: 오실레이터 폴백(활성 ≤ 96, 배지로 알림). 모든 라이브 경로는 `getOutputBus(ctx)`, 오프라인은 `createOfflineOutput`. 스테레오(레이어 pan + 채널 pan). 스튜디오 트레몰로는 공용 모듈로 출력에 연결.

### G9. UI 구성
- 상단: 레이어 스트립(추가/삭제/복제/mute/solo/색), 상태 배지(`✓ 베이킹 · 재계산 단계 n/N · 활성 bin 수 · CPU`), `⇪ 글리산도 보이스로 베이킹`, 이미지 가져오기, JSON/WAV 내보내기, 프리셋 메뉴, 시드 🎲.
- 본문: **왼쪽 = Editor + Result 듀얼 윈도우**(§G5-A, 동일 크기·동일 비율, 시간축 정렬, 뷰 동기화) + 윈도우 좌측 가장자리 도구 바 / **오른쪽 = 랙**(`<section>`: 브러시, 레이어 음색, **효과 스택**(＋ 효과 추가 메뉴, 카드 접기/펼치기, 눈 토글, ↑↓ 순서, 복제, 삭제, mix, mask), **출력 단계 효과**(Noise·Chromatic 고정 구역), 스튜디오 트레몰로).
- 효과 카드 파라미터는 레지스트리 스키마로 자동 생성하되 각 효과 고유 UI(퍼스펙티브 초점 드래그, 크로매틱 비율 메뉴)는 훅으로 확장.
- 모든 컨트롤 `data-help="grid.xxx"` + EN/KO 도움말(요약 + 이미지 연산 ↔ 소리 연산 번역 설명 + 수식). `grid-i18n.js`로 병합, `findMissingI18nKeys()` 빈 배열.

### G10. Bake → Glissando 보이스
- **처리된 행렬(Result)** 에서 리지 트래킹(프레임별 극대점 → 연속성 매칭, 최대 이동/프레임 제한, 사라지면 종료·새 피크 시작)으로 트랙 추출 → 보이스(`engine:'custom'`, `captureCurveToCustomPoints`), 게인은 `gainPoints`. 레이어당 트랙 수와 전체 ≤ 64(진폭 순으로 컷, 개수 토스트).
- 크로매틱 → **정확히 `12·log2(ratio)` 반음 이동한 복제 보이스**. 블러 → 한계: 클러스터는 소수의 디튠 보이스로만 근사(토스트/도움말 `grid.bakeLoss`에 명시).
- 표현 불가(손실) 항목을 UI에 목록으로 표시: 노이즈, 할프톤 게이트의 미세 구조(앵커 한도), 글리치의 그래뉼러 길이, 스테레오 pan(Voice에 pan 없음).
- 리지 트래커는 다른 스튜디오 파일을 import하지 말고(Wave는 수정/의존 금지) 새 순수 모듈 `js/modules/ridge-tracker.js`로 **새로** 만들거나 `grid-engine.js` 안에 구현. 새 shared 모듈을 만들면 보고서에 "Wave도 쓰도록 통합 제안"만 적기.

### G11. 프리셋 (Result가 소리와 닮았는지 눈과 귀로 확인하는 용도)
`Pure Lines`(효과 없음, 선 몇 개) · `Chorus Cloud`(가우시안 σ 60 cents + shimmer) · `Smear`(모션 블러, 상승 잔상) · `Focus Pull`(퍼스펙티브, 중앙 선명/가장자리 구름) · `Breath`(핑크 노이즈 follow 0.7) · `Stutter`(글리치 rate 8, toPainted) · `Dotted Light`(할프톤, jitter 0.6) · `Fifth Shimmer`(크로매틱 2:3/1:1/3:2, 시간 ±8 ms) · `Wavy`(Liquify 사인 모양 곡률) · `Everything`(전부 약하게, 예산 시험용).

### G12. 단계와 완료 기준
**Phase A (필수, 먼저 끝내고 검증)**
1. 데이터 모델·래스터 직렬화·undo, 편집 도구(브러시/지우개/선/도형/버킷/그라데이션/선택/마스크), 이미지 가져오기, 보기 3종, 공용 모듈 연결.
2. 파이프라인 + 단계 캐시 + 미세 행렬 + Tier 1 효과 6종(레지스트리 구조).
3. `grid-bank` 워클릿 + 폴백 + 오프라인 WAV, 예산/배지, 재생 중 편집.
4. 레이어(≤4), 프리셋, Bake→Glissando, EN/KO·도움말, 자가진단, 문서(`STUDIO_INTEGRATION_LOG.md`의 `## Grid Studio (prototype)`, CHANGELOG, 선택: 짧은 `grid.md` 사용 설명서).
**Phase B (A가 전부 통과한 뒤)**
5. Manager 통합 — Wave를 레퍼런스로: `grep -rn "'wave'\|wave" js --include=*.js`로 `js/studios/wave*` 밖의 모든 연결점을 목록화(예: `core/manager-state.js`의 `MANAGER_STUDIOS`·색, `mgr.short.grid` i18n, `audio/studio-clips.js` 어댑터 — `scalesTime`/`render(params, sr, { rate, ampMask, pitchWarp })`/`key(params)`/`lines(params)`, Master View 선). 편집 지점을 줄 추가로만. **`ampMask`와 `pitchWarp` 지원**(행렬에 마스크 곱 / 프레임별 음고 리샘플), 피치 보존 템포(행렬 프레임율 재라벨링 — Wave의 `retimeWaveBake` 방식 참고).
6. Tier 2 효과, 궤적 보내기(`studios/trajectory-link.js`, `audio/send-sources.js`)는 선택(소스: 리지 트랙). 못 하면 "미구현"으로 보고.
Phase B를 못 끝내면 A가 깨끗한 상태로 멈추고 상태를 정직하게 보고.

**완료 기준 (Phase A)**
1. 프리셋 10개 전부 소리·그림이 의도대로. 블러 σ를 0 → 300 cents로 올리면 한 줄이 코러스를 거쳐 구름으로 변하는 것이 들리고 보임.
2. Chromatic: 한 음을 칠하고 3:2 설정 시 정확히 순정 5도 위/아래 복제(주파수 분석으로 확인), Result에서 세 장이 7.02 반음 어긋남.
3. 슬라이더 드래그 30 fps 이상, 손 뗀 뒤 < 400 ms에 소리 반영, 재생 중 편집 안전, 같은 입력 = 같은 소리(결정론).
4. **두 윈도우 요구**: Editor와 Result가 왼쪽에 동시에 같은 크기·비율로 보이고(세로 적층/가로 나란히 모두), 리사이즈·줌·팬·재생헤드·커서 십자선이 동기화되며, Result에서 편집 입력은 무시됨. 윈도우 크기 변경 후에도(락 상태) 두 `metrics`가 동일(자가진단). 락 해제 후 한쪽만 리사이즈 가능, 락 재클릭 시 즉시 재동기화.
5. 공통 문서 §6의 모든 항목 + G0 항목 통과.

### G13. 자가진단 (최소, 그룹 `studio`)
- 래스터: RLE8 왕복(양자화 오차 ≤ 1/255), 해상도 변경 후 총 에너지 ±2%, 빈 래스터 = 0 바이트급.
- 행렬: 셀 하나를 칠하면 에너지 중심이 그 음고 ±½ 미세 bin, 총 에너지 보존 ±2%.
- Blur: `σ=0` 항등(비트 동일), 한 부분음의 스펙트럼 표준편차 ≈ σ cents(±10%), σ 증가에 단조, 전력 보존 ±5%, 모션 `trail:'both'` 무게중심 이동 0 / `'after'` 이동 부호 정확, 퍼스펙티브 σ(x,y) 공식 일치, 분리형 = 2D 직접 컨볼루션(오차 < 1e-5).
- Noise: 오프라인 렌더 FFT 기울기 white 0 / pink −3 / brown −6 dB/oct (±0.7), `levelDb` 보정 ±1 dB, `follow=1`에서 칠한 음고 대역 에너지 ≥ 10 dB(바깥 대비), 시드 재현.
- Glitch: 이벤트 수 평균 `rate·T` ±3σ, 길이 ∈ [min,max], 경계 진폭 스텝 < ε, 같은 시드 동일/다른 시드 다름, `rate=0` 항등, `toPainted` 점프 목적지가 항상 칠해진 행.
- Halftone: 평균 듀티 ≈ 목표(±5%), 켜짐/꺼짐 길이 평균·CV가 설정 분포와 일치(±10%), 엣지 ≥ `edgeMs`, `angle`이 행 간 위상 오프셋을 정확히 만듦, `dropout` 비율 일치.
- Chromatic: 주파수 표 `f_i·r_c` 비율 보존(상대 오차 < 1e-9), 오프라인 렌더 단일음 FFT 피크가 `f·r_c` 와 0.1 cent 이내(채널 3개 모두), 시간 오프셋 정확, 팬 `L²+R²=1`, 채널 `on:false` = 해당 뱅크 무음.
- Liquify: 변위 0 = 항등, push 스트로크가 에너지 중심을 Δ만큼(±5%) 이동, ops 재생 결정론, `reconstruct` 후 항등(오차 < 1e-6), `lockTime`일 때 시간 중심 불변, 에너지 보존(`|det J|` 켬) ±5%.
- 파이프라인: 단계 캐시 적중(후속 효과만 변경 시 앞 단계 재계산 0회), `on:false` 효과 = 항등, `mix=0` 항등, 마스크 밖 불변, 시그니처 안정.
- 뱅크: 희소 = 밀집 결과(< 1e-6), `process()` 할당 0 구조 검사, 오프라인 vs 실시간 상관 > 0.99, 피크 ≤ 0.98, 예산 컷이 진폭 순.
- 스펙트로그램 왕복: 프리셋 `Chorus Cloud`/`Wavy`/`Fifth Shimmer` 오프라인 렌더 → STFT → Result 행렬과 상관 > 0.8(할프톤·글리치는 시간 해상도 한계로 제외, 이유를 보고).
- Bake: 보이스 ≤ 64, 리지 음고 ±1 미세 bin, 크로매틱 복제 보이스 오프셋 = `12·log2(ratio)`(오차 < 1e-9 반음), 상태 불변(`withIsolatedState`).
- 리사이즈 락: 잠금 중 핸들 조작 → 두 크기 동일, 해제 중 한쪽만 변경됨, 재잠금 시 마지막 조정 윈도우 기준으로 즉시 동일해짐, 락 상태 저장/복원.
- 레이아웃: 두 윈도우의 `metrics`(폭·높이·플롯 rect)가 항상 동일(세로/가로 배치, 리사이즈 후, 좁은 창 자동 전환 후), 같은 (시간, 음고) ↔ 픽셀 변환 왕복이 양쪽에서 일치, 뷰 상태 단일 소스.
- i18n 누락 없음, 레지스트리 계약 검증(`validate`), Manager 항목(Phase B).

### G14. 위험/주의
- **비용 폭발**: bin × 채널 × 레이어 × 하모닉. 항상 활성 목록 + `maxActive` 예산을 먼저 설계하고 실측치를 보고서에 표로.
- 이미지 연산 → 소리 연산의 직관이 어긋나는 경우(예: 큰 모션 블러가 소리에선 에코)가 있으면 **Result 캔버스를 소리에 맞게** 그려라(그림이 소리를 따라가야지, 반대가 아님).
- 크로매틱의 "정확한 비율"을 bin 보간으로 구현하지 말 것(위 §G6-5의 이유). 세 채널은 *별도 주파수 표*.
- 코러스 느낌이 정적 비팅으로만 들리면 `shimmer`를 확인. 귀로 판단한 결과를 보고서에 한 줄로.
- Voice에 pan/노이즈가 없는 것은 Bake 한계로 UI에 명시.

### G15. 최종 보고에 추가로 적을 것
- 해석 결정(§G1)과 효과별 번역 방식에서 문서와 달라진 점·이유.
- 실측 수치 표: 래스터 직렬화 크기, undo 비용, 편집→소리 지연, 활성 bin / CPU(기본·최악), 스펙트로그램 상관 값.
- 공용 모듈 사용 현황(어떤 것을 썼고, 꺼 둔 기능과 이유), 공유 파일에 추가한 줄 목록, `CHANGELOG.md` 버전 번호와 커밋 해시(로컬, push 안 함).
- Phase B 상태(통합/미구현), 후속 후보(Tier 3 효과, 레이어 블렌드 모드, 레이어 간 사이드체인 등).
