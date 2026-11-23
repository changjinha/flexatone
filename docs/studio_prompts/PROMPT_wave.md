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
## Wave Studio — 스튜디오 id `wave`, dev 포트 `8027`, order 100

### 한 줄 목표
**음고 축 자체를 매질(medium)로 보고 파동 방정식을 흘린다.** 세로축(음고)이 "줄"이 되어, 파동 pulse·soliton·반응-확산 패턴이 시간에 따라 음고 위를 이동/반사/퍼지는 것을 소리로 만든다. 하나의 pulse가 움직이면 글리산도, 퍼지면 구름, 정상파면 화음이 됩니다.

### 지원 PDE (1D, 격자 `Nx` = 음고 빈, 기본 128)
| id | 방정식 | 비고 |
|---|---|---|
| `wave` | `u_tt = c(x)² u_xx − γ u_t (+ dispersion β u_xxxx)` | 감쇠 γ, 매질 `c(x)` 곡선(불균일), 분산 항 선택 |
| `kg` | Klein–Gordon `u_tt = c² u_xx − m² u` | 질량 항 → 분산 있는 파동 |
| `sg` | sine-Gordon `u_tt = c² u_xx − sin u` | **soliton(kink)** 이동·충돌 — 글리산도처럼 움직이는 입자 |
| `gs` | Gray–Scott 반응-확산 `u_t = Du u_xx − uv² + F(1−u)`, `v_t = Dv v_xx + uv² − (F+k)v` | 패턴 형성 |
x = 음고 `pLo..pHi`(MIDI, 선형=반음 단위)에 선형 대응. 경계: `fixed`(반사 부호 반전), `free`(부호 유지), `absorbing`(흡수), `periodic`(순환).

### 수치 방법 (순수 엔진 `wave-engine.js`)
- `wave/kg/sg`: **Störmer–Verlet(leapfrog)** — 에너지 보존(대칭적), CFL `c·dt/dx ≤ 1`을 자동 클램프하고 배지에 표시. `u_tt = F(u)` 형태. 감쇠는 반 스텝 보정.
- `gs`: 양해 오일러 + 안정 조건 `Dmax·dt/dx² ≤ 0.5` 클램프.
- 시뮬레이션 시간 `T_sim`은 곡 길이 `length`(초)에 선형 대응, 베이킹 시간 격자 `bakeRate`(기본 100 Hz) → 출력 행렬 `E[ti][xi]` (`Float32Array`, 길이 `length·bakeRate·Nx`; 60초 × 100Hz × 128 = 약 77만 값).
- 초기 조건: 여러 pulse(가우시안/삼각/사각), 정상파 모드 n, kink 쌍, 랜덤(시드). 외부 구동 `drivers`: 위치 `x0`, 주파수 `f`(Hz 대신 모델 시간 Hz), 지속 시간, 진폭 — 파원이 연속으로 파를 보냄.
- 캐시 시그니처: `eq, 격자, 경계, 매질, 초기조건, 구동, dt, 시뮬 길이`. 소리 파라미터는 제외.

### 소리화 2모드
**A. Spectral(합성 뱅크)** — 각 빈 `i`가 사인 1개: 주파수 `f_i = midiToFreq(pLo + i·Δp)`, 진폭 `a_i(t) = clamp(g · |u_i(t)|^γ_amp)` (`energy` 모드는 `u_t²+c²u_x²` 국소 에너지). 빈 수 128개는 노드 128개로 부담 → **AudioWorklet 가산 뱅크**(Risset `risset-voicebank.js` Blob 패턴 참고) 사용. 제어 행렬은 `port`로 전달하고 블록 단위 선형 보간. 워클릿 불가 환경은 오실레이터 폴백(빈 수 ≤ 64로 클램프).
**B. Ridge → 보이스(트래킹)** — 프레임마다 극대점(peak, 임계값 이상)을 찾아 **연속성 기반 추적**(이전 프레임 근접 매칭, 최대 이동 반음/프레임 제한, 사라지면 종료/새 피크 시작)으로 최대 `K=16` 트랙 생성. 트랙 = 글리산도 보이스(피치 = 피크 위치(보간 정밀도: 포물선 보간), 게인 = 피크 높이). 이 모드가 **Bake→Glissando의 원천**이며 직접 재생도 Field 방식(Oscillator + `setValueCurveAtTime`).
모드 전환 UI와 설명(도움말) 필수.

### 문서 스키마 (`appState.studioParams.wave`)
```js
{
  eq: 'wave', Nx: 128, pLo: 36, pHi: 96, length: 30, bakeRate: 100, simSpeed: 1,
  c: CurveObj /* 매질 c(x), x∈0..1 */, damping: 0.0, dispersion: 0.0, mass: 0.0,
  boundary: 'fixed'|'free'|'absorbing'|'periodic',
  init: [{ kind:'gauss'|'tri'|'box'|'standing'|'kink'|'noise', x, width, amp, mode, velocity }],
  drivers: [{ x, hz, amp, t0, dur }],
  gs: { Du, Dv, F, k },
  sonify: { mode:'spectral'|'ridge', ampPower: 1, gain: 1, floor: 1e-3, peakThresh: 0.1, maxTracks: 16, maxJump: 3 },
  timbre: {...}, seed: 1
}
```

### 캔버스 (UI)
1. **히트맵(메인)**: x=시간, y=음고(Glissando와 같은 piano-roll 좌표), 색 = 진폭/에너지(`u` 부호 있는 양극 컬러맵 선택 가능). 오프스크린 캔버스에 `E` 행렬을 한 번 그리고 재생헤드만 매 프레임 갱신. 줌/팬/큐 더블클릭 조작은 다른 스튜디오와 동일.
2. **프로파일 스트립**: 현재 재생헤드 시각의 줄 모양 `u(x)`(세로 음고 축에 맞춰 가로로 표시) — 줄 위 파동이 실시간으로 움직임.
3. **초기 조건/구동 에디터**: 히트맵의 시간=0 열에서 pulse를 드래그로 추가/이동/폭 조절, 구동 지점은 점으로 표시. 매질 `c(x)` 곡선 편집(스트립).
4. **리지 오버레이**: ridge 모드에서는 추적 트랙을 선으로 겹쳐 표시.
상태 배지: `CFL 0.92 · 베이킹 N회 · 에너지 오차 0.3%`.

### 프리셋 5개
`Single Pulse`(wave, 중앙 pulse가 양쪽으로 갈라져 반사) · `Standing Chord`(standing n=3,5,8 합) · `Kink Collision`(sg, kink 2개 충돌) · `Moving Medium`(c(x) 경사, 파가 가속/굴절) · `Turing Bloom`(gs, 패턴이 음고 위에서 번짐).

### Bake → Glissando
ridge 트랙 → Voice(`engine:'custom'`, `captureCurveToCustomPoints`), 게인 → `gainPoints`. 트랙 수 ≤ `maxTracks` ≤ 64. Spectral 모드일 때도 Bake 버튼은 ridge 추출을 수행하여 변환(토스트로 "Spectral 질감은 ridge로 근사됨" 안내).

### 완료 기준
1. `Single Pulse`에서 pulse가 퍼져 반사하는 모습이 히트맵에 보이고, Spectral 모드에서 올라가며 내려가는 글리산도가 들림.
2. `Kink Collision`에서 soliton 2개가 충돌 후 속도를 유지하며 통과(sine-Gordon의 특징)하는 것이 시각과 소리로 구분됨.
3. 파라미터 편집 시 베이킹 < 300 ms(기본), 재생 중 재베이킹 없음, 워클릿/폴백 둘 다 동작.
4. §6 전부 통과.

### 자가진단 (최소)
- 안정성: CFL 위반 입력이 자동 클램프되어 유한 출력(NaN 없음)
- 에너지 보존: 무감쇠 `fixed` 경계 `wave`가 10⁴ 스텝에서 상대 에너지 오차 < 1%
- 속도: pulse 피크 이동 속도가 `c` ±2%(균일 매질)
- 반사: `fixed` 경계에서 반사 pulse 부호 반전, `free`에서 유지, `absorbing`에서 잔여 에너지 < 5%
- 정상파: 모드 n 초기 조건이 주기 `2L/(n c)`로 진동
- sine-Gordon kink가 초기 속도에서 속도 `v`로 이동하고 충돌 후 속도 유지(±5%)
- Gray-Scott: 안정 조건 클램프, `u,v`가 [0,1.1]에 머묾
- 피크 추적: 단일 이동 pulse → 트랙 1개, 연속성 유지(점프 ≤ `maxJump`), 두 pulse 교차 시 트랙 수 보존 여부 정책 문서화
- 결정론(시드), 캐시(소리 파라미터 변경 시 재베이킹 0회)
- 워클릿 `process()` 안에서 할당 0회(배열 재사용 검사 가능한 구조), 오프라인 렌더 = 실시간 출력 일치(상관 > 0.99)
- Voice 변환: 개수 ≤ 64, 상태 불변

### 위험/주의
- 행렬 크기와 `postMessage` 비용: 제어 행렬은 청크 단위로 전달하거나 `bakeRate` 100 Hz 이하로 제한. 전체를 한 번에 복사하는 방식이 느리면 `SharedArrayBuffer` 없이 가능한 대안(청크 스트리밍)을 설계하고 보고.
- Spectral 합성은 위상 연속성 필요(진폭만 변화): 빈 주파수는 고정, 위상 누산기는 워클릿 내부 상태로 유지.
- 앨리어싱: `pHi` 대응 주파수가 Nyquist 안에 있도록 클램프.
