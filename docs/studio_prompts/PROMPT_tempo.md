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
## Tempo Studio — 스튜디오 id `tempo`, dev 포트 `8024`, order 70

### 한 줄 목표
**시간 축 Risset**: 같은 선율(subject)을 서로 다른 템포 곡선으로 동시에 연주하는 템포 캐논/페이징 스튜디오(Nancarrow 수렴 캐논, Reich 페이징, Ligeti식 어긋남). 이 스튜디오가 만드는 것은 *곡 안의 시간 구조*입니다.

### 이름 충돌 주의 (필독)
프로젝트에는 이미 **Tempo Manager**(`js/core/tempo.js`, `js/modules/tempo-manager.js`, `manager-state.js`의 `tempo`)가 있습니다. 이것은 *재생 속도를 전체/채널 단위로 스케일하는 DAW식 마스터 템포*이고, 이 스튜디오는 *보이스 간 상대 템포 구조를 생성*합니다. 두 개념을 혼동하지 않도록 UI 이름은 "Tempo Studio"(탭) / "템포 캐논"(설명)으로 하고, `js/core/tempo.js`의 `tempoRate` 규약(rate = 배속)을 읽어 **같은 의미의 rate**를 쓰되 해당 파일들은 수정하지 마세요. Tempo Manager와 함께 쓰면 곱해지는 구조임을 도움말에 한 줄 적습니다.

### 핵심 수학
- **Subject**: 길이 L(초)인 선율 `S(τ)`, τ∈[0,L]. 노트 열: `[{ midi, dur, glide }]`(glide = 이전 음고에서 이 음으로의 글라이드 비율 0..1).
- **보이스 i의 템포 곡선** `r_i(u)` (u = 전체 진행 시간 0..T, 단위 = 배속). 악보 위치 `s_i(u) = s0_i + ∫₀ᵘ r_i(x) dx`. 소리: `pitch_i(u) = S(s_i(u) mod L)` (루프) 혹은 한 번만(`loop:false`).
- **수렴 캐논(Nancarrow)**: 수렴 시각 `T_c`와 수렴 위치 `s_c`를 지정하면, 모든 보이스가 `s_i(T_c) = s_c`가 되도록 보이스별 상수 비율 또는 곡선 스케일을 **해석적으로 풀어** `s0_i`/`r_i`를 정한다. 예: 비율 `3:4:5` → `r_i = ρ_i·r0`, `s0_i = s_c − ρ_i·r0·T_c`.
- **페이징(Reich)**: 보이스 0은 r=1, 보이스 1은 `r=1+ε`(ε ≈ 0.003–0.02). 위상차 `Δs(u)=ε·u`, 한 루프만큼 어긋나는 시각 `L/ε`.
- **곡선형 템포**: `r_i(u)`를 curve-engine 객체(`evaluateCurveObjectY`)로 두어 accelerando/ritardando 지수형, 로그형 허용(`rate = lo + (hi−lo)·curve(u/T)` 또는 로그 보간).
- 적분은 수치 적분(사다리꼴, 샘플 N=2000/보이스)으로 미리 계산해 `Float64Array s_i[k]`를 캐시(시그니처 캐시). 역변환(시간 → 악보 위치)은 단조 증가이므로 이분 탐색.

### 문서 스키마 (`appState.studioParams.tempo`)
```js
{
  subject: { notes:[{midi,dur,glide}], source:'editor'|'glissandoVoice', voiceIndex, bpmRef },
  length: 40, voices: [{ id, name, color, muted, solo,
    start: 0, transpose: 0, octaveShift: 0,
    tempo: { mode:'const'|'curve'|'converge', ratio: 1, curve: CurveObj, lo: 0.5, hi: 2, scale:'lin'|'log' },
    loop: true, timbre:{...}, baseGain }],
  converge: { enabled:false, Tc: 30, sc: 0, ratios:[3,4,5], preset: 'nancarrow'|'custom' },
  phasing: { enabled:false, epsilon: 0.01 },
  pulse: { audible:true, kind:'click'|'tick', accentFirst:true },   // 템포를 귀로 확인하는 보조 클릭
  quantizeBake: 'continuous'   // 보이스 변환 시 선율 곡선 표현 방식 (아래)
}
```
- `source:'glissandoVoice'`: `appState.voices[voiceIndex]`(core 계층 state)에서 곡선을 읽어 subject로 사용(읽기 전용). 순수 `tempo-engine.js`는 appState를 import하지 말고, 스튜디오 파일(`tempo-studio.js`)에서 읽어 값만 넘기세요.

### 프리셋 5개
`Nancarrow 3:4:5`(수렴 캐논, Tc=30) · `Reich Phase`(2보이스, ε=0.01, 루프) · `Accelerando Fan`(보이스마다 가속 곡선 다름) · `Golden Polytempo`(비율 1, φ, φ², 비정수) · `Stagger Canon`(같은 템포, 오프셋만 다른 캐논).

### 오디오 (`tempo-audio.js`)
- 베이킹된 `pitch_i(u)`/`gain_i(u)` 곡선을 Field 방식(`setValueCurveAtTime`)으로 스케줄. 곡선 샘플 속도는 `bakeRate` (예: 200 pts/s)로 노트 어택/글라이드를 충분히 표현. 노트 경계의 어택/릴리즈 포락선은 곡선의 게인 채널에 포함(노트마다 5–15 ms 램프).
- **펄스 레이어**: 보이스별로 subject의 1박(루프 시작)마다 짧은 클릭(필터 노이즈 버스트 혹은 사인 틱)을 스케줄. 보이스 i의 루프 시작 시각 = `s_i(u) = k·L`이 되는 u (이분 탐색). 보이스별 다른 음고/패닝 없이 구분은 음색 차이(틱 주파수 `800·2^(i/3)`).
- 오프라인 WAV는 같은 스케줄러 재사용.

### 캔버스 (UI)
1. **타임라인(메인)**: 시간×음고, 보이스마다 색 다른 선. 루프 경계에 얇은 세로선.
2. **악보 위치 그래프**: x = 시간, y = 악보 위치 `s_i(u)`. 보이스 직선/곡선이 한 점에서 만나는 수렴이 시각화됨. 수렴 지점 `(Tc, sc)` 마커(드래그 가능, 드래그 중 비율 재계산).
3. **위상차 행렬/막대**: 선택 시각 u에서 보이스 쌍의 `(s_i−s_j) mod L / L`. 동기(0)에 가까우면 강조.
4. **Subject 에디터**: 노트 열 목록(편집 가능) + 소형 피아노롤.
재생헤드가 모든 캔버스에 동기.

### Bake → Glissando 보이스
- 보이스 i → Voice 1개(`engine:'custom'`). 단, 루프 N회 포함 시 한 보이스의 길이가 `MAX_TIME 300`·점 수에 걸릴 수 있음. 시간 곡선이 계단형(노트 경계)이라 앵커 수 부족 가능:
  - 기본: 루프(subject 1회) 단위로 **분할**하여 보이스 = (voices × loops) ≤ 64. 초과 시 루프 수를 줄이도록 경고.
  - `quantizeBake:'continuous'`면 노트 경계에서도 곡선 연속(글라이드로 이음), `'steps'`면 짧은 램프로 계단.
- 각 보이스 `startTime`/`duration`은 시간 압축/확장 결과를 사용.

### 완료 기준
1. Nancarrow 3:4:5가 정확히 Tc에서 한 점에 모이고 소리로도 "한 순간에 모인다"고 들림, 펄스 레이어로 템포 차이가 구분됨.
2. 비수렴(페이징·곡선형) 프리셋에서 위상차 그래프가 시간에 따라 변함.
3. 파라미터 편집 시 즉시 갱신(베이킹 < 100 ms), 재생 중 재베이킹 없음.
4. §6 전부 통과.

### 자가진단 (최소)
- 수렴 정확도: 모든 보이스 `s_i(Tc) = sc` 오차 < 1e-9 (해석해 경로)와 수치 적분 경로 < 1e-6
- 수치 적분 vs 폐형(예: 상수 r → s=s0+r·u, 지수 r(u)=e^{ku} → s=(e^{ku}−1)/k) 상대오차 < 1e-6
- 역변환(시간←악보 위치) 왕복 오차 < 1e-6, 단조성(`r>0`일 때 s 단조 증가)
- 페이징: `Δs(L/ε)=L` (한 루프 어긋남) 허용 1e-6
- 루프 시작 시각 계산이 `s_i(u)=kL`을 만족
- 시그니처 캐시: 소리 파라미터만 바꾸면 재계산 0회
- 결정론, `r<=0` 입력 방어(최소 rate 하한 0.01)
- Voice 변환: 개수 ≤ 64, 보이스 길이·시작 시각 일치, 상태 불변

### 위험/주의
- 매우 느린 rate에서 한 루프가 곡 길이를 넘는 경우 처리(루프 1회 미만 → 부분만 재생).
- 펄스 클릭 수가 많아질 때 스케줄링 지연: 룩어헤드 윈도우 방식 사용(Cloud 스튜디오 방식과 동일).
- Tempo Manager의 `rate`와 곱해질 때 동작을 어떻게 가정했는지 최종 보고에 명시.
