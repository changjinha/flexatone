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
## Draw Studio — 스튜디오 id `draw`, dev 포트 `8021`, order 40

### 한 줄 목표
캔버스에 **손으로 그린 선이 곧 글리산도**가 되는 UPIC식 드로잉 스튜디오. 입력 축을 여는 가장 저비용 스튜디오입니다.

### 핵심 개념
- 가로 = 시간(초), 세로 = 음고(로그, MIDI). 획(stroke) 1개 = 보이스 1개.
- 획은 포인터 이벤트로 수집한 원시 점 → 정리(단조화·단순화·스냅) → 스플라인(`customPoints`)으로 변환됩니다. 원시 점과 정리된 결과를 모두 문서에 저장해 파라미터를 바꾸면 **원본에서 다시 계산**(비파괴).
- 획 두께/압력 = 진폭(UPIC 방식). 펜 압력이 없으면 슬라이더로 두께를 지정하고, 획을 따라 변하는 두께는 `PointerEvent.pressure`가 0이 아닌 장치에서만 기록.

### 문서 스키마 (`appState.studioParams.draw`)
```js
{
  strokes: [{ id, name, color, muted, solo,
    raw: [{t, p, w}],                 // t: 초, p: MIDI(실수), w: 0..1 두께/압력. 저장 시 소수 4자리로 반올림
    timeMode: 'x' | 'arc',            // 'x': 가로 위치=시간 (시간 역행은 §시간 정리 규칙). 'arc': 호 길이로 재생(곡선이 뒤로 가도 됨)
    arcSpeed: 12,                     // arc 모드: 화면상 초당 이동량 (px 환산 아님: 정규화 길이/초)
    smooth: 0.35,                     // 0..1 → rdpSimplify epsilon + 스플라인 허용오차
    pitchSnap: 'off'|'semitone'|'quarter'|'scale', scaleId, snapStrength: 0..1,  // 0 = 안 붙음, 1 = 완전 스냅(스냅 구간 글라이드 유지)
    gainSource: 'width' | 'fixed', baseGain,
    timbre: { sine, tri, saw, sqr, rich },
    transform: { transpose, stretch, reverse, invert }   // 비파괴 변환
  }],
  grid: { timeDiv: 0.25|0.5|1|off, pitchDiv: 'semitone'|'off' },
  view: {...},                         // 기록만, history:false 편집
  activeStrokeId, tool: 'draw'|'select'|'node'|'erase'|'line'
}
```

### 시간 정리 규칙 (`timeMode:'x'`)
Voice는 시간의 함수여야 하므로 `t`가 되돌아가는 구간이 있으면:
1. `reversal: 'drop'` — 뒤로 가는 점 삭제(기본), 2. `'split'` — 되돌아가는 지점에서 획을 여러 보이스로 분할, 3. `'arc'` — 위 `timeMode:'arc'` 사용.
UI에서 3가지를 고를 수 있어야 하고, 분할 시 보이스 수 상한(64)을 넘으면 경고 토스트.

### 도구 (캔버스)
- **Draw**: 자유 곡선. 포인터 이벤트 + `getCoalescedEvents()`로 점 수집, 드래그 중 실시간 미리보기(단순화 전/후 겹쳐 표시).
- **Line**: 두 점 직선 글리산도(Shift = 반음 스냅).
- **Select/Move**: 획 선택(클릭), 드래그 이동(시간/음고), 휠로 줌, 빈 곳 드래그로 팬. Shift+드래그 = 박스 선택, 복수 선택 이동.
- **Node**: 선택한 획의 스플라인 앵커 표시 → 앵커 드래그로 편집(편집하면 `raw`를 앵커 샘플로 교체하고 `customPoints` 직접 수정 모드로 전환했음을 배지로 표시).
- **Erase**: 획 클릭 삭제, 드래그로 일부 구간 잘라내기(획 분할).
- 단축키: `D`,`V`,`N`,`E`,`L`(도구), `Delete`, `Cmd/Ctrl+D`(복제), `F`(전체 맞춤). 숫자 입력으로 정확한 transpose/stretch.
- 변환 메뉴: Reverse / Invert / Transpose(±반음) / Time-stretch / **Echo Canon**(복제본 N개를 시간·음고 오프셋으로 자동 배치).

### 가져오기 (SVG 경로 + 이미지)
1. **SVG**: 파일 드롭/선택 → DOM `SVGGeometryElement.getPointAtLength()`로 경로 샘플링(ui 계층에서 수행) → 정규화 → 획으로 추가. 순수 엔진에는 "점 배열 → 획" 함수만 둠.
2. **래스터 이미지 윤곽(선택 구현)**: 임계값 → marching squares 윤곽 추적(순수 엔진) → 획. 구현이 길어지면 **SVG만 필수**, 이미지는 "후속 과제"로 보고.
3. 가져온 도형은 캔버스 중앙에 맞추고 배율/위치 조절 가능.

### 변환 파이프라인 (순수 엔진 `draw-engine.js`)
`raw → (시간 정리) → (스냅) → rdpSimplify → fitStrokeToSpline → customPoints` 순서. 결과는 시그니처(JSON 해시) 캐시. 시그니처에 `smooth/snap/timeMode/transform`을 포함하고 소리(timbre/gain)는 제외 → 소리 변경은 재계산 없음.
- `fitStrokeToSpline` 옵션과 반환 형식은 `math-utils.js` 540행 부근을 읽고 맞출 것.
- 피치 스냅은 로그 MIDI 공간에서 계산, `snapStrength`는 `lerp(원래, 스냅된, strength)`; 스케일 목록은 12평균율 장/단조, 5음계, 온음계(ratio 조율 `scaleId` 확장 가능하도록 centOffsets 배열로 정의).

### 오디오 (`draw-audio.js`)
Field 방식 그대로: 획마다 `OscillatorNode`(PeriodicWave = `computeAdditiveCoefficients`) + `GainNode`, 주파수는 `setValueCurveAtTime`로 베이킹된 곡선, 게인은 두께 곡선. 큐 지점부터 재생, 루프, 오프라인 렌더(WAV). 두께가 0인 구간은 무음. 가청 범위 20–20000 Hz 밖은 클램프.

### Bake
`generateVoices`: 획 → Voice(`engine:'custom'`, 로그 피치, `f0Hz/f1Hz`는 첫/끝 점). 두께 곡선 → `gainPoints`(최대 17점). 보이스 ≤ 64. 분할된 획은 각각 별도 보이스.

### UI 랙
- 획 목록(이름·색·mute/solo·삭제·복제), 그리기 설정(smooth, snap, grid, reversal 모드), 소리(timbre 5파, baseGain, 두께→게인 깊이), 변환, 가져오기, 프리셋.
- 프리셋 3개: "Rising Arc"(단순 호), "UPIC Swarm"(난수 획 12개, 시드 PRNG), "Mirror Canon"(획 + 반전 복제).

### 완료 기준 (프로토타입)
1. 마우스로 그린 획이 즉시 들리고 보이며, smooth 슬라이더로 실시간 정리됨.
2. 3가지 시간 역행 규칙이 작동, 획 20개까지 지연 없이 편집.
3. SVG 가져오기 동작(예: 하트·별 경로가 음고 곡선이 됨).
4. 베이킹/저장/불러오기/실행 취소/WAV/EN-KO/도움말 모두 §6 통과.

### 자가진단 항목 (최소)
- `fitStrokeToSpline` 결과와 원본 `raw`의 RMSE ≤ 허용오차(smooth별)
- 시간 정리: `drop` 결과 `t` 단조 증가, `split` 결과 각 조각 단조 + 총 점 수 보존
- 스냅 멱등성: 이미 스냅된 값에 다시 스냅해도 동일, `strength=0` 입력 불변, `strength=1` 격자값 일치
- `arc` 모드 총 재생 길이 = 호 길이 / `arcSpeed`
- 시그니처 캐시: 소리 파라미터만 바꾸면 재계산 0회
- 보이스 변환: 개수 ≤ 64, `customPoints` x 단조·0…1 범위, 상태 불변(`withIsolatedState`)
- 저장→불러오기 왕복에서 `raw`가 동일

### 위험/주의
- 포인터 점이 너무 많으면 `raw` 저장 용량 증가: 기록 시 최소 거리/시간 간격으로 간인.
- 캔버스 좌표↔(초, MIDI) 변환은 Glissando 메인 캔버스의 viewport 규칙을 읽고 맞출 것. 동일한 줌/팬 단축키 의미 유지.
- 압력 미지원 마우스에서 `w` 상수 취급.
