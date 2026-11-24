/**
 * Flexatone — ui/option-inspector.js
 * Layer 4 (ui): global Option(Alt)-key context inspector for physics / math / DSP variables.
 * 계층 4 (ui): 물리·수학·DSP 변수에 대한 전역 Option(Alt) 키 컨텍스트 인스펙터.
 *
 *   Option(Alt) + hover : one-line summary tooltip; hides as soon as Alt is released or the
 *                         pointer leaves the control. / 1줄 요약 툴팁 (Alt 해제·이탈 시 즉시 숨김)
 *   Option(Alt) + click : intercepts the control's own click (preventDefault + stopPropagation)
 *                         and opens a modal with the full explanation and governing equation.
 *                         / 기본 동작을 가로채 상세 설명·지배 방정식 모달 표시
 *
 * A control is documented by `data-help="<key>"` (or by its id via HELP_BY_ID). Keys resolve in
 * HELP_DB; `guide.<engine>` keys are generated from the curve-engine formulas.
 */

import { getLang } from '../core/i18n.js';
import { ENGINE_DEFS, getEngineLabel } from '../modules/curve-engine.js';
import { HELP_EXTRA, HELP_EXTRA_BY_ID } from './help-entries.js';

const E = (title, summary, detail, formula = '') => ({ title, summary, detail, formula });

/** Help entries: key → { en, ko } each { title, summary, detail, formula }. / 도움말 DB */
export const HELP_DB = {
  // ---------------- Field Studio: particle physics / 입자 물리
  'field.mass': {
    en: E('Particle Mass m', 'Inertia: heavier particles resist the field and overshoot more.', 'The particle relaxes toward the local field velocity with rate γ/m. Larger m → slower response, wider arcs, later turns; smaller m → it follows the field almost instantly (first-order behaviour).', 'dv/dt = (F(t, y) − v) · γ / m'),
    ko: E('입자 질량 m', '관성: 무거울수록 장에 늦게 반응하고 더 크게 지나칩니다.', '입자는 γ/m 비율로 국소 장 속도를 향해 이완합니다. m이 크면 반응이 느리고 호가 넓어지며, 작으면 장을 거의 즉시 따라갑니다(1차 거동).', 'dv/dt = (F(t, y) − v) · γ / m'),
  },
  'field.drag': {
    en: E('Viscosity / Drag γ', 'How strongly the medium pulls the particle onto the field velocity.', 'γ is the viscous coupling between particle and flow. High γ: the particle is “stuck” to the streamlines. Low γ: it keeps its own momentum and cuts across them. Only γ/m matters for the dynamics.', 'a = (F − v) · γ / m'),
    ko: E('점성 마찰 γ', '매질이 입자를 장 속도 쪽으로 끌어당기는 세기.', 'γ는 입자와 흐름 사이의 점성 결합입니다. 크면 유선에 밀착하고, 작으면 자기 운동량을 유지하며 유선을 가로지릅니다. 동역학에는 γ/m 비만 작용합니다.', 'a = (F − v) · γ / m'),
  },
  'field.launch': {
    en: E('Launch Angle θ₀ / Speed v₀', 'Initial velocity vector of the particle at t = 0.', 'The particle starts at (t, y) = (0, 0) with velocity (v₀ cos θ₀, 2 v₀ sin θ₀). Positive angles launch upward in pitch. With low drag the launch shapes the whole first gesture.', 'v(0) = (v₀ cos θ₀, 2 v₀ sin θ₀)'),
    ko: E('발사각 θ₀ / 초속도 v₀', 't = 0에서 입자의 초기 속도 벡터.', '입자는 (t, y) = (0, 0)에서 (v₀ cos θ₀, 2 v₀ sin θ₀)로 출발합니다. 양의 각도는 음고 위쪽. 마찰이 작으면 발사 조건이 첫 제스처 전체를 결정합니다.', 'v(0) = (v₀ cos θ₀, 2 v₀ sin θ₀)'),
  },
  'field.boundary': {
    en: E('Boundary Mode', 'What happens when the particle leaves the pitch range.', 'Elastic Bounce reflects at y = −0.15 / 1.15 and scales the velocity by the restitution e. Soft Clamp holds y in [−0.5, 1.5]. Octave Wrap teleports y by ±1 (one F₀→F₁ span), like a Shepard tone.', 'bounce: y′ = b − (y − b)·e,  v_y′ = −v_y·e   ·   wrap: y ← y mod 1'),
    ko: E('경계 처리', '입자가 음역을 벗어났을 때의 처리.', '탄성 반사는 y = −0.15 / 1.15에서 반사하며 속도에 반발계수 e를 곱합니다. 소프트 클램프는 y를 [−0.5, 1.5]에 고정. 옥타브 랩은 셰퍼드 톤처럼 y를 ±1(F₀→F₁ 한 구간) 이동시킵니다.', 'bounce: y′ = b − (y − b)·e,  v_y′ = −v_y·e   ·   wrap: y ← y mod 1'),
  },
  'field.coupling': {
    en: E('N-Body Coupling', 'Attraction (+) or repulsion (−) toward the other baked voices.', 'Each voice feels every previously baked voice at the same t. Positive values pull voices together (unison/convergence), negative values push them apart (voice spacing). The force grows as the gap shrinks.', 'Δv_y = Σⱼ 1.4·c·sign(yⱼ − y) / (4(|yⱼ − y| + 0.04))'),
    ko: E('N-체 결합', '다른 보이스 쪽으로 인력(+) 또는 척력(−).', '각 보이스는 같은 t에서 먼저 베이킹된 보이스들을 느낍니다. 양수는 보이스를 모으고(유니즌·수렴), 음수는 벌립니다(성부 간격). 간격이 좁을수록 힘이 커집니다.', 'Δv_y = Σⱼ 1.4·c·sign(yⱼ − y) / (4(|yⱼ − y| + 0.04))'),
  },
  // ---------------- Field Studio: the field / 벡터장
  'field.guidePull': {
    en: E('Guiding Pull', 'Spring + feed-forward toward the chosen guiding curve g(t).', 'The field’s vertical velocity follows the guide’s slope and adds a restoring term toward g(t). At 0 the particle only feels nodes, turbulence and wells.', 'v_y += g′(t)·min(1, k/2) + 3.5·k·(g(t) − y)'),
    ko: E('가이드 인력', '선택한 가이드 곡선 g(t)를 향한 스프링 + 전방 보상.', '장의 수직 속도는 가이드의 기울기를 따르고 g(t)를 향한 복원 항을 더합니다. 0이면 노드·난류·우물만 작용합니다.', 'v_y += g′(t)·min(1, k/2) + 3.5·k·(g(t) − y)'),
  },
  'field.phase': {
    en: E('Field Phase', 'Animates the force nodes and turbulence along a closed loop.', 'Phase φ ∈ [0, 1) orbits every node by ±0.06 and shifts the noise domain. Sweeping it produces a family of related trajectories.', 'node = (x + 0.06 sin 2πφ, y + 0.06 cos 2πφ)'),
    ko: E('필드 위상', '힘 노드와 난류를 닫힌 궤도로 움직입니다.', '위상 φ ∈ [0, 1)은 각 노드를 ±0.06 궤도로 돌리고 노이즈 영역을 이동시킵니다. 위상을 바꾸면 서로 닮은 궤적군이 생깁니다.', 'node = (x + 0.06 sin 2πφ, y + 0.06 cos 2πφ)'),
  },
  'field.turbulence': {
    en: E('Curl Turbulence', 'Divergence-free noise: swirls without sources or sinks.', 'The velocity is the curl of a smooth value-noise N, so it rotates particles without compressing them. Frequency sets the eddy size.', 'v = (∂N/∂y, −∂N/∂x),  ∇·v = 0'),
    ko: E('컬 난류', '발산 없는 노이즈: 소스·싱크 없이 소용돌이만 만듭니다.', '속도는 부드러운 값 노이즈 N의 회전(curl)이라 입자를 압축하지 않고 회전시킵니다. 주파수는 소용돌이 크기를 정합니다.', 'v = (∂N/∂y, −∂N/∂x),  ∇·v = 0'),
  },
  'field.wellGrid': {
    en: E('Pitch Well Grid / Pull', 'Gaussian potential wells that snap the pitch toward a tuning grid.', 'Off · 12-TET (semitones) · 24-TET (quarter tones) · Pentatonic (0 2 4 7 9) · Overtone Series (n·f_fund). The pull is strongest just next to a well (width 0.035 in y).', 'v_y += 12·k·Δy·exp(−Δy² / (2·0.035²)),  Δy = y_target − y'),
    ko: E('음정 우물 격자 / 인력', '음고를 조율 격자로 끌어당기는 가우시안 퍼텐셜 우물.', '끄기 · 12-TET(반음) · 24-TET(사분음) · 5음 음계(0 2 4 7 9) · 배음열(n·f_기음). 우물 바로 옆에서 인력이 가장 큽니다(y 폭 0.035).', 'v_y += 12·k·Δy·exp(−Δy² / (2·0.035²)),  Δy = y_target − y'),
  },
  'field.node.attractor': {
    en: E('Attractor Node', 'Pulls trajectories toward its centre (drag it on the canvas).', 'Radial inflow with Gaussian falloff of radius r and strength s.', 'v += 2.2·s·e^(−r²/2R²)·(x_n − t, y_n − y)'),
    ko: E('인력 노드', '궤적을 중심으로 끌어당깁니다 (캔버스에서 드래그).', '반경 R의 가우시안 감쇠를 갖는 방사형 유입.', 'v += 2.2·s·e^(−r²/2R²)·(x_n − t, y_n − y)'),
  },
  'field.node.repeller': {
    en: E('Repeller Node', 'Pushes trajectories away from its centre.', 'Radial outflow with Gaussian falloff — carves gaps and forces detours.', 'v −= 2.5·s·e^(−r²/2R²)·(x_n − t, y_n − y)'),
    ko: E('척력 노드', '궤적을 중심에서 밀어냅니다.', '가우시안 감쇠를 갖는 방사형 유출 — 빈 공간과 우회 경로를 만듭니다.', 'v −= 2.5·s·e^(−r²/2R²)·(x_n − t, y_n − y)'),
  },
  'field.node.vortex': {
    en: E('Vortex Node', 'Rotational flow around its centre — makes loops and spirals.', 'Tangential velocity (perpendicular to the radius). In 2D Flow mode it can make time run backwards locally (retrograde loops).', 'v += 3.2·s·e^(−r²/2R²)·(−(y_n − y), x_n − t)'),
    ko: E('소용돌이 노드', '중심 주위 회전 흐름 — 루프와 나선을 만듭니다.', '반경에 수직인 접선 속도. 2D 흐름 모드에서는 국소적으로 시간을 거꾸로 흐르게 할 수 있습니다(역행 루프).', 'v += 3.2·s·e^(−r²/2R²)·(−(y_n − y), x_n − t)'),
  },
  'field.regions': {
    en: E('Local Regions', 'Shapes that change how strongly each field component acts inside them.', 'Each region scales the guide pull, force nodes, curl turbulence and pitch wells by its own gains, and can add a uniform local flow. Outside every region the field is unchanged. Drag a region on the canvas to move it, drag its ◢ handle to resize. Overlapping regions multiply.', 'F = G·g_G(t,y) + Σnodes·g_N + T·g_T + W·g_W + push,   g_c = Π lerp(1, gain_c, w_r(t,y))'),
    ko: E('국소 영역', '도형 안에서 각 장 성분이 작용하는 세기를 바꿉니다.', '영역마다 가이드 인력·힘 노드·컬 난류·음정 우물에 고유 배율을 곱하고, 균일한 국소 흐름을 더할 수 있습니다. 모든 영역 밖에서는 장이 그대로입니다. 캔버스에서 영역을 드래그해 옮기고 ◢ 핸들로 크기를 조절합니다. 겹친 영역은 곱해집니다.', 'F = G·g_G(t,y) + Σnodes·g_N + T·g_T + W·g_W + push,   g_c = Π lerp(1, gain_c, w_r(t,y))'),
  },
  'field.region.geometry': {
    en: E('Region geometry', 'Centre (seconds, MIDI pitch), half-width in seconds and half-height in semitones.', 'Same absolute pitch × time plane as the field layers and force nodes, shared by every particle.'),
    ko: E('영역 도형', '중심 (초, MIDI 음고), 반폭(초), 반높이(반음).', '벡터장 레이어·힘 노드와 같은 절대 음고 × 시간 평면이며 모든 입자가 공유합니다.'),
  },
  'field.region.feather': {
    en: E('Feather', 'Width of the soft edge outside the shape (0 = hard edge).', 'The weight falls smoothly from 1 on the boundary to 0 at distance “feather”. Soft edges avoid sudden kinks in the trajectory.', 'w = 1 − smoothstep(0, feather, sdf(t, y))'),
    ko: E('페더', '도형 바깥 부드러운 경계의 폭 (0 = 딱딱한 경계).', '가중치가 경계에서 1, 거리 feather에서 0으로 부드럽게 줄어듭니다. 부드러운 경계는 궤적의 급격한 꺾임을 막습니다.', 'w = 1 − smoothstep(0, feather, sdf(t, y))'),
  },
  'field.region.invert': {
    en: E('Invert region', 'Apply the region everywhere except inside the shape.', 'The weight becomes 1 − w: a “keep-out” mask.', 'w′ = 1 − w'),
    ko: E('영역 반전', '도형 안을 제외한 모든 곳에 영역을 적용합니다.', '가중치가 1 − w가 됩니다: “제외” 마스크.', 'w′ = 1 − w'),
  },
  'field.region.gain': {
    en: E('Component gain', 'Multiplier for one field component inside the region (1 = unchanged, 0 = off).', 'Blended by the region weight so the effect fades across the feather.', 'g = 1 + w·(gain − 1)'),
    ko: E('성분 배율', '영역 안에서 한 장 성분에 곱하는 값 (1 = 그대로, 0 = 끄기).', '영역 가중치로 섞이므로 페더 구간에서 서서히 사라집니다.', 'g = 1 + w·(gain − 1)'),
  },
  'field.region.flow': {
    en: E('Local flow push', 'A uniform velocity added inside the region (angle 90° = pitch up).', 'Use it to steer particles through a zone. With 2D Flow, angles beyond ±90° push time backwards (retrograde).', 'push = w · s · (cos θ, sin θ)'),
    ko: E('국소 흐름', '영역 안에 더하는 균일한 속도 (각도 90° = 음고 위로).', '특정 구역에서 입자를 원하는 방향으로 이끕니다. 2D 흐름에서 ±90°를 넘으면 시간이 역행합니다.', 'push = w · s · (cos θ, sin θ)'),
  },
  'field.flow.ode': {
    en: E('ODE y(t) mode', 'Time always advances: the trajectory is a function y(t).', 'The time component of the field is pinned to 1, so only y is integrated. No retrograde loops are possible.', 'dt/ds = 1,  dy/ds = F_y(t, y)'),
    ko: E('ODE y(t) 모드', '시간은 항상 전진: 궤적은 함수 y(t).', '장의 시간 성분을 1로 고정해 y만 적분합니다. 역행 루프가 생기지 않습니다.', 'dt/ds = 1,  dy/ds = F_y(t, y)'),
  },
  'field.flow.2d': {
    en: E('2D Flow (Retrograde)', 'Both t and y follow the field: time may loop backwards.', 'The particle moves in the (t, y) plane. Where F_t < 0 the trajectory runs backwards in time — highlighted in magenta.', 'dt/ds = F_t(t, y) ∈ [−1.6, 2.4],  dy/ds = F_y(t, y)'),
    ko: E('2D 흐름 (역행)', 't와 y 모두 장을 따릅니다: 시간이 거꾸로 돌 수 있음.', '입자가 (t, y) 평면에서 움직입니다. F_t < 0인 곳에서는 시간 역행 — 자홍색으로 표시됩니다.', 'dt/ds = F_t(t, y) ∈ [−1.6, 2.4],  dy/ds = F_y(t, y)'),
  },
  'field.retroMode': {
    en: E('Retrograde Mode', 'How a looping (time-reversing) trajectory is heard.', 'Parametric Unfold (as is) plays the path in integration order s, so loops become audible pitch gestures. Retrograde from Reversal Point reflects every backwards stretch about the time where it began, so the loop is heard forwards along the time axis. Monotonic Time reads y at the first point whose t ≥ playback time, skipping loops.', 'unfold: y(τ) = y(s = τ)   ·   mirror: τ = t₀ + Σ|Δt|,  t′ = 2T₀ − t   ·   monotonic: y(τ) = y(min{s : t(s) ≥ τ})'),
    ko: E('역행 처리 모드', '시간이 거꾸로 도는 궤적을 어떻게 들려줄지.', '파라메트릭 펼침(그대로)은 적분 순서 s대로 재생해 루프를 음고 제스처로 들려줍니다. 역행 시점 기준 retrograde는 시간이 뒤로 가기 시작한 시점을 축으로 뒤로 가는 구간을 반사해, 루프를 시간축을 따라 앞으로 재생합니다. 단조 시간은 t ≥ 재생 시각인 첫 점의 y를 읽어 루프를 건너뜁니다.', 'unfold: y(τ) = y(s = τ)   ·   mirror: τ = t₀ + Σ|Δt|,  t′ = 2T₀ − t   ·   monotonic: y(τ) = y(min{s : t(s) ≥ τ})'),
  },
  'field.retro': {
    en: E('Retrograde loop', 'Part of the active trajectory moves backwards in time.', 'Shown in magenta on the canvas. Pick how it sounds right here: As is plays the path in integration order; Retrograde reflects each backwards stretch about the time where the reversal began, so it plays forwards along the time axis (the output is cut at the voice end); Skip loops ignores them.', 'mirror: τ = t₀ + Σ|Δt|  (t′ = 2T₀ − t on a backwards stretch)'),
    ko: E('시간 역행 루프', '활성 궤적의 일부가 시간을 거슬러 움직입니다.', '캔버스에 자홍색으로 표시됩니다. 여기서 바로 소리를 고르세요: 그대로 재생은 적분 순서대로, 역행 시점 기준 retrograde는 시간이 뒤로 가기 시작한 시점을 축으로 뒤로 가는 구간을 반사해 시간축을 따라 앞으로 재생합니다(보이스 끝에서 잘림). 루프 건너뜀은 루프를 무시합니다.', 'mirror: τ = t₀ + Σ|Δt|  (뒤로 가는 구간에서 t′ = 2T₀ − t)'),
  },
  'field.speedToGain': {
    en: E('Speed → Gain', 'Louder where the particle moves fast, softer where it is slow.', 'The baked speed |v| is normalised to [0, 1] per voice and blended into the amplitude.', 'g = baseGain · clamp(1 − 0.65·k + k·|v|/|v|ₘₐₓ, 0.05, 1.4)'),
    ko: E('유속 → 볼륨', '입자가 빠를수록 크게, 느릴수록 작게.', '베이킹된 속력 |v|를 보이스별 [0, 1]로 정규화해 진폭에 섞습니다.', 'g = baseGain · clamp(1 − 0.65·k + k·|v|/|v|ₘₐₓ, 0.05, 1.4)'),
  },
  'field.curvToBright': {
    en: E('Curvature → Bright', 'Sharper turns open a low-pass filter and add saw/rich partials.', 'Curvature κ = |Δ heading| / Δs is normalised per voice. It drives the filter cutoff and boosts bright partials in the wavetable.', 'f_c = f · (1.5 + 8·k·κ/κₘₐₓ)'),
    ko: E('곡률 → 배음 밝기', '급하게 꺾일수록 저역통과 필터가 열리고 밝은 배음이 늘어납니다.', '곡률 κ = |방향 변화| / Δs를 보이스별로 정규화해 필터 차단주파수와 밝은 배음을 제어합니다.', 'f_c = f · (1.5 + 8·k·κ/κₘₐₓ)'),
  },
  'field.canvas': {
    en: E('Vector field canvas', 'Drag nodes · drag empty space to pan · double-click sets the cue · wheel zooms.', 'Purple arrows show F(t, y) for the active particle; the dashed blue curve is the guide; amber lines are pitch wells.'),
    ko: E('벡터장 캔버스', '노드 드래그 · 빈 곳 드래그로 이동 · 더블클릭으로 큐 · 휠로 줌.', '보라색 화살표는 활성 입자의 F(t, y), 파란 점선은 가이드, 주황 선은 음정 우물입니다.'),
  },
  'field.monitor': {
    en: E('Baked profile monitor', 'Green: Speed → Gain · Rose dashed: Curvature → Bright (s-axis).', 'Exactly what playback reads from the baked arrays — no field math happens at playback.'),
    ko: E('베이킹 프로파일 모니터', '초록: 유속→볼륨 · 분홍 점선: 곡률→밝기 (s축).', '재생 시 베이킹 배열에서 읽는 값 그대로입니다 — 재생 중 벡터장 연산은 없습니다.'),
  },
  'field.vector': {
    en: E('Field vector F(t, y)', 'Velocity of the field under the pointer for the active particle.', 'Computed live only for this display; audio never evaluates the field.'),
    ko: E('장 벡터 F(t, y)', '포인터 위치에서 활성 입자가 느끼는 장 속도.', '표시용으로만 실시간 계산되며, 오디오는 벡터장을 평가하지 않습니다.'),
  },
  'field.bake': {
    en: E('Edit-time baking', 'Trajectories are integrated when you edit, then cached.', 'Each physics edit re-runs the RK2 integrator (221 samples per particle). Playback and WAV rendering only read the cached arrays. The counter shows how many bakes ran.', 'x_{n+1} = x_n + Δs·f(x_n + ½Δs·f(x_n))'),
    ko: E('에디팅 시점 베이킹', '편집할 때 궤적을 적분해 캐시합니다.', '물리 편집 시마다 RK2 적분기가 실행됩니다(입자당 221 샘플). 재생·WAV 렌더링은 캐시 배열만 읽습니다. 카운터는 베이킹 실행 횟수입니다.', 'x_{n+1} = x_n + Δs·f(x_n + ½Δs·f(x_n))'),
  },
  'field.bakeGliss': {
    en: E('Bake to Glissando Voices', 'Exports every particle as a Glissando voice (11. Custom).', 'The heard trajectory (Retrograde Mode applied) is fitted to an adaptive Bézier spline; Speed → Gain becomes the gain envelope. Replace swaps the voice list, Append adds to it. Undoable.'),
    ko: E('글리산도 보이스로 베이킹', '모든 입자를 글리산도 보이스(11. 커스텀)로 내보냅니다.', '들리는 궤적(역행 모드 반영)을 적응형 베지에 스플라인으로 근사하고, 유속→볼륨은 게인 엔벨로프가 됩니다. 교체/추가 선택, 실행 취소 가능.'),
  },
  'field.pitchRange': {
    en: E('F₀ / F₁', 'y = 0 maps to F₀ and y = 1 to F₁ on a log-frequency axis.', 'Values outside [0, 1] extrapolate beyond the range.', 'f(y) = F₀ · (F₁/F₀)^y'),
    ko: E('F₀ / F₁', '로그 주파수 축에서 y = 0은 F₀, y = 1은 F₁.', '[0, 1] 밖의 값은 범위 밖으로 외삽됩니다.', 'f(y) = F₀ · (F₁/F₀)^y'),
  },
  'field.timing': {
    en: E('Start / Duration', 'When the particle sounds and how long its s-axis lasts.', 'Playback maps s ∈ [0, 1] onto [start, start + duration].'),
    ko: E('시작 / 길이', '입자가 발음되는 시점과 s축 길이.', '재생 시 s ∈ [0, 1]을 [시작, 시작 + 길이]에 매핑합니다.'),
  },
  'field.timbre': {
    en: E('5-wave timbre', 'Sine · Tri · Saw · Sqr · Rich additive mix (shared timbre synth).', 'The PeriodicWave comes from modules/timbre-synth.js; Curvature → Bright adds saw/rich on top.'),
    ko: E('5파형 음색', '사인 · 삼각 · 톱니 · 사각 · 리치 가산 혼합 (공용 음색 합성기).', 'PeriodicWave는 modules/timbre-synth.js에서 생성되며, 곡률→밝기가 톱니/리치를 더합니다.'),
  },
  // ---------------- Risset Studio / 리세 스튜디오
  'risset.rate': {
    en: E('Glissando Rate v', 'Speed of the master phase around S¹ (+ rises, − falls, 0 = frozen chord).', 'One full turn of the phase moves every voice up by one span. The cycle time links bandwidth B, voice count N and |v|.', 'φ(τ) = wrap(φ₀ + v·F(τ)),   T = B / (N·|v|)'),
    ko: E('글리산도 속도 v', 'S¹ 위 마스터 위상의 속도 (+ 상승, − 하강, 0 = 정지 화성).', '위상이 한 바퀴 돌면 모든 보이스가 스팬만큼 올라갑니다. 순환 주기는 대역폭 B, 보이스 수 N, |v|로 연결됩니다.', 'φ(τ) = wrap(φ₀ + v·F(τ)),   T = B / (N·|v|)'),
  },
  'risset.phase': {
    en: E('Circular phase space S¹', 'Each dot is a voice on the circle; brightness = A_global·A_local.', 'Phase wraps 1 → 0 without a jump: a voice leaving the top re-enters at the bottom under a silent envelope.', 'pᵢ = wrap(φ + offᵢ / span)'),
    ko: E('원형 위상 공간 S¹', '각 점은 원 위의 보이스, 밝기 = A_global·A_local.', '위상은 1 → 0으로 끊김 없이 순환: 위로 나간 보이스는 무음 포락선 아래에서 아래로 다시 들어옵니다.', 'pᵢ = wrap(φ + offᵢ / span)'),
  },
  'risset.voices': {
    en: E('Voices N & gain', '2–60 simultaneous voices with automatic 1/√N level compensation.', 'Uncorrelated partials add in power, so the sum is scaled by 1/√N (the gain-bus equal-power rule) and the master gain.', 'out = masterGain · (1/√N) · 0.65 · Σ Aᵢ sin 2πfᵢt'),
    ko: E('보이스 수 N & 게인', '2–60개 동시 보이스, 1/√N 자동 레벨 보정.', '상관없는 부분음은 파워로 더해지므로 합에 1/√N(게인 버스 동일 파워 규칙)과 마스터 게인을 곱합니다.', 'out = masterGain · (1/√N) · 0.65 · Σ Aᵢ sin 2πfᵢt'),
  },
  'risset.span': {
    en: E('Span & Base MIDI', 'The phase circle maps onto [base, base + span] semitones.', 'Default C1 + 96 st (8 octaves). Frequencies are exponential in phase.', 'f = 440 · 2^((base + p·span − 69)/12)'),
    ko: E('스팬 & 기준 MIDI', '위상 원이 [기준, 기준 + 스팬] 반음에 매핑됩니다.', '기본 C1 + 96반음(8옥타브). 주파수는 위상에 대해 지수적입니다.', 'f = 440 · 2^((base + p·span − 69)/12)'),
  },
  'risset.shape': {
    en: E('Trajectory shaping', 'Redistributes the glissando speed over time; v = 0 always gives y = 0.', 'Linear, Cosine (eased glides that rest at each period), Sine (speed surges), Polynomial (accelerating / decelerating), or any curve engine. F(0) = 0 and F(kP) = kP keep the mean speed v.', 'y(τ) = v·F(τ);   F = τ | P(⌊u⌋ + ½(1−cos π{u})) | τ + AP/2π·sin 2πu | P(⌊u⌋ + {u}ᵏ)'),
    ko: E('궤적 셰이핑', '글리산도 속도를 시간에 따라 재분배; v = 0이면 항상 y = 0.', '선형, 코사인(주기마다 쉬는 완만한 글리산도), 사인(속도 출렁임), 다항(가속/감속), 또는 곡선 엔진. F(0) = 0과 F(kP) = kP로 평균 속도 v를 유지합니다.', 'y(τ) = v·F(τ);   F = τ | P(⌊u⌋ + ½(1−cos π{u})) | τ + AP/2π·sin 2πu | P(⌊u⌋ + {u}ᵏ)'),
  },
  'risset.grid': {
    en: E('Harmonic offset grid', 'Semitone offsets that place each voice on the circle.', 'Equal spacing gives the classic Shepard octave/interval stack; unequal offsets make rotating asymmetric clusters. Interval and Pitch fields stay in sync (c1, f#2, bb2 → C1, F#2, Bb2).', 'offᵢ ∈ [−60, 144] st (0.01),   Iequal = span / N'),
    ko: E('화성 오프셋 격자', '각 보이스를 원 위에 배치하는 반음 오프셋.', '등간격은 전형적인 셰퍼드 옥타브/음정 스택, 비등간격은 회전하는 비대칭 클러스터를 만듭니다. 음정·피치 입력은 양방향 동기화(c1, f#2, bb2 → C1, F#2, Bb2).', 'offᵢ ∈ [−60, 144] 반음 (0.01),   I등간격 = span / N'),
  },
  'risset.local': {
    en: E('Local Emergence A_local', 'Breathing fragments: voices fade in/out asynchronously.', 'Random: smooth noise vs. threshold gates an S-curve fade (mean ± deviation). Sine: per-voice LFO with a floor. Only voices inside the phase band are affected.', 'A = ½ − ½ cos(π·ramp),   ramp += dt / fade'),
    ko: E('로컬 명멸 A_local', '호흡 입자: 보이스가 비동기적으로 페이드 인/아웃.', '랜덤: 부드러운 노이즈와 임계값으로 S커브 페이드(평균 ± 편차) 개폐. 사인: 보이스별 LFO와 하한. 위상 대역 안의 보이스만 영향을 받습니다.', 'A = ½ − ½ cos(π·ramp),   ramp += dt / fade'),
  },
  'risset.envelope': {
    en: E('Global spectral envelope A_global', 'Fades voices in at the bottom and out at the top of the circle.', 'Bell-Pass (flat top, steep skirts), Gaussian, Raised Cosine. σ (Bell Width) up to 1.00 lets the whole span sound. Skew splits σ into left/right widths; γ sets the Bell-Pass kurtosis (γ = 4 is the classic shape).', 'Bell-Pass 1/(1 + |d|^γ),  Gaussian e^(−d²/2),  d = (p − c)/σ_side,  σ_L = σ(1 − skew), σ_R = σ(1 + skew)'),
    ko: E('전역 스펙트럼 포락선 A_global', '원의 아래에서 페이드 인, 위에서 페이드 아웃.', '벨패스(평탄한 상단, 가파른 경사), 가우시안, 레이즈드 코사인. σ(벨 폭)를 1.00까지 올리면 전 대역이 들립니다. 비대칭은 σ를 왼쪽/오른쪽 폭으로 나누고, γ는 벨패스의 첨도입니다(γ = 4가 기존 모양).', 'Bell-Pass 1/(1 + |d|^γ),  Gaussian e^(−d²/2),  d = (p − c)/σ_side,  σ_L = σ(1 − skew), σ_R = σ(1 + skew)'),
  },
  'risset.peq': {
    en: E('Parametric EQ', 'Peaking biquads after the voice sum (Freq / Gain / Q).', 'The curve is the exact RBJ peaking-filter response of the chain. Comb Filter alternates ±7 dB at octave spacing.', 'H(z) = (b₀ + b₁z⁻¹ + b₂z⁻²)/(a₀ + a₁z⁻¹ + a₂z⁻²),  A = 10^(G/40)'),
    ko: E('파라메트릭 EQ', '보이스 합 뒤의 피킹 바이쿼드 (주파수 / 게인 / Q).', '곡선은 체인의 실제 RBJ 피킹 필터 응답입니다. 콤 필터는 옥타브 간격으로 ±7 dB를 교차합니다.', 'H(z) = (b₀ + b₁z⁻¹ + b₂z⁻²)/(a₀ + a₁z⁻¹ + a₂z⁻²),  A = 10^(G/40)'),
  },
  'risset.auto': {
    en: E('Looping automation', 'Spline lanes that modulate parameters around their knob value, looping every Loop seconds.', 'y = ½ means no change; the lane swings the value by ±¼ of its range. Several lanes can run together.', 'eff = clamp(base + (y(u) − ½)·(max − min)·½),  u = (τ mod L)/L'),
    ko: E('루핑 오토메이션', '노브 값 주위로 파라미터를 변조하는 스플라인 레인, Loop 초마다 반복.', 'y = ½이면 변화 없음, 레인은 값을 범위의 ±¼만큼 흔듭니다. 여러 레인을 동시에 쓸 수 있습니다.', 'eff = clamp(base + (y(u) − ½)·(max − min)·½),  u = (τ mod L)/L'),
  },
  'risset.canvas': {
    en: E('Phase trails', 'Past (left) and future (right of the green line) voice paths. Drag sideways to move along the time axis: left = later, right = earlier (phase, trajectory shape, automation and every region move together; the readout shows the offset). The pointer stays where it is while you drag, so the motion has no screen edge. Let go while moving and the field glides on with that speed, which fades to the normal Glissando speed (inertia). With the field frozen (rate 0) the drag scrubs φ.', 'Line width and opacity follow A_global·A_local; the right strip shows the envelope over the span. 📍 Locate turns the drag into moving region edges; Shift-drag draws a range.'),
    ko: E('위상 궤적', '과거(왼쪽)와 미래(초록 선 오른쪽) 보이스 경로. 좌우로 드래그하면 시간축을 따라 이동: 왼쪽 = 나중, 오른쪽 = 이전 (위상·궤적 셰이프·오토메이션·모든 영역이 함께, 표시줄에 이동량). 드래그 중에는 커서가 제자리에 고정되어 화면 끝 제한 없이 계속 이동합니다. 움직이는 채로 놓으면 그 속도로 더 미끄러지다가 원래 글리산도 속도로 점점 돌아갑니다(관성). 음장이 정지(속도 0)면 φ 스크럽.', '선 굵기·투명도는 A_global·A_local을 따르며, 오른쪽 띠는 스팬 위의 포락선입니다. 📍 Locate를 켜면 드래그가 영역 끝단 이동, Shift-드래그는 범위 그리기.'),
  },
  'risset.ratio': {
    en: E('Ratio grid & stretched span', 'Stacks just ratios (3:2, 4:3, 5:4, 9:8 or any p:q) instead of tempered semitones; the cycle itself may be non-octave.', 'Each step adds 12·log₂(p/q) semitones (shown in cents) and wraps into the span. Cycle ratio R sets the span to 12·log₂(R): R = 2 is the octave, 2.1 a stretched octave, 3 a tritave.', 'off_{i+1} = (off_i + 12·log₂(p/q)) mod span,   3:2 = 701.955¢,   span = 12·log₂ R'),
    ko: E('비율 격자 & 스트레치 스팬', '평균율 반음 대신 순정 비율(3:2, 4:3, 5:4, 9:8, 임의 p:q)로 보이스를 쌓고, 순환 자체도 비옥타브로 둘 수 있습니다.', '한 단계마다 12·log₂(p/q) 반음(센트로 표시)을 더하고 스팬 안으로 래핑합니다. 순환 비율 R은 스팬을 12·log₂(R)로 정합니다: R = 2는 옥타브, 2.1은 늘린 옥타브, 3은 트리타브.', 'off_{i+1} = (off_i + 12·log₂(p/q)) mod span,   3:2 = 701.955¢,   span = 12·log₂ R'),
  },
  'risset.color': {
    en: E('Harmonic colour R · H · C', 'Live analysis of the sounding partials, drawn under the trail canvas.', 'R_total = Plomp–Levelt roughness (Sethares form) over all pairs; H = Σ aᵢaⱼ over pairs inside one critical band; C_spec = amplitude-weighted mean log frequency. Spectral tilt weights each partial by (f/1 kHz) in dB/oct.', 'd = min(aᵢ,aⱼ)(e^(−3.51sΔf) − e^(−5.75sΔf)),  s = 0.24/(0.0207 f_min + 18.96);  C = Σa log₂f / Σa'),
    ko: E('화성 색채 R · H · C', '발음 중인 부분음을 실시간 분석해 궤적 캔버스 아래에 그립니다.', 'R_total = 모든 쌍의 Plomp–Levelt 거칠기(Sethares 형태), H = 임계 대역 안 쌍의 Σ aᵢaⱼ, C_spec = 진폭 가중 log 주파수 평균. 음색 기울기는 각 부분음에 (f/1 kHz) 기준 dB/oct 가중을 줍니다.', 'd = min(aᵢ,aⱼ)(e^(−3.51sΔf) − e^(−5.75sΔf)),  s = 0.24/(0.0207 f_min + 18.96);  C = Σa log₂f / Σa'),
  },
  'risset.colorCtl': {
    en: E('Colour invariance controller', 'A PI controller keeps C_spec or R_total at a target while the cluster rotates.', 'It moves the base value of envelope skew, A_local threshold or spectral tilt; looping automation is applied afterwards as ± deviation. The integrator stops while the actuator is saturated (anti-windup).', 'u = base + dir·range/16·(Kp·e + Ki∫e) → lag τ 0.25 s,  e = log₂(target/C) | (target − R)/target'),
    ko: E('색채 불변성 제어기', '클러스터가 회전하는 동안 PI 제어로 C_spec 또는 R_total을 목표값에 유지합니다.', '포락선 비대칭, A_local 임계값, 음색 기울기 중 하나의 기준값을 움직이고, 루핑 오토메이션은 그 뒤 ± 편차로 적용됩니다. 조절 대상이 한계에 닿으면 적분을 멈춥니다(anti-windup).', 'u = base + dir·range/16·(Kp·e + Ki∫e) → lag τ 0.25 s,  e = log₂(target/C) | (target − R)/target'),
  },
  'risset.rhythm': {
    en: E('Rhythm ↔ tone continuum', 'f_min on a log slider from 0.5 Hz: the same Shepard glide becomes an endless accelerando of pulse trains in the rhythm band and a pitch glide in the tone band.', 'Zones: rhythm < 12 Hz, flutter 12–30 Hz, tone > 30 Hz. Partials above 0.4·fs fade out (no sine above Nyquist).', 'f = f_min·2^(p·span/12),  f_min = 440·2^((base − 69)/12)'),
    ko: E('리듬 ↔ 톤 연속체', 'f_min을 0.5 Hz부터 로그 슬라이더로: 같은 셰퍼드 글리산도가 리듬 대역에서는 펄스열의 끝없는 아첼레란도, 톤 대역에서는 음고 글리산도가 됩니다.', '구간: 리듬 < 12 Hz, 떨림 12–30 Hz, 톤 > 30 Hz. 0.4·fs 위의 부분음은 사라지게 처리합니다(나이퀴스트 위 사인 없음).', 'f = f_min·2^(p·span/12),  f_min = 440·2^((base − 69)/12)'),
  },
  'risset.wave': {
    en: E('Waveform / duty morph', 'Morphs each voice from a sine to a band-limited pulse with adjustable duty.', 'The pulse uses PolyBLEP corrections at both edges, so harmonics above Nyquist do not fold back audibly. Duty 50% has only odd harmonics. Worklet engine only (the oscillator fallback stays sine).', 'y = (1 − m)·sin 2πψ + m·0.8·(pulse_d(ψ) − (2d − 1)),  |c_k| ∝ |sin πkd|/k'),
    ko: E('파형 / 듀티 모핑', '각 보이스를 사인에서 대역 제한 펄스(듀티 조절)로 모핑합니다.', '펄스는 양쪽 모서리에 PolyBLEP 보정을 넣어 나이퀴스트 위 배음이 크게 접혀 들어오지 않습니다. 듀티 50%는 홀수 배음만 있습니다. 워클릿 엔진 전용(오실레이터 대체 엔진은 사인 유지).', 'y = (1 − m)·sin 2πψ + m·0.8·(pulse_d(ψ) − (2d − 1)),  |c_k| ∝ |sin πkd|/k'),
  },
  'risset.sync': {
    en: E('Phase sync ↔ dispersion', 'Kuramoto coupling of the voices’ oscillator (waveform) phases; r = order parameter.', 'K > 0 pulls the pulses into alignment (r → 1, entrains rates within ±K Hz); K < 0 pushes them apart (r → 0). The S¹ pitch phases are not touched. r is measured in the worklet.', 'dψᵢ/dt = fᵢ + K·r·sin 2π(Ψ − ψᵢ),  r·e^{2πiΨ} = ⟨e^{2πiψ}⟩'),
    ko: E('위상 동기화 ↔ 분산', '보이스 오실레이터(파형) 위상의 쿠라모토 결합, r = 질서 매개변수.', 'K > 0은 펄스를 정렬(r → 1, ±K Hz 안의 속도를 동조), K < 0은 흩어지게 합니다(r → 0). S¹ 음고 위상은 건드리지 않습니다. r은 워클릿에서 측정합니다.', 'dψᵢ/dt = fᵢ + K·r·sin 2π(Ψ − ψᵢ),  r·e^{2πiΨ} = ⟨e^{2πiψ}⟩'),
  },
  'risset.flutter': {
    en: E('Flutter-band envelope', 'A second envelope over frequency for voices in the 12–30 Hz flutter/roughness zone, independent of the amplitude envelope.', 'Gain (dB) inside 12–30 Hz with half-octave cosine skirts; 0 dB = off.', 'W(f) = 10^(G·b(f)/20),  b = 1 on [12, 30] Hz'),
    ko: E('떨림 대역 포락선', '12–30 Hz 떨림/거칠기 구간의 보이스에만 걸리는, 진폭 포락선과 별개인 두 번째 주파수 포락선.', '12–30 Hz 안의 게인(dB), 반 옥타브 코사인 경사. 0 dB = 끔.', 'W(f) = 10^(G·b(f)/20),  [12, 30] Hz에서 b = 1'),
  },
  'risset.warp': {
    en: E('Polyrhythm–harmony grid warp', 'One non-octave ratio warps both grids: voices are spaced by p:q and the cycle closes after N steps.', 'In the rhythm band the voices are pulse trains in p:q polyrhythm; in the tone band the same grid is a p:q harmony.', 'off_i = i·12·log₂(p/q),  span = N·12·log₂(p/q)'),
    ko: E('폴리리듬-화성 격자 워핑', '비옥타브 비율 하나로 두 격자를 함께 변형: 보이스 간격 p:q, N단계 뒤 순환이 닫힘.', '리듬 대역에서는 p:q 폴리리듬 펄스열, 톤 대역에서는 같은 격자가 p:q 화성이 됩니다.', 'off_i = i·12·log₂(p/q),  span = N·12·log₂(p/q)'),
  },
  'risset.particles2': {
    en: E('Local particles 2.0', 'Shape of each fade (κ), how fade lengths are spread, and a frequency band in Hz in addition to the phase band.', 'κ = 0 is the original cosine S-curve; κ > 0 snaps faster through the middle, κ < 0 lingers. Fade lengths: uniform mean ± dev (original), normal, or log-normal (always positive, long tail). Only voices inside both bands flicker.', 'S = cᵃ/(cᵃ + (1−c)ᵃ),  c = ½ − ½cos πx,  a = 1/(1−κ) | 1+κ'),
    ko: E('로컬 입자 2.0', '페이드 모양(κ), 페이드 길이 분포, 그리고 위상 대역에 더한 주파수(Hz) 대역.', 'κ = 0은 원래 코사인 S커브, κ > 0은 가운데를 빠르게 지나고, κ < 0은 오래 머뭅니다. 페이드 길이: 균등 평균 ± 편차(기존), 정규, 로그정규(항상 양수, 긴 꼬리). 두 대역 모두 안에 있는 보이스만 명멸합니다.', 'S = cᵃ/(cᵃ + (1−c)ᵃ),  c = ½ − ½cos πx,  a = 1/(1−κ) | 1+κ'),
  },
  'risset.mass': {
    en: E('Mass & buoyancy', 'Each voice gets a gravitational mass Mᵢ = A_global·A_local and a buoyancy Bᵢ; the interaction dynamics use them.', 'Inertia uses m₀ + Mᵢ, so a silent voice (M = 0) still has mass m₀ and nothing divides by zero. Buoyancy is an upward lift, strongest on the steep flanks of the envelope; against gravity g·M (dynamics) loud, heavy voices sink and light ones rise — a convection cycle.', 'm_inert = m₀ + Mᵢ,  Mᵢ = A_g·A_l,  Bᵢ = β·A_l·|∂A_g/∂p|'),
    ko: E('질량 · 부력', '각 보이스에 중력 질량 Mᵢ = A_global·A_local과 부력 Bᵢ를 부여하며, 상호작용 동역학이 이를 사용합니다.', '관성에는 m₀ + Mᵢ를 써서 무음 보이스(M = 0)도 질량 m₀를 가지므로 0으로 나누는 일이 없습니다. 부력은 위쪽으로 드는 힘이며 포락선의 가파른 경사에서 가장 큽니다. 동역학의 중력 g·M과 맞서면 크고 무거운 보이스는 가라앉고 가벼운 보이스는 떠올라 대류 순환이 생깁니다.', 'm_inert = m₀ + Mᵢ,  Mᵢ = A_g·A_l,  Bᵢ = β·A_l·|∂A_g/∂p|'),
  },
  'risset.dynamics': {
    en: E('Interaction dynamics on S¹', 'Voices become particles at positions xᵢ relative to the rotating frame φ (macro rotation v₀ = v), pᵢ = wrap(φ + xᵢ).', 'Orders: 0th = equilibrium placement, 1st = relaxation, 2nd = inertia (mass m₀ + Mᵢ), delay = coupling read at t − τ (canon). Forces use sin(2πΔ) so nothing jumps at the wrap: Kuramoto–Sakaguchi attraction to the grid spacing (α = frustration), critical-band repulsion, laminar/turbulent viscosity, Boids, buoyancy − g·mass, directional drag, seeded noise. RK4 at 100 Hz; speed/acceleration are softly saturated. Space rotation θ (region modules) only rotates the reading frame.', 'ẍᵢ(m₀+Mᵢ) = K/N Σ sin(2π(Δᵢⱼ−δᵢⱼ)−α) − R Σ sin(2πΔ)e^{−(1−cos2πΔ)/2π²w²} − μΣk(uᵢ∓uⱼ) + Bᵢ − gMᵢ − γ±uᵢ'),
    ko: E('S¹ 위 상호작용 동역학', '보이스가 회전 좌표계 φ(거시 회전 v₀ = v)에 대한 위치 xᵢ의 입자가 됩니다. pᵢ = wrap(φ + xᵢ).', '차수: 0차 = 평형 배치, 1차 = 이완, 2차 = 관성(질량 m₀ + Mᵢ), 지연 = t − τ 시점 결합(캐논). 힘은 sin(2πΔ)를 써서 래핑에서 점프가 없습니다: 격자 간격으로의 쿠라모토-사쿠라구치 인력(α = 좌절), 임계 대역 척력, 층류/난류 점성, Boids, 부력 − g·질량, 방향별 저항, 시드 잡음. 100 Hz RK4, 속도·가속도는 부드럽게 포화. 공간 회전 θ(영역 모듈)는 읽는 좌표계만 회전합니다.', 'ẍᵢ(m₀+Mᵢ) = K/N Σ sin(2π(Δᵢⱼ−δᵢⱼ)−α) − R Σ sin(2πΔ)e^{−(1−cos2πΔ)/2π²w²} − μΣk(uᵢ∓uⱼ) + Bᵢ − gMᵢ − γ±uᵢ'),
  },
  'risset.resetPhase': {
    en: E('Reset φ', 'Puts the master phase, the automation clock and the shape clock back to 0.', 'Region modules and their rotation clocks restart too. The document is not changed (nothing to undo).', 'φ ← 0,  τ_auto ← 0,  τ_shape ← 0'),
    ko: E('φ 초기화', '마스터 위상, 오토메이션 시계, 셰이프 시계를 0으로 되돌립니다.', '영역 모듈과 회전 시계도 다시 시작합니다. 문서는 바뀌지 않습니다(실행 취소 대상 아님).', 'φ ← 0,  τ_auto ← 0,  τ_shape ← 0'),
  },
  'risset.exportSec': {
    en: E('WAV length (s)', 'Length of the file written by the header’s Export WAV button (1–180 s).', 'Rendered offline at 48 kHz with the same DSP as the live worklet. With interaction dynamics on, the render starts from the grid at t = 0 (reproducible); otherwise it continues from the current state.'),
    ko: E('WAV 길이 (초)', '헤더의 WAV 내보내기로 쓰는 파일 길이(1–180초).', '실시간 워클릿과 같은 DSP로 48 kHz 오프라인 렌더링합니다. 상호작용 동역학이 켜져 있으면 t = 0 격자에서 시작해 재현 가능하고, 아니면 현재 상태에서 이어집니다.'),
  },
  'risset.viewOpts': {
    en: E('Trail view options', 'How the trail canvas is drawn — display only, never changes the sound.', 'Piano-Roll / Phase 0–1: note-name or phase axis. Trails: past and future paths. Local Band: shade the Local Emergence band. Window: seconds shown across the canvas (the green line sits at 78 %).'),
    ko: E('궤적 보기 옵션', '궤적 캔버스를 그리는 방식 — 표시만 바꾸고 소리는 바꾸지 않습니다.', '피아노롤 / 위상 0–1: 음이름 축 또는 위상 축. 궤적 선: 과거·미래 경로. 로컬 대역: 로컬 명멸 대역 표시. 시간창: 화면에 보이는 초 (초록 선은 78% 위치).'),
  },
  'risset.offsets': {
    en: E('Per-voice offsets', 'Type each voice’s offset above Base MIDI in semitones (0.01) or as a note name (C2+50¢).', '▲/▼ step by 0.01 st (Shift: 1 st). Editing a cell switches the grid to Custom. + / − expands or collapses the cell list.', 'pᵢ = wrap(φ + offᵢ / span)'),
    ko: E('보이스별 오프셋', '각 보이스의 오프셋을 기준 MIDI 위 반음(0.01) 또는 음이름(C2+50¢)으로 입력합니다.', '▲/▼는 0.01반음(Shift: 1반음)씩. 셀을 고치면 격자가 사용자 모드로 바뀝니다. + / −는 셀 목록을 펼치거나 접습니다.', 'pᵢ = wrap(φ + offᵢ / span)'),
  },
  'risset.engine': {
    en: E('Audio engine', 'Worklet (auto): one AudioWorklet computes every voice sample by sample; Oscillators: the older one-oscillator-per-voice engine.', 'The worklet advances each voice’s S¹ phase per sample (exact wrap, any speed), evaluates the envelope per sample and interpolates control gains per block. It falls back to oscillators automatically when AudioWorklet is unavailable. WAV export always uses the worklet’s DSP class.', 'p[n+1] = wrap(p[n] + ω/fs),  f = 440·2^((base + p·span − 69)/12),  y = Σ g·scale·A(p)·sin 2πψ'),
    ko: E('오디오 엔진', '워클릿(자동): AudioWorklet 하나가 모든 보이스를 샘플 단위로 계산 / 오실레이터: 보이스마다 오실레이터를 쓰는 예전 엔진.', '워클릿은 보이스별 S¹ 위상을 샘플마다 진행(정확한 래핑, 어떤 속도든)하고 포락선을 샘플마다 계산하며 제어 게인은 블록 단위로 보간합니다. AudioWorklet을 쓸 수 없으면 자동으로 오실레이터로 전환됩니다. WAV 내보내기는 항상 워클릿과 같은 DSP 클래스를 씁니다.', 'p[n+1] = wrap(p[n] + ω/fs),  f = 440·2^((base + p·span − 69)/12),  y = Σ g·scale·A(p)·sin 2πψ'),
  },
  'risset.regions': {
    en: E('Region modules', 'Each module confines the Risset field to its own pitch range [low, high] and can move independently.', 'A module follows the global v or runs at its own speed with its own phase. Edge fade softens interior range borders; module gain scales it. Up to 6 modules sum together; voice offsets, envelope and EQ are shared.', 'A = A_global(s) · A_local · gain · edge(s),  s ∈ [lo, hi]'),
    ko: E('영역 모듈', '모듈마다 리세 음장을 자기 음고 범위 [아래, 위]에 가두고 독립적으로 움직이게 합니다.', '모듈은 전역 v를 따르거나 자체 위상·자체 속도로 움직입니다. 가장자리 페이드는 범위 안쪽 경계를 부드럽게, 모듈 게인은 음량을 조절합니다. 최대 6개 모듈이 합산되며 보이스 오프셋·포락선·EQ는 공유합니다.', 'A = A_global(s) · A_local · gain · edge(s),  s ∈ [lo, hi]'),
  },
  'risset.rotation': {
    en: E('Space rotation', 'Rotates the module\'s (time × phase) trail space about the green line; whatever crosses the line sounds.', 'θ = 0 is the normal field, 180° mirrors it (rising ↔ falling), ±90° turns time into pitch. Angle = θ + spin·t + swing·sin(2πt/P). T sets how many seconds equal one phase unit (Fit screen makes the drawing a true rotation). A trail may cross the line several times — each crossing is its own tone.', 'a = (s−c)·sinθ,  y = c + (s−c)·cosθ;  sound where φ(T·a) + offᵢ − y ∈ ℤ'),
    ko: E('공간 회전', '모듈의 (시간 × 위상) 궤적 공간을 초록 선 위의 중심으로 회전; 선에 걸치는 것이 소리 납니다.', 'θ = 0은 원래 음장, 180°는 거울상(상승 ↔ 하강), ±90°는 시간을 음고로 바꿉니다. 각도 = θ + 스핀·t + 스윙·sin(2πt/P). T는 위상 1단위에 해당하는 초(화면 비율 맞춤 시 그림이 실제 회전과 일치). 궤적이 선을 여러 번 지나면 교차마다 별도 음이 됩니다.', 'a = (s−c)·sinθ,  y = c + (s−c)·cosθ;  φ(T·a) + offᵢ − y ∈ ℤ 인 곳에서 발음'),
  },
  'risset.bake': {
    en: E('Bake to Glissando Voices', 'Simulates Bake seconds and exports each voice as Glissando voices.', 'Each voice is cut at its wrap points (top → bottom) into separate 11. Custom voices; the envelope becomes gain points. At most 64 voices are written.'),
    ko: E('글리산도 보이스로 베이킹', '베이킹 초 동안 시뮬레이션해 각 보이스를 글리산도 보이스로 내보냅니다.', '각 보이스는 래핑 지점(위 → 아래)에서 잘려 별도의 11. 커스텀 보이스가 되고, 포락선은 게인 점이 됩니다. 최대 64개.'),
  },
  // ---------------- Glissando editor / 글리산도 편집기
  select: {
    en: E('Select tool', 'Drag across the active voice to make a local region.', 'A region can be soloed/muted, re-shaped with its own curve (partial morph amount), and its edges ramped where the result is not smooth.', 'y = y_base + w(t)·mix·(y_region − y_base)'),
    ko: E('선택 도구', '활성 보이스 위를 드래그해 로컬 구간을 만듭니다.', '구간은 솔로/뮤트, 자체 곡선(부분 모핑 양)으로 재형성할 수 있고, 매끄럽지 않은 경계는 램프 처리됩니다.', 'y = y_base + w(t)·mix·(y_region − y_base)'),
  },
  legato: {
    en: E('Legato Join', 'Back-to-back voices share one phase-continuous oscillator.', 'Separate oscillators restart at phase 0 and fade out/in around the join, which leaves a short gap (the “click”). Joined voices are rendered by phase-locked oscillators with an equal-gain crossfade and an optional log-frequency glide.', 'φ(t) = 2π ∫ f(τ) dτ  (never reset at the join)'),
    ko: E('레가토 연결', '맞닿은 보이스가 위상이 이어지는 오실레이터를 공유합니다.', '따로 된 오실레이터는 위상 0에서 다시 시작하고 경계에서 페이드 아웃/인되어 짧은 공백(“뚝”)이 생깁니다. 연결된 보이스는 위상 고정 오실레이터와 동일 게인 크로스페이드, 선택적 로그 주파수 글라이드로 렌더링됩니다.', 'φ(t) = 2π ∫ f(τ) dτ  (경계에서 초기화하지 않음)'),
  },
  // ---------------- Output stage / 출력 단계
  'out.fader': {
    en: E('Loudness Manager — fader', 'Final gain of every studio (amp / dB / sone), applied after the master bus.', 'Changes glide with a one-pole low-pass (setTargetAtTime, τ = 5–10 ms) so moving the fader never produces zipper noise. Export WAV uses the same gain.', 'A = 10^(dB/20) = exp(dB·ln10/20)'),
    ko: E('라우드니스 매니저 — 페이더', '마스터 버스 뒤, 모든 스튜디오에 적용되는 최종 게인 (진폭 / dB / sone).', '변경은 1차 저역통과(setTargetAtTime, τ = 5–10 ms)로 부드럽게 이어져 지퍼 노이즈가 없습니다. WAV 내보내기에도 같은 게인이 적용됩니다.', 'A = 10^(dB/20) = exp(dB·ln10/20)'),
  },
  'out.limiter': {
    en: E('Limiter', 'Last stage of the Loudness Manager: keeps the output below the ceiling.', 'A fast compressor (ratio 20, 2 ms attack, 120 ms release, threshold 1.5 dB under the ceiling) turns peaks down smoothly, then a 2×-oversampled clamp guarantees nothing passes the ceiling. The red number is the current gain reduction. Meter, analyzer and Export WAV see the limited signal.', 'y = clamp(x, ±10^(ceil/20))'),
    ko: E('리미터', '라우드니스 매니저의 마지막 단계: 출력이 천장을 넘지 않게 합니다.', '빠른 컴프레서(비율 20, 어택 2 ms, 릴리즈 120 ms, 문턱 = 천장 −1.5 dB)가 피크를 부드럽게 누른 뒤, 2배 오버샘플 클램프가 천장 초과를 막습니다. 빨간 숫자는 현재 게인 감소량입니다. 미터·분석기·WAV 내보내기 모두 리미팅된 신호를 봅니다.', 'y = clamp(x, ±10^(천장/20))'),
  },
  'out.amp': {
    en: E('Amp mode', 'The fader is the linear output amplitude (0 … 1), like the original Flexatone output.', 'Half the fader = half the amplitude (−6 dB), so most of the audible range sits in the top of the travel. The readout shows the amplitude and its dB equivalent. Smoothing (τ) still applies.', 'A = x'),
    ko: E('진폭 모드', '페이더가 곧 선형 출력 진폭(0 … 1)입니다. 기존 Flexatone 출력과 같습니다.', '페이더 절반 = 진폭 절반(−6 dB)이라 들리는 범위 대부분이 위쪽에 몰려 있습니다. 숫자 칸은 진폭과 그 dB 환산값을 보여 줍니다. 평활(τ)은 그대로 적용됩니다.', 'A = x'),
  },
  'out.taper': {
    en: E('dB taper A / B', 'How fader travel maps to gain.', 'A (linear dB): x = 0 is silence, otherwise dB = dBmin + x·(dBmax − dBmin). B (DAW): the bottom 15% is linear in amplitude from 0 to ε, the rest is linear in dB — no jump at the bottom. ε = 10^(dBmin/20).', 'B: x < 0.15 → A = ε·x/0.15'),
    ko: E('dB 테이퍼 A / B', '페이더 이동량 → 게인 매핑 방식.', 'A(선형 dB): x = 0은 무음, 그 외 dB = dBmin + x·(dBmax − dBmin). B(DAW): 하단 15%는 0 → ε 진폭 선형, 나머지는 dB 선형 — 바닥에서 소리가 툭 끊기지 않습니다. ε = 10^(dBmin/20).', 'B: x < 0.15 → A = ε·x/0.15'),
  },
  'out.meter': {
    en: E('Peak / RMS meter', 'Post-fader level, linear in dB.', 'Ticks at −60, −45, −30, −15, 0 dB are equally spaced; anything below ε reads as the bottom. The thin marker is the peak hold.'),
    ko: E('피크 / RMS 미터', '페이더 뒤 레벨, dB 등간격.', '−60, −45, −30, −15, 0 dB 눈금이 등간격이며 ε 미만은 바닥으로 표시됩니다. 얇은 선은 피크 홀드입니다.'),
  },
  'out.sone': {
    en: E('Loudness (Sone)', 'Measured perceived loudness of the output, in sones.', 'An AudioWorklet runs a 1024-point FFT every 512 samples, weights it by the outer/middle ear, groups it into 24 Bark bands, spreads it with level-dependent masking slopes, and converts excitation to specific loudness with α = 0.23. 1 sone = a 1 kHz tone at 40 dB SPL; doubling sones ≈ twice as loud.', "N' = 0.08·E_TQ^0.23·[(0.5 + 0.5·E/E_TQ)^0.23 − 1]"),
    ko: E('라우드니스 (Sone)', '출력의 측정된 지각 음량(sone).', 'AudioWorklet이 512샘플마다 1024점 FFT를 계산하고, 외이·중이 가중, 24 Bark 대역 묶기, 레벨 의존 마스킹 확산을 거쳐 α = 0.23으로 특정 라우드니스를 구합니다. 1 sone = 1 kHz 40 dB SPL 순음, sone이 두 배면 약 두 배로 크게 들립니다.', "N' = 0.08·E_TQ^0.23·[(0.5 + 0.5·E/E_TQ)^0.23 − 1]"),
  },
  'out.lock': {
    en: E('Sone Lock', 'Keeps the output at a target loudness.', 'You control the level with Target (sone), not the fader: the fader and dB box only show the gain the lock is applying. Doubling the target ≈ twice as loud (≈ +13 dB). The gain follows the measured Total Sone (about 0.4 s time constant), holds during silence and never boosts above +12 dB. Needs the Analyzer ON. Use it to compare studios or presets at equal loudness.', 'ΔdB = log10(S_target / S_measured) / 0.023'),
    ko: E('Sone 락', '출력을 목표 라우드니스로 유지합니다.', '음량은 페이더가 아니라 “목표(sone)” 칸으로 조절합니다. 페이더와 dB 칸은 락이 현재 걸고 있는 게인을 보여 주기만 합니다. 목표를 두 배로 하면 약 두 배로 크게 들립니다(≈ +13 dB). 게인은 측정된 Total Sone을 따라가며(시간상수 약 0.4초), 무음에서는 유지되고 +12 dB 이상 키우지 않습니다. 분석기가 켜져 있어야 동작합니다. 스튜디오·프리셋을 같은 음량으로 비교할 때 쓰세요.', 'ΔdB = log10(S_목표 / S_측정) / 0.023'),
  },
  'out.calib': {
    en: E('Calibration', 'The dB SPL a full-scale sine is assumed to play at.', 'Sone values depend on absolute level. Set this to your listening level (e.g. 90 dB SPL for a full-scale sine) for meaningful numbers.'),
    ko: E('캘리브레이션', '풀스케일 사인파가 재생되는 dB SPL.', 'Sone 값은 절대 레벨에 따라 달라집니다. 실제 청취 레벨에 맞추면(예: 풀스케일 사인 = 90 dB SPL) 수치가 의미를 가집니다.'),
  },
  'gain.unit': {
    en: E('Envelope unit', 'How the gain envelope y ∈ [0, 1] becomes amplitude.', 'Amp: y is amplitude. dB: y follows the dB taper (A linear / B DAW) down to dB min. Sone: y is loudness in sones (1 = 0 dBFS), so straight lines sound like even fades.'),
    ko: E('엔벨로프 단위', '게인 엔벨로프 y ∈ [0, 1]을 진폭으로 바꾸는 방식.', '진폭: y가 곧 진폭. dB: y가 dB 테이퍼(A 선형 / B DAW)를 따라 최저 dB까지. Sone: y가 sone 단위 음량(1 = 0 dBFS)이라 직선이 고르게 들리는 페이드가 됩니다.'),
  },
};

// Header / Glissando entries live in help-entries.js; entries defined above take precedence.
// 헤더·글리산도 항목은 help-entries.js에 있음 (위 항목이 우선).
for (const [k, v] of Object.entries(HELP_EXTRA)) if (!HELP_DB[k]) HELP_DB[k] = v;

/** Controls documented by id (Glissando header / toolbar). / id로 연결되는 도움말 */
const HELP_BY_ID = {
  ...HELP_EXTRA_BY_ID,
  btnSelectMode: 'select',
  btnLegatoJoin: 'legato',
  inputJoinGlide: 'legato',
  btnGainUnitAmp: 'gain.unit',
  btnGainUnitDb: 'gain.unit',
  btnGainUnitSone: 'gain.unit',
  btnGainTaper: 'out.taper',
  inputGainDbMin: 'gain.unit',
};

function guideEntry(engineId) {
  const def = ENGINE_DEFS.find((d) => d.id === engineId);
  if (!def) return null;
  const mk = (lang) => E(
    `${def.num}. ${getEngineLabel(engineId)}`,
    lang === 'ko' ? '공용 곡선 엔진으로 계산되는 가이드 곡선 g(t).' : 'Guiding curve g(t) from the shared curve engine.',
    lang === 'ko' ? '가이드 인력이 입자를 이 곡선 쪽으로 끌어당깁니다 (Multi-Morph·Custom 제외 9종).' : 'Guiding Pull draws particles toward this curve (9 engines; Multi-Morph and Custom excluded).',
    def.formula,
  );
  return { en: mk('en'), ko: mk('ko') };
}

const ENGINE_SUMMARY = {
  harmonic: ['S-curve with adjustable pivot: smooth, symmetric or skewed glide.', '피벗을 조절하는 S자 곡선: 부드럽고 대칭/비대칭인 글리산도.'],
  damped: ['Glide that overshoots the target and settles with a damped oscillation.', '목표를 지나쳤다가 감쇠 진동하며 자리 잡는 글리산도.'],
  anticipation: ['Dips the opposite way first, then moves (with optional overshoot).', '먼저 반대로 살짝 움직인 뒤 출발 (오버슈트 선택).'],
  ratchet: ['Staircase of N steps with smoothed edges.', '가장자리를 다듬은 N단 계단.'],
  chirp: ['Smooth glide with a vibrato whose rate sweeps from f₀ to f₁.', '비브라토 속도가 f₀→f₁로 바뀌는 부드러운 글리산도.'],
  bounce: ['Falls into the target and bounces like a ball.', '목표로 떨어져 공처럼 튀는 곡선.'],
  bezier: ['Cubic Bézier timing curve with two control points.', '조절점 두 개로 만드는 3차 베지어 타이밍 곡선.'],
  plateau: ['Holds a shelf (waypoint) in the middle of the glide.', '글리산도 중간에 머무는 구간(경유점)을 만듭니다.'],
  polynomial: ['Polynomial through the points you place.', '찍은 점을 지나는 다항식.'],
  morph: ['Combine several Curve Engines with blend / add / multiply operations.', '여러 곡선 엔진을 섞기·더하기·곱하기로 합성합니다.'],
  custom: ['Free spline: drag anchors and handles directly on the canvas.', '자유 스플라인: 캔버스에서 앵커와 핸들을 직접 드래그.'],
  expo: ['Exponential or logarithmic glide (fast start or fast finish).', '지수/로그 글리산도 (빠른 시작 또는 빠른 끝).'],
  trig: ['A slice of a trigonometric function mapped to 0 → 1.', '삼각함수 구간을 0 → 1로 매핑한 곡선.'],
  formula: ['Your own expression f(t; a, b, c …).', '직접 쓰는 수식 f(t; a, b, c …).'],
};

/** Glissando curve engine entry (tabs + parameter rack). / 글리산도 곡선 엔진 도움말 */
function engineEntry(engineId) {
  const def = ENGINE_DEFS.find((d) => d.id === engineId);
  if (!def) return null;
  const sum = ENGINE_SUMMARY[engineId] || ['Curve engine for y(t), t ∈ [0, 1].', 'y(t), t ∈ [0, 1]을 만드는 곡선 엔진.'];
  const mk = (lang) => E(
    `${def.num}. ${getEngineLabel(engineId)}`,
    lang === 'ko' ? sum[1] : sum[0],
    lang === 'ko' ? '선택한 곡선 엔진이 활성 보이스(또는 진폭 대상)의 곡선 모양을 정합니다. 파라미터 랙의 슬라이더가 아래 식의 계수입니다.' : 'The selected Curve Engine shapes the active voice (or the amplitude target). The sliders in the parameter rack are the coefficients of the formula below.',
    def.formula,
  );
  return { en: mk('en'), ko: mk('ko') };
}

const isHelpKey = (k) => !!(HELP_DB[k] || (k.startsWith('guide.') && guideEntry(k.slice(6))) || (k.startsWith('engine.') && engineEntry(k.slice(7))));

/** Resolve a help entry in the current language. / 현재 언어의 도움말 */
export function getHelp(key) {
  if (!key) return null;
  const entry = HELP_DB[key] || (key.startsWith('guide.') ? guideEntry(key.slice(6)) : key.startsWith('engine.') ? engineEntry(key.slice(7)) : null);
  if (!entry) return null;
  return entry[getLang()] || entry.en;
}

/** Help key documented on this exact element (not its ancestors), or null. / 요소 자체의 도움말 키 */
export function ownHelpKey(node) {
  const k = node?.dataset?.help;
  if (k && isHelpKey(k)) return k;
  if (node?.id && HELP_BY_ID[node.id]) return HELP_BY_ID[node.id];
  return null;
}

export const isHelpModalOpen = () => !!modal;

function helpKeyOf(node) {
  const el = node?.closest?.('[data-help], [id]');
  let cur = node;
  while (cur && cur !== document.body) {
    if (cur.dataset?.help && isHelpKey(cur.dataset.help)) return { key: cur.dataset.help, el: cur };
    if (cur.id && HELP_BY_ID[cur.id]) return { key: HELP_BY_ID[cur.id], el: cur };
    cur = cur.parentElement;
  }
  return el ? null : null;
}

// --------------------------------------------------------------------------
// Tooltip & modal / 툴팁과 모달
// --------------------------------------------------------------------------

let tip = null;
let modal = null;
let altDown = false;
let hoverTarget = null;

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'fixed z-[60] pointer-events-none hidden max-w-xs px-2.5 py-1.5 rounded-lg bg-slate-900/95 border border-violet-500/60 text-[11px] text-violet-100 shadow-xl';
  document.body.append(tip);
  return tip;
}

function hideTip() {
  tip?.classList.add('hidden');
  hoverTarget = null;
}

function showTip(found) {
  const h = getHelp(found.key);
  if (!h) { hideTip(); return; }
  const box = ensureTip();
  box.replaceChildren();
  const b = document.createElement('b');
  b.className = 'text-violet-300';
  b.textContent = `${h.title} — `;
  box.append(b, document.createTextNode(h.summary));
  box.classList.remove('hidden');
  const r = found.el.getBoundingClientRect();
  const w = box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  box.style.top = `${r.bottom + 6 + box.offsetHeight > window.innerHeight ? r.top - box.offsetHeight - 6 : r.bottom + 6}px`;
  hoverTarget = found.el;
}

export function closeHelpModal() {
  modal?.remove();
  modal = null;
}

/** Open the detailed help modal for a key. / 상세 도움말 모달 */
export function openHelpModal(key) {
  const h = getHelp(key);
  if (!h) return false;
  closeHelpModal();
  hideTip();
  modal = document.createElement('div');
  modal.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const card = document.createElement('div');
  card.className = 'w-full max-w-lg rounded-2xl bg-slate-900 border border-violet-500/50 shadow-2xl p-5 flex flex-col gap-3';
  const title = document.createElement('h3');
  title.className = 'text-base font-bold text-violet-200';
  title.textContent = h.title;
  const summary = document.createElement('p');
  summary.className = 'text-sm text-slate-200';
  summary.textContent = h.summary;
  const detail = document.createElement('p');
  detail.className = 'text-[13px] leading-relaxed text-slate-400';
  detail.textContent = h.detail;
  card.append(title, summary, detail);
  if (h.formula) {
    const f = document.createElement('code');
    f.className = 'block px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[13px] text-sky-200 whitespace-pre-wrap';
    f.textContent = h.formula;
    card.append(f);
  }
  const close = document.createElement('button');
  close.className = 'self-end px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold';
  close.textContent = getLang() === 'ko' ? '닫기 (Esc)' : 'Close (Esc)';
  close.addEventListener('click', closeHelpModal);
  card.append(close);
  modal.append(card);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeHelpModal(); });
  document.body.append(modal);
  close.focus();
  return true;
}

let installed = false;

/** Install the global Option(Alt) listeners once. / 전역 리스너 1회 설치 */
export function initOptionInspector() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal) { e.stopImmediatePropagation(); closeHelpModal(); return; }
    if (e.key === 'Alt') altDown = true;
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') { altDown = false; hideTip(); }
  }, true);
  window.addEventListener('blur', () => { altDown = false; hideTip(); });
  document.addEventListener('pointermove', (e) => {
    if (!(e.altKey || altDown)) { if (hoverTarget) hideTip(); return; }
    const found = helpKeyOf(e.target);
    if (!found) { hideTip(); return; }
    if (found.el !== hoverTarget) showTip(found);
  }, true);
  // Alt + press/click: swallow the control's own action and open the modal.
  // Alt + 누르기/클릭: 컨트롤 기본 동작을 막고 모달 열기
  const intercept = (e) => {
    if (!e.altKey) return;
    const found = helpKeyOf(e.target);
    if (!found) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click') openHelpModal(found.key);
  };
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) document.addEventListener(type, intercept, true);
}
