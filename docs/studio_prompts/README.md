# 새 스튜디오 프롬프트 (7종)

각 `PROMPT_<id>.md`는 공통 전제 + 해당 스튜디오 계획이 합쳐진 **단독 프롬프트**입니다. 파일 전체를 새 챗에 그대로 붙여 넣으세요.
(원본: `_common.md` + `<id>.md`. 공통을 고치면 `cat _common.md <id>.md > PROMPT_<id>.md`로 재생성)

| id | 포트 | order | 난이도 | 비고 |
|---|---|---|---|---|
| draw | 8021 | 40 | 낮음 | SVG 가져오기 필수, 이미지 윤곽은 선택 |
| chaos | 8022 | 50 | 중간 | Field의 RK 인프라 재사용 |
| cloud | 8023 | 60 | 중간 | 보이스 상한 64 → 레인 할당 |
| tempo | 8024 | 70 | 중간 | Tempo Manager와 이름 충돌 주의 |
| space | 8025 | 80 | 중상 | 스테레오 출력, pan은 Voice에 없음 |
| fractal | 8026 | 90 | 중간 | 6모드, 앵커 한도 근사 손실 |
| wave | 8027 | 100 | 높음 | AudioWorklet 가산 뱅크 |
| grid | 8028 | 110 | 높음 | 래스터 + 이미지 효과 6종, 공용 모듈/Manager 포함 (최신 프로젝트 기준 G0 우선 규칙) |

## Space Studio 확장 프롬프트 (기존 스튜디오 확장)

`PROMPT_spacex_<단계>.md` = `space_ext_common.md` + `space_ext_<단계>.md`. 공통을 고치면
`for p in a b c f1 f2 f3 f4; do cat space_ext_common.md space_ext_$p.md > PROMPT_spacex_$p.md; done`로 재생성.
**A → B → C 순서로 의존**합니다(한 챗에 한 단계). 후속 과제 F1–F4는 A–C 뒤에 독립적으로 진행.

| 단계 | 내용 | 전제 | 비고 |
|---|---|---|---|
| a | 3D 스플라인 궤적(노드별 xyz·곡률) + 파라미터 레인(엔벨로프 창), Comet 프리셋 | — | 공용 `modules/spline3d.js`, `ui/envelope-window.js` |
| b | HOA(바이노럴 모니터링, ambiX 내보내기) + 다른 스튜디오의 소리 가져오기(라이브 링크) | a | 공용 `modules/ambisonics.js`, `audio/hoa-bus.js`, `audio/instance-source.js` |
| c | 타임라인·움직이는 청취자 + Manager의 Space Master(마스터 트랙) | a, b | C1 → C2 → C3, 큼 |
| f1 | 다른 스튜디오의 궤적을 경로로(Chaos 3D 등) + 스템/스테레오 분리 | a–c | a, b 두 번에 나눠도 됨 |
| f2 | 스피커 배열 출력 + 사용자 HRIR | b | |
| f3 | 방(지면 반사·영상 음원)·잔향 = 거리감 | b | 두 번에 나눠도 됨 |
| f4 | Manager 모듈레이션·씬 연동 + 변하는 음속·초음속 | c | a, b 한 챗에 하나씩 |

선택지 정책: 한 결정에 선택지가 여럿이면 가장 자연스러운 것이 기본값, 나머지는 UI 기능(각 문서의 "기본값 표").
