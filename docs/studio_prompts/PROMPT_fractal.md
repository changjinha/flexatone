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
## Fractal Studio — 스튜디오 id `fractal`, dev 포트 `8026`, order 90

### 한 줄 목표
**자기유사(self-similar) 구조로 글리산도 궤적과 보이스 구조를 생성**한다. 확대할수록 비슷한 모양이 나오는 곡선(프랙탈 보간, fBm, 칸토어 계단)과 가지치기 구조(L-system 트리 → 다성부), 스케일 캐논(노르고르 무한 급수)을 지원합니다.

### 생성 모드 6가지 (각각 순수 함수, 시드 결정적)
1. **`fif` — 프랙탈 보간 함수(Barnsley)**: 보간점 `(x_k, y_k)` k=0..N와 수직 스케일 `d_k∈(−1,1)`로 정의되는 연속 함수. 구간 k의 어파인 사상 `w_k(x,y) = (a_k x + e_k, c_k x + d_k y + f_k)` (`a_k=(x_k−x_{k−1})/(x_N−x_0)` 등, 끝점 조건으로 `c_k,e_k,f_k` 결정). 그래프를 **반복(random iteration 또는 결정적 재귀 샘플링 depth)** 으로 `y(x)` 배열 생성. 보간점 드래그 + `d_k` 슬라이더로 편집.
2. **`fbm` — 분수 브라운 운동**: 스펙트럼 합성(`Σ A_k cos(2π k x + φ_k)`, `A_k ∝ k^{−(H+0.5)}`) 또는 midpoint displacement, Hurst 지수 `H∈(0,1)`, 옥타브 수 `octaves`. 시드 PRNG.
3. **`weierstrass` — Weierstrass/Takagi**: `Σ a^k cos(b^k π x)` (0<a<1, ab>1) 또는 Takagi `Σ s(2^k x)/2^k`(s = 삼각파 거리). 해상도 상한 주의.
4. **`cantor` — 악마의 계단**: 칸토어 함수와 일반화(삼분 → `m`분, 제거 비율 `gap`). 단조 증가이므로 "자기유사 계단 글리산도 + 고원(plateau)".
5. **`lsystem` — L-system 트리**: 문자열 재작성(`axiom`, `rules`, `iterations` ≤ 8) → **음고 거북이**: `F` = 시간 전진하며 음고 유지/글라이드, `+`/`−` = 음고 ±`stepSemitones` 방향 전환(누적 기울기), `[` `]` = 분기 push/pop → **분기마다 새 보이스 시작**. 문자열 길이 상한(예: 20만 기호)·보이스 상한 64 방어. 프리셋: 조류(algae: A→AB, B→A), Koch형, 이진 트리.
6. **`canon` — 스케일 캐논 / 노르고르 무한 급수**: 기본 선율(노르고르 급수 `a(0)=0, a(2n)=−a(n), a(2n+1)=a(n)+1` → 0,1,−1,2,1,0,−2,3,…)을 음정 열로 사용해 `K`개 스케일 층(시간 `r^k` 배, 음정 `r^k` 배, r=1/2 또는 사용자)으로 동시 재생. 보이스 = 층.

### 공통 옵션
- **진행적 정밀화(Progressive refinement)**: 세부 단계 `level = 0..K`, 보이스 k는 "레벨 k까지 합산한 곡선"(스펙트럼/반복 depth 기준). 0..K 중 선택한 단계만 켜서 큰 윤곽 → 세부 순서로 들려줌(최대 12보이스), `staggerSec`로 시작 시각 어긋남. fif는 반복 depth, fbm/weierstrass는 옥타브 수에 대응.
- **음고 매핑**: `y∈[0,1]` → `lo..hi` MIDI(로그), 양자화 `off|12tet|scale`, 진폭은 곡선 기울기 크기 `|y'|` 또는 고정 선택(`gainSource`).
- **시간 매핑**: 기본 1배, `canon`은 `r^k`.

### 문서 스키마 (`appState.studioParams.fractal`)
```js
{
  mode: 'fif', seed: 1, length: 30, lo: 36, hi: 84, quantize:'off',
  fif: { points:[{x,y}], d:[...], depth: 6 },
  fbm: { H: 0.5, octaves: 8 }, weier: { a: 0.5, b: 3, terms: 10, takagi: false },
  cantor: { div: 3, gap: 1/3, depth: 6 },
  lsys: { axiom:'F', rules:[{from:'F',to:'F[+F]F[-F]F'}], iterations: 3, angleSemitones: 3, stepSec: 0.6, glide: true },
  canon: { layers: 5, ratio: 0.5, subject:'norgard'|'custom', customIntervals:[...], baseNote: 60, stepSemitones: 2 },
  refine: { enabled:false, levels:[0,2,4,6], staggerSec: 1.5 },
  gain: {...}, timbre: {...}, voicesMax: 16
}
```

### 분석/시각화
- **프랙탈 차원 추정(박스 카운팅)** 결과 `D`와 이론값(`fbm`: `D = 2 − H`) 비교 표시.
- **줌 렌즈(핵심 시각 효과)**: 메인 곡선 위 드래그로 구간 선택 → 보조 패널에 같은 곡선을 확대 표시, 확대할 때 닮은꼴이 반복됨을 확인. 로그 시간 줌 단축키.
- **레벨 색상**: 정밀화 보이스를 단계별 색 그라데이션.
- L-system 트리는 시간×음고 평면에서 가지로 표시(분기점 마커).

### 오디오
`fractal-audio.js`: Field 방식(보이스당 Oscillator + `setValueCurveAtTime`). 곡선 해상도 `bakeRate` 200 pts/s(fbm/Weierstrass 세부 표현을 위해 조절 가능, 최대 총 샘플 상한). 칸토어 고원 구간은 음고 일정, 계단 경계는 5 ms 글라이드로 클릭 방지.

### Bake → Glissando 보이스
- 곡선 모드: 보이스 1 + (정밀화 켜면 레벨별) → `captureCurveToCustomPoints(maxAnchors 64)`. fbm/Weierstrass는 세부가 많아 앵커 64개로는 윤곽만 남음 → **이 근사 손실을 UI에 표기**하고, 허용오차 슬라이더 제공.
- L-system: 분기 수가 64 초과 시 깊이를 줄이도록 경고.
- canon: 층 = 보이스.

### 프리셋 6개
`Coastline`(fbm H=0.3) · `Smooth Drift`(fbm H=0.8) · `Barnsley Ridge`(fif 5점, d=0.5/−0.4…) · `Devil's Stair`(cantor div 3, depth 6) · `Binary Tree`(lsystem, 보이스 수 ≤ 32) · `Infinity Canon`(norgard, 5층).

### 완료 기준
1. 모드 전환 즉시 갱신, 6모드 모두 들림/보임, 줌 렌즈에서 자기유사성이 육안 확인.
2. 정밀화 재생이 "윤곽 → 세부" 순으로 쌓이는 것이 들림.
3. 베이킹 근사 손실 표시, §6 전부 통과.

### 자가진단 (최소)
- `fif`: 곡선이 모든 보간점을 정확히(1e-9) 통과, `d=0`이면 구간별 선형(분할선)
- `fbm`: 같은 시드/H → 동일, 증분 분산 스케일링으로 추정한 `H`가 입력 `H±0.1`
- Weierstrass: 유계(`|y| ≤ 1/(1−a)`), 연속(인접 샘플 차 유한)
- `cantor`: `F(0)=0`, `F(1)=1`, 단조, `F(1/2)=1/2`(삼분), `F(x)=1/2`가 `[1/3,2/3]` 상수
- L-system: algae 반복 길이가 피보나치(1,2,3,5,8,13), 대괄호 균형 검사, 보이스 수 = 분기 수 + 1
- 노르고르: `a(0..7) = 0,1,−1,2,1,0,−2,3`
- 박스 카운팅 `D` 추정: 직선 ≈ 1.0(±0.05), 높은 `H` 낮은 `D`
- 정밀화: 레벨 k 곡선과 k+1 곡선 차이의 RMS가 단조 감소(옥타브가 늘수록 변화 작음)
- 시그니처 캐시와 Voice 변환(개수 ≤ 64, 상태 불변)

### 위험/주의
- fbm/Weierstrass를 그대로 베이킹하면 앵커 한도에서 매우 거칠게 근사: 먼저 `rdpSimplify`로 의미 있는 극값만 남기는 단계를 고려.
- L-system 문자열 폭발 방어(길이 상한) 필수, 상한 도달 시 안전하게 중단하고 배지로 알림.
