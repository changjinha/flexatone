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
## Space Studio — 스튜디오 id `space`, dev 포트 `8025`, order 80

### 한 줄 목표
**움직이는 음원이 만드는 도플러 글리산도**를 물리적으로 시뮬레이션한다. 음원은 경로를 따라 움직이고, 청취자가 듣는 음고/음량/패닝/고역 감쇠가 **지연 시간(retarded time)** 계산으로 얻어집니다. 지나가는 사이렌처럼 *글리산도가 물리로부터 자연스럽게 생기는* 스튜디오입니다. (Field의 "입자 이동"과 개념적으로 가장 가까움.)

### 핵심 물리 (순수 엔진 `space-engine.js`)
- 2D 평면(상단 시점) + 선택적 높이 `y`(기본 0). 청취자 L=(Lx,Ly), 기본 원점.
- 음속 `c` (기본 343 m/s). **`cScale`**(0.05–1): 일상 속도에서도 도플러가 크게 들리도록 가상 음속을 줄이는 "예술용" 슬라이더. 기본 1(현실), 프리셋에서 낮춤.
- 음원 위치 `X(t)`. 청취자가 시각 `t`에 듣는 소리는 방출 시각 `t_e`에서 나온 것이며 `t = t_e + |X(t_e) − L| / c` (지연 시간 방정식).
  - 풀이: `g(t_e) = t_e + |X(t_e)−L|/c − t = 0`. 음원 속도 `|v| < c`일 때 `g`는 단조 증가이므로 **이분 탐색**(bracket `[t − r_max/c, t]`, 허용 1e-10) 또는 뉴턴(안전장치로 이분 병행).
  - 관측 주파수: `f_obs(t) = f_s(t_e) · 1 / (1 + v_r(t_e)/c)` 단, `v_r = d|X−L|/dt_e` (멀어지면 +). 이 식은 `v_r` 방향이 청취자 쪽이면 f 상승. 수치 미분 대신 해석적 `v_r = (X−L)·v / |X−L|`.
  - 초음속 `|v| ≥ c`: 지연 시간 해가 유일하지 않음. 프로토타입은 `|v|`를 `0.98c`로 클램프하고 UI에 "초음속 클램프" 배지를 표시(소닉 붐은 범위 밖).
- 음량: `gain = refDist / max(r, refDist)` (역거리 법칙), `refDist` 기본 1 m, 근접 클램프로 발산 방지.
- 고역 감쇠(공기 흡수 근사): 로우패스 컷오프 `fc = clamp(18000 / (1 + r/airDist), 800, 20000)` (airDist 기본 40 m, 조절 가능).
- 패닝: 청취자 정면 +z 기준 방위각 `θ`, 팬 값 `pan = sin θ` (equal-power `StereoPanner`) 기본. 선택으로 `PannerNode(HRTF)`(라이브 전용, 오프라인 미지원 가능성 확인 후 보고).
- 음원 자체 음고 `f_s(t)`: 상수 또는 곡선(curve-engine 객체, 한 번 지정). 보이스 i마다 별도.

### 경로 타입 (파라메트릭, 길이 T 정규화)
`line`(출발·도착점, 속도 곡선), `orbit`(원/타원, 청취자 중심 여부 선택), `lissajous`(a,b,δ), `spiral`(r0→r1), `draw`(캔버스에 자유 경로를 그려 점 배열 → 등속/속도 곡선 재매개), `static`(고정, 비교용). 경로마다 속도 프로파일(상수/곡선, m/s)과 `startTime`.

### 문서 스키마 (`appState.studioParams.space`)
```js
{
  c: 343, cScale: 1, airDist: 40, refDist: 1,
  listener: { x: 0, y: 0, headingDeg: 0 },
  sources: [{ id, name, color, muted, solo,
    path: { type, ...params }, speed: { mode:'const'|'curve', value: 20, curve: CurveObj },
    start: 0, duration: 20, f: { mode:'const'|'curve', hz: 440, curve: CurveObj },
    timbre:{...}, baseGain: 0.6, doppler: true, distanceGain: true, airAbsorb: true, pan: true }],
  length: 30, bakeRate: 200,
  panMode: 'equalPower'|'hrtf'
}
```
- `doppler:false` 같은 개별 토글로 각 효과를 끄고 비교 청취 가능(교육·디버깅에 중요).

### 베이킹
보이스 i → 샘플 배열 `{ fObs, gain, lp, pan, r, vr }` (`bakeRate` Hz, 시그니처 캐시). 시그니처 = 경로·속도·c·cScale·청취자·`f` 곡선(소리 음색/baseGain 제외). 베이킹 횟수 배지.

### 오디오 (`space-audio.js`)
- 보이스당 `Oscillator(PeriodicWave) → BiquadFilter(lowpass) → Gain → StereoPanner → 출력 버스`.
- 곡선 `frequency / filter.frequency / gain / pan`을 `setValueCurveAtTime(Float32Array, t0, dur)`로 설정(베이킹 배열 직접). 재생 중 연산 없음.
- 오프라인 렌더: 같은 스케줄러를 스테레오 `OfflineAudioContext`에, 2채널 WAV. `encodeWav`가 다채널을 지원하는지 `audio-engine.js` 636행 부근을 읽어 확인하고, 미지원이면 `space-audio.js` 안에 2채널 인코더를 새로 작성(기존 파일 수정 금지) 후 보고.
- 출력 버스는 기존 `getOutputBus` 사용(스테레오 유지 여부 확인).

### 캔버스 (UI)
1. **상단 시점 장면(메인)**: 청취자 아이콘(헤딩 표시), 경로 선, 음원 점이 재생헤드 위치로 이동. 음원 주위에 **파면 링**(방출 시각별 반지름 `c·(t−t_e)`)을 그려 도플러 압축/확장이 시각적으로 보이게(링 수 상한 24). 속도 벡터와 `v_r` 화살표.
   - 드래그: 청취자 이동, 경로 제어점 이동, `draw` 경로 그리기.
2. **관측 곡선 패널**: 시간×음고(`f_obs`, Glissando 좌표계와 동일) + 점선으로 원음고 `f_s`. 같은 시간축에 `gain`, `pan`, `r` 미니 곡선 스택.
3. **스펙트럼 위치 읽기값**: 현재 시각의 `f_obs/f_s`, `v_r`, `r`, 방위각 텍스트.

### 프리셋 5개
`Pass-by`(직선 통과, 가장 기본: 20 m/s, 최단거리 5 m) · `Orbit`(원 궤도, 청취자 중심 아님) · `Spiral In`(나선으로 접근, cScale 0.3) · `Two Sirens`(두 음원 반대 방향 통과) · `Lissajous Swarm`(음원 4개, 각각 다른 f).

### Bake → Glissando
`generateVoices`: 음원 i → Voice(`engine:'custom'`, `f_obs(t)` 곡선, `gainPoints = gain(t)` 17점+). **Voice에 pan이 없어 패닝·고역 감쇠 정보는 손실** — 토스트와 도움말에 명시(`space.bakeLoss`). 베이킹 형태는 보이스 ≤ 64.

### 완료 기준
1. `Pass-by` 프리셋에서 접근 시 음고가 높고 통과 순간 급강하, 멀어질 때 낮은 음고. 패닝이 좌→우로 이동, 고역 감쇠 체감.
2. 각 효과 토글로 개별 비교 가능, 청취자 드래그가 소리에 즉시 반영(재베이킹 < 100 ms).
3. 스테레오 WAV 내보내기 정상(좌우 채널 차이 확인).
4. §6 전부 통과.

### 자가진단 (최소)
- 지연 시간 솔버 잔차 `|g(t_e)| < 1e-9` (여러 경로·속도에서)
- 직선 통과(최단거리 d, 속도 v, f_s): 시작 직후(원거리 접근) `f_obs ≈ f_s·c/(c−v)`, 멀어질 때 `≈ f_s·c/(c+v)` (상대 오차 0.5% 이내, 먼 거리 조건)
- 청취자를 중심으로 하는 원 궤도: `v_r = 0 → f_obs = f_s` (오차 1e-6)
- 정지 음원: `f_obs = f_s`
- `|v| ≥ c` 입력이 `0.98c`로 클램프되고 유한 출력
- 역거리 법칙: 거리 2배 → 게인 1/2 (`refDist` 밖에서)
- Equal-power 팬: `L² + R² = 1` (±1e-9), 청취자 정면 `pan = 0`, 오른쪽 90° `pan = 1`
- 시그니처 캐시: 음색/baseGain 변경은 재베이킹 0회, `cScale`/청취자 변경은 1회
- Voice 변환: 개수, 상태 불변, `f_obs` 샘플 일치

### 위험/주의
- `StereoPanner`가 없는 브라우저/오프라인 호환성 확인.
- `cScale`이 작을수록 `v/c`가 커져 클램프 영역에 근접: UI에 현재 `max(v)/c` 값을 표시.
- 파면 링 그리기는 재생헤드 프레임마다 재계산하되 수식은 간단히(`t_e` 샘플링만).
- 청취자 이동(동적 청취자)은 이번 범위 밖(정지 청취자만). 구현이 쉽다면 이후 과제로 보고.
