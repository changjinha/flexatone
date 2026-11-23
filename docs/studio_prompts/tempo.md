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
