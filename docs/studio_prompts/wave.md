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
