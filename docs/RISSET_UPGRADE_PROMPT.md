# Risset Studio 고급화: 새 챗용 프롬프트

> 아래 `---` 사이의 내용을 그대로 복사해 새 챗에 붙여넣으세요.
> 맨 끝 **[이론 원문]** 자리에 Part 1-1과 Part 1-2 원문을 함께 붙이면 가장 정확합니다.

---

## 역할과 목표

`~/Documents/Flexatone` 프로젝트의 **Risset Studio**를 리세-셰퍼드 이론(Part 1-1, 1-2) 기반으로 고급화해 줘. 단계는 **A-1 → A-5 순서**로 진행해. 단계 하나가 끝날 때마다 자가진단과 브라우저 확인을 하고, 결과를 한국어로 보고한 뒤 다음 단계로 넘어가.

## 먼저 읽을 것 (코드 수정 전에)

1. `flexatone_architecture_agent_guide.md`: 계층 규칙
2. `docs/ROADMAP_PLANS.md`의 **A장**: 이 작업의 원래 계획과 이론 ↔ 구현 대응표
3. `docs/STUDIO_INTEGRATION_LOG.md`의 Risset 절과 Output stage 절: 이미 해결한 충돌들
4. `risset.md`: 현재 사용자 기능 튜토리얼
5. `js/studios/risset/` 전체
   - `risset-core.js`, `harmony-grid.js`, `local-particles.js`, `loop-automation.js`, `peq-envelope.js`, `space-regions.js`, `risset-audio.js`, `risset-panels.js`
   - 그리고 `js/studios/risset-studio.js`
   - **`space-regions.js`(시간 × 위상 공간의 영역 모듈, 회전 θ)는 계획서 작성 이후에 내가 다른 챗에서 직접 만든 기능**이야. 의도된 기능이니 지우거나 동작을 바꾸지 말고, 새 동역학과 어떻게 공존할지 먼저 파악해.

## 반드시 지킬 프로젝트 규칙

- **빌드 없는 브라우저 ES 모듈 구조:** core → modules → studios → audio → ui → main 계층
  - `core/*`, `modules/*`, 그리고 `studios/risset/`의 순수 파일(`*-core`, `harmony-grid`, `local-particles`, `loop-automation`, `peq-envelope`, `space-regions`, 새 순수 파일)은 **DOM과 Web Audio를 쓰지 않음**
  - 오디오 코드는 `risset-audio.js`, UI 코드는 `risset-panels.js`에만. 순수 파일은 이 둘을 import하지 않음
- **상태:** Risset 문서 전체는 `appState.studioParams.risset`에 있음 (저장, 실행 취소 대상)
  - 새 필드는 sanitize 함수에서 기본값을 채워, 예전 프로젝트 파일도 열리게 할 것
  - 보기 전용 변경은 `history: false`
- **i18n:** 기본 언어 `en`, `ko` 토글. 새 문구는 `js/core/i18n.js`의 en과 ko 양쪽에 추가
- **도움말:** 새 컨트롤마다 `data-help` 키를 달고, `js/ui/option-inspector.js`의 HELP_DB에 en/ko 설명(가능하면 수식 포함)을 추가 (Alt 툴팁, 클릭하면 모달)
- **숫자 입력:** 모든 `<input type="number">`는 `ui/number-scrub.js`가 자동 처리 (드래그 1회 = 실행 취소 1단계)
- **기존 불변식 (깨지면 안 됨):**
  - 셰이핑 y = v·F(τ), F(0) = 0 ⇒ **v = 0이면 위상 완전 정지**
  - 보이스 게인 1/√N (gain-bus)
  - 루핑 오토메이션은 양극성: eff = clamp(base + (y − ½)·(max − min)·depth)
  - Bake to Glissando는 순환 지점에서 보이스를 자르고, 최대 64개
  - 스튜디오 전환, Stop, Esc 때 `studio-host.stopAllAudio()`로 정지
- **출력 경로:** 실시간은 `getOutputBus(ctx)`, 오프라인은 `createOfflineOutput(ctx)` (`js/audio/output-bus.js`). `ctx.destination`에 직접 연결 금지
- **워클릿:** 별도 파일을 fetch하지 말고 **Blob 워클릿**으로
  - 예시: `buildLoudnessWorkletSource()`는 순수 클래스의 `toString()`과 얇은 processor를 합침
  - 이렇게 하면 같은 클래스를 메인 스레드 자가진단으로도 테스트할 수 있음
  - 그 클래스는 import 없이 자기완결이어야 함
- **테스트:** Node가 설치되어 있지 않음. `registerSelfCheck(name, fn, { group })`로 자가진단을 추가하고, 브라우저 콘솔의 `await runSelfCheck()`로 확인 (현재 **54/54 통과**, 이 숫자가 줄면 안 됨)
- **개발 서버:** `.claude/launch.json`의 `flexatone` (`.claude/devserver.py 8000`, no-store 캐시)
- **기록:**
  - 충돌이나 계획 변경은 `docs/STUDIO_INTEGRATION_LOG.md`에 "Risset upgrade" 절로 기록
  - 끝난 단계는 `docs/ROADMAP_PLANS.md` A장에 "상태: 구현 완료" 표시
  - 사용자 기능은 `risset.md` 튜토리얼에 추가

## 단계별 작업

### A-1. 기반: 신호 규격과 AudioWorklet 엔진

- **신호 규격 통일**
  - 새 순수 파일 `js/studios/risset/signal-graph.js`를 만들고, 모든 단계가 보이스 배열 `phase[N] ∈ [0,1)`, `amp[N] ∈ [0,1]`, `mass[N]`을 주고받게 해
  - 단계 인터페이스는 `stage.process(state, dt)`
  - 기존 런타임을 위상 코어 → 격자 → 포락선 → 명멸 → 동역학(지금은 통과) → 출력으로 나눠
  - `space-regions`의 영역별 φᵣ도 이 흐름 안에 넣어
- **Risset AudioWorklet (Blob)**
  - 보이스별 위상 누산기를 샘플 단위로 계산
  - 제어 값(위상 속도, 진폭)은 port로 받고 블록 단위 선형 보간
  - 현재 방식(60개 오실레이터 + 프레임마다 `setTargetAtTime`)을 대체하되, AudioWorklet을 못 쓰는 환경에서는 기존 방식으로 자동 전환
- **자가진단:**
  - 래핑 지점 위상·진폭 연속성
  - 1/√N 레벨
  - 같은 설정에서 오프라인 렌더와 워클릿 결과 일치
  - v = 0 ⇒ 위상 불변

### A-2. 음정 확장과 화성 색채 불변성

- **비율 격자 모드 (`ratio`):**
  - 3:2, 4:3, 5:4, 9:8, 사용자 p:q
  - 오프셋 = 12·log₂(p/q), 센트 표시
  - 비옥타브(스트레치) 스팬 지원
- **포락선 확장:**
  - 비대칭: 왼쪽/오른쪽 σ 분리
  - 첨도 지수 γ: `1/(1 + |d|^γ)`
- **새 순수 파일 `color-analysis.js`:** 부분음 목록(주파수·진폭)에서 프레임마다 계산
  - R_total: Sethares 형태의 Plomp-Levelt 거칠기
  - H(t): 임계 대역 내 쌍 수 × 진폭
  - C_spec: 진폭 가중 log 주파수 평균
  - 캔버스 하단에 시계열로 표시
- **색채 불변성 제어기 (선택):**
  - 목표 C_spec 또는 R_total을 PI 제어로 유지
  - 조절 대상: 포락선 비대칭, A_local Threshold, 음색 기울기
  - 합성 순서는 "제어기 → 기준값", 그다음 "오토메이션 → ± 편차"
- **자가진단:**
  - R_total이 단2도 부근에서 최대 (문헌값)
  - 비율 → 센트 변환 (3:2 = 701.955¢)
  - γ와 비대칭이 0·기본값일 때 기존 포락선과 동일

### A-3. 리듬 ↔ 톤 연속체

- **속도 범위:** v를 리듬 대역(0.5–15 Hz)부터 가청 대역까지 로그 슬라이더로 확장 (기존 −1…+1 범위와의 호환 유지)
- **파형·듀티 모핑:** 보이스 파형을 사인 → 펄스(듀티)로 모핑. 워클릿에서 **PolyBLEP**으로 앨리어싱 억제
- **위상 동기화 ↔ 분산:** 쿠라모토 질서 매개변수 r ∈ [0,1]로 보이스 위상 정렬 정도 제어
- **12–30 Hz 떨림 구간:** 진폭 포락선과 거칠기 포락선을 분리한 이중 포락선
- **폴리리듬-화성 격자 워핑:** 비옥타브 비율로 리듬 격자와 음고 격자를 동시에 변형
- **자가진단:** 나이퀴스트 위로 접혀 들어온 에너지가 한계 이하, 듀티 50% 펄스의 짝수 배음 ≈ 0

### A-4. 로컬 입자 2.0과 질량·부력

- **`local-particles.js` 확장:**
  - S커브 곡률: 코사인 → 가변 시그모이드
  - 주파수 대역 마스킹 (위상 대역에 추가로)
  - 비동기 페이드 분포 (정규 / 로그정규)
- **질량:** 관성 질량 = m₀ + M_i(t), 중력 질량 = A_global·A_local로 분리. m₀ > 0으로 0 나눗셈 발산을 방지
- **부력:** B_i(t) = 포락선 기울기 방향의 상승력. A-5의 입력이 됨
- **자가진단:** m₀ > 0이면 어떤 입력에서도 발산하지 않음, 기본값에서 기존 명멸과 동일

### A-5. 상호작용 동역학 (S¹ 위)

- **새 순수 파일 `dynamics.js`**
- **시간 차수 선택:**
  - 0차: 정적 배치
  - 1차: 이완 θ̇
  - 2차: 관성 θ̈
  - 지연: t − τ (모방 대위법, 캐논)
  - 적분은 `core/math-utils.js`의 `rk4Step`·`integrateRK4`로, 제어율 100 Hz
- **결합 항.** 모두 래핑 경계에서 연속이 되도록 sin(Δθ)를 사용:
  - 쿠라모토 인력: 목표 간격 Δᵢⱼ로 수렴, 기하학적 좌절 허용
  - 임계 대역 척력: 과밀과 성부 교차 방지
  - 점성 μ: 층류(병진행) / 난류(반진행)
  - Boids: 국소 시야각 안의 정렬·응집·분리
- **회전·비대칭 프레임:**
  - 거시 회전 속도 v₀
  - 방향별 저항
  - 부력-중력 대류장
  - `space-regions`의 회전 θ와 개념이 겹치니, 통합할지 분리할지 먼저 제안해 줘
- **에디팅 시점 베이킹:**
  - Field Studio처럼 WAV 내보내기와 Bake to Glissando는 미리 적분한 배열을 사용해 재현성을 보장
  - 베이킹 캐시는 물리 시그니처를 키로 쓰고, 기본값은 결정적이어야 함 (랜덤 id 금지: Field에서 매 프레임 재베이킹 버그가 있었음)
- **자가진단:**
  - v = 0이고 결합이 0이면 위상 불변
  - 점성이 있으면 에너지 단조 감쇠
  - 재생 중 베이킹 0회

## 진행 방식

- 각 단계 시작 전에 **바꿀 파일, 새 파일, 새 state 필드, UI 위치**를 짧게 제시하고 바로 진행해.
  - 이론 원문과 계획이 충돌하거나 해석이 애매하면, 원문을 우선하고 충돌 기록에 남겨.
- 각 단계 끝에 보고할 것:
  - `runSelfCheck` 결과
  - 콘솔 오류 여부
  - 측정한 수치 (예: 앨리어싱 dB, R_total 곡선)
  - **내가 귀로 확인해야 할 체크리스트**
- 계획대로 안 된 것, 생략한 것, 우회한 것은 숨기지 말고 따로 정리해 줘.

## [이론 원문]

(여기에 Part 1-1 원문을 붙여넣기)

(여기에 Part 1-2 원문을 붙여넣기)

---
