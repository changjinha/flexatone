# Flexatone 업그레이드 계획 (Roadmap)

세 가지 계획을 담았습니다:
- **A.** 리세-셰퍼드 이론(Part 1-1·1-2) 기반 Risset Studio 업그레이드
- **B.** 세 스튜디오를 제어하는 총 Manager 모듈 설계
- **C.** 시그널 플로우 마지막 출력 단계 설계 (dB 페이더 테이퍼, Sone·마스킹 엔진)

각 단계는 지금 구조(순수 `core/modules/studios` ↔ `audio`/`ui` 계층, `runSelfCheck`)를 그대로 따릅니다.

---

## A. Risset Studio 업그레이드 계획

### A-0. 이론 변수 ↔ 현재 구현 대응표

| 이론 (Part 1-1 / 1-2) | 현재 상태 | 위치 |
|---|---|---|
| 글리산도 속도 v (±, 0 = 정지) | ✅ −1…+1, 오토메이션, v = 0 ⇒ y = 0 셰이핑 | `risset-core.js` |
| 순환 주기 T = B / (N·\|v\|) | ⚠️ 표시 없음 | 텔레메트리에 추가 예정 |
| N, 간격 I = B/N, 비등간격 Δsᵢ | ✅ 2–60, Equal/Fixed/Pattern/Custom | `harmony-grid.js` |
| 스팬 B, 기준음 M_base, 지수 매핑 | ✅ (반음 단위) | `risset-core.js` |
| 초기 위상 φ₀, 파형, 1/√N | ⚠️ φ₀는 스크럽만, 파형은 사인만 / ✅ 1/√N | |
| S¹ 래핑 | ✅ | |
| A_global (중심 c, 폭 σ) | ✅ Bell-Pass/Gaussian/Raised Cosine | `peq-envelope.js` |
| A_global 비대칭도(Skewness)·첨도 γ | ❌ | A-2 |
| 배음 비율 음정(3:2, 5:4, 9:8) | ⚠️ 반음 근사(7, 4, 2)만 있음 | A-2 |
| R_total (Plomp-Levelt), H(t), C_spec | ❌ | A-2 |
| 리듬 ↔ 톤 연속체, 듀티 모핑, 앨리어싱 억제 | ❌ | A-3 |
| A_local (Rate, Threshold, 페이드 평균·편차, 대역 마스킹) | ✅ | `local-particles.js` |
| S커브 곡률, 주파수 대역 마스킹 | ⚠️ 곡률 고정(코사인), 위상 대역만 | A-4 |
| 질량 M_i(t), 부력 B_i(t), m₀ + M_i | ❌ | A-4 |
| 0차 / 1차 / 2차 / 지연(t − τ) 동역학 | ❌ | A-5 |
| 쿠라모토 인력·좌절, 척력, 점성 μ, Boids | ❌ | A-5 |
| 정지 프레임 vs 회전·비대칭 프레임 | ⚠️ v만 있음 | A-5 |
| 모듈형 신호 흐름 (위상 → 격자 → 포락선 → 명멸 → 동역학 → 출력) | ⚠️ 순서는 맞으나 한 런타임 안에 있음 | A-1 |

### A-1. 기반: 신호 규격과 AudioWorklet 엔진

> **상태: 구현 완료** — `signal-graph.js`, `risset-voicebank.js`(Blob 워클릿 = 같은 클래스), 오실레이터 자동 대체. 별도 `audio/worklets/` 파일은 만들지 않음(Blob 규칙). 세부: STUDIO_INTEGRATION_LOG “Risset upgrade”.


- **신호 규격 통일**
  - 모든 단계가 보이스 배열 `phase[N] ∈ [0,1)`, `amp[N] ∈ [0,1]`, `mass[N]`을 주고받습니다 (`mc~` 방식).
  - 새 파일 `js/studios/risset/signal-graph.js` (순수)에 단계 인터페이스 `stage.process(state, dt)`를 정의하고, 기존 런타임을 위상 코어 → 격자 → 포락선 → 명멸 → 동역학 단계로 나눕니다.
- **AudioWorklet 엔진** (`js/audio/worklets/risset-processor.js`)
  - 보이스별 위상 누산기를 샘플 단위로 계산합니다.
  - 지금은 60개 오실레이터 + 프레임마다 `setTargetAtTime`입니다. 바꾸면 샘플 정확한 래핑, 리듬 대역 속도, 듀티 모핑이 가능해집니다.
  - 제어 값(위상 속도, 진폭)은 `port`로 받고, 블록 단위로 선형 보간합니다.
- **자가진단:** 래핑 지점의 연속성, 1/√N 레벨, 오프라인과 실시간 출력의 일치.

### A-2. 음정 확장과 화성 색채 불변성

> **상태: 구현 완료** — 비율 격자·센트, 비정수 스팬, 비대칭·γ(벨패스), `color-analysis.js`, PI 제어기(range/16 + 0.25 s 지연으로 안정화).


- **비율 기반 격자:** `ratio` 모드(3:2, 4:3, 5:4, 9:8, 사용자 p:q). 비율은 오프셋 12·log₂(p/q)로 변환하고 센트까지 표시합니다. 비옥타브 스트레치 스팬도 지원합니다.
- **포락선 형태 확장:** 비대칭도(왼쪽/오른쪽 σ 분리)와 첨도 지수 γ(`1/(1 + |d|^γ)`)를 추가합니다.
- **분석 모듈** `js/studios/risset/color-analysis.js` (순수)
  - 현재 부분음 목록(주파수·진폭)에서 아래 세 값을 프레임마다 계산합니다:
    - R_total: Sethares 형태의 Plomp-Levelt 거칠기
    - H(t): 가중 화성 밀도 (임계 대역 내 쌍 수 × 진폭)
    - C_spec: 진폭 가중 log 주파수 평균
  - 캔버스 하단에 시계열로 표시합니다.
- **색채 불변성 제어기** (선택)
  - 목표 C_spec 또는 R_total을 PI 제어로 유지합니다.
  - 조절 대상: 포락선 비대칭, A_local 확률(Threshold), 음색 기울기.
  - 루핑 오토메이션과 충돌하지 않도록 “제어기 → 기준값”, “오토메이션 → ± 편차” 순서로 합성합니다.

### A-3. 리듬 ↔ 톤 연속체

> **상태: 구현 완료 (원문 해석으로 변경)** — v 대신 기준 주파수를 0.5 Hz까지 확장(원문 우선), 펄스 모핑 + PolyBLEP + 주파수 의존 모핑, 진폭 가중 쿠라모토 K, 떨림 대역 포락선, 격자 워핑. 옥타브 스택의 쿠라모토 정렬은 보류.


- **속도 범위:** v를 리듬 대역(0.5–15 Hz)과 가청 대역까지 로그 슬라이더로 확장합니다.
- **파형·듀티 모핑:** 보이스 파형을 사인 → 펄스(듀티)로 모핑하고, PolyBLEP 대역 제한으로 앨리어싱을 억제합니다(워클릿).
- **위상 동기화 ↔ 분산:** 쿠라모토 질서 매개변수 r ∈ [0,1]로 보이스 위상 정렬 정도를 제어합니다.
- **12–30 Hz 떨림 구간:** 진폭 포락선과 거칠기 포락선을 따로 두는 이중 포락선입니다.
- **폴리리듬-화성 격자 워핑:** 비옥타브 비율로 리듬 격자와 음고 격자를 동시에 변형합니다.

### A-4. 로컬 입자 2.0과 질량·부력 결합

> **상태: 구현 완료** — κ 시그모이드, Hz 대역 마스크, 균등/정규/로그정규, 질량 m₀ + M, 부력 B = β·A_l·|∂A_g/∂p| (상승력으로 재해석).


- **명멸 세부 제어:** S커브 곡률(코사인 → 가변 시그모이드), 주파수 대역 마스킹, 비동기 페이드 분포(정규/로그정규)를 추가합니다.
- **질량 정의:** 관성 질량 = m₀ + M_i(t), 중력 질량 = A_global·A_local로 분리합니다. 0으로 나누는 발산이 생기지 않습니다.
- **부력:** B_i(t)는 포락선 기울기 방향의 상승력이며, A-5 동역학의 입력이 됩니다.

### A-5. 상호작용 동역학 (원형 공간 위)

> **상태: 구현 완료** — `dynamics.js` (0차/1차/2차/지연, RK4 100 Hz), 회전 좌표계 v₀ = v, space-regions θ와 분리, 결정적 사전 적분 캐시(재생 중 0회).


- **시간 차수 선택:** 0차(정적 배치) / 1차 이완 θ̇ / 2차 관성 θ̈ / 지연 t − τ(모방 대위법, 캐논).
  - 적분은 `core/math-utils.js`의 `rk4Step`·`integrateRK4`를 제어율 100 Hz로 사용합니다.
- **결합 항.** 모두 래핑 경계에서 연속이 되도록 sin(Δθ)을 사용합니다.
  - 쿠라모토 인력: 목표 간격 Δᵢⱼ로 수렴하며, 기하학적 좌절을 허용합니다.
  - 임계 대역 척력: 과밀과 성부 교차를 방지합니다.
  - 점성 μ: 층류(병진행)와 난류(반진행)를 가릅니다.
  - Boids: 국소 시야각 안의 정렬·응집·분리 규칙입니다.
- **회전·비대칭 프레임:** 거시 회전 속도 v₀ + 방향별 저항·부력-중력 대류장.
- **에디팅 시점 베이킹 옵션:** Field Studio처럼, 내보내기와 Bake to Glissando는 미리 적분한 배열을 사용해 재현성을 보장합니다.

### 단계별 산출물 요약

| 단계 | 새 파일 | 자가진단 |
|---|---|---|
| A-1 | `signal-graph.js`, `audio/worklets/risset-processor.js` | 래핑 연속성, 오프라인 = 실시간 |
| A-2 | `color-analysis.js` | R_total 문헌값(단2도 최대 거칠기), 비율 → 센트 |
| A-3 | 워클릿 확장 | 앨리어싱(나이퀴스트 위 에너지) 한계 |
| A-4 | `local-particles.js` 확장 | m₀ > 0에서 발산 없음 |
| A-5 | `dynamics.js` | v = 0 + 결합 0 ⇒ 위상 불변, 에너지 감쇠 |

---

## B. 총 Manager 모듈 설계 (스튜디오 간 합성·사이드체인·상호작용)

### B-1. 핵심 아이디어

각 스튜디오는 지금처럼 독립 플러그인으로 남깁니다. 대신 레지스트리 계약에 다음 세 가지만 추가합니다:

1. **출력 신호** (`signals`)
2. **조작 가능한 파라미터** (`params`)
3. **모듈레이션 적용 훅** (`applyModulation`)

Manager는 이 계약만 보고 라우팅합니다. 스튜디오끼리는 서로를 import하지 않습니다(DAG 유지).

```
studios ──signals()──▶  core/signal-bus  ──▶ modules/mod-matrix ──▶ applyModulation(eff) ──▶ studios
   │                                         ▲          │
   └── audio buses ──▶ audio/manager-mixer ──┘ (sidechain followers)
```

### B-2. 계약 추가 (`studios/registry.js`)

- `params()` → `ParamSpec[]`, 형식 `{ id: 'risset.envCenter', min, max, unit, scale: 'lin'|'log', default }`
  - Risset의 `AUTOMATABLE_PARAMS`를 일반화한 것입니다. Glissando 보이스 파라미터와 Field 물리 파라미터도 같은 형식으로 선언합니다.
- `signals()` → `SignalSpec[]`, 형식 `{ id: 'field.particle.0.speed', range: [0,1], rate: 'control'|'audio' }`
  - 예: Risset 위상·보이스 진폭, Field 입자 속도·곡률, Glissando 보이스 정규 음고·엔벨로프.
- `readSignals(t)` (순수): 시각 t의 신호 값입니다. 베이킹 배열이나 런타임 값을 읽습니다.
- `applyModulation(effMap)` (순수): `{ paramId → 값 }`을 받아 그 프레임의 유효 파라미터를 돌려줍니다. 문서(undo 대상)는 바꾸지 않습니다.

### B-3. 모듈

| 파일 | 계층 | 역할 |
|---|---|---|
| `core/signal-bus.js` | core | 신호 등록·조회, 정규화(0–1 / 양극) |
| `modules/mod-matrix.js` | modules | 라우트 평가, 사이클 검출(DAG), 위상 정렬 순서 |
| `audio/manager-mixer.js` | audio | 스튜디오별 출력 버스, dB 페이더(C의 테이퍼), 사이드체인 엔벨로프 팔로워 |
| `ui/manager-panel.js` | ui | 모듈레이션 매트릭스 그리드, Learn 모드, 라우트별 미니 곡선 편집 |

**라우트 형식**

```js
{ id, source: 'risset.voice.*.amp' | 'audio:glissando.rms', target: 'field.turbulence',
  amount: 0.5, mode: 'add' | 'mul' | 'replace' | 'blend',
  transfer: { engine: 'expo', expK: 3 },   // curve-engine 객체 재사용 (14종 함수 그대로)
  smoothingMs: 20, follower: { attackMs: 5, releaseMs: 120 } }
```

- **전달 함수(transfer):** `curve-engine.js` 객체를 그대로 씁니다. 지수/로그, 삼각, 사용자 수식, 구간(region)까지 재사용할 수 있습니다.
- **합성 규칙:** 같은 대상에 여러 라우트가 있으면 replace → blend(가중 평균) → add → mul 순서로 적용합니다. Multi-Morph 노드 연산(Blend/+Add/×Mul/−Diff)과 같은 의미 체계입니다.

### B-4. 상호작용 3종

1. **파라미터 합성:** 두 소스를 blend/add/mul로 합쳐 한 대상에 적용합니다.
   - 예: Risset 포락선 중심 = 0.6·Field 입자 높이 + 0.4·LFO
   - 스튜디오 스냅샷 간 모핑도 같은 방식입니다.
2. **사이드체인:** 스튜디오 A의 오디오 엔벨로프(RMS, 이후 C의 Sone)가 B의 게인·파라미터를 조절합니다.
   - 덕킹: Glissando가 크면 Risset 마스터를 낮춤
   - 스펙트럼 사이드체인: Glissando 음고 중심 → Risset 포락선 중심
3. **구조 결합:** 한 스튜디오의 출력이 다른 스튜디오의 구조가 됩니다.
   - Field 입자 궤적 → Risset 보이스 오프셋
   - Glissando 보이스 곡선 → Field 가이드 곡선
   - Risset 위상 φ → Field Field Phase

### B-5. 시간·상태·UI

- **공통 시계:** Manager 트랜스포트 하나가 세 스튜디오를 같은 타임라인으로 재생합니다.
  - 지금의 `studio-host`는 “활성 스튜디오 하나만 재생”입니다. Manager 모드에서는 동시 재생으로 바꿉니다.
  - Risset 같은 연속 음장은 타임라인 구간(시작·끝)으로 배치합니다.
- **상태:** `appState.manager = { routes, mixer, clock }`. 저장·실행 취소 대상입니다.
- **Learn 모드:** Risset의 “파라미터 선택 모드”를 전역으로 일반화합니다(`data-param-id` + 캡처 리스너). Option(Alt) 인스펙터와 같은 방식이라 충돌이 없습니다.
- **안전장치**
  - A → B → A 사이클은 등록 시 거부합니다.
  - 제어율은 100 Hz이고, 오디오율 라우트는 워클릿 포트로 확장합니다(B 단계 후반).

### B-6. 단계

| 단계 | 내용 |
|---|---|
| M1 | ParamSpec·SignalSpec 계약 + 세 스튜디오 선언 + 자가진단 |
| M2 | mod-matrix + Learn UI + 라우트 곡선 편집 |
| M3 | 출력 버스 믹서 + 사이드체인 팔로워 (C 완료 후) |
| M4 | 구조 결합 3종 |
| M5 | 공통 타임라인 / 씬(Scene) 전환 |

---

## C. 출력 단계 (dB 모드 · Sone 모드) 설계와 충돌 사항

> **상태: 구현 완료.** 실제 파일 구성과 충돌 처리는 `docs/STUDIO_INTEGRATION_LOG.md`의 *Output stage* 절을 보세요. 워클릿은 별도 파일 대신 Blob으로만 만들었습니다(`LoudnessAnalyzer.toString()`).

### C-1. 이미 있는 것

- `gainUnit: 'amp' | 'db' | 'sone'` 엔벨로프 단위가 있습니다.
  - `gain-bus.envelopeToAmp`, `ENVELOPE_DB_RANGE = 60`, `units.ampToDb`(바닥 −96 dB).
- 마스터 버스의 `soneNormalize` 모드는 스티븐스 근사입니다.

→ 새 출력 단계는 이것을 **대체하지 않고 확장**합니다. 엔벨로프의 dB 모드와 출력 페이더 테이퍼를 같은 함수로 통일합니다.

### C-2. a. dB 모드 (요청 사양 그대로)

- **`core/units.js`에 추가:** `createDbTaper({ dbMin = -60, dbMax = 0, mode: 'linear' | 'daw', knee = 0.15 })`
  - 반환값: `ampToNorm(A)`, `normToAmp(x)`, `dbToNorm`, `normToDb`.
  - ε = 10^(dB_min/20). 상수 `20/Math.LN10`, `Math.LN10/20`은 미리 계산하고, `Math.log`·`Math.exp`만 사용합니다.
- **방식 A:** x = 0 → A = 0. 나머지는 dB = dB_min + x·(dB_max − dB_min).
- **방식 B (DAW):** x < 0.15 구간은 A_thresh·(x/0.15) 선형, 나머지는 dB 선형 매핑입니다.
- **미터 눈금:** x = 0, 0.25, 0.5, 0.75, 1 ↔ −60, −45, −30, −15, 0 dB 등간격.
- **지퍼 노이즈 방지:** 메인 스레드 페이더는 `AudioParam.setTargetAtTime(A, t, τ = 0.005–0.01)`로 처리합니다. 이것이 네이티브 1차 저역통과이므로 워클릿이 필요 없습니다. 워클릿 안의 게인(A-1 엔진)은 one-pole 계수 `1 − e^(−1/(τ·fs))`를 직접 적용합니다.

### C-3. b. Sone · 협대역 마스킹 엔진

| 요구 사항 | 반영 방법 |
|---|---|
| Zero-GC | 생성자에서 링 버퍼, FFT, 24×24×3 확산 행렬, LUT를 `Float32Array`로 한 번만 할당. `process()` 안에서는 할당 0 (자가진단으로 확인) |
| 512 홉 / 1024-FFT | 128 블록 × 4마다 실행, 사인/코사인 LUT + Hann, in-place radix-2 |
| 외이·중이 보정 | 3–4 kHz 공명 부스트 + 저역 감쇠를 빈별 가중치 테이블로 |
| 24 Bark 희소 매핑 | 대역별 `startBin`/`endBin`만 순회 |
| 마스킹 | 하향 −27 dB/Bark, 상향 −10…−25 dB/Bark(레벨 의존). Low/Mid/High 3단 행렬 사이를 Lerp |
| Sone | α ≈ 0.23 LUT + 선형 보간, 0 dBFS ↔ 기준 dB SPL 캘리브레이션 파라미터 |
| UI | `port.postMessage`를 30–60 fps로 스로틀, 24밴드·마스킹 곡선·Total Sone 캔버스 |

### C-4. 충돌과 우회 방법

1. **“단일 .html” 요구 ↔ Flexatone ES 모듈 구조**
   - Flexatone은 이미 여러 파일로 나뉜 무빌드(zero-build) 구조입니다.
   - **우회:** 워클릿을 `js/audio/worklets/loudness-processor.js`로 두고 `audioWorklet.addModule(new URL('./worklets/loudness-processor.js', import.meta.url))`로 로드합니다. 빌드 도구와 CDN이 필요 없다는 핵심 원칙은 그대로입니다.
   - Blob + `createObjectURL` 방식도 대안 경로로 함께 넣어, 단일 HTML로 내보낼 때 쓸 수 있게 합니다.
2. **`soneNormalize` 버스와 중복**
   - 측정된 Total Sone이 생기면, 마스터 버스 정규화를 근사식 대신 측정값 기반 피드백으로 바꿀 수 있습니다. 선택 옵션으로 둡니다.
3. **오프라인 WAV 렌더링**
   - `OfflineAudioContext`에서도 워클릿은 동작합니다. 렌더링 중 라우드니스 곡선을 기록하면 내보낸 파일의 Sone 리포트를 만들 수 있습니다.

### C-5. 파일

| 파일 | 계층 | 역할 |
|---|---|---|
| `core/units.js` (확장) | core | dB 테이퍼 A/B, 정규화 미터 매핑 |
| `modules/output-stage.js` | modules | 출력 모드 상태(Amp/dB/Sone), 테이퍼 선택, 캘리브레이션 |
| `audio/worklets/loudness-processor.js` | audio (worklet) | FFT → Bark → 마스킹 → Sone |
| `audio/loudness-meter.js` | audio | 워클릿 노드 래퍼, 스로틀 수신, 오프라인 지원 |
| `ui/output-panel.js` | ui | 출력 모드 스위치, dB 페이더(테이퍼 B), 24밴드 미터 캔버스 |
