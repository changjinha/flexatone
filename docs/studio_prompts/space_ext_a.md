## Space 확장 A — 3D 스플라인 궤적 + 파라미터 레인(엔벨로프 창)

### A0. 한 줄 목표
음원의 궤적을 **노드마다 xyz 좌표와 곡률을 정의하는 3D 곡선**으로 만들 수 있게 하고, 그 **속도와 다른 변수(음고·음량·밝기·음색·공기 흡수·도플러 세기)를 엔벨로프 창에서 자유롭게** 그릴 수 있게 합니다. 대표 시나리오는 **혜성**: 청취자에게 점점 빨라지며 다가와 스쳐 지나간 뒤 점점 느려지며 멀어지는 음원. 이 단계의 소리 출력은 기존 스테레오/HRTF 그대로입니다(HOA는 B, 타임라인·움직이는 청취자는 C).

### A1. 기본값 표 (선택지 정책: 기본값 + 나머지는 기능)
| 결정 | 기본값 | 다른 선택지(기능으로 제공) |
|---|---|---|
| 경로 종류 | 기존 그대로(`line` 등) | 새 `spline`; 기존 종류 → "스플라인으로 변환" 버튼 |
| 스플라인 차원 | `2d`(z = 기존 `h`) | `3d`(노드별 z) |
| 노드 접선 | `auto`(Catmull–Rom, C1 연속) | `free`(in/out 핸들 직접), 모서리(`curv = 0`) |
| 닫힘 | 열린 곡선 | 닫힌 곡선(순환) |
| 끝 동작 | `stop`(끝에서 정지, 기존 draw와 같음) | `loop`(닫힌 곡선), `pingpong` |
| 시간 모드 | `speed`(속도가 시간을 결정, 지속시간은 결과값) | `fit`(지속시간 고정, 속도 프로파일은 상대값으로 정규화). `pinned`는 C에서 추가 |
| 속도 프로파일 | 기존 `const` | 기존 `curve`·`rankine` + 새 `env`(엔벨로프 창) |
| 레인의 x축(도메인) | 속도 = `path`(곡선 진행도), 나머지 = `time`(음원 시계) | `time` / `path` / `distance`(청취자와의 거리) 모두 선택 가능 |
| 레인 y 스케일 | 속도·게인(dB)·밝기(oct) = 선형, 음고(Hz) = 로그 | 레인마다 lin/log 전환 |
| 편집 뷰 | 상단(XY) 1뷰(기존 화면) | 3뷰(상단 XY · 정면 XZ · 측면 YZ) + 원근 뷰 |

### A2. 데이터 모델 (추가분; 옛 필드는 유지)
```js
source.path.type: … | 'spline'
source.path.spline = {
  dims: '2d' | '3d', closed: false, end: 'stop' | 'loop' | 'pingpong',
  nodes: [{ id, x, y, z,                 // m, 2d 모드에서는 z 무시하고 path.h 사용
            curv: 1,                      // 0..2: 접선 크기 배율. 1 = 표준 Catmull–Rom, 0 = 모서리, >1 = 더 부풀림
            tangent: 'auto' | 'free',
            hin: [dx, dy, dz], hout: [dx, dy, dz] }]   // free일 때의 핸들(노드 기준 상대, m)
}
source.timeMode: 'speed' | 'fit'
source.speed.mode: 'const' | 'curve' | 'rankine' | 'env'
source.speed.env = Lane           // unit m/s
source.f.mode: 'const' | 'curve' | 'env' ;  source.f.env = Lane   // Hz, log
source.lanes = { gain: Lane, bright: Lane, timbre: Lane, air: Lane, dopplerAmt: Lane }
source.timbreB = { …timbre 스펙 }            // timbre 레인의 B쪽 음색(공용 timbre-editor 스펙)
listener.z: 0                                 // 청취자 높이(정지). 회전은 기존 headingDeg만(피치·롤은 C)
doc.view3d = { layout: 'top' | 'quad', az, el, dist }   // 뷰 전용(history: false, 서명 밖)

Lane = { on: false, domain: 'time' | 'path' | 'distance',
         dom: null | [a, b],              // x축 범위. null = 자동(time: [0, 지속시간], path: [0, 1], distance: [rMin, rMax])
         min, max, scale: 'lin' | 'log',  // y 범위와 스케일
         curve: CurveObj }                // curve-engine 객체. 자유 편집은 engine 'custom' + customPoints(x∈[0,1] 단조, y∈[0,1], handles)
```
레인 정의(기본 범위): `speed.env` 0.5–60 m/s · `f.env` 55–3520 Hz(log) · `gain` −24…+12 dB(거리 법칙 위에 곱함) · `bright` −3…+3 oct(로우패스 컷오프에 곱함) · `timbre` 0…1(A↔B 모핑) · `air` 0…2(공기 흡수 양; `airDist`를 나눔, 0 = 흡수 없음) · `dopplerAmt` 0…1(`f_obs = f_s · ratio^amt`). `on: false`인 레인은 중립값(게인 0 dB, 밝기 0 oct, 음색 0, air 1, dopplerAmt 1)이며 기존 동작과 같습니다. 기존 효과 토글(`doppler/distanceGain/airAbsorb/pan`)은 그대로 두고, 토글이 꺼지면 해당 레인도 무시합니다.

### A3. 순수 엔진
1. **3D 스플라인 수학은 공용 모듈** `js/modules/spline3d.js`(순수): 큐빅 Hermite 구간, `auto` 접선 = `curv · (P[i+1] − P[i−1]) / 2`(끝 노드는 한쪽 차분, 닫힌 곡선은 순환), `free` 접선 = `hout`/`−hin`. `position(u)`, `derivative(u)`, **호장 표**(구간당 ≥ 256현, 누적 길이 → `u(s)` 역보간), 전체 길이, 최근접점 투영(노드 삽입용), 노드 삽입/삭제/분할 시 곡선 모양 보존(de Casteljau 등가). C에서 청취자 경로에도 그대로 씁니다.
2. `buildGeometry`를 3D로 일반화: 모든 경로 종류가 `P(u) → {x, y, z}`, `D(u) → {x, y, z}`를 반환(기존 종류는 `z = h`, `Dz = 0`). `stateAt(τ)`는 `{x, y, z, vx, vy, vz}`. 거리는 `|X − L|`(3D, `listener.z` 포함). 방향 성분: `lat`, `fwd`는 기존 헤딩 회전, `up = (z − Lz)/r`. `pan = lat / r`(변경 없음).
3. **운동학(시간 모드)**
   - `speed`: 속도 `v`가 정의하는 대로 `s(τ)`를 적분. 도메인별로
     - `time`: `s(τ) = ∫₀^τ v(τ′) dτ′`
     - `path`: `τ(s) = ∫₀^s ds′ / v(u(s′))`
     - `distance`: `τ(s) = ∫₀^s ds′ / v(r(s′))`, `r(s) = |P(u(s)) − L|` (정지 청취자이므로 기하만으로 결정)
     지속시간 = 경로 끝에 도달하는 시각(결과값, UI에 읽기 전용 표시). `v` 하한 0.05 m/s로 0 나눗셈 방지, 지속시간 상한(예: 600 s)과 `MAX_BAKE_SAMPLES` 초과 시 배지 경고.
   - `fit`: 같은 프로파일을 **상대값**으로 보고 전체가 `duration`에 맞도록 스케일. UI에는 결과 평균/최대 속도와 `max(v)/c`를 표시.
   - 기존 초음속 클램프(`0.98·c_eff`)와 배지 유지. 기존 `const/curve/rankine` 경로의 결과는 **비트 단위로 동일**해야 합니다(회귀).
4. **레인 평가**: 모든 레인은 **방출 시각 τ의 양**(음원 시계, 경로 진행도 `u(τ)`, 방출 위치의 거리 `r(τ)`)으로 평가해 **청취 시간 배열**로 베이킹합니다(`b.gainLane, b.brightOct, b.morph, b.airAmt, b.dop` 등). 도플러: `fObs = fs · (1 / (1 + vr/c))^dop`. 서명에 레인·스플라인·`timeMode`·`listener.z`를 포함. `baseGain`/음색 A·B의 내용/mute/solo는 여전히 서명 밖.
5. `solveEmission`은 3D 거리로 일반화(단조성 조건은 그대로: `|v| < c`). 잔차 `< 1e-9 s` 유지.
6. 프리셋 **`Comet Flyby`** 추가(기존 6종은 그대로): 3D 스플라인(쌍곡선 꼴 7–9 노드, 청취자 위쪽 몇 m를 비스듬히 통과), `speed.mode = 'env'`, 도메인 `distance`, 곡선은 vis-viva `v(r) = sqrt(v∞² + 2k/r)`를 샘플링한 custom points(가까울수록 빠름), `cScale` 0.3 근처, `gain`/`bright` 레인으로 접근 시 밝아짐. 그리고 3D 예시 하나(`Helix` — 청취자 주위를 돌며 올라가는 나선) 추가.
7. "스플라인으로 변환": `line/orbit/lissajous/spiral/draw` → 노드(궤적 오차 ≤ 0.5 m 또는 길이의 0.5%가 되도록 노드 수 적응, 상한 64).
8. `sourceToGlissandoVoice`는 스플라인/레인 음원에도 동작(게인 = 거리 게인 × 게인 레인). 손실 안내(`space.bakeLoss`)에 z·밝기·음색 모핑 추가.

### A4. 오디오 (`space-audio.js`)
- 게인 = `baseGain × 거리 게인 × 게인 레인`, 컷오프 = `lp × 2^brightOct`(800–20000 Hz 클램프), `air` 레인은 베이킹 단계에서 `lp`에 반영.
- **음색 모핑**: `timbre` 레인이 켜진 음원만 오실레이터 2개(A, B; 같은 주파수 곡선)를 equal-power 크로스페이드(`cos/sin` 곡선). 꺼져 있으면 기존처럼 오실레이터 1개(노드 수 증가 없음을 확인).
- HRTF 모드는 이미 `pan/up/fwd` 3축을 쓰므로 3D 궤적의 고도가 반영됩니다. 스테레오 모드는 좌우만.
- 오프라인 렌더·라이브 재스케줄(12 ms 크로스페이드, 45 ms 스로틀)·Manager 어댑터(`ampMask/pitchWarp/brightWarp/voiceMod`)에서 같은 스케줄러를 쓰는 구조 유지.

### A5. 공용 UI — 엔벨로프 창 (`js/ui/envelope-window.js`, 공용 모듈)
- 먼저 Glissando의 게인 곡선 편집기(점 + 베지어 핸들 편집)를 읽고 **재사용 가능한지 판단**하세요. 그대로 떼어 쓸 수 있으면 얇게 감싸고, 결합이 심하면 같은 조작 문법으로 새 공용 컴포넌트를 만듭니다(기존 Glissando 코드는 수정하지 않음). 어느 쪽인지 보고.
- API(예): `createEnvelopeWindow({ title, get, set, x: { label, unit, range, domains?, getDomain, setDomain }, y: { label, unit, min, max, scale }, overlay?(ctx, map), help })` → `{ root, sync(), destroy() }`. 랙에 접힌 미니 미리보기(스파크라인) + 클릭하면 펼쳐지는 큰 편집 창(캔버스 높이 조절은 `ui/canvas-size.js`).
- 기능: 곡선 엔진 프리셋 선택(시작 모양) → "점으로 변환"(`captureCurveToCustomPoints`) → 점 추가/이동/삭제, 핸들 드래그, 구간 곡률, 가로/세로 스냅, 반전(`reverse`)/뒤집기(`inverse`), 초기화, 복사/붙여넣기(레인 간), 축 눈금에 **실제 단위**(m/s, Hz, dB, s, m) 표시, 커서 읽기값. 드래그 1회 = 실행 취소 1단계.
- **오버레이**: 레인 창 뒤에 참고 곡선을 흐리게 표시 — 시간 도메인이면 `r(τ)`(거리)와 최근접 시각 표시선, 경로 도메인이면 노드 위치 눈금, 거리 도메인이면 접근/이탈 구간. 재생 중에는 현재 위치 표시선.
- 도메인을 바꿔도 곡선 모양은 그대로 두고 x축 의미만 바뀝니다(자동 변환 버튼 "모양 유지하며 도메인 변환"은 선택 기능: 현재 운동학으로 리샘플).

### A6. Space UI
1. **경로 랙**: 경로 종류에 `spline` 추가, 차원(2D/3D)·닫힘·끝 동작·"스플라인으로 변환". **노드 인스펙터**(선택한 노드의 x, y, z, 곡률, 접선 모드, 핸들 초기화, 노드 앞/뒤 삽입, 삭제; 숫자 입력).
2. **뷰**: `top`(기존 화면 그대로)과 `quad`(상단 XY · 정면 XZ · 측면 YZ · 원근) 전환. 세 정사영 뷰에서 노드·핸들 드래그(각 뷰는 자기 평면의 두 좌표만 바꿈), 경로 위 더블클릭 = 노드 삽입, Delete = 선택 노드 삭제, 다중 선택(⇧), 휠 줌/팬은 `ui/view-nav.js` 문법. **원근 뷰**는 canvas2D 궤도 카메라(드래그 = 회전, 휠 = 거리), 바닥 격자, 노드에서 바닥으로 내리는 **수직 낙하선**과 바닥 그림자 경로로 깊이를 보여주고, 재생 시 음원·들리는 위치(지연된 위치)·속도 벡터를 그립니다. 편집은 정사영 뷰에서만(원근 뷰는 보기 전용 + 노드 클릭 선택). 뷰 좌표 변환·피킹은 순수 함수(`space-views.js`)로 분리해 자가진단 가능하게.
3. 파면 링은 각 정사영 뷰에서 **구와 그 평면의 단면 원**으로 그립니다(상한 24 유지).
4. **레인 랙**: 속도·음고는 기존 프로파일 랙의 모드 세그먼트에 `env` 추가, 나머지 레인(게인·밝기·음색·공기·도플러 세기)은 새 "Lanes" 랙에 켜기 토글 + 엔벨로프 창. 음색 레인이 켜지면 음색 B 편집기(공용 `createTimbreEditor`) 표시.
5. 시간 모드 세그먼트(`speed`/`fit`), 결과 읽기값(지속시간, 경로 길이, 평균·최대 속도, `max(v)/c`, 최근접 거리와 시각).
6. 관측 곡선 패널의 미니 곡선 스택에 레인 결과(게인 합성, 컷오프) 반영. 스크린샷/클린 차트(`ui/clean-chart.js`)는 기존 선 그대로.
7. 좁은 창에서는 quad 뷰가 2×2 → 세로 적층으로 바뀝니다.

### A7. 자가진단 (최소; 이름 접두 `space-a-`)
- 스플라인: 2노드 직선 길이 = 유클리드 거리(1e-9), `auto` 노드에서 접선 방향 연속(각도 차 < 1e-6), `curv = 0`/`free` 불일치에서만 꺾임, 호장 역보간 `u(s(u)) = u`(1e-6), 노드 삽입 후 곡선 최대 편차 < 1e-6 m, 닫힌 곡선의 시작 = 끝.
- 등가성: 2노드 스플라인(−150,5,0)→(150,5,0)의 베이킹이 기존 `line` Pass-by와 일치(`fObs` 상대 1e-9). 기존 `orbit` → 스플라인 변환의 `fObs` 차이 ≤ 0.5%.
- 3D: 높이 z로 지나가는 직선의 최근접 거리 = `sqrt(d² + z²)`, `up` 부호, 솔버 잔차 < 1e-9(스플라인 3종 × cScale 1/0.3).
- 운동학: `speed` 모드에서 `∫v dτ` = 경로 길이(상대 1e-6)를 세 도메인 모두에서, `fit` 모드에서 지속시간 = `duration`(1e-9)이고 속도 비율이 프로파일과 일치, 속도 상수일 때 `path` 도메인 레인 = `time` 도메인 레인(1e-9).
- 레인: 게인 레인 −6 dB → 게인 ×0.5012, `dopplerAmt = 0` → `fObs = fs`, `= 1` → 기존 식, 밝기 +1 oct → 컷오프 ×2(클램프 안), 레인 `on: false` → 기존과 비트 동일.
- Comet: 최근접 시각에 속도 최대, 접근 구간에서 `r`이 줄수록 `v` 단조 증가, 통과 전 `fObs > fs`·통과 후 `fObs < fs`, 초음속 클램프 미발동.
- 서명: `baseGain`/음색 내용/mute → 0회, 레인 점 이동 → 1회, 노드 드래그 → 해당 음원 1회.
- 뷰: 세계↔뷰 좌표 왕복(1e-9), 세 뷰 각각에서 노드 피킹, 원근 투영의 앞뒤 순서.
- 오디오(비동기): 음색 레인 0→1 오프라인 렌더에서 스펙트럼 중심이 A값 → B값으로 이동, 레인 꺼진 음원의 노드 수 = 기존.
- §X3 공통 항목.

### A8. 완료 기준
1. `Comet Flyby`를 열면 접근하며 빨라지고 음고가 올라가다 통과 순간 급강하, 멀어지며 느려지는 것이 관측 곡선과 오프라인 렌더(순간 주파수)에 나타납니다.
2. quad 뷰에서 노드를 세 평면으로 끌어 3D 곡선을 만들고, 곡률·핸들을 노드마다 바꿀 수 있습니다(재베이킹 < 100 ms, 음원 8개).
3. 속도 엔벨로프의 도메인을 time/path/distance로 바꿔 같은 궤적에서 다른 결과를 듣고 볼 수 있습니다.
4. 기존 프리셋·프로젝트는 소리와 화면이 그대로입니다.
5. §X5 전부 통과.

### A9. 위험/주의
- 호장 표 해상도가 낮으면 속도 리플 → 도플러 음고에 미세한 떨림. 구간당 256현 이상 + 역보간은 선형이 아니라 구간 내 뉴턴 1회 보정을 검토하고, `fObs`의 2차 차분 잡음을 실측해 보고.
- 노드의 꺾임(C0)은 `v_r`의 불연속 = 음고 스텝입니다. 의도된 물리(급선회)이지만 클릭이 나지 않도록 주파수 곡선은 베이킹 표본 사이를 선형 보간합니다.
- `distance` 도메인은 청취자를 옮기면 운동학 전체가 바뀝니다(서명에 청취자 포함 — 이미 그렇습니다).
- 음색 모핑은 오실레이터 수를 두 배로 늘립니다. 음원 상한(기존 값 확인)과 CPU를 보고.
