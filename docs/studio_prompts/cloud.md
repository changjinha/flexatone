## Cloud Studio — 스튜디오 id `cloud`, dev 포트 `8023`, order 60

### 한 줄 목표
Xenakis식 **확률 구름(stochastic cloud)**: 확률 분포와 시간에 따라 변하는 밀도로 수십~수천 개의 짧은 글리산도 이벤트를 생성한다. 하나의 큰 소리 덩어리를 통계로 조각한다는 점이 Glissando(손 설계)·Risset(결정적 위상)과 다릅니다.

### 핵심 개념
이벤트 = 짧은 글리산도 "입자": `{ t0, dur, p0 (MIDI), p1 (MIDI), gain, laneHint }`. 생성은 완전 **시드 PRNG 결정적**이며, 이벤트 목록을 베이킹(캐시)한 뒤 재생합니다.

### 문서 스키마 (`appState.studioParams.cloud`)
```js
{
  seed: 1, length: 30,                               // 전체 길이(초)
  density: CurveObj,      // events/sec, 시간에 따른 곡선 (curve-engine 객체. evaluateCurveObjectY 재사용). 범위 0.2..200
  pitch: {
    center: CurveObj,     // MIDI, 시간에 따른 중심
    width:  CurveObj,     // 반음 단위 폭 (분포의 σ 또는 반폭)
    dist: 'uniform'|'gauss'|'cauchy'|'logistic'|'levy'|'brownian',
    brownStep: 2.0,       // brownian: 이벤트마다 평균 이동량(반음)
    levyAlpha: 1.5,       // lévy 안정 지수 1<α≤2
    sieve: { enabled:false, terms:[{mod:12, residues:[0,2,4,5,7,9,11]}, ...], op:'union'|'inter', grid:'semitone'|'quarter'|'eighth' },
    snapSieve: true       // 샘플 값을 가장 가까운 체 원소로 끌어당김
  },
  glide: {
    mode: 'slope' | 'target',
    slopeMean: 0, slopeSpread: 6,   // 반음/초
    upBias: 0.5,                     // 상승 비율 (0..1)
    clusterCollapse: CurveObj        // Ligeti 모드: 0=원분포, 1=center 한 점 수렴 (width에 곱해 수렴/발산 연출)
  },
  duration: { dist:'exp'|'lognormal'|'uniform', mean: 0.8, min: 0.05, max: 4 },
  gain: { base: 0.5, spread: 0.3, pitchComp: 'off'|'equalLoud', envelope: 'hann'|'tukey'|'expdecay', attack: 0.02 },
  timbre: {...}, maxEvents: 4000, maxPolyphony: 128
}
```
- **시간 비균질 포아송**: 밀도 λ(t)를 쓰므로 thinning(Lewis–Shedler) 또는 누적 intensity 역변환으로 이벤트 시각 생성. 시드 PRNG(`createSeededRandom`)만 사용, `Math.random` 금지.
- **분포 샘플러**(모두 순수 함수, 같은 PRNG 흐름): uniform, gaussian(Box–Muller), cauchy, logistic, **Lévy 안정 분포**(Chambers–Mallows–Stuck), brownian(누적 합: 이전 이벤트 피치를 상태로).
- **체(sieve)**: Xenakis 방식 `{mod m, residue r}` 항의 합집합/교집합으로 MIDI 정수(또는 1/2, 1/4 반음 격자) 집합을 만들고, 샘플 피치를 가장 가까운 허용값으로 이동.
- **폴리포니 제한**: `maxPolyphony` 초과 시 가장 조용한/오래된 이벤트부터 드랍(결정적 규칙).

### 베이킹 → 오디오 (`cloud-audio.js`)
- 이벤트 정렬 배열(Struct-of-arrays `Float32Array`: t0, dur, p0, p1, gain). 시그니처 캐시.
- 라이브: 스케줄 윈도우(예: 현재 +0.5초 룩어헤드)를 `setInterval`/`requestAnimationFrame`로 굴리며 이벤트마다 `Oscillator + Gain` 쌍을 풀(pool) 방식으로 생성·`stop` 시 폐기. 동시 노드 수 ≤ `maxPolyphony`. 노드 생성 비용을 측정해 보고(예: 200 events/s에서 CPU).
- 이벤트 하나: 주파수 `exponentialRampToValueAtTime`(로그 글라이드), 게인 포락선(hann/tukey/지수감쇠) — 클릭 없음.
- 오프라인 렌더(WAV)는 같은 스케줄러를 `OfflineAudioContext`에 적용. 이벤트가 수천 개면 렌더 시간이 길어질 수 있으니 진행 표시.
- 선택 최적화(시간 남으면): AudioWorklet 그레인 엔진. **프로토타입에서는 노드 풀 방식이 필수, 워클릿은 선택.**

### Bake → Glissando 보이스 (핵심 난제)
이벤트가 수천 개라 보이스 상한 64를 넘음. **레인 할당(interval graph coloring)**:
1. 이벤트를 시작 시각 순으로 정렬, 각 이벤트를 겹치지 않는 가장 앞 레인에 배치(그리디 → 최소 레인 수 = 최대 동시 중첩).
2. 레인 수 > 64면 가장 조용한 이벤트부터 제거하고 제거 개수를 토스트로 알림(`field.bakedToGliss`처럼 개수 포함).
3. 레인 1개 = Voice 1개: 전체 길이 곡선에 이벤트 구간만 `customPoints`로 표현하고, 이벤트 사이는 **직전 이벤트 끝 음고 유지 + 게인 0**(gainPoints에 0 구간). 이벤트 경계의 급한 음고 점프는 무음 구간에서 일어나게 배치. `captureCurveToCustomPoints`의 `maxAnchors`가 부족하면(레인에 이벤트 수십 개) 허용오차/앵커 수를 키우거나 레인을 분할(보이스 수 한도 안에서), 한계를 보고.
4. 이 변환은 근사임을 도움말/토스트에 명시(포락선 모양, 이벤트 겹침 아닌 경우 정확, 풀 드랍 있을 수 있음).

### 캔버스 (UI)
1. **메인 산점도**: 시간×음고에 이벤트를 선분(p0→p1)으로 그림. 선 굵기/알파 = 게인. 이벤트 수천 개에서도 부드럽게(오프스크린 캔버스에 한 번 그리고 viewport 변환만 반영, 재생헤드 이벤트만 하이라이트).
2. **밀도/중심/폭 곡선 편집**: 하단 스트립에 `density`, `pitch.center`, `pitch.width`, `clusterCollapse` 곡선(기존 커브 편집 UI 재사용 가능한지 `panels.js`/`canvases.js`의 게인 캔버스 패턴 참고; 어려우면 곡선 엔진 14종 드롭다운 + 파라미터 슬라이더로 대체).
3. **히스토그램 옆 패널**: 현재 구간의 피치 히스토그램 vs 이론 PDF(분포 선택에 따른 곡선)를 겹쳐 표시(분포가 의도대로 나오는지 확인용).

### 프리셋 5개
`Gauss Rain`(center 60, σ 7, λ 30) · `Lévy Flights`(lévy α=1.3, 점프 큼) · `Brownian Climb`(drift 상승) · `Ligeti Collapse`(clusterCollapse 0→1, 폭 24→0) · `Sieve Garden`(체 M3∪M5, 사분음 격자).

### 완료 기준
1. 프리셋 전환과 파라미터 편집이 즉시 반영, 이벤트 수와 베이킹 횟수 표시, 재생 중 재베이킹 없음.
2. 라이브 재생이 이벤트 100/s에서 끊김 없음(측정값 보고), 같은 시드 → 같은 소리.
3. Bake → Glissando 보이스(≤64)가 원본과 대략 같은 구름 형태(눈으로 비교 가능, 레인 할당 결과 보고).
4. §6 전부 통과.

### 자가진단 (최소)
- 결정론: 같은 시그니처 → 동일 이벤트 배열, 다른 시드 → 다름
- 포아송: 상수 λ=20, T=60 → 이벤트 수 평균 1200±3σ(√1200≈35)
- 비균질: `density` 램프에서 앞 절반 대비 뒤 절반 이벤트 수 비율이 이론값 ±15%
- 분포 샘플러: gauss 평균/표준편차(±3% 샘플 1e5), cauchy 중앙값≈center, lévy α=2에서 σ√2 가우시안과 일치, brownian 증분 분산
- 체: sieve 활성 시 모든 이벤트 피치 ∈ 허용집합, 합집합 ⊇ 각 항, 교집합 ⊆ 각 항
- 폴리포니 제한: 어느 순간에도 동시 이벤트 ≤ `maxPolyphony`
- 레인 할당: 같은 레인의 이벤트가 겹치지 않음, 레인 수 = 최대 중첩 수(그리디 최적)
- 게인 포락선 양끝 0(클릭 없음), 이벤트 수 상한 준수
- Voice 변환: 개수 ≤ 64, 앵커 x 단조, 상태 불변

### 위험/주의
- 이벤트가 많을 때 메인 스레드 병목: 스케줄러 윈도우 크기와 노드 풀 상한을 조절 가능하게(고급 설정).
- 로그 주파수 글라이드는 `exponentialRampToValueAtTime`이 0 이하를 거부하므로 항상 양수 Hz 보장.
