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
