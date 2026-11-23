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
## Cloud Studio — 스튜디오 id `cloud`, dev 포트 `8023`, order 60

### 한 줄 목표
Xenakis식 **확률 구름(stochastic cloud)**: 확률 분포와 시간에 따라 변하는 밀도로 수십~수천 개의 짧은 글리산도 이벤트를 생성한다. 하나의 큰 소리 덩어리를 통계로 조각한다는 점이 Glissando(손 설계)·Risset(결정적 위상)과 다릅니다.

### 핵심 개념
이벤트 = 짧은 글리산도 "입자": `{ t0, dur, p0 (MIDI), p1 (MIDI), gain, laneHint }`. 생성은 완전 **시드 PRNG 결정적**이며, 이벤트 목록을 베이킹(캐시)한 뒤 재생합니다.

### 문서 스키마 (`appState.studioParams.cloud`)
```js
{
  seed: 1, length: 30,                               // 전체 길이(초)
  density: CurveObj,      // events/sec, 시간에 따른 곡선 (curve-engine 객체. evaluateCurveObjectY 재사용). 범위 0.2..200
  pitch: {
    center: CurveObj,     // MIDI, 시간에 따른 중심
    width:  CurveObj,     // 반음 단위 폭 (분포의 σ 또는 반폭)
    dist: 'uniform'|'gauss'|'cauchy'|'logistic'|'levy'|'brownian',
    brownStep: 2.0,       // brownian: 이벤트마다 평균 이동량(반음)
    levyAlpha: 1.5,       // lévy 안정 지수 1<α≤2
    sieve: { enabled:false, terms:[{mod:12, residues:[0,2,4,5,7,9,11]}, ...], op:'union'|'inter', grid:'semitone'|'quarter'|'eighth' },
    snapSieve: true       // 샘플 값을 가장 가까운 체 원소로 끌어당김
  },
  glide: {
    mode: 'slope' | 'target',
    slopeMean: 0, slopeSpread: 6,   // 반음/초
    upBias: 0.5,                     // 상승 비율 (0..1)
    clusterCollapse: CurveObj        // Ligeti 모드: 0=원분포, 1=center 한 점 수렴 (width에 곱해 수렴/발산 연출)
  },
  duration: { dist:'exp'|'lognormal'|'uniform', mean: 0.8, min: 0.05, max: 4 },
  gain: { base: 0.5, spread: 0.3, pitchComp: 'off'|'equalLoud', envelope: 'hann'|'tukey'|'expdecay', attack: 0.02 },
  timbre: {...}, maxEvents: 4000, maxPolyphony: 128
}
```
- **시간 비균질 포아송**: 밀도 λ(t)를 쓰므로 thinning(Lewis–Shedler) 또는 누적 intensity 역변환으로 이벤트 시각 생성. 시드 PRNG(`createSeededRandom`)만 사용, `Math.random` 금지.
- **분포 샘플러**(모두 순수 함수, 같은 PRNG 흐름): uniform, gaussian(Box–Muller), cauchy, logistic, **Lévy 안정 분포**(Chambers–Mallows–Stuck), brownian(누적 합: 이전 이벤트 피치를 상태로).
- **체(sieve)**: Xenakis 방식 `{mod m, residue r}` 항의 합집합/교집합으로 MIDI 정수(또는 1/2, 1/4 반음 격자) 집합을 만들고, 샘플 피치를 가장 가까운 허용값으로 이동.
- **폴리포니 제한**: `maxPolyphony` 초과 시 가장 조용한/오래된 이벤트부터 드랍(결정적 규칙).

### 베이킹 → 오디오 (`cloud-audio.js`)
- 이벤트 정렬 배열(Struct-of-arrays `Float32Array`: t0, dur, p0, p1, gain). 시그니처 캐시.
- 라이브: 스케줄 윈도우(예: 현재 +0.5초 룩어헤드)를 `setInterval`/`requestAnimationFrame`로 굴리며 이벤트마다 `Oscillator + Gain` 쌍을 풀(pool) 방식으로 생성·`stop` 시 폐기. 동시 노드 수 ≤ `maxPolyphony`. 노드 생성 비용을 측정해 보고(예: 200 events/s에서 CPU).
- 이벤트 하나: 주파수 `exponentialRampToValueAtTime`(로그 글라이드), 게인 포락선(hann/tukey/지수감쇠) — 클릭 없음.
- 오프라인 렌더(WAV)는 같은 스케줄러를 `OfflineAudioContext`에 적용. 이벤트가 수천 개면 렌더 시간이 길어질 수 있으니 진행 표시.
- 선택 최적화(시간 남으면): AudioWorklet 그레인 엔진. **프로토타입에서는 노드 풀 방식이 필수, 워클릿은 선택.**

### Bake → Glissando 보이스 (핵심 난제)
이벤트가 수천 개라 보이스 상한 64를 넘음. **레인 할당(interval graph coloring)**:
1. 이벤트를 시작 시각 순으로 정렬, 각 이벤트를 겹치지 않는 가장 앞 레인에 배치(그리디 → 최소 레인 수 = 최대 동시 중첩).
2. 레인 수 > 64면 가장 조용한 이벤트부터 제거하고 제거 개수를 토스트로 알림(`field.bakedToGliss`처럼 개수 포함).
3. 레인 1개 = Voice 1개: 전체 길이 곡선에 이벤트 구간만 `customPoints`로 표현하고, 이벤트 사이는 **직전 이벤트 끝 음고 유지 + 게인 0**(gainPoints에 0 구간). 이벤트 경계의 급한 음고 점프는 무음 구간에서 일어나게 배치. `captureCurveToCustomPoints`의 `maxAnchors`가 부족하면(레인에 이벤트 수십 개) 허용오차/앵커 수를 키우거나 레인을 분할(보이스 수 한도 안에서), 한계를 보고.
4. 이 변환은 근사임을 도움말/토스트에 명시(포락선 모양, 이벤트 겹침 아닌 경우 정확, 풀 드랍 있을 수 있음).

### 캔버스 (UI)
1. **메인 산점도**: 시간×음고에 이벤트를 선분(p0→p1)으로 그림. 선 굵기/알파 = 게인. 이벤트 수천 개에서도 부드럽게(오프스크린 캔버스에 한 번 그리고 viewport 변환만 반영, 재생헤드 이벤트만 하이라이트).
2. **밀도/중심/폭 곡선 편집**: 하단 스트립에 `density`, `pitch.center`, `pitch.width`, `clusterCollapse` 곡선(기존 커브 편집 UI 재사용 가능한지 `panels.js`/`canvases.js`의 게인 캔버스 패턴 참고; 어려우면 곡선 엔진 14종 드롭다운 + 파라미터 슬라이더로 대체).
3. **히스토그램 옆 패널**: 현재 구간의 피치 히스토그램 vs 이론 PDF(분포 선택에 따른 곡선)를 겹쳐 표시(분포가 의도대로 나오는지 확인용).

### 프리셋 5개
`Gauss Rain`(center 60, σ 7, λ 30) · `Lévy Flights`(lévy α=1.3, 점프 큼) · `Brownian Climb`(drift 상승) · `Ligeti Collapse`(clusterCollapse 0→1, 폭 24→0) · `Sieve Garden`(체 M3∪M5, 사분음 격자).

### 완료 기준
1. 프리셋 전환과 파라미터 편집이 즉시 반영, 이벤트 수와 베이킹 횟수 표시, 재생 중 재베이킹 없음.
2. 라이브 재생이 이벤트 100/s에서 끊김 없음(측정값 보고), 같은 시드 → 같은 소리.
3. Bake → Glissando 보이스(≤64)가 원본과 대략 같은 구름 형태(눈으로 비교 가능, 레인 할당 결과 보고).
4. §6 전부 통과.

### 자가진단 (최소)
- 결정론: 같은 시그니처 → 동일 이벤트 배열, 다른 시드 → 다름
- 포아송: 상수 λ=20, T=60 → 이벤트 수 평균 1200±3σ(√1200≈35)
- 비균질: `density` 램프에서 앞 절반 대비 뒤 절반 이벤트 수 비율이 이론값 ±15%
- 분포 샘플러: gauss 평균/표준편차(±3% 샘플 1e5), cauchy 중앙값≈center, lévy α=2에서 σ√2 가우시안과 일치, brownian 증분 분산
- 체: sieve 활성 시 모든 이벤트 피치 ∈ 허용집합, 합집합 ⊇ 각 항, 교집합 ⊆ 각 항
- 폴리포니 제한: 어느 순간에도 동시 이벤트 ≤ `maxPolyphony`
- 레인 할당: 같은 레인의 이벤트가 겹치지 않음, 레인 수 = 최대 중첩 수(그리디 최적)
- 게인 포락선 양끝 0(클릭 없음), 이벤트 수 상한 준수
- Voice 변환: 개수 ≤ 64, 앵커 x 단조, 상태 불변

### 위험/주의
- 이벤트가 많을 때 메인 스레드 병목: 스케줄러 윈도우 크기와 노드 풀 상한을 조절 가능하게(고급 설정).
- 로그 주파수 글라이드는 `exponentialRampToValueAtTime`이 0 이하를 거부하므로 항상 양수 Hz 보장.
