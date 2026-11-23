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
