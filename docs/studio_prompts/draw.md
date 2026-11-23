## Draw Studio — 스튜디오 id `draw`, dev 포트 `8021`, order 40

### 한 줄 목표
캔버스에 **손으로 그린 선이 곧 글리산도**가 되는 UPIC식 드로잉 스튜디오. 입력 축을 여는 가장 저비용 스튜디오입니다.

### 핵심 개념
- 가로 = 시간(초), 세로 = 음고(로그, MIDI). 획(stroke) 1개 = 보이스 1개.
- 획은 포인터 이벤트로 수집한 원시 점 → 정리(단조화·단순화·스냅) → 스플라인(`customPoints`)으로 변환됩니다. 원시 점과 정리된 결과를 모두 문서에 저장해 파라미터를 바꾸면 **원본에서 다시 계산**(비파괴).
- 획 두께/압력 = 진폭(UPIC 방식). 펜 압력이 없으면 슬라이더로 두께를 지정하고, 획을 따라 변하는 두께는 `PointerEvent.pressure`가 0이 아닌 장치에서만 기록.

### 문서 스키마 (`appState.studioParams.draw`)
```js
{
  strokes: [{ id, name, color, muted, solo,
    raw: [{t, p, w}],                 // t: 초, p: MIDI(실수), w: 0..1 두께/압력. 저장 시 소수 4자리로 반올림
    timeMode: 'x' | 'arc',            // 'x': 가로 위치=시간 (시간 역행은 §시간 정리 규칙). 'arc': 호 길이로 재생(곡선이 뒤로 가도 됨)
    arcSpeed: 12,                     // arc 모드: 화면상 초당 이동량 (px 환산 아님: 정규화 길이/초)
    smooth: 0.35,                     // 0..1 → rdpSimplify epsilon + 스플라인 허용오차
    pitchSnap: 'off'|'semitone'|'quarter'|'scale', scaleId, snapStrength: 0..1,  // 0 = 안 붙음, 1 = 완전 스냅(스냅 구간 글라이드 유지)
    gainSource: 'width' | 'fixed', baseGain,
    timbre: { sine, tri, saw, sqr, rich },
    transform: { transpose, stretch, reverse, invert }   // 비파괴 변환
  }],
  grid: { timeDiv: 0.25|0.5|1|off, pitchDiv: 'semitone'|'off' },
  view: {...},                         // 기록만, history:false 편집
  activeStrokeId, tool: 'draw'|'select'|'node'|'erase'|'line'
}
```

### 시간 정리 규칙 (`timeMode:'x'`)
Voice는 시간의 함수여야 하므로 `t`가 되돌아가는 구간이 있으면:
1. `reversal: 'drop'` — 뒤로 가는 점 삭제(기본), 2. `'split'` — 되돌아가는 지점에서 획을 여러 보이스로 분할, 3. `'arc'` — 위 `timeMode:'arc'` 사용.
UI에서 3가지를 고를 수 있어야 하고, 분할 시 보이스 수 상한(64)을 넘으면 경고 토스트.

### 도구 (캔버스)
- **Draw**: 자유 곡선. 포인터 이벤트 + `getCoalescedEvents()`로 점 수집, 드래그 중 실시간 미리보기(단순화 전/후 겹쳐 표시).
- **Line**: 두 점 직선 글리산도(Shift = 반음 스냅).
- **Select/Move**: 획 선택(클릭), 드래그 이동(시간/음고), 휠로 줌, 빈 곳 드래그로 팬. Shift+드래그 = 박스 선택, 복수 선택 이동.
- **Node**: 선택한 획의 스플라인 앵커 표시 → 앵커 드래그로 편집(편집하면 `raw`를 앵커 샘플로 교체하고 `customPoints` 직접 수정 모드로 전환했음을 배지로 표시).
- **Erase**: 획 클릭 삭제, 드래그로 일부 구간 잘라내기(획 분할).
- 단축키: `D`,`V`,`N`,`E`,`L`(도구), `Delete`, `Cmd/Ctrl+D`(복제), `F`(전체 맞춤). 숫자 입력으로 정확한 transpose/stretch.
- 변환 메뉴: Reverse / Invert / Transpose(±반음) / Time-stretch / **Echo Canon**(복제본 N개를 시간·음고 오프셋으로 자동 배치).

### 가져오기 (SVG 경로 + 이미지)
1. **SVG**: 파일 드롭/선택 → DOM `SVGGeometryElement.getPointAtLength()`로 경로 샘플링(ui 계층에서 수행) → 정규화 → 획으로 추가. 순수 엔진에는 "점 배열 → 획" 함수만 둠.
2. **래스터 이미지 윤곽(선택 구현)**: 임계값 → marching squares 윤곽 추적(순수 엔진) → 획. 구현이 길어지면 **SVG만 필수**, 이미지는 "후속 과제"로 보고.
3. 가져온 도형은 캔버스 중앙에 맞추고 배율/위치 조절 가능.

### 변환 파이프라인 (순수 엔진 `draw-engine.js`)
`raw → (시간 정리) → (스냅) → rdpSimplify → fitStrokeToSpline → customPoints` 순서. 결과는 시그니처(JSON 해시) 캐시. 시그니처에 `smooth/snap/timeMode/transform`을 포함하고 소리(timbre/gain)는 제외 → 소리 변경은 재계산 없음.
- `fitStrokeToSpline` 옵션과 반환 형식은 `math-utils.js` 540행 부근을 읽고 맞출 것.
- 피치 스냅은 로그 MIDI 공간에서 계산, `snapStrength`는 `lerp(원래, 스냅된, strength)`; 스케일 목록은 12평균율 장/단조, 5음계, 온음계(ratio 조율 `scaleId` 확장 가능하도록 centOffsets 배열로 정의).

### 오디오 (`draw-audio.js`)
Field 방식 그대로: 획마다 `OscillatorNode`(PeriodicWave = `computeAdditiveCoefficients`) + `GainNode`, 주파수는 `setValueCurveAtTime`로 베이킹된 곡선, 게인은 두께 곡선. 큐 지점부터 재생, 루프, 오프라인 렌더(WAV). 두께가 0인 구간은 무음. 가청 범위 20–20000 Hz 밖은 클램프.

### Bake
`generateVoices`: 획 → Voice(`engine:'custom'`, 로그 피치, `f0Hz/f1Hz`는 첫/끝 점). 두께 곡선 → `gainPoints`(최대 17점). 보이스 ≤ 64. 분할된 획은 각각 별도 보이스.

### UI 랙
- 획 목록(이름·색·mute/solo·삭제·복제), 그리기 설정(smooth, snap, grid, reversal 모드), 소리(timbre 5파, baseGain, 두께→게인 깊이), 변환, 가져오기, 프리셋.
- 프리셋 3개: "Rising Arc"(단순 호), "UPIC Swarm"(난수 획 12개, 시드 PRNG), "Mirror Canon"(획 + 반전 복제).

### 완료 기준 (프로토타입)
1. 마우스로 그린 획이 즉시 들리고 보이며, smooth 슬라이더로 실시간 정리됨.
2. 3가지 시간 역행 규칙이 작동, 획 20개까지 지연 없이 편집.
3. SVG 가져오기 동작(예: 하트·별 경로가 음고 곡선이 됨).
4. 베이킹/저장/불러오기/실행 취소/WAV/EN-KO/도움말 모두 §6 통과.

### 자가진단 항목 (최소)
- `fitStrokeToSpline` 결과와 원본 `raw`의 RMSE ≤ 허용오차(smooth별)
- 시간 정리: `drop` 결과 `t` 단조 증가, `split` 결과 각 조각 단조 + 총 점 수 보존
- 스냅 멱등성: 이미 스냅된 값에 다시 스냅해도 동일, `strength=0` 입력 불변, `strength=1` 격자값 일치
- `arc` 모드 총 재생 길이 = 호 길이 / `arcSpeed`
- 시그니처 캐시: 소리 파라미터만 바꾸면 재계산 0회
- 보이스 변환: 개수 ≤ 64, `customPoints` x 단조·0…1 범위, 상태 불변(`withIsolatedState`)
- 저장→불러오기 왕복에서 `raw`가 동일

### 위험/주의
- 포인터 점이 너무 많으면 `raw` 저장 용량 증가: 기록 시 최소 거리/시간 간격으로 간인.
- 캔버스 좌표↔(초, MIDI) 변환은 Glissando 메인 캔버스의 viewport 규칙을 읽고 맞출 것. 동일한 줌/팬 단축키 의미 유지.
- 압력 미지원 마우스에서 `w` 상수 취급.
