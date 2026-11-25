/**
 * Flexatone — ui/param-help-entries.js
 * One-parameter descriptions shown when hovering a parameter label / control (ui/param-help.js).
 * 파라미터 라벨/컨트롤에 마우스를 올리면 보이는 파라미터별 설명.
 *
 * Keys (looked up in this order):
 *   "<helpKey>><labelKey>"  a generic label inside one data-help block ("field.timing>matrix.start")
 *   "<labelKey>"            the label's i18n key ("risset.rotSwingSec")
 *   "<helpKey>><text>"      label without an i18n key; digits → #, trailing "(unit)" dropped ("chaos.sys.lorenz>σ")
 * Parameters whose data-help entry already documents only them (e.g. field.mass) need no entry.
 * 파라미터 하나만 설명하는 data-help 항목이 이미 있으면 여기 항목이 필요 없음.
 */

const P = (en, ko) => ({ en, ko });

export const PARAM_HELP = {
  // ======================================================================
  // Shared curve engine (Glissando, Cloud, Space, Tempo, Field guide …) / 공용 곡선 엔진
  // ======================================================================
  'param.alpha': P('Tilt of the S-curve at its midpoint. 0° = plain cosine S-glide; positive values steepen the middle and flatten the ends, negative values do the reverse (±88° max).',
    'S자 곡선 중앙의 기울기. 0° = 기본 코사인 S 글리산도. 양수면 가운데가 가팔라지고 양 끝이 평평해지며, 음수면 그 반대 (최대 ±88°).'),
  'param.x1': P('Where (0–0.5 of the duration) the first bend of the S-curve sits. Smaller = the glide leaves the start pitch earlier.',
    'S자 곡선의 첫 번째 굽이가 놓이는 위치 (전체 길이의 0–0.5). 작을수록 시작 음을 더 일찍 떠납니다.'),
  'param.x2': P('Where (0.5–1 of the duration) the second bend sits. Larger = the glide reaches the target pitch later.',
    'S자 곡선의 두 번째 굽이 위치 (전체 길이의 0.5–1). 클수록 목표 음에 더 늦게 도착합니다.'),
  'param.symLock': P('Keeps the curve symmetric by forcing x₂ = 1 − x₁.', 'x₂ = 1 − x₁로 묶어 곡선을 좌우 대칭으로 유지합니다.'),
  'param.dampC1': P('On: the oscillation starts and ends with zero slope (smooth landing). Off (C⁰): it starts with a sharp impact at t₀.',
    '켜면 진동이 기울기 0으로 시작·끝나 부드럽게 안착합니다. 끄면(C⁰) t₀에서 날카롭게 부딪히며 시작합니다.'),
  'param.dampMode': P('Whether the arrival at t₀ is smooth (C¹) or a sharp impact (C⁰).', 't₀ 도착이 부드러운지(C¹) 날카로운 충돌인지(C⁰) 선택합니다.'),
  'param.dampT0': P('Fraction of the duration (0.05–0.92) at which the glide first reaches the target and the ringing begins.',
    '글리산도가 처음 목표에 닿고 흔들림이 시작되는 시점 (전체의 0.05–0.92).'),
  'param.dampA': P('Size of the overshoot/ringing around the target, in units of the whole glide. Negative values ring on the other side first.',
    '목표 주변 오버슈트·흔들림의 크기 (전체 글리산도 폭 단위). 음수면 반대쪽부터 흔들립니다.'),
  'param.dampN': P('How many oscillation cycles happen between t₀ and the end.', 't₀부터 끝까지 일어나는 진동 횟수.'),
  'param.dampK': P('Exponential decay rate of the ringing: higher = it dies out faster.', '흔들림의 지수 감쇠율. 클수록 빨리 잦아듭니다.'),
  'param.antD': P('How far the pitch first dips the opposite way before departing (0 = no wind-up).', '출발 전에 반대 방향으로 먼저 물러나는 깊이 (0 = 예비 동작 없음).'),
  'param.antTw': P('Moment (fraction of the duration) where the wind-up is deepest, i.e. the release point.', '예비 후퇴가 가장 깊은 시점 = 발사 순간 (전체 길이 비율).'),
  'param.antP': P('Exponent of the main move tᵖ: 1 = steady, larger = slow start then a fast launch.', '주 이동 tᵖ의 지수. 1 = 일정, 클수록 천천히 시작했다가 빠르게 튀어 나갑니다.'),
  'param.antR': P('Overshoot past the target just before arrival (0 = none).', '도착 직전 목표를 지나치는 정도 (0 = 없음).'),
  'param.ratN': P('Number of equal pitch steps between start and target (staircase glide).', '시작과 목표 사이를 나누는 같은 크기의 음 계단 수.'),
  'param.ratSig': P('Fraction of each step spent sliding to the next one: small = hard steps, 1 = fully smooth.', '각 계단에서 다음 계단으로 미끄러지는 데 쓰는 비율. 작으면 딱딱한 계단, 1이면 완전히 매끈.'),
  'param.chirpA': P('Vibrato depth added on top of the glide, in units of the whole glide (bell-shaped: 0 at both ends).',
    '글리산도 위에 얹는 비브라토 깊이 (전체 폭 단위, 양 끝에서는 0인 종 모양).'),
  'param.chirpF0': P('Vibrato rate at the start of the voice (cycles per unit duration).', '보이스 시작 시점의 비브라토 속도.'),
  'param.chirpF1': P('Vibrato rate at the end; the rate sweeps linearly from f₀ to f₁ (chirp).', '끝 시점의 비브라토 속도. f₀에서 f₁까지 선형으로 변합니다 (처프).'),
  'param.bounceN': P('Number of bounces off the target before the pitch comes to rest.', '음이 멈추기 전까지 목표에서 튀어 오르는 횟수.'),
  'param.bounceK': P('How quickly the bounce height decays (inelastic loss).', '튀는 높이가 줄어드는 속도 (비탄성 손실).'),
  'param.bounceP': P('Time warp of the bounces: >1 makes them speed up toward the end, <1 slows them down.', '튀는 리듬의 시간 왜곡. 1보다 크면 끝으로 갈수록 빨라지고, 작으면 느려집니다.'),
  'param.bezX1': P('Time position (0–1) of the first Bézier handle P₁.', '첫 번째 베지에 핸들 P₁의 시간 위치 (0–1).'),
  'param.bezY1': P('Pitch position of P₁ (0 = start pitch, 1 = target; may go outside for overshoot).', 'P₁의 음고 위치 (0 = 시작 음, 1 = 목표, 벗어나면 오버슈트).'),
  'param.bezX2': P('Time position (0–1) of the second Bézier handle P₂.', '두 번째 베지에 핸들 P₂의 시간 위치 (0–1).'),
  'param.bezY2': P('Pitch position of P₂ (0 = start pitch, 1 = target).', 'P₂의 음고 위치 (0 = 시작 음, 1 = 목표).'),
  'param.platTm': P('Centre time (fraction of the duration) of the resting shelf.', '머무는 구간(선반)의 중심 시각 (전체 길이 비율).'),
  'param.platYm': P('Pitch level of the shelf (0 = start pitch, 1 = target).', '선반의 음고 높이 (0 = 시작 음, 1 = 목표).'),
  'param.platW': P('How long the pitch holds on the shelf (fraction of the duration).', '선반에서 음이 머무는 길이 (전체 길이 비율).'),
  'param.expMode': P('Exponential = slow start, fast finish. Logarithmic = fast start, slow finish.', '지수 = 느리게 시작해 빠르게 끝남. 로그 = 빠르게 시작해 느리게 끝남.'),
  'param.expK': P('Curvature: near 0 is almost a straight line, larger values bend the curve harder.', '곡률. 0에 가까우면 거의 직선, 클수록 강하게 휩니다.'),
  'param.trigFn': P('Which trigonometric function g(x) draws the curve.', '곡선을 그리는 삼각 함수 g(x).'),
  'param.trigX0': P('Input value at the start of the voice (sin, cos, tan in multiples of π).', '보이스 시작 시점의 입력값 (sin·cos·tan은 π의 배수).'),
  'param.trigX1': P('Input value at the end of the voice; the input runs linearly from x₀ to x₁.', '보이스 끝의 입력값. 입력은 x₀에서 x₁까지 선형으로 움직입니다.'),
  'param.trigNorm': P('On: the curve is rescaled so it starts at 0 and ends at 1. Off: raw A·g(x) + bias.', '켜면 0에서 시작해 1에서 끝나도록 다시 맞춥니다. 끄면 원본 A·g(x) + 바이어스.'),
  'param.trigAmp': P('Multiplier A on g(x) (raw mode); in normalized mode it scales the wobble when g(x₀) = g(x₁).', 'g(x)에 곱하는 A (원본 모드). 정규화 모드에서 g(x₀) = g(x₁)일 때 흔들림 크기.'),
  'param.trigBias': P('Constant added to A·g(x) in raw mode (0 = start pitch, 1 = target).', '원본 모드에서 A·g(x)에 더하는 상수 (0 = 시작 음, 1 = 목표).'),
  'param.formulaNorm': P('On: your f(t) is rescaled so f(0) = 0 and f(1) = 1. Off: f(t) is used as is.', '켜면 f(0) = 0, f(1) = 1이 되도록 맞춥니다. 끄면 f(t)를 그대로 씁니다.'),
  'param.flowKind': P('Fluid-dynamics profile: Poiseuille parabola, Blasius boundary layer, Rankine vortex or Stokes\' oscillating layer.', '유체역학 프로파일: 푸아죄유 포물선, 블라지우스 경계층, 랭킨 소용돌이, 스톡스 진동 경계층.'),
  'param.flowP': P('Poiseuille: u = 1 − (1 − t)ⁿ. n = 2 is the true parabola; larger n flattens the plug.', '푸아죄유: u = 1 − (1 − t)ⁿ. n = 2가 실제 포물선, 클수록 중심이 평평해집니다.'),
  'param.flowCouette': P('Share β of a moving wall (Couette flow) mixed into the pressure-driven parabola: u = (1 − β)·Poiseuille + β·t. β = 1 is a straight line.', '압력 구동 포물선에 섞는 이동벽(쿠에트 유동) 비율 β: u = (1 − β)·푸아죄유 + β·t. β = 1이면 직선.'),
  'param.flowSlip': P('Navier slip: the fluid already moves at the wall with fraction s of the final value, u = s + (1 − s)·u₀. Gives the glide a head start.', '나비에 미끄러짐: 벽에서 이미 최종값의 s만큼 움직입니다 (u = s + (1 − s)·u₀). 글라이드가 앞서 출발합니다.'),
  'param.flowEta': P('Blasius: the similarity coordinate η reached at the end (5 ≈ 99 % of free stream). Smaller = still inside the layer, larger = long flat tail.', '블라지우스: 끝에서 도달하는 상사 좌표 η (5 ≈ 자유류의 99 %). 작으면 층 안쪽, 크면 긴 평탄 꼬리.'),
  'param.flowBlaWarp': P('Warps the wall distance, η = η₀·t^w. w < 1 thins the layer (faster rise), w > 1 thickens it, like moving downstream along the plate.', '벽 거리 변형 η = η₀·t^w. w < 1이면 층이 얇아져(빠른 상승), w > 1이면 두꺼워집니다. 판을 따라 하류로 가는 효과.'),
  'param.flowBlaInt': P('Use the stream function f(η) = ∫f′ instead of the velocity f′(η): a gentler start that bends smoothly into a line.', '속도 f′(η) 대신 유선 함수 f(η) = ∫f′를 씁니다. 더 완만하게 시작해 직선으로 이어집니다.'),
  'param.flowCore': P('Rankine: core radius a as a fraction of the span. The glide rises to a peak 1/a at the core edge, then relaxes as 1/r.', '랭킨: 핵 반지름 a (전체 비율). 핵 가장자리에서 1/a 정점까지 오른 뒤 1/r로 가라앉습니다.'),
  'param.flowDecay': P('Outer-field exponent m in v = (a/r)^m. m = 1 is the ideal free vortex; smaller = slower fall-off, larger = a sharper spike.', '바깥 영역 지수 m, v = (a/r)^m. m = 1이 이상적 자유 소용돌이, 작으면 천천히, 크면 뾰족하게 감소.'),
  'param.flowSmooth': P('Blend from the sharp Rankine corner (0) to the smooth viscous Lamb–Oseen vortex (1) with the same core radius.', '뾰족한 랭킨(0)에서 같은 핵 반지름의 매끈한 점성 램–오신 소용돌이(1)로 혼합합니다.'),
  'param.flowStokesEta': P('Stokes: how many boundary-layer thicknesses the voice spans (more = more ripples).', '스톡스: 경계층 두께를 몇 개 지나는지 (클수록 물결이 많음).'),
  'param.flowPhase': P('Stokes: phase φ of the oscillating wall in the profile e^(−η)cos(η − φ).', '스톡스: 프로파일 e^(−η)cos(η − φ)에서 진동 벽의 위상 φ.'),
  'param.flowWaveK': P('Ratio κ of ripple wavenumber to the physical value (1 = Stokes). Higher = faster ripples at the same decay.', '물결 파수와 물리값의 비 κ (1 = 스톡스). 클수록 같은 감쇠에서 물결이 빨라집니다.'),
  'param.flowDamp': P('Ratio ζ of the decay rate to the physical value (1 = Stokes). Lower = ripples ring longer, higher = they die fast.', '감쇠율과 물리값의 비 ζ (1 = 스톡스). 낮으면 오래 울리고 높으면 빨리 사라집니다.'),
  'param.morphMode': P('How the function nodes are combined into one curve (weighted sum, product …).', '함수 노드들을 하나의 곡선으로 합치는 방식 (가중합, 곱 …).'),
  'param.morphWeight': P('Weight w of this node in the combination.', '합성에서 이 노드의 가중치 w.'),

  // ======================================================================
  // Shared 5-wave timbre mix (every studio) / 공용 5파형 음색 혼합
  // ======================================================================
  'trem.shape.sine': P('Level of the sine component in this voice’s 5-wave timbre mix (pure tone, no overtones).', '5파형 음색 혼합에서 사인 성분의 양 (배음 없는 순음).'),
  'timbre.tri': P('Level of the triangle component in the timbre mix (soft, odd harmonics only).', '음색 혼합에서 삼각파 성분의 양 (부드러운 홀수 배음).'),
  'trem.shape.saw': P('Level of the sawtooth component in the timbre mix (all harmonics, bright and buzzy).', '음색 혼합에서 톱니파 성분의 양 (모든 배음, 밝고 거침).'),
  'trem.shape.square': P('Level of the square component in the timbre mix (strong odd harmonics, hollow).', '음색 혼합에서 사각파 성분의 양 (강한 홀수 배음, 텅 빈 소리).'),
  'timbre.rich': P('Level of the “rich” component in the timbre mix (dense upper harmonics).', '음색 혼합에서 “리치” 성분의 양 (촘촘한 고배음).'),

  // ======================================================================
  // Risset Studio / 리세 스튜디오
  // ======================================================================
  'risset.rate': P('Speed v of the endless glissando, in cycles per second: 1 cycle = every voice climbs one full cycle ratio R. Negative = falling. With two or more regions, it sets the selected region’s own speed (and unlinks it from the global rate); with 🌐 Edit all regions it sets the global rate.',
    '끝없는 글리산도의 속도 v (초당 사이클). 1사이클 = 모든 보이스가 순환 비율 R만큼 한 바퀴 오름. 음수 = 하강. 영역이 2개 이상이면 선택된 영역의 자체 속도를 설정합니다(전역 속도 연동 해제). 🌐 모든 영역 편집에서는 전역 속도를 설정합니다.'),
  'risset.loopSec': P('Length of one pass of the automation lanes, in seconds; the lanes repeat after this.', '오토메이션 레인 한 바퀴의 길이 (초). 이 시간마다 반복됩니다.'),
  'risset.voices': P('Number of simultaneous voices spread evenly around the phase circle (2–60). The sum is scaled by 1/√N so loudness stays steady.',
    '위상 원 위에 고르게 놓이는 동시 보이스 수 (2–60). 합은 1/√N로 보정되어 음량이 일정합니다.'),
  'risset.masterGain': P('Overall output level of the Risset voices after the 1/√N compensation.', '1/√N 보정 뒤 리세 보이스 전체의 출력 레벨.'),
  'risset.span': P('Pitch distance, in semitones, that one trip around the phase circle covers (default 96 st = 8 octaves).', '위상 원 한 바퀴가 덮는 음 거리 (반음, 기본 96 = 8옥타브).'),
  'risset.baseMidi': P('MIDI note at the bottom of the circle (phase 0). Together with Span it fixes the frequency range.', '원 맨 아래(위상 0)의 MIDI 음. Span과 함께 주파수 범위를 정합니다.'),
  'risset.fmin': P('Frequency at the bottom of the circle. Below ~12 Hz the voices are heard as pulses (rhythm), above ~30 Hz as pitch.',
    '원 맨 아래의 주파수. 약 12 Hz 아래에서는 펄스(리듬), 30 Hz 위에서는 음높이로 들립니다.'),
  'risset.shapePeriod': P('Period P (s) of the speed shaping: the speed pattern repeats every P seconds while the average speed stays v.',
    '속도 성형의 주기 P (초). 평균 속도 v는 유지한 채 속도 패턴이 P초마다 반복됩니다.'),
  'risset.shapeAmount': P('Sine mode: how strongly the speed surges and slows within each period (0 = constant speed).', '사인 모드: 한 주기 안에서 속도가 빨라졌다 느려지는 정도 (0 = 일정 속도).'),
  'risset.shapePower': P('Polynomial mode: exponent k. k > 1 starts each period slowly and accelerates; k < 1 does the opposite.', '다항 모드: 지수 k. 1보다 크면 주기마다 천천히 시작해 가속, 작으면 반대.'),
  'risset.waveMorph': P('Blend of each voice’s waveform from a pure sine (0) to a band-limited pulse (1). Worklet engine only.', '각 보이스 파형을 순수 사인(0)에서 대역 제한 펄스(1)로 섞는 양. 워클릿 엔진 전용.'),
  'risset.waveDuty': P('Pulse width as a fraction of the period. 50% contains only odd harmonics; narrow pulses sound brighter and thinner.', '주기 대비 펄스 폭. 50%는 홀수 배음만, 좁을수록 밝고 가늘어집니다.'),
  'risset.oscSync': P('Kuramoto coupling of the voices’ waveform phases (Hz). Positive pulls the pulses into step, negative pushes them apart. Pitch is not changed.',
    '보이스 파형 위상의 쿠라모토 결합 (Hz). 양수는 펄스를 한 박자로 모으고, 음수는 흩뜨립니다. 음고는 바뀌지 않습니다.'),
  'risset.flutterDb': P('Level of the voices while they pass through the 12–30 Hz flutter band (between rhythm and tone), in dB.', '보이스가 리듬과 음 사이의 12–30 Hz 플러터 대역을 지날 때의 레벨 (dB).'),
  'risset.massM0': P('Base inertial mass every voice has, added to its loudness-based mass. Larger = slower reactions in the dynamics.',
    '모든 보이스가 기본으로 가지는 관성 질량 (음량 기반 질량에 더해짐). 클수록 동역학 반응이 느립니다.'),
  'risset.buoyancy': P('Upward lift on voices on the steep flanks of the envelope. Against gravity g it drives a convection cycle.', '엔벨로프의 가파른 비탈에 있는 보이스를 위로 띄우는 힘. 중력 g와 맞서 대류 순환을 만듭니다.'),
  'risset.envOn': P('Turns the global spectral envelope on: voices fade in at the bottom of the circle and out at the top.', '전역 스펙트럼 엔벨로프를 켭니다: 보이스가 원 아래에서 서서히 나타나고 위에서 사라집니다.'),
  'risset.envCenter': P('Phase (0–1) where the envelope is loudest.', '엔벨로프가 가장 큰 위상 (0–1).'),
  'risset.envWidth': P('Width σ of the bell. 1.00 lets the whole span sound; small values leave a narrow loud band.', '종 모양의 폭 σ. 1.00이면 전 구간이 울리고, 작으면 좁은 대역만 크게 들립니다.'),
  'risset.envSkew': P('Makes the bell lopsided: positive widens the upper side and narrows the lower side, negative the reverse.', '종을 비대칭으로 만듭니다. 양수면 위쪽이 넓고 아래쪽이 좁아지며, 음수는 반대.'),
  'risset.envGamma': P('Bell-Pass kurtosis γ: higher = flatter top and steeper skirts (γ = 4 is the classic shape).', '벨-패스 첨도 γ. 클수록 윗부분이 평평하고 가장자리가 가파릅니다 (γ = 4가 고전 형태).'),
  'risset.spectralTilt': P('Brightness tilt: each partial is boosted (+) or cut (−) by this many dB per octave above 1 kHz.', '밝기 기울기. 1 kHz 기준으로 옥타브당 이만큼 dB를 올리거나(+) 내립니다(−).'),
  'risset.colorCtlOn': P('Turns on the PI controller that keeps the sound’s colour (C_spec or roughness) at a target while the cluster moves.', '클러스터가 움직이는 동안 음색(C_spec 또는 거칠기)을 목표값으로 유지하는 PI 제어기를 켭니다.'),
  'risset.colorSetHz': P('Target spectral centroid C_spec (Hz) the controller holds.', '제어기가 유지할 목표 스펙트럼 중심 C_spec (Hz).'),
  'risset.colorSetR': P('Target total roughness R_total the controller holds.', '제어기가 유지할 목표 총 거칠기 R_total.'),
  'risset.colorActuator': P('Which parameter the controller moves to reach the target: envelope skew, local threshold or spectral tilt.', '목표에 맞추려고 제어기가 움직이는 파라미터: 엔벨로프 기울기, 로컬 임계값, 스펙트럼 기울기 중 하나.'),
  'risset.colorKp': P('Proportional gain: how strongly the controller reacts to the current error.', '비례 이득: 현재 오차에 얼마나 강하게 반응하는가.'),
  'risset.colorKi': P('Integral gain: how fast the controller removes a lasting error (stops while the actuator is at its limit).', '적분 이득: 남아 있는 오차를 얼마나 빨리 없애는가 (조절 대상이 한계에 닿으면 멈춤).'),
  'risset.localRate': P('Speed of the local fade pattern: how often voices are re-drawn on/off (Random) or the LFO rate (Sine), in Hz.', '로컬 페이드 패턴의 속도 (Hz): 랜덤은 켜짐/꺼짐 재추첨 빈도, 사인은 LFO 속도.'),
  'risset.localThreshold': P('Random: a voice sounds while its noise is above this value (higher = fewer voices). Sine: sets the floor level.',
    '랜덤: 잡음 값이 이보다 높을 때 보이스가 울림 (높을수록 적게). 사인: 최저 레벨을 정함.'),
  'risset.fadeMean': P('Average fade-in/out time (ms) when a voice switches on or off.', '보이스가 켜지거나 꺼질 때의 평균 페이드 시간 (ms).'),
  'risset.fadeDev': P('Random spread of the fade time around the mean (ms).', '평균 페이드 시간 주변의 무작위 편차 (ms).'),
  'risset.bandMin': P('Lower phase edge of the band where local fading acts; voices outside the band are unaffected.', '로컬 페이드가 작용하는 대역의 아래 위상 경계. 대역 밖 보이스는 영향받지 않습니다.'),
  'risset.bandMax': P('Upper phase edge of the local-fading band.', '로컬 페이드 대역의 위 위상 경계.'),
  // Region modules / 영역 모듈
  'risset.peq>Q': P('Bandwidth of this EQ bell: higher Q = narrower band around its frequency.', '이 EQ 벨의 대역폭. Q가 클수록 중심 주파수 주변의 좁은 대역만 바뀝니다.'),
  'risset.regions>trem.toggle': P('Turns this region module on or off.', '이 영역 모듈을 켜거나 끕니다.'),
  'risset.regionLo': P('Bottom of this module’s pitch range, as a phase of the circle (0 = Base MIDI, 1 = top of the span).', '이 모듈 음역의 아래 끝 (원 위상: 0 = Base MIDI, 1 = 범위 꼭대기).'),
  'risset.regionHi': P('Top of this module’s pitch range, as a phase of the circle.', '이 모듈 음역의 위 끝 (원 위상).'),
  'risset.regionEdge': P('Width (in phase) of the fade at the module’s inner borders, so voices do not pop in/out at the range edge.', '모듈 안쪽 경계의 페이드 폭 (위상). 경계에서 보이스가 갑자기 생기거나 사라지지 않게 합니다.'),
  'risset.regionGain': P('Level of this module (0–2) relative to the others.', '다른 모듈 대비 이 모듈의 레벨 (0–2).'),
  'risset.regionLink': P('On: the module moves at the global glissando speed v. Off: it runs at its own speed. Moving the Core rate slider with this region selected sets that speed and turns this link off.', '켜면 전역 글리산도 속도 v로 움직이고, 끄면 자체 속도로 움직입니다. 이 영역을 선택한 채 Core 속도 슬라이더를 움직이면 그 속도가 정해지고 연동이 꺼집니다.'),
  // Space rotation / 공간 회전
  'risset.rotOn': P('Rotates this module’s time × pitch trail picture; the tones you hear are where the trails cross the green line.', '이 모듈의 시간 × 음고 궤적 그림을 회전시킵니다. 궤적이 초록 선을 지나는 곳이 소리가 됩니다.'),
  'risset.rotAngle': P('Fixed rotation angle θ. 0° = normal, 180° = mirrored (rising ↔ falling), ±90° turns time into pitch.', '고정 회전각 θ. 0° = 원래대로, 180° = 뒤집힘(상승 ↔ 하강), ±90° = 시간이 음고로 바뀜.'),
  'risset.rotSpin': P('Continuous rotation speed in degrees per second, added on top of θ (negative = clockwise).', 'θ에 더해지는 연속 회전 속도 (초당 도, 음수 = 시계 방향).'),
  'risset.rotSwing': P('Amplitude of a back-and-forth swing added to the angle: the angle rocks ±this many degrees.', '각도에 더해지는 왕복 흔들림의 크기: 각도가 ±이 값만큼 흔들립니다.'),
  'risset.rotSwingSec': P('Time for one full back-and-forth swing, in seconds (angle = θ + spin·t + depth·sin(2πt / period)).', '왕복 흔들림 한 번에 걸리는 시간 (초). 각도 = θ + 회전·t + 깊이·sin(2πt / 주기).'),
  'risset.rotCenterAuto': P('On: the rotation pivot is the middle of the module’s range. Off: set it yourself below.', '켜면 회전 중심이 모듈 음역의 가운데. 끄면 아래에서 직접 정합니다.'),
  'risset.rotCenter': P('Pitch position (phase 0–1) of the pivot the picture rotates around.', '그림이 도는 회전 중심의 음고 위치 (위상 0–1).'),
  'risset.rotTimeScale': P('How many seconds of trail count as one phase unit when rotating — sets the aspect ratio of the rotated picture.', '회전할 때 궤적 몇 초를 위상 1단위로 볼지 — 회전된 그림의 가로세로 비율을 정합니다.'),
  // Interaction dynamics / 상호작용 동역학
  'risset.dyn.K': P('Kuramoto attraction: pulls voices toward even spacing around the circle (negative = toward clumping).', '쿠라모토 인력: 보이스를 원 위 고른 간격으로 끌어당깁니다 (음수 = 뭉치는 쪽).'),
  'risset.dyn.frustration': P('Phase lag α in the Kuramoto term (radians). Non-zero values make the voices chase each other instead of settling.', '쿠라모토 항의 위상 지연 α (라디안). 0이 아니면 보이스가 자리 잡지 않고 서로를 쫓습니다.'),
  'risset.dyn.repulsion': P('Pushes apart voices that come within one critical band of each other (reduces roughness).', '서로 임계 대역 안으로 가까워진 보이스를 밀어냅니다 (거칠기 감소).'),
  'risset.dyn.viscosity': P('Viscosity μ: neighbouring voices drag each other toward a common speed.', '점성 μ: 이웃 보이스끼리 서로를 같은 속도 쪽으로 끌어당깁니다.'),
  'risset.dyn.view': P('How far (in phase) a voice “sees” its neighbours for viscosity and Boids rules.', '점성과 보이드 규칙에서 보이스가 이웃을 “보는” 거리 (위상).'),
  'risset.dyn.align': P('Boids alignment: each voice steers toward the average speed of its neighbours.', '보이드 정렬: 각 보이스가 이웃의 평균 속도 쪽으로 방향을 맞춥니다.'),
  'risset.dyn.cohesion': P('Boids cohesion: each voice moves toward the centre of its neighbours (flocking).', '보이드 응집: 각 보이스가 이웃의 중심 쪽으로 다가갑니다 (무리 짓기).'),
  'risset.dyn.separation': P('Boids separation: each voice moves away from neighbours that are too close.', '보이드 분리: 너무 가까운 이웃에게서 멀어집니다.'),
  'risset.dyn.gravity': P('Gravity g on each voice’s loudness-based mass: loud voices sink, buoyancy lifts quiet ones (negative = reversed).', '음량 기반 질량에 걸리는 중력 g: 큰 보이스는 가라앉고 부력이 작은 보이스를 띄웁니다 (음수 = 반대).'),
  'risset.dyn.noise': P('Random jitter σ on every voice (seeded, so the same settings give the same result).', '모든 보이스에 더하는 무작위 흔들림 σ (시드 고정이라 같은 설정이면 같은 결과).'),
  'risset.dyn.dragUp': P('Resistance against voices moving upward relative to the rotating frame.', '회전 기준틀에 대해 위로 움직이는 보이스에 걸리는 저항.'),
  'risset.dyn.dragDown': P('Resistance against voices moving downward relative to the rotating frame.', '회전 기준틀에 대해 아래로 움직이는 보이스에 걸리는 저항.'),
  'risset.dyn.delaySec': P('Delay τ: voices react to where the others were τ seconds ago (canon-like lag).', '지연 τ: 보이스가 τ초 전 다른 보이스의 위치에 반응합니다 (캐논 같은 지연).'),

  // ======================================================================
  // Glissando Studio / 글리산도 스튜디오
  // ======================================================================
  'gliss.timing>matrix.start': P('When this voice starts, in seconds from the beginning.', '이 보이스가 시작하는 시각 (처음부터 초).'),
  'gliss.baseGain>matrix.gain': P('Overall level of this voice before the loudness curve.', '음량 곡선 적용 전 이 보이스의 기본 레벨.'),

  // ======================================================================
  // Field Studio / 필드 스튜디오
  // ======================================================================
  'field.arrowDensity': P('Spacing of the field arrows in pixels: smaller = more arrows. Display only.', '필드 화살표 간격 (픽셀). 작을수록 화살표가 많아집니다. 표시 전용.'),
  'field.arrowSize': P('Length multiplier of the field arrows. Display only.', '필드 화살표 길이 배율. 표시 전용.'),
  'field.arrowWidth': P('Line width of the field arrows in pixels. Display only.', '필드 화살표 선 굵기 (픽셀). 표시 전용.'),
  'field.guide': P('Shows the guiding curve g(t) that the Guiding Pull draws particles toward.', '가이드 인력이 입자를 끌어당기는 가이드 곡선 g(t)를 표시합니다.'),
  'field.wells': P('Shows the pitch-well grid lines on the canvas.', '캔버스에 음정 우물 격자선을 표시합니다.'),
  'field.wellPull': P('Strength of the pitch wells: how hard nearby particles are snapped onto the tuning grid.', '음정 우물의 세기: 근처 입자를 조율 격자로 얼마나 세게 끌어당기는가.'),
  'field.turbFreq': P('Size of the turbulence eddies: higher = smaller, faster swirls.', '난류 소용돌이의 크기. 높을수록 작고 촘촘한 소용돌이.'),
  'field.region.flowAngle': P('Direction of the push inside the region: 0° = forward in time, 90° = pitch up, −90° = pitch down.', '영역 안에서 미는 방향. 0° = 시간 앞으로, 90° = 음고 위, −90° = 음고 아래.'),
  'field.region.flowStrength': P('How hard the region pushes particles in that direction.', '영역이 그 방향으로 입자를 미는 세기.'),
  'field.nodeStrength': P('Strength of this force: positive attracts / pushes along its direction, negative reverses it.', '이 힘의 세기. 양수는 끌어당기거나 그 방향으로 밀고, 음수는 반대.'),
  'field.nodeRadius': P('Reach of the node: its effect fades out (Gaussian) beyond this distance.', '노드의 영향 반경. 이 거리를 넘으면 효과가 (가우시안으로) 사라집니다.'),
  'field.launchAngle': P('Direction of the particle’s initial velocity: 0° = straight forward in time, positive = upward in pitch.', '입자 초기 속도의 방향. 0° = 시간 앞으로 똑바로, 양수 = 음고 위쪽.'),
  'field.launchSpeed': P('Magnitude of the particle’s initial velocity.', '입자 초기 속도의 크기.'),
  'field.restitution': P('Bounciness at the pitch boundary (Elastic Bounce): 1 keeps all speed, 0 stops dead.', '음역 경계에서의 반발 계수 (탄성 반사). 1은 속도 유지, 0은 그 자리에서 멈춤.'),
  'field.timing>matrix.start': P('When this particle starts sounding, in seconds.', '이 입자가 소리 나기 시작하는 시각 (초).'),
  'field.timing>glis.duration': P('How long this particle sounds, in seconds (its whole path is stretched to this length).', '이 입자가 소리 나는 길이 (초). 전체 경로가 이 길이에 맞춰집니다.'),
  'field.speedToGain>matrix.gain': P('This particle’s level before the speed-to-gain modulation.', '속도 → 게인 변조 전 이 입자의 기본 레벨.'),
  'field.baseGain': P('This particle’s level before the speed-to-gain modulation.', '속도 → 게인 변조 전 이 입자의 기본 레벨.'),
  'field.layer.full': P('On: the layer acts on the whole plane. Off: only inside the box set by Start/End and Low/High.', '켜면 레이어가 평면 전체에 작용. 끄면 시작/끝, 낮은/높은 음으로 정한 상자 안에서만 작용.'),
  'field.layer.t0': P('Left edge (time, s) of the box where this layer acts.', '이 레이어가 작용하는 상자의 왼쪽 경계 (시간, 초).'),
  'field.layer.t1': P('Right edge (time, s) of the layer’s box.', '레이어 상자의 오른쪽 경계 (시간, 초).'),
  'field.layer.m0': P('Lower pitch edge (MIDI) of the layer’s box.', '레이어 상자의 아래 음고 경계 (MIDI).'),
  'field.layer.m1': P('Upper pitch edge (MIDI) of the layer’s box.', '레이어 상자의 위 음고 경계 (MIDI).'),
  'field.region.x': P('Centre of the region in time (s).', '영역 중심의 시간 위치 (초).'),
  'field.region.y': P('Centre of the region in pitch (MIDI).', '영역 중심의 음고 위치 (MIDI).'),
  'field.region.w': P('Half-width of the region in seconds (it extends this far left and right of the centre).', '영역의 시간 방향 반폭 (중심에서 좌우로 이만큼, 초).'),
  'field.region.h': P('Half-height of the region in semitones.', '영역의 음고 방향 반높이 (반음).'),

  // ======================================================================
  // Draw Studio / 드로잉 스튜디오
  // ======================================================================
  'draw.echoCount': P('Number of echo copies added after the active stroke.', '활성 획 뒤에 덧붙는 에코 사본 수.'),
  'draw.echoDt': P('Time delay between successive copies, in seconds.', '연속된 사본 사이의 시간 지연 (초).'),
  'draw.echoDp': P('Transposition step between successive copies, in semitones (negative = downward).', '연속된 사본 사이의 이조 간격 (반음, 음수 = 아래로).'),
  'draw.echoDecay': P('Gain multiplier per copy: copy k has gain × decayᵏ.', '사본마다 곱하는 게인 배율: k번째 사본 = 게인 × decayᵏ.'),

  // ======================================================================
  // Cloud Studio / 클라우드 스튜디오
  // ======================================================================
  'cloud.curve.lo': P('Event density (events per second) where the density curve is at 0.', '밀도 곡선이 0일 때의 이벤트 밀도 (초당 이벤트 수).'),
  'cloud.curve.hi': P('Event density (events per second) where the density curve is at 1.', '밀도 곡선이 1일 때의 이벤트 밀도 (초당 이벤트 수).'),
  'cloud.pitchMin': P('Lowest pitch (MIDI) any event may have; draws below it are clipped.', '이벤트가 가질 수 있는 가장 낮은 음 (MIDI). 그 아래 값은 잘립니다.'),
  'cloud.pitchMax': P('Highest pitch (MIDI) any event may have.', '이벤트가 가질 수 있는 가장 높은 음 (MIDI).'),
  'cloud.sieve.op': P('Union: a pitch is allowed if any sieve term allows it. Intersection: only if all terms allow it.', '합집합: 한 항이라도 허용하면 허용. 교집합: 모든 항이 허용해야 허용.'),
  'cloud.sieve>mgrVid.grid': P('Size of one sieve step: semitone, quarter tone or eighth tone.', '체 한 칸의 크기: 반음, 사분음, 팔분음.'),
  'cloud.sieve.mod': P('Modulus m of this sieve term: the pattern repeats every m grid steps.', '이 체 항의 법 m: 격자 m칸마다 패턴이 반복됩니다.'),
  'cloud.slopeMean': P('Average glide steepness of an event, in semitones per second.', '이벤트 글리산도의 평균 기울기 (초당 반음).'),
  'cloud.slopeSpread': P('Random spread of the glide steepness around the mean (st/s).', '평균 기울기 주변의 무작위 편차 (초당 반음).'),
  'cloud.durMean': P('Average event duration in seconds.', '이벤트 평균 길이 (초).'),
  'cloud.durMin': P('Shortest allowed event duration; every duration is clipped to [min, max].', '허용되는 가장 짧은 이벤트 길이. 모든 길이는 [최소, 최대]로 잘립니다.'),
  'cloud.durMax': P('Longest allowed event duration.', '허용되는 가장 긴 이벤트 길이.'),
  'cloud.gain>draw.baseGain': P('Average level of every event before the random spread.', '무작위 편차 적용 전 모든 이벤트의 평균 레벨.'),
  'cloud.gainBase': P('Average level of every event before the random spread.', '무작위 편차 적용 전 모든 이벤트의 평균 레벨.'),
  'cloud.gainSpread': P('How much each event’s level varies at random: gain = base · (1 ± spread).', '이벤트마다 레벨이 무작위로 흔들리는 정도: 게인 = 기본 · (1 ± 편차).'),
  'cloud.lookahead': P('How far ahead live playback schedules events (s). Larger = more robust, but edits are heard later.', '실시간 재생이 미리 예약하는 시간 (초). 클수록 안정적이지만 편집이 늦게 들립니다.'),
  'cloud.interval': P('How often the scheduler wakes up to schedule the next events (ms).', '스케줄러가 다음 이벤트를 예약하러 깨어나는 간격 (ms).'),
  'cloud.brownStep': P('Brownian walk: typical (RMS) pitch change from one event to the next, in semitones.', '브라운 운동: 이벤트 간 전형적(RMS) 음고 변화 (반음).'),
  'cloud.brownDrift': P('Brownian walk: constant pitch change added at every event (positive = climbing).', '브라운 운동: 이벤트마다 더하는 일정한 음고 변화 (양수 = 상승).'),

  // ======================================================================
  // Space Studio / 스페이스 스튜디오
  // ======================================================================
  'space.lx': P('Listener position, east–west (m).', '청취자 위치, 동서 방향 (m).'),
  'space.ly': P('Listener position, north–south (m).', '청취자 위치, 남북 방향 (m).'),
  'space.x0': P('x coordinate (m) where the source’s straight path starts.', '음원 직선 경로가 시작하는 x 좌표 (m).'),
  'space.y0': P('y coordinate (m) where the source’s straight path starts.', '음원 직선 경로가 시작하는 y 좌표 (m).'),
  'space.x1': P('x coordinate (m) of the point the path heads toward (it continues straight past it).', '경로가 향하는 점의 x 좌표 (m). 지나서도 직진합니다.'),
  'space.y1': P('y coordinate (m) of the point the path heads toward.', '경로가 향하는 점의 y 좌표 (m).'),
  'space.hz0': P('Emitted frequency at the start of the source’s pitch curve (Hz).', '음원 음고 곡선 시작의 방출 주파수 (Hz).'),
  'space.hz1': P('Emitted frequency at the end of the pitch curve (Hz); the curve engine shapes the way between.', '음고 곡선 끝의 방출 주파수 (Hz). 그 사이 모양은 곡선 엔진이 정합니다.'),
  'space.speedCurve>space.from': P('Source speed (m/s) at the start of its movement.', '움직임 시작 시 음원의 속도 (m/s).'),
  'space.speedCurve>space.to': P('Source speed (m/s) at the end of its movement.', '움직임 끝의 음원 속도 (m/s).'),
  'space.timing>matrix.start': P('When the source starts moving and emitting (source time, s); you hear it later by the travel delay r/c.', '음원이 움직이며 소리를 내기 시작하는 시각 (음원 시간, 초). 실제로는 전파 지연 r/c만큼 늦게 들립니다.'),
  'space.timing>glis.duration': P('How long the source moves and emits (s).', '음원이 움직이며 소리를 내는 시간 (초).'),
  'space.timing>space.start': P('When the source starts moving and emitting (source time, s); you hear it later by the travel delay r/c.', '음원이 움직이며 소리를 내기 시작하는 시각 (음원 시간, 초). 실제로는 전파 지연 r/c만큼 늦게 들립니다.'),
  'space.timing>space.duration': P('How long the source moves and emits (s).', '음원이 움직이며 소리를 내는 시간 (초).'),

  // ======================================================================
  // Tempo Studio / 템포 스튜디오
  // ======================================================================
  'tempo.pitchShift>draw.transpose': P('Transposes this voice by semitones; timing is unchanged.', '이 보이스를 반음 단위로 이조합니다. 타이밍은 그대로입니다.'),
  'tempo.transpose': P('Transposes this voice by semitones; timing is unchanged.', '이 보이스를 반음 단위로 이조합니다. 타이밍은 그대로입니다.'),
  'tempo.octave': P('Shifts this voice by whole octaves.', '이 보이스를 옥타브 단위로 옮깁니다.'),
  'tempo.sound>mgrHelp.gain.t': P('Level of this voice (sound only — never changes the timing).', '이 보이스의 레벨 (소리만 바뀌고 타이밍은 안 바뀜).'),
  'tempo.converge.on': P('Solves every voice’s start offset so all voices reach position sc at the same moment Tc.', '모든 보이스가 같은 순간 Tc에 위치 sc에 닿도록 각 보이스의 시작 오프셋을 계산합니다.'),
  'tempo.Tc': P('The moment (s) at which all voices line up.', '모든 보이스가 한 점에 모이는 시각 (초).'),
  'tempo.sc': P('The score position (s within the subject) that all voices play at the moment Tc.', 'Tc 순간에 모든 보이스가 연주하는 악보 위치 (주제 안의 초).'),
  'tempo.phasing.on': P('Turns on Reich-style phasing: voice i runs (1 + i·ε) times as fast, so the voices drift apart slowly.', '라이히식 페이징을 켭니다: i번째 보이스가 (1 + i·ε)배 빠르게 달려 천천히 어긋납니다.'),
  'tempo.epsilon': P('Drift ε per voice: after L/ε seconds neighbouring voices are one whole loop apart and line up again.', '보이스당 어긋남 ε. L/ε초 뒤 이웃 보이스가 한 바퀴 차이로 다시 맞물립니다.'),
  'tempo.pulse.on': P('Adds a click on every beat of each voice (not part of the Glissando bake).', '각 보이스의 박마다 클릭을 더합니다 (글리산도 베이크에는 포함되지 않음).'),
  'tempo.pulse.level': P('Volume of the beat clicks.', '박 클릭의 음량.'),
  'tempo.pulse.accent': P('Makes the click on the first beat of each loop louder.', '각 루프 첫 박의 클릭을 더 크게 합니다.'),
  'tempo.lo': P('Playback rate (× the subject tempo) at the start of the piece.', '곡 시작의 재생 배속 (주제 템포의 배수).'),
  'tempo.hi': P('Playback rate (× the subject tempo) at the end; the tempo curve shapes the change in between.', '곡 끝의 재생 배속. 그 사이 변화는 템포 곡선이 정합니다.'),

  // ======================================================================
  // Chaos Studio / 카오스 스튜디오
  // ======================================================================
  'chaos.sys.lorenz>σ': P('Prandtl number σ: how fast x follows y. Classic value 10.', '프란틀 수 σ: x가 y를 따라가는 빠르기. 고전값 10.'),
  'chaos.sys.lorenz>ρ': P('Rayleigh number ρ (heating). Below ≈ 24.7 the orbit settles; above it becomes chaotic. Classic 28.', '레일리 수 ρ (가열 세기). 약 24.7 아래면 정착, 위면 카오스. 고전값 28.'),
  'chaos.sys.lorenz>β': P('Geometry factor β (damping of z). Classic 8/3.', '기하 인자 β (z의 감쇠). 고전값 8/3.'),
  'chaos.sys.rossler>a': P('a: feedback of y on itself; larger a widens the spiral.', 'a: y의 자기 되먹임. 클수록 나선이 넓어집니다.'),
  'chaos.sys.rossler>b': P('b: constant offset that re-injects z.', 'b: z를 다시 밀어 올리는 상수 항.'),
  'chaos.sys.rossler>c': P('c: threshold of the fold. Raising c goes through period doubling into chaos (classic 5.7).', 'c: 접힘 문턱값. 키우면 주기 배가를 거쳐 카오스가 됩니다 (고전값 5.7).'),
  'chaos.sys.duffing>δ': P('Damping δ of the spring.', '스프링 감쇠 δ.'),
  'chaos.sys.duffing>α': P('Linear stiffness α (negative = double-well).', '선형 강성 α (음수 = 이중 우물).'),
  'chaos.sys.duffing>β': P('Cubic stiffness β (how strongly the spring hardens).', '3차 강성 β (스프링이 단단해지는 정도).'),
  'chaos.sys.duffing>γ': P('Drive amplitude γ: 0.37 is chaotic, ≈ 0.28 gives period 2.', '구동 진폭 γ: 0.37은 카오스, 약 0.28은 주기 2.'),
  'chaos.sys.duffing>ω': P('Drive frequency ω of the periodic force.', '주기적 힘의 구동 각진동수 ω.'),
  'chaos.sys.thomas>b': P('Damping b: ≈ 0.208 is chaotic; smaller values give a random walk across the lattice.', '감쇠 b: 약 0.208은 카오스, 더 작으면 격자를 가로지르는 랜덤 워크.'),
  'chaos.sys.dpend>m': P('Mass of each pendulum bob.', '각 진자 추의 질량.'),
  'chaos.sys.dpend>L': P('Length of each pendulum arm.', '각 진자 팔의 길이.'),
  'chaos.sys.dpend>g': P('Gravitational acceleration g.', '중력 가속도 g.'),
  'chaos.sys.logistic>r': P('Growth rate r: < 3 fixed point, 3–3.449 period 2, then 4, 8 …, ≳ 3.57 chaos.', '성장률 r: 3 미만 고정점, 3–3.449 주기 2, 이어서 4, 8 …, 약 3.57 이상 카오스.'),
  'chaos.sys.henon>a': P('a: nonlinearity. 1.4 is the classic chaotic value; above ≈ 1.42 orbits escape.', 'a: 비선형성. 1.4가 고전 카오스 값, 약 1.42를 넘으면 궤도가 탈출합니다.'),
  'chaos.sys.henon>b': P('b: area contraction per step (classic 0.3).', 'b: 한 단계당 면적 수축 (고전값 0.3).'),
  'chaos.map.range>fractal.lo': P('Lowest pitch (MIDI) this channel can produce.', '이 채널이 낼 수 있는 가장 낮은 음 (MIDI).'),
  'chaos.map.range>fractal.hi': P('Highest pitch (MIDI) this channel can produce. Low > High inverts the mapping.', '이 채널이 낼 수 있는 가장 높은 음 (MIDI). 낮음 > 높음이면 반전됩니다.'),
  'chaos.lo': P('Output value of this channel at the bottom of its input range.', '입력 범위 맨 아래에서 이 채널의 출력값.'),
  'chaos.hi': P('Output value at the top of the input range (Low > High inverts).', '입력 범위 맨 위에서의 출력값 (낮음 > 높음이면 반전).'),
  'chaos.seed>cloud.seed': P('Random seed for the voices’ tiny initial differences — the same seed gives the same piece.', '보이스 초기값의 미세한 차이를 만드는 난수 시드. 같은 시드면 같은 곡이 나옵니다.'),
  'chaos.axis.az': P('Azimuth of the reading axis in the x–y plane (0° = x, 90° = y).', 'x–y 평면에서 읽기 축의 방위각 (0° = x, 90° = y).'),
  'chaos.axis.el': P('Elevation of the reading axis toward z (90° = pure z).', '읽기 축이 z 쪽으로 기운 고도각 (90° = 순수 z).'),

  // ======================================================================
  // Fractal Studio / 프랙탈 스튜디오
  // ======================================================================
  'fractal.fif.points>y#': P('Height of this interpolation point (0 = Low pitch, 1 = High pitch); the fractal curve passes through it.', '이 보간점의 높이 (0 = 낮은 음, 1 = 높은 음). 프랙탈 곡선이 이 점을 지납니다.'),
  'fractal.fif.points>x#': P('Time position of this interpolation point (0–1 of the length).', '이 보간점의 시간 위치 (길이의 0–1).'),
  'fractal.fif.d>d#': P('Vertical scale of this interval: how strongly it holds a copy of the whole curve (0 = straight, ±0.95 = very rough; negative flips it).',
    '이 구간의 수직 축척: 전체 곡선의 사본을 얼마나 강하게 품는가 (0 = 직선, ±0.95 = 매우 거침, 음수 = 뒤집힘).'),
  'fractal.length>mgrHelp.length.t': P('Duration of the curve, or of each canon layer, in seconds.', '곡선 또는 각 캐논 레이어의 길이 (초).'),
  'fractal.gain.level>mgr.warpParam.level': P('Level of each voice before the mix (0 … 1.5).', '믹스 전 각 보이스의 레벨 (0 … 1.5).'),
  'fractal.gain.level>draw.gainSource': P('What sets each voice’s loudness: a fixed level or the curve’s slope.', '각 보이스 음량을 정하는 기준: 고정 레벨 또는 곡선 기울기.'),
  'fractal.range>fractal.lo': P('Pitch (MIDI) that y = 0 maps to.', 'y = 0에 대응하는 음 (MIDI).'),
  'fractal.range>fractal.hi': P('Pitch (MIDI) that y = 1 maps to.', 'y = 1에 대응하는 음 (MIDI).'),

  // ======================================================================
  // Wave Studio / 웨이브 스튜디오
  // ======================================================================
  'wave.length>mgrHelp.length.t': P('Length of the simulated piece in seconds.', '시뮬레이션되는 곡의 길이 (초).'),
  'wave.cLo': P('Medium speed multiplier at the left end of the medium curve (×c).', '매질 곡선 왼쪽 끝의 속도 배율 (×c).'),
  'wave.cHi': P('Medium speed multiplier at the right end of the medium curve (×c).', '매질 곡선 오른쪽 끝의 속도 배율 (×c).'),
};
