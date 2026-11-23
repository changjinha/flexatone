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
