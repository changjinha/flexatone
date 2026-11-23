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
## Chaos Studio — 스튜디오 id `chaos`, dev 포트 `8022`, order 50

### 한 줄 목표
Lorenz, Rössler 같은 **카오스 동역학계의 궤적을 글리산도로 소리화**한다. 초기값이 아주 조금 다른 보이스 N개가 갈라지는 "나비효과"를 듣고 보는 것이 핵심입니다. (Field Studio의 RK 적분·베이킹 인프라를 재사용, Risset의 쿠라모토 결합과 비교 청취가 가능한 위치.)

### 지원 시스템 (연속계 6 + 이산 사상 2)
| id | 방정식 | 기본 파라미터 |
|---|---|---|
| `lorenz` | ẋ=σ(y−x), ẏ=x(ρ−z)−y, ż=xy−βz | σ=10, ρ=28, β=8/3 |
| `rossler` | ẋ=−y−z, ẏ=x+ay, ż=b+z(x−c) | a=0.2, b=0.2, c=5.7 |
| `duffing` | ẍ+δẋ+αx+βx³=γcos(ωt) (x, v, t로 3차원화) | δ=0.3, α=−1, β=1, γ=0.37, ω=1.2 |
| `thomas` | ẋ=sin y−bx, ẏ=sin z−by, ż=sin x−bz | b=0.208 |
| `aizawa` | 표준 Aizawa 계수 | a=.95,b=.7,c=.6,d=3.5,e=.25,f=.1 |
| `dpend` | 이중 진자(라그랑주, θ1,θ2,ω1,ω2) | m=1, L=1, g=9.81 |
| `logistic` | x_{n+1}=r·x_n(1−x_n), **r(t) 분기 스윕** | r: 2.8→3.99 |
| `henon` | x'=1−ax²+y, y'=bx | a=1.4, b=0.3 |
각 시스템은 `{ id, name:{en,ko}, dim, params:[{id,min,max,default,step}], deriv(state, p, t), defaultIC, scaleHint }` 형태의 순수 객체로 `chaos-engine.js`에 등록(레지스트리처럼 Map). 새 시스템 추가가 객체 1개 추가로 끝나도록.

### 문서 스키마 (`appState.studioParams.chaos`)
```js
{
  system: 'lorenz', params: {sigma, rho, beta},
  seed: 1, voices: N(1..16), spread: 1e-6,      // 보이스 i 초기값 = IC + spread·i·(시드 PRNG 단위벡터)
  dt: 0.005, transient: 20,                      // 버릴 초기 과도 구간(시뮬 시간)
  simTime: 60, duration: 30,                     // 시뮬 시간 → 곡 길이로 압축/확장
  map: {                                          // 출력 매핑 (각각 소스·범위·곡선)
    pitch: { source:'x'|'y'|'z'|'speed'|'curv'|'radius', lo:36, hi:84, curve:'linear'|'expo'..., invert:false, quantize:'off'|'12tet'|'scale', slewMs },
    gain:  { source:'z', lo:0.1, hi:1, ... },
    bright:{ source:'speed', ... }                // 선택: 필터/음색 모듈
  },
  discrete: { mode:'hold'|'glide', rate:8 /*notes/s*/, glideMs },   // logistic/henon 전용
  sweep: { param:'r', from:2.8, to:3.99 },        // logistic: 시간에 따라 파라미터 변화
  timbre: {...}, normalize:'reference'|'perVoice'
}
```
- **정규화**: 시스템마다 긴 기준 궤적(예: 200 시뮬 초)을 한 번 돌려 2–98 퍼센타일 범위를 구해 `lo/hi` 매핑에 쓴다(`normalize:'reference'`). 그래야 파라미터를 바꿔도 음역이 안정적이고 보이스끼리 비교 가능. 결과는 `(system, params, dt)` 시그니처로 캐시.

### 적분과 베이킹 (순수 엔진)
- `math-utils.js`의 `rk4Step`/`integrateRK4`를 읽고 시그니처에 맞춰 사용. 고정 스텝 RK4, `dt` 기본 0.005. 보이스 N개를 한 번에 베이킹(Float64Array 재사용, 할당 최소화).
- 베이킹 출력: 보이스당 `Float32Array`(시간 균등 `bakeRate` 예: 200 pts/s 곡 시간) — 피치/게인/밝기 3채널 + 위상 초상용 `x,y,z` 다운샘플(캔버스용).
- 시그니처 = `system, params, seed, voices, spread, dt, transient, simTime, duration, map 중 소스/범위 관련 필드`. 소리(timbre/baseGain)는 시그니처 제외. 베이킹 횟수 카운터 노출(`getBakeCount()`).
- 발산 방지: `!Number.isFinite` 감지 시 해당 보이스를 중단하고 상태 배지에 "발산" 표시, 마지막 유한값 유지.
- 이중 진자는 θ를 [−π,π]로 래핑하여 피치로 쓰지 않도록(연속성) 주의: 소스 `theta2_unwrapped`와 `angular speed` 제공.

### 분석 지표 (UI와 자가진단 겸용)
- 보이스 간 거리 d(t)=‖x_i−x_0‖의 로그 그래프 → 초기 지수 성장 구간의 기울기 = 최대 Lyapunov 지수 추정치(Benettin 방법: 별도 쌍 섭동을 주기적으로 재정규화).
- "Divergence time"(d가 스칼라 임계 0.1·attractor 지름을 넘는 시각)을 텍스트로 표시.
- 이산 사상 `logistic`: 분기도(r 대 x) 미니 캔버스 + 현재 r 스윕 위치 표시.

### 캔버스 (UI)
1. **위상 초상**(x–z 투영, 보기 전환 x–y/y–z, 3D 회전은 선택): 궤적 꼬리(trail), 재생헤드 위치의 점, 보이스별 색. 초상 위 점이 소리 나는 현재 상태.
2. **음고 곡선**(시간×MIDI, Glissando 좌표와 동일): 보이스 N개 겹침. 갈라지는 지점이 보임.
3. **발산 그래프**(로그 y): d(t)와 기울기 직선.
각 캔버스 `render(scopes)`에서 재생헤드만 매 프레임, 나머지는 베이킹 변경 시에만 다시 그림(오프스크린 캔버스 캐시).

### 오디오
`chaos-audio.js`: Field 방식(오실레이터 + `setValueCurveAtTime`). 곡선 샘플은 베이킹 배열에서 직접. 이산 모드 `hold`는 `setValueAtTime` 계단(클릭 방지 5ms 슬루), `glide`는 `linearRamp`. 보이스 N≤16이면 라이브 재생 충분. 오프라인 WAV는 동일 스케줄러 재사용.

### Bake
`generateVoices`: 보이스 i → Voice(`engine:'custom'`, `captureCurveToCustomPoints`(maxAnchors 64, 허용오차 0.002)). 이산 hold 모드는 계단이라 앵커 부족 → 그 경우 `maxAnchors` 상향이 가능한지 `captureCurveToCustomPoints` 구현을 확인하고, 불가하면 보이스를 구간 분할(최대 64 보이스)하거나 `glide` 근사로 저장하고 한계를 보고.

### 프리셋 5개
`Butterfly`(Lorenz, N=8, spread=1e-6) · `Two Scrolls`(Rössler, N=3) · `Driven Bell`(Duffing, 이산 양자화 12평균율) · `Bifurcation Ladder`(logistic r 스윕, hold) · `Double Pendulum Pair`(dpend N=2, θ2 → 피치).

### 완료 기준
1. 시스템 전환 즉시 소리·그림 갱신(베이킹 < 200 ms 기본 설정), 재생 중 베이킹 횟수 불변.
2. Lorenz N=8 `spread=1e-6`에서 약 10–20 시뮬 초 후 보이스가 눈에 띄게 갈라지고 발산 그래프에 직선 구간이 나타남.
3. 매핑(소스·범위·양자화)과 slew 조절이 실시간 반영, 베이킹/저장/WAV/EN-KO/도움말 §6 통과.

### 자가진단 (최소)
- RK4 수렴 차수: 조화진동자(ẍ=−x)에서 `dt`를 절반으로 줄이면 전역 오차가 약 1/16(±30%)
- 결정론: 같은 시그니처 두 번 → 동일 배열(비트 단위), 다른 시드 → 다름
- Lorenz 경계성: 기본 파라미터 60 시뮬 초 동안 |x|<60, |y|<80, 0<z<70 (유한)
- 최대 Lyapunov 지수 Lorenz ≈ 0.9 (허용 0.6–1.2)
- `spread` 초기 d(0)가 `spread` 오더이고 이후 증가(로그 기울기 > 0)
- 이산 사상: `logistic r=3.2` 주기-2(말미 4점이 2값 반복), `r=3.99` 카오스(값이 [0,1] 안)
- 시그니처 캐시: 음색/게인 변경 재계산 0회, `params` 변경 1회
- 매핑 범위: 피치 출력이 `lo..hi` 밖으로 나가지 않음(클램프), 발산 보이스 처리 non-throw
- Voice 변환: 개수·x 단조·상태 불변

### 위험/주의
- 보이스 N·`bakeRate`·`simTime` 곱이 커지면 베이킹 시간 폭증: N≤16, 총 샘플 상한(예: 300만)으로 클램프하고 UI에 표시.
- Duffing은 비자율계(시간 항): 상태에 t를 포함하거나 deriv에 t 인자를 받는지 `integrateRK4` 시그니처를 확인.
