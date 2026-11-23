/**
 * Flexatone — ui/help-entries.js
 * Layer 4 (ui): help text for the header / transport and the Glissando Studio static controls.
 * 계층 4 (ui): 헤더·트랜스포트와 글리산도 스튜디오 정적 컨트롤의 도움말.
 *
 * Merged into HELP_DB by ui/option-inspector.js. Static index.html controls are linked by id
 * (HELP_EXTRA_BY_ID), so the markup does not need data-help attributes.
 * option-inspector.js가 HELP_DB에 병합. index.html 컨트롤은 id로 연결.
 */

const E = (title, summary, detail = '', formula = '') => ({ title, summary, detail, formula });
const H = (en, ko) => ({ en: E(...en), ko: E(...ko) });

export const HELP_EXTRA = {
  // ---------------- Header / 헤더
  'app.studioTabs': H(
    ['Studio tabs', 'Switch between the studios (Glissando, Risset, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave).', 'Each studio keeps its own document inside the project. Playback, undo and WAV export follow the active studio.'],
    ['스튜디오 탭', '스튜디오를 전환합니다 (글리산도, 리세, 필드, 드로잉, 클라우드, 스페이스, 템포, 카오스, 프랙탈, 웨이브).', '스튜디오마다 문서가 프로젝트 안에 따로 저장됩니다. 재생·실행 취소·WAV 내보내기는 활성 스튜디오를 따릅니다.'],
  ),
  // Per-studio tabs / 스튜디오별 탭
  'app.studio.glissando': H(
    ['Glissando Studio', 'Edit continuous pitch and gain trajectories voice by voice.', 'Each voice glides from F₀ to F₁ along a curve engine (or a hand-edited spline), with its own gain envelope and timbre. The other studios can bake their results into this editor. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['글리산도 스튜디오', '보이스마다 연속적인 음고·게인 궤적을 편집합니다.', '각 보이스는 곡선 엔진(또는 직접 편집한 스플라인)을 따라 F₀에서 F₁로 미끄러지며, 고유한 게인 엔벨로프와 음색을 가집니다. 다른 스튜디오의 결과도 이 편집기로 베이킹할 수 있습니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.risset': H(
    ['Risset Studio', 'Shepard-Risset sonic field: up to 60 voices on a circular pitch space.', 'Voices glide endlessly up or down while a spectral bell fades them in and out, creating the illusion of a never-ending glissando. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['리세 스튜디오', '셰퍼드-리세 음장: 원형 음고 공간 위 최대 60개 보이스.', '보이스들이 끝없이 오르내리고 스펙트럼 종 모양 창이 음량을 넣고 빼서, 끝나지 않는 글리산도의 착각을 만듭니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.field': H(
    ['Field Studio', 'Particles flying through a vector field draw glissando trajectories.', 'Guide curve, force nodes, turbulence, pitch wells and local regions shape the field; each particle is one voice, baked at edit time. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['필드 스튜디오', '벡터장 위를 날아가는 입자가 글리산도 궤적을 그립니다.', '가이드 곡선, 힘 노드, 난류, 음정 우물, 국소 영역이 장을 만들고, 입자 하나가 보이스 하나이며 편집할 때 미리 베이킹됩니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.draw': H(
    ['Draw Studio', 'Hand-drawn strokes become glissandi (UPIC-style).', 'Draw on the time-pitch canvas; every stroke is played as a voice. Tools and shortcuts are listed under the canvas. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['드로잉 스튜디오', '손으로 그린 획이 글리산도가 됩니다 (UPIC 방식).', '시간-음고 캔버스에 그리면 획 하나하나가 보이스로 재생됩니다. 도구와 단축키는 캔버스 아래에 있습니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.cloud': H(
    ['Cloud Studio', 'Stochastic glissando clouds (Xenakis): density, distributions, sieves.', 'Many short glissandi are drawn at random from probability distributions; density, pitch/slope distributions and sieves shape the texture. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['클라우드 스튜디오', '확률적 글리산도 구름 (크세나키스): 밀도, 분포, 체.', '확률 분포에서 짧은 글리산도를 무작위로 많이 뽑아 냅니다. 밀도, 음고·기울기 분포, 체(sieve)가 질감을 정합니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.space': H(
    ['Space Studio', 'Doppler glissandi from sources moving past a listener.', 'Sound sources move along paths; the pitch the listener hears is computed with retarded time (the sound needs time to arrive), so passing sources bend downward. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['스페이스 스튜디오', '청취자 곁을 지나가는 음원이 만드는 도플러 글리산도.', '음원이 경로를 따라 움직이고, 청취자가 듣는 음고는 지연 시간(소리가 도착하는 데 걸리는 시간)으로 계산되어 지나가는 음원의 음이 아래로 휩니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.tempo': H(
    ['Tempo Studio', 'Tempo canons: one subject played at several tempo curves.', 'Each voice plays the same subject with its own tempo curve, so voices drift apart and converge (phasing, convergence points). Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['템포 스튜디오', '템포 캐논: 하나의 주제를 여러 템포 곡선으로 연주합니다.', '각 보이스가 같은 주제를 서로 다른 템포 곡선으로 연주해, 흩어졌다가 다시 만납니다 (페이징, 수렴점). “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.chaos': H(
    ['Chaos Studio', 'Chaotic attractors (Lorenz, Rössler, …) sonified as diverging glissandi.', 'Voices start from almost identical states and separate over time; the divergence point is marked on the canvas. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['카오스 스튜디오', '카오스 끌개(로렌츠, 뢰슬러 …)를 갈라지는 글리산도로 들려줍니다.', '거의 같은 상태에서 출발한 보이스들이 시간이 지나며 갈라지고, 갈라지는 지점이 캔버스에 표시됩니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.fractal': H(
    ['Fractal Studio', 'Self-similar glissandi: FIF, fBm, Weierstrass, Cantor, L-system trees, Nørgård canon.', 'Choose a generator and zoom into the curve with the lens to hear the same shape repeat at smaller scales. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['프랙탈 스튜디오', '자기유사 글리산도: FIF, fBm, 바이어슈트라스, 칸토어, L-시스템 트리, 노르고르 캐논.', '생성기를 고르고 렌즈로 곡선을 확대하면, 같은 모양이 더 작은 규모에서 반복되는 것을 들을 수 있습니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.studio.wave': H(
    ['Wave Studio', 'Wave equations on the pitch axis: pitch is the medium.', 'Pulses placed on the t = 0 line travel, spread and reflect along the pitch axis; the result is baked at edit time. Bake to Glissando Voices turns the result into ordinary, editable Glissando voices. Each studio keeps its own document in the project; Play, Undo and WAV export follow the active tab.'],
    ['웨이브 스튜디오', '음고 축 위의 파동 방정식: 음고가 매질이 됩니다.', 't = 0 선에 놓은 펄스가 음고 축을 따라 이동·퍼짐·반사되며, 결과는 편집할 때 미리 베이킹됩니다. “글리산도 보이스로 베이킹”을 누르면 결과가 편집 가능한 일반 글리산도 보이스가 됩니다. 스튜디오마다 문서가 프로젝트에 따로 저장되며, 재생·실행 취소·WAV 내보내기는 활성 탭을 따릅니다.'],
  ),
  'app.play': H(
    ['Play / Pause', 'Start playback from the cue point (Space).', 'Space toggles play ⇄ stop. Playback reads pre-computed curves, so editing while playing is safe.'],
    ['재생 / 일시정지', '큐 지점부터 재생합니다 (Space).', 'Space로 재생 ⇄ 정지를 전환합니다. 재생은 미리 계산된 곡선을 읽으므로 재생 중 편집해도 안전합니다.'],
  ),
  'app.loop': H(
    ['Loop', 'Repeat playback continuously (L).', 'When the last voice ends, playback jumps back to the cue point.'],
    ['반복', '재생을 계속 반복합니다 (L).', '마지막 보이스가 끝나면 큐 지점으로 돌아가 다시 재생합니다.'],
  ),
  'app.stop': H(
    ['Stop', 'Stop playback and return to the cue point.', 'Esc also stops and clears the point selection.'],
    ['정지', '재생을 멈추고 큐 지점으로 돌아갑니다.', 'Esc도 정지하며 점 선택을 해제합니다.'],
  ),
  'app.cue': H(
    ['Cue / playhead', 'Current cue time. Click to reset the cue to 0 s.', 'Double-click a canvas to set the cue anywhere.'],
    ['큐 / 플레이헤드', '현재 큐 시각입니다. 누르면 0초로 초기화합니다.', '캔버스를 더블클릭하면 원하는 위치에 큐를 지정할 수 있습니다.'],
  ),
  'app.undo': H(
    ['Undo / Redo', 'Step back or forward through edits (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z).', 'A slider drag or canvas drag is recorded as one step. View changes (zoom, pan) are not recorded.'],
    ['실행 취소 / 다시 실행', '편집을 한 단계씩 되돌리거나 다시 적용합니다 (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z).', '슬라이더나 캔버스 드래그 한 번이 1단계로 기록됩니다. 줌·이동 같은 보기 변경은 기록되지 않습니다.'],
  ),
  'app.screenshot': H(
    ['Screenshot', 'Save the graph on screen as a PNG image (for research or scores).', 'Mode “Full” = the screen as shown; “Axes + lines” = only axes and curves on white; its SVG button saves a vector file instead of a PNG (set in the Version Gallery). Each screenshot also stores a restorable Version, with the image as its thumbnail (Glissando editor).'],
    ['스크린샷', '화면의 그래프를 PNG 이미지로 저장합니다 (연구·악보용).', '“화면 그대로”는 보이는 그대로, “축 + 선”은 흰 배경에 축과 곡선만 남기며, SVG 버튼을 켜면 PNG 대신 벡터 파일로 저장합니다 (버전 갤러리에서 선택). 스크린샷마다 그 이미지를 썸네일로 한 복원 가능한 버전도 함께 보관됩니다 (글리산도 에디터).'],
  ),
  'app.saveLoad': H(
    ['Save / Load project', 'Save or open the whole project as a .json file.', 'Includes every studio document, voices, output settings and versions. In Chrome / Edge, Save opens a window to choose the folder and file name; other browsers download the file. Pressing Cmd/Ctrl+R or F5 with changes that are not in a saved file asks first, with a Save and reload option.'],
    ['프로젝트 저장 / 불러오기', '전체 프로젝트를 .json 파일로 저장하거나 엽니다.', '모든 스튜디오 문서, 보이스, 출력 설정, 버전이 포함됩니다. Chrome/Edge에서는 저장 시 폴더와 파일 이름을 고르는 창이 뜨고, 다른 브라우저는 다운로드됩니다. 파일에 저장하지 않은 변경이 있을 때 Cmd/Ctrl+R 또는 F5를 누르면 \'저장 후 새로고침\' 선택지가 있는 확인 창이 먼저 뜹니다.'],
  ),
  'app.newProject': H(
    ['New project', 'Start over from the default document.', 'Asks first. The current work is replaced, including the autosaved copy, so use Save before it if you want to keep it.'],
    ['새 프로젝트', '기본 문서로 새로 시작합니다.', '먼저 확인을 묻습니다. 자동 저장본을 포함해 지금 작업이 대체되므로, 남기려면 먼저 저장하세요.'],
  ),
  'app.exportWav': H(
    ['Export WAV', 'Render the active studio offline to a 48 kHz / 16-bit WAV.', 'The output stage (fader, limiter) is applied exactly as during playback.'],
    ['WAV 내보내기', '활성 스튜디오를 48kHz / 16비트 WAV로 오프라인 렌더합니다.', '출력 단계(페이더, 리미터)가 재생 때와 똑같이 적용됩니다.'],
  ),
  'app.lang': H(
    ['Language', 'Switch the interface between English and Korean.', ''],
    ['언어', '인터페이스를 영어 / 한국어로 전환합니다.', ''],
  ),
  'app.layout': H(
    ['Landscape / Portrait', 'Toggle the panel layout for wide or tall screens.', ''],
    ['가로 / 세로', '넓은 화면과 세로 화면용 패널 배치를 전환합니다.', ''],
  ),
  'app.uiZoom': H(
    ['UI zoom', 'Scale the whole interface (40–200 %).', ''],
    ['UI 배율', '인터페이스 전체 크기를 조절합니다 (40–200%).', ''],
  ),
  'app.manager': H(
    ['Manager', 'Open the Manager window (M) for project-wide voice and mixer overview.', ''],
    ['매니저', '프로젝트 전체 보이스·믹서를 보는 매니저 창을 엽니다 (M).', ''],
  ),
  'app.helpMode': H(
    ['Help mode', 'Highlight every documented control (H). Hover a box to read it, click for details.', 'Esc or H closes help mode. Option(Alt) + hover / click works at any time as well.'],
    ['도움말 모드', '설명이 있는 모든 컨트롤을 강조합니다 (H). 상자에 마우스를 올리면 설명, 클릭하면 자세히.', 'Esc나 H로 닫습니다. Option(Alt) + 마우스 오버/클릭도 언제든 쓸 수 있습니다.'],
  ),

  // ---------------- Glissando: voices / 보이스
  'gliss.voiceEdit': H(
    ['Add / Duplicate / Delete voice', 'Manage the voices of the Glissando grapher.', 'Duplicate places the copy right after the active voice. Shift+R does the same from the keyboard.'],
    ['보이스 추가 / 복제 / 삭제', '글리산도 그래퍼의 보이스를 관리합니다.', '복제는 활성 보이스 바로 뒤에 놓입니다. 키보드 Shift+R도 같습니다.'],
  ),
  'gliss.matrix': H(
    ['Unified Matrix', 'Edit Curve Engine, F₀/F₁, start, length, gain and S/M of all voices in one table.', ''],
    ['통합 매트릭스', '모든 보이스의 곡선 엔진, F₀/F₁, 시작, 길이, 게인, S/M을 표 하나에서 편집합니다.', ''],
  ),
  'gliss.view': H(
    ['Piano roll / 0–1 Norm', 'Vertical axis as pitch (piano roll) or as the normalized curve value.', 'Norm view shows y(t) ∈ [0, 1] exactly as the curve engine outputs it.'],
    ['피아노롤 / 0–1 정규화', '세로축을 음고(피아노롤) 또는 정규화된 곡선 값으로 표시합니다.', '정규화 보기는 곡선 엔진이 내놓는 y(t) ∈ [0, 1]을 그대로 보여 줍니다.'],
  ),
  'gliss.grid': H(
    ['Grid subdivision', 'Time grid density used for display and snapping.', ''],
    ['그리드 분할', '표시와 스냅에 쓰는 시간 격자 간격입니다.', ''],
  ),
  'gliss.locate': H(
    ['Locate mode', 'Drag the curve body to move a voice, drag an endpoint to stretch it.', 'Arrow keys nudge F₀/F₁ or the whole voice; Shift for larger steps (Glissando window). The same Locate is shared by Field (particles), Draw (strokes, with Select / Node), Tempo (timeline voices: start + transpose) and Space (observed-pitch roll: start + emitted pitch; end dots = time only). In those studios, releasing a drag plays the studio from the object’s start without moving the cue.'],
    ['위치 모드', '곡선 몸통을 드래그하면 이동, 끝점을 드래그하면 늘이기.', '화살표 키로 F₀/F₁이나 보이스 전체를 미세 이동합니다 (Shift: 크게, 글리산도 창). 같은 이동 도구를 필드(입자), 드로(획, 선택·노드 도구), 템포(타임라인 보이스: 시작·조옮김), 스페이스(관측 음고 롤: 시작·방출 음고, 끝점은 시간만)에서도 씁니다. 이 스튜디오들에서는 드래그를 놓으면 큐를 옮기지 않고 그 대상의 시작부터 재생합니다.'],
  ),
  'gliss.snap': H(
    ['Snap', 'Snap dragged positions to semitones and 0.1 s.', ''],
    ['스냅', '드래그 위치를 반음과 0.1초 단위로 맞춥니다.', ''],
  ),
  'gliss.scrub': H(
    ['Scrub audio', 'Hear the sound under the playhead while you drag it.', ''],
    ['스크럽 오디오', '플레이헤드를 드래그하는 동안 그 위치의 소리를 들려줍니다.', ''],
  ),
  'gliss.deriv': H(
    ['Show f′(t)', 'Overlay the derivative (pitch velocity) of each curve.', 'Useful to find kinks: a jump in f′ is a corner in f.'],
    ['f′(t) 보기', '각 곡선의 도함수(음고 속도)를 겹쳐 보여 줍니다.', '꺾인 점을 찾을 때 유용합니다: f′의 불연속 = f의 모서리.'],
  ),
  'gliss.zoom': H(
    ['Zoom', 'Pitch (Y), time (X) and proportional zoom. Fit shows everything (F).', 'Wheel zooms time, Shift+wheel zooms pitch.'],
    ['줌', '음고(Y)·시간(X)·비례 줌입니다. 전체 맞춤은 F.', '휠은 시간 줌, Shift+휠은 음고 줌입니다.'],
  ),
  'gliss.canvas': H(
    ['Trajectory canvas', 'All voice trajectories over time. Drag points / handles to edit the active curve.', 'Double-click sets the cue. Behaviour of drags depends on Locate / Select mode.'],
    ['궤적 캔버스', '모든 보이스의 시간별 궤적입니다. 점·핸들을 드래그해 활성 곡선을 편집합니다.', '더블클릭으로 큐를 지정합니다. 드래그 동작은 위치 / 선택 모드에 따라 다릅니다.'],
  ),

  // ---------------- Glissando: gain / 게인
  'gliss.gainMode': H(
    ['Gain envelope source', 'Points: draw the envelope by hand. Curve Engine: generate it from a curve.', ''],
    ['게인 엔벨로프 소스', '포인트: 직접 그리기. 곡선 엔진: 곡선으로 생성.', ''],
  ),
  'gliss.gainPresets': H(
    ['Envelope presets', 'Flat, crescendo, decrescendo or swell in one click.', 'The result is expressed in the current envelope unit (Amp / dB / Sone).'],
    ['엔벨로프 프리셋', '평탄·크레센도·디크레센도·스웰을 한 번에 적용합니다.', '현재 엔벨로프 단위(진폭 / dB / Sone)로 표현됩니다.'],
  ),
  'gliss.gainCanvas': H(
    ['Gain envelope canvas', 'Amplitude of the active voice over its duration.', 'Drag points to edit; the vertical meaning follows the envelope unit.'],
    ['게인 엔벨로프 캔버스', '활성 보이스의 길이에 따른 음량입니다.', '점을 드래그해 편집합니다. 세로축 의미는 엔벨로프 단위를 따릅니다.'],
  ),

  // ---------------- Glissando: Curve Engine rack / 곡선 엔진 랙
  'gliss.target': H(
    ['Curve Engine target', 'Edit the pitch curve or the amplitude curve with the Curve Engine rack.', ''],
    ['곡선 엔진 대상', '곡선 엔진 랙으로 음고 곡선 또는 진폭 곡선을 편집할지 고릅니다.', ''],
  ),
  'gliss.reverse': H(
    ['Reverse / Inverse', 'Reverse plays the curve backwards in time; Inverse flips it upside down.', '', 'reverse: f(1 − t)   ·   inverse: 1 − f(t)'],
    ['역방향 / 반전', '역방향은 시간을 거꾸로, 반전은 위아래를 뒤집습니다.', '', 'reverse: f(1 − t)   ·   inverse: 1 − f(t)'],
  ),
  'gliss.ampRange': H(
    ['Amplitude range / Auto-Fit', 'Map the Curve Engine output into [Amp min, Amp max]. Auto-Fit stretches it to fill the range.', '', 'g(t) = min + (max − min) · f(t)'],
    ['진폭 범위 / 자동 맞춤', '곡선 엔진 출력을 [최소, 최대] 진폭으로 매핑합니다. 자동 맞춤은 범위를 꽉 채웁니다.', '', 'g(t) = min + (max − min) · f(t)'],
  ),

  // ---------------- Glissando: pitch & timing / 음고·타이밍
  'gliss.groupApply': H(
    ['Group apply', 'Apply edits to every selected voice at once.', ''],
    ['그룹 적용', '선택한 모든 보이스에 편집을 한꺼번에 적용합니다.', ''],
  ),
  'gliss.scale': H(
    ['Pitch scale', 'Log: equal steps sound equal (semitones). Linear Hz: equal steps in frequency.', '', 'log: f = f₀·(f₁/f₀)^y   ·   lin: f = f₀ + (f₁ − f₀)·y'],
    ['음고 스케일', '로그: 같은 간격이 같은 음정으로 들림(반음). 선형 Hz: 주파수 기준 등간격.', '', 'log: f = f₀·(f₁/f₀)^y   ·   lin: f = f₀ + (f₁ − f₀)·y'],
  ),
  'gliss.audioTarget': H(
    ['Audio source f(t) / f′(t)', 'Sonify the curve itself, or its normalized derivative (velocity).', ''],
    ['오디오 소스 f(t) / f′(t)', '곡선 자체 또는 정규화된 도함수(속도)를 소리로 만듭니다.', ''],
  ),
  'gliss.f0': H(
    ['F₀ — start pitch', 'Pitch at t = 0: note name, MIDI slider, Hz, and fine tune in cents.', 'All four fields stay in sync.'],
    ['F₀ — 시작 음고', 't = 0의 음고: 음 이름, MIDI 슬라이더, Hz, 센트 미세 조정.', '네 칸은 항상 서로 맞춰집니다.'],
  ),
  'gliss.f1': H(
    ['F₁ — end pitch', 'Pitch at t = 1: note name, MIDI slider, Hz, and fine tune in cents.', ''],
    ['F₁ — 끝 음고', 't = 1의 음고: 음 이름, MIDI 슬라이더, Hz, 센트 미세 조정.', ''],
  ),
  'gliss.timing': H(
    ['Start / Duration', 'When the voice starts and how long it lasts (seconds).', 'The ⇄ button switches between Duration and End time.'],
    ['시작 / 길이', '보이스가 시작하는 시각과 길이(초).', '⇄ 버튼으로 길이 / 끝 시각 입력을 전환합니다.'],
  ),
  'gliss.baseGain': H(
    ['Base gain', 'Overall level of the active voice, multiplied with its envelope.', '', 'out = baseGain · envelope(t)'],
    ['기본 게인', '활성 보이스의 전체 음량. 엔벨로프와 곱해집니다.', '', 'out = baseGain · envelope(t)'],
  ),
  // ---------------- Glissando: timbre / 음색
  'gliss.timbreMode': H(
    ['Timbre mode', 'Mix: blend five waveforms. f(x): define the waveform by a formula or another voice curve. Sample: this voice plays a region of a sound file.', ''],
    ['음색 모드', '믹스: 다섯 파형 섞기. f(x): 수식이나 다른 보이스 곡선으로 파형 정의. 샘플: 이 보이스가 사운드 파일의 구간을 재생.', ''],
  ),
  'gliss.timbreSample': H(
    ['Sampler (this voice)', 'The voice plays a region of a sound file instead of a synthesized wave. Its pitch curve sets the playback speed, like tape: one octave up plays twice as fast.', 'Sampler voices are individual voices: the setting belongs to the active voice only (Group Apply does not copy it), and they never join legato chains. Root = the note the file sounds at normal speed (Detect estimates it). Loop region repeats the region while the voice lasts (with a crossfade of Fade ms); otherwise the region plays once. Files are kept in the project file (16-bit mono, at most 60 s each). Playback — Tape: pitch and speed move together. Pitch only: the pitch curve changes only the pitch (granular shift, Grain ms) and the file is read at Speed × its own speed; Speed 0 freezes the sound at the region start.', 'tape: rate(t) = f(t) / f_root   ·   pitch only: ratio(t) = f(t) / f_root, read pointer = t0 + speed · t'],
    ['샘플러 (이 보이스)', '보이스가 합성 파형 대신 사운드 파일의 구간을 재생합니다. 음고 곡선이 테이프처럼 재생 속도를 정합니다 — 한 옥타브 위 = 두 배 속도.', '샘플러 보이스는 개별 보이스입니다: 설정은 활성 보이스에만 적용되고(그룹 적용으로 복사되지 않음), 레가토 체인에 들어가지 않습니다. 루트 = 파일이 원래 속도로 낼 때의 음(추정 버튼으로 계산). 구간 반복은 보이스가 계속되는 동안 구간을 반복하고(페이드 ms 길이의 크로스페이드), 끄면 구간을 한 번만 재생합니다. 파일은 프로젝트 파일에 저장됩니다(16비트 모노, 파일당 최대 60초). 재생 방식 — 테이프: 음높이와 속도가 함께 변함. 음높이만: 음고 곡선이 음높이만 바꾸고(그레인 시프트, 그레인 ms) 파일은 속도 × 원래 속도로 읽음. 속도 0은 구간 시작에서 소리를 정지(프리즈)합니다.', '테이프: rate(t) = f(t) / f_root   ·   음높이만: ratio(t) = f(t) / f_root, 읽기 위치 = t0 + speed · t'],
  ),
  'gliss.timbreMix': H(
    ['Waveform mix', 'Levels of sine, triangle, saw, square and rich partials.', 'Combined into one PeriodicWave (additive synthesis).'],
    ['파형 믹스', '사인·삼각·톱니·사각·풍부 배음의 비율입니다.', '하나의 PeriodicWave로 합쳐집니다 (가산 합성).'],
  ),
  'gliss.timbreFunc': H(
    ['Waveform f(x)', 'One period of the waveform, x ∈ [0, 1]. Its harmonics are found by DFT.', '', 'a_k = DFT{ f(x) }'],
    ['파형 f(x)', '파형 한 주기 x ∈ [0, 1]. 배음은 DFT로 계산됩니다.', '', 'a_k = DFT{ f(x) }'],
  ),

  // ---------------- Field Studio extras / 필드 스튜디오 보충
  'field.layers': H(
    ['Vector field layers', 'The field is a stack of layers on the absolute pitch × time plane, shared by every particle. Each layer has its own nodes, turbulence and uniform flow, and acts inside its range.', 'The stack is evaluated from the bottom (1) to the top. The Main field covers the full range by default. Add a Local field to change the field in one area; drag its body on the canvas to move it, drag its □ corners to resize. Guide pull and pitch wells are separate and always apply.', 'acc ← blend(acc, V_layer, w_layer(t, pitch))  for layer 1 … n'],
    ['벡터장 레이어', '벡터장은 절대 음고 × 시간 평면 위의 레이어 스택이며 모든 입자가 같은 장을 공유합니다. 레이어마다 노드·난류·균일 흐름이 있고 자기 범위 안에서 작용합니다.', '스택은 아래(1)부터 위로 계산됩니다. 메인 장은 기본적으로 전체 범위입니다. 로컬 장을 추가해 특정 영역의 장을 바꿀 수 있습니다. 캔버스에서 본체를 드래그해 옮기고 □ 모서리로 크기를 조절합니다. 가이드 인력과 음정 우물은 별도로 항상 작용합니다.', 'acc ← blend(acc, V_레이어, w_레이어(t, 음고))  레이어 1 … n'],
  ),
  'field.layer.mode': H(
    ['Blend mode', 'How this layer combines with the layers below it, inside its range.', 'Add stacks its own field (× amount). Multiply scales everything below (−1 silences, +1 doubles). Replace swaps in its own field, crossfading at the edge.', 'add: acc + w·a·V   multiply: acc·(1 + w·a)   replace: (1 − w)·acc + w·V'],
    ['블렌드 모드', '범위 안에서 이 레이어가 아래 레이어들과 합쳐지는 방식.', '더하기는 자체 장을 (× 양) 더합니다. 곱하기는 아래 전체를 배율 조절합니다 (−1 없앰, +1 두 배). 대체는 자체 장으로 바꾸며 경계에서 크로스페이드합니다.', 'add: acc + w·a·V   multiply: acc·(1 + w·a)   replace: (1 − w)·acc + w·V'],
  ),
  'field.layer.amount': H(
    ['Amount', 'Strength of Add or Multiply, from −1 to 1 (drag or type).', 'Add: negative values reverse the layer’s field. Multiply: −1 removes the field below, 0 leaves it, +1 doubles it.'],
    ['양', '더하기·곱하기의 세기, −1 ~ 1 (드래그 또는 입력).', '더하기: 음수면 레이어의 장이 반대로 작용합니다. 곱하기: −1은 아래 장을 없애고, 0은 그대로, +1은 두 배입니다.'],
  ),
  'field.layer.order': H(
    ['Layer order', 'Move the layer up or down the stack.', 'Layers apply bottom → top, so order matters: a Replace or Multiply layer only affects the layers below it.'],
    ['레이어 순서', '레이어를 스택에서 위·아래로 옮깁니다.', '레이어는 아래 → 위로 적용되므로 순서가 중요합니다. 대체·곱하기 레이어는 자기 아래 레이어에만 영향을 줍니다.'],
  ),
  'field.layer.range': H(
    ['Layer range', 'Where this layer acts: the full pitch / time plane, or a box from Start to End and Low to High pitch.', 'Turn off Full range to set a box (it starts from the visible area). Drag the box on the canvas, or drag its □ corners.'],
    ['레이어 범위', '이 레이어가 작용하는 곳: 음고·시간 전체, 또는 시작~끝 · 낮은 음~높은 음 상자.', '전체 범위를 끄면 상자를 설정합니다 (보이는 영역에서 시작). 캔버스에서 상자나 □ 모서리를 드래그해도 됩니다.'],
  ),
  'field.layer.edge': H(
    ['Inside / outside and edge', 'Shape (rectangle / ellipse), Invert (act outside instead of inside) and how the edge joins the outside.', 'Hard cuts at the boundary. Soft fades the weight from 1 to 0 over the feather width outside the shape, so trajectories do not kink.', 'w = 1 − smoothstep(0, feather, sdf);  invert → 1 − w'],
    ['안·밖과 경계', '도형(사각형·타원), 반전(안 대신 밖에서 작용), 경계를 바깥과 잇는 방식.', '딱딱하게는 경계에서 바로 끊습니다. 부드럽게는 도형 바깥 페더 폭에 걸쳐 가중치를 1에서 0으로 줄여 궤적이 꺾이지 않게 합니다.', 'w = 1 − smoothstep(0, feather, sdf);  반전 → 1 − w'],
  ),
  'field.layer.invert': H(
    ['Invert range', 'Apply the layer everywhere except inside its range.', 'The weight becomes 1 − w.', 'w′ = 1 − w'],
    ['범위 반전', '범위 안을 제외한 모든 곳에 레이어를 적용합니다.', '가중치가 1 − w가 됩니다.', 'w′ = 1 − w'],
  ),
  'field.arrowStyle': H(
    ['Arrow style', 'Density (grid spacing in px: smaller = more arrows), size and line width of the field arrows.', 'Arrows cover the whole visible plot and show F as felt by the active particle. Display only: the bake does not change.'],
    ['화살표 스타일', '벡터장 화살표의 밀도(격자 간격 px, 작을수록 촘촘), 크기, 선 굵기.', '화살표는 보이는 영역 전체에 그려지며 활성 입자가 받는 F를 보여 줍니다. 표시만 바뀌고 베이킹은 그대로입니다.'],
  ),
  'field.fieldToggle': H(
    ['Vector field ON / OFF', 'OFF bypasses the whole field (guide pull, nodes, turbulence, wells, regions, coupling): every particle follows the guiding curve exactly, so you edit the pure glissando shape.', 'Particle F₀/F₁, start and duration still apply. Field settings are kept and come back when you turn it ON. Playback, WAV and Bake to Glissando use what you see.', 'y(t) = g(t)'],
    ['벡터장 ON / OFF', 'OFF이면 벡터장 전체(가이드 당김, 노드, 난류, 우물, 영역, 결합)를 건너뛰고 모든 입자가 가이드 곡선을 그대로 따라갑니다. 순수 글리산도 모양만 에딧할 수 있습니다.', '입자의 F₀/F₁, 시작, 길이는 그대로 적용됩니다. 벡터장 설정은 보존되어 다시 ON하면 돌아옵니다. 재생·WAV·글리산도 베이킹은 화면에 보이는 대로 나옵니다.', 'y(t) = g(t)'],
  ),
  'field.arrows': H(
    ['Field arrows', 'Show or hide the purple arrows of F(t, y) for the active particle.', 'Arrows reflect every component, including Local Regions.'],
    ['벡터장 화살표', '활성 입자의 F(t, y) 보라색 화살표를 표시하거나 숨깁니다.', '국소 영역을 포함한 모든 성분이 반영됩니다.'],
  ),
  'field.view': H(
    ['Piano roll / 0–1 Norm', 'Vertical axis as pitch (piano roll) or as the normalized value y between F₀ and F₁.', 'Norm view uses the same 0–1 coordinates as force nodes and Local Regions. Display only: the bake does not change.'],
    ['피아노롤 / 0–1 정규화', '세로축을 음고(피아노롤) 또는 F₀–F₁ 사이의 정규화 값 y로 표시합니다.', '정규화 보기는 힘 노드·국소 영역과 같은 0–1 좌표를 씁니다. 표시만 바뀌고 베이킹은 그대로입니다.'],
  ),
  'field.zoom': H(
    ['Zoom / Fit All', 'Pitch − / + and time − / + zoom the canvas; Fit All frames every particle (F).', 'Wheel zooms time, Shift+wheel zooms pitch, dragging empty space pans. Display only.'],
    ['줌 / 전체 맞춤', '음고 − / +, 시간 − / +로 캔버스를 확대·축소하고, 전체 맞춤은 모든 입자가 보이게 맞춥니다 (F).', '휠은 시간 줌, Shift+휠은 음고 줌, 빈 곳 드래그는 화면 이동입니다. 표시만 바뀝니다.'],
  ),
  'field.clearNodes': H(
    ['Clear force nodes', 'Delete every force node (attractor, repeller, vortex).', 'Undoable (Ctrl/⌘+Z). Particles and Local Regions stay.'],
    ['힘 노드 모두 삭제', '인력·척력·소용돌이 노드를 전부 지웁니다.', '실행 취소(Ctrl/⌘+Z)할 수 있습니다. 입자와 국소 영역은 그대로입니다.'],
  ),
  'field.clearRegions': H(
    ['Clear Local Regions', 'Delete every Local Region; the field applies uniformly again.', 'Undoable (Ctrl/⌘+Z). Force nodes stay.'],
    ['국소 영역 모두 삭제', '국소 영역을 전부 지워 장이 다시 화면 전체에 똑같이 적용됩니다.', '실행 취소(Ctrl/⌘+Z)할 수 있습니다. 힘 노드는 그대로입니다.'],
  ),
  'field.particleCard': H(
    ['Particle card', 'Click to make this particle active. S = solo, M = mute.', 'The racks on the right edit the active particle; the canvas draws its field arrows.'],
    ['입자 카드', '누르면 이 입자가 활성 입자가 됩니다. S = 솔로, M = 뮤트.', '오른쪽 랙은 활성 입자를 편집하고, 캔버스는 그 입자의 장 화살표를 그립니다.'],
  ),
  'field.particleEdit': H(
    ['Add / Duplicate / Delete particle', 'Each particle is one voice flying through the field.', 'Duplicate starts the copy where the original ends. At least one particle remains.'],
    ['입자 추가 / 복제 / 삭제', '입자 하나가 장 위를 날아가는 보이스 하나입니다.', '복제는 원본이 끝나는 지점에서 시작합니다. 최소 1개는 남습니다.'],
  ),
  'field.exportJson': H(
    ['Export baked JSON', 'Save the baked trajectories (t, y, speed, curvature) as a JSON file.', ''],
    ['베이킹 JSON 내보내기', '베이킹된 궤적(t, y, 속력, 곡률)을 JSON 파일로 저장합니다.', ''],
  ),

  // ---------------- Generate Voices / 보이스 생성
  'gen.glissando.panel': H(
    ['Generate Voices', 'Create several voices at once from a preset rule.', 'Pick a preset and its parameters, then press Replace or Append. The generated voices are ordinary voices: edit their Curve Engines, gain envelopes and regions afterwards. The settings are saved with the project.'],
    ['보이스 생성', '프리셋 규칙으로 여러 보이스를 한 번에 만듭니다.', '프리셋과 파라미터를 고른 뒤 교체 또는 추가를 누르세요. 만들어진 보이스는 일반 보이스와 같아서 이후에 곡선 엔진·게인 엔벨로프·구간을 자유롭게 고칠 수 있습니다. 설정은 프로젝트에 함께 저장됩니다.'],
  ),
  'gen.glissando.preset': H(
    ['Preset', 'The rule that lays out start pitch, target pitch and entry time of each voice.', 'Converging Cluster: spread start pitches all glide to one target, entering together. Staggered Canon: the same contour transposed, entering one after another. Mirror Pairs: every voice gets a partner reflected around the centre pitch.', 'cluster: f₀ᵢ = C + offsetᵢ, f₁ = T\ncanon: f₀ᵢ = C + trᵢ, f₁ᵢ = T + trᵢ, startᵢ = i·stagger\nmirror: f₁′ = 2C − T − tr'],
    ['프리셋', '각 보이스의 시작음·목표음·진입 시각을 배치하는 규칙.', '수렴 클러스터: 퍼진 시작음들이 한 목표로 동시에 모입니다. 엇박 카논: 같은 윤곽을 이조해 차례로 진입합니다. 거울 쌍: 모든 보이스에 중심음 기준으로 반사된 짝이 생깁니다.', 'cluster: f₀ᵢ = C + offsetᵢ, f₁ = T\ncanon: f₀ᵢ = C + trᵢ, f₁ᵢ = T + trᵢ, startᵢ = i·stagger\nmirror: f₁′ = 2C − T − tr'],
  ),
  'gen.glissando.voiceCount': H(
    ['Voice count', 'How many voices to generate (1–16).', 'In Mirror Pairs the voices are made in original/mirror pairs, so an odd count leaves one unpaired.'],
    ['보이스 수', '생성할 보이스 개수 (1–16).', '거울 쌍에서는 원본·반사 쌍으로 만들어지므로 홀수이면 하나는 짝이 없습니다.'],
  ),
  'gen.glissando.centerNote': H(
    ['Centre note', 'The pitch the start notes are arranged around.', 'Type a note name such as C4, F#3 or Bb2. In Mirror Pairs it is also the axis of reflection.'],
    ['중심음', '시작음들이 배치되는 기준 음고.', 'C4, F#3, Bb2 같은 음이름을 입력합니다. 거울 쌍에서는 반사의 축이기도 합니다.'],
  ),
  'gen.glissando.targetNote': H(
    ['Target note', 'The pitch the voices glide toward (F₁).', 'In Converging Cluster every voice lands on this note. In Canon and Mirror it sets the interval of the contour (target − centre).'],
    ['목표음', '보이스들이 향하는 음고 (F₁).', '수렴 클러스터에서는 모든 보이스가 이 음에 도착합니다. 카논·거울에서는 윤곽의 음정(목표 − 중심)을 정합니다.'],
  ),
  'gen.glissando.spread': H(
    ['Spread (semitones)', 'Total pitch range the voices are spread over.', 'Cluster: start pitches span ±spread/2 around the centre. Canon: the last voice is transposed up by spread. Mirror: the pairs are spread by up to spread/2.', 'offsetᵢ = −spread/2 + spread·i/(N−1)'],
    ['퍼짐 (반음)', '보이스들이 퍼지는 전체 음고 폭.', '클러스터: 시작음이 중심 ±spread/2에 걸칩니다. 카논: 마지막 보이스가 spread만큼 위로 이조됩니다. 거울: 쌍이 최대 spread/2까지 벌어집니다.', 'offsetᵢ = −spread/2 + spread·i/(N−1)'],
  ),
  'gen.glissando.stagger': H(
    ['Stagger (s)', 'Time between successive voice entries.', 'Used by Canon and Mirror Pairs (per pair). Converging Cluster ignores it: all voices start at 0.'],
    ['엇박 간격 (초)', '연속한 보이스 진입 사이의 시간.', '카논과 거울 쌍(쌍 단위)에서 쓰입니다. 수렴 클러스터는 모두 0초에 시작하므로 무시합니다.'],
  ),
  'gen.glissando.duration': H(
    ['Duration (s)', 'Length of every generated voice.', ''],
    ['길이 (초)', '생성되는 모든 보이스의 길이.', ''],
  ),
  'gen.glissando.engine': H(
    ['Curve engine', 'The curve engine given to every generated voice.', 'Morph and Custom are not offered here; switch a voice to them afterwards in the Curve Engine panel.'],
    ['곡선 엔진', '생성되는 모든 보이스에 적용할 곡선 엔진.', '모핑과 커스텀은 여기서 고를 수 없습니다. 생성 후 곡선 엔진 패널에서 바꾸세요.'],
  ),
  'gen.glissando.replace': H(
    ['Replace', 'Delete the current voices and generate new ones.', 'Undo (⌘/Ctrl+Z) brings the previous voices back.'],
    ['교체', '현재 보이스를 모두 지우고 새로 생성합니다.', '실행 취소(⌘/Ctrl+Z)로 이전 보이스를 되돌릴 수 있습니다.'],
  ),
  'gen.glissando.append': H(
    ['Append', 'Keep the current voices and add the generated ones after them.', 'Voice numbering and colours continue from the existing voices.'],
    ['추가', '현재 보이스를 유지하고 생성된 보이스를 뒤에 더합니다.', '보이스 번호와 색상은 기존 보이스에 이어서 붙습니다.'],
  ),

  // ---------------- Tremolo / 트레몰로
  'trem.toggle': H(
    ['Tremolo on / off', 'Periodic amplitude modulation of the voice (Group Apply honoured).', 'The modulation only ever lowers the level (g ≤ 1), so it cannot clip. It is applied to the voice before the master-bus compensation, and joins with legato neighbours stay phase-continuous.', 'g = 1 − d · (1 − m(φ)),   m = (w(φ) + 1) / 2'],
    ['트레몰로 켜기 / 끄기', '보이스의 진폭을 주기적으로 흔듭니다 (그룹 적용 지원).', '변조는 음량을 낮추기만 하므로(g ≤ 1) 클리핑이 없습니다. 마스터 버스 보정 앞에서 보이스에 적용되고, 레가토로 이어진 이웃과도 위상이 끊기지 않습니다.', 'g = 1 − d · (1 − m(φ)),   m = (w(φ) + 1) / 2'],
  ),
  'trem.shape': H(
    ['LFO shape', 'The waveform of the modulation.', 'Sine and Triangle are smooth; Square and Saw have edges you can soften; Random is a smooth sample-and-hold (one new value per cycle, repeatable by seed); ƒ(x) uses your own formula of the cycle position x (the result is rescaled to fill the full depth).'],
    ['LFO 파형', '변조 파형.', '사인·삼각은 부드럽고, 사각·톱니는 모서리 부드러움을 조절할 수 있습니다. 랜덤은 주기마다 새 값을 잡는 부드러운 샘플&홀드(시드로 재현), ƒ(x)는 한 주기 위치 x의 수식을 직접 씁니다(전체 깊이를 채우도록 자동 정규화).'],
  ),
  'trem.rate': H(
    ['Rate (Hz)', 'Modulation cycles per second at the start of the voice.', 'Roughly 3–8 Hz sounds like a classic tremolo; above ~20 Hz it turns into a rough, buzzing timbre.', 'φ(t) = φ₀ + ∫ rate dt'],
    ['속도 (Hz)', '보이스 시작에서의 초당 변조 횟수.', '약 3–8 Hz는 전형적인 트레몰로, 20 Hz를 넘으면 거칠게 윙윙거리는 음색이 됩니다.', 'φ(t) = φ₀ + ∫ rate dt'],
  ),
  'trem.rateUnit': H(
    ['Rate unit', 'Hz, or locked to a tempo (beat sync).', 'Beat sync: the rate is cycles per beat and the real speed follows the BPM, so the tremolo stays on the beat grid (the BPM is that of the document\'s own time; Manager tempo scales it along with everything else). Switch to Hz for a free rate.', 'Hz = (cycles / beat) × BPM / 60'],
    ['속도 단위', 'Hz, 또는 템포에 고정(박 동기).', '박 동기에서는 속도가 “박당 주기”이고 실제 속도가 BPM을 따라가므로 트레몰로가 박 격자에 맞습니다 (BPM은 문서 자체 시간 기준이며, Manager 템포는 다른 모든 시간과 함께 이를 스케일합니다). 자유로운 속도가 필요하면 Hz로 바꾸세요.', 'Hz = (박당 주기) × BPM / 60'],
  ),
  'trem.bpm': H(
    ['BPM', 'Tempo the beat-synced tremolo follows.', 'Beats per minute of the document\'s own time. 120 BPM = 2 beats per second, so a quarter-note tremolo (1 cycle / beat) runs at 2 Hz and a sixteenth (4 cycles / beat) at 8 Hz. Risset has no document time, so there it is a real BPM.'],
    ['BPM', '박 동기 트레몰로가 따르는 템포.', '문서 자체 시간 기준의 분당 박 수입니다. 120 BPM = 초당 2박이라 4분음표 트레몰로(박당 1주기)는 2 Hz, 16분음표(박당 4주기)는 8 Hz입니다. Risset에는 문서 시간이 없어서 실제 BPM으로 동작합니다.'],
  ),
  'trem.division': H(
    ['Note division', 'Common rhythmic values (cycles per beat).', 'Half 0.5 · Quarter 1 · Eighth 2 · Eighth triplet 3 · Sixteenth 4 · Sixteenth triplet 6 · 32nd 8 cycles per beat. Picking one sets the start and end rate; edit the rate directly for any other value (shown as Custom).'],
    ['음표 단위', '흔한 리듬 값 (박당 주기).', '2분 0.5 · 4분 1 · 8분 2 · 8분 셋잇단 3 · 16분 4 · 16분 셋잇단 6 · 32분 8주기/박. 고르면 시작·끝 속도가 함께 정해지고, 다른 값은 속도를 직접 입력하세요(직접 지정으로 표시).'],
  ),
  'trem.rateEnd': H(
    ['End rate (Hz)', 'Rate at the end of the voice: different from the start gives an accelerando or ritardando.', 'The rate moves from Rate to End rate with the chosen sweep easing; the phase is integrated, so the modulation never jumps.'],
    ['끝 속도 (Hz)', '보이스 끝에서의 속도: 시작과 다르면 점점 빨라지거나(아첼) 느려집니다(리타).', '속도는 선택한 스윕 이징으로 시작 속도에서 끝 속도로 움직입니다. 위상을 적분하므로 변조가 튀지 않습니다.'],
  ),
  'trem.rateEngine': H(
    ['Sweep easing', 'The shape of the change from Rate to End rate.', 'Linear, S-curve, Exponential or Plateau, reusing the curve engines. Has no effect when both rates are equal.'],
    ['스윕 이징', '시작 속도에서 끝 속도로 변하는 모양.', '직선, S자, 지수, 정체 선반 중 선택(곡선 엔진 재사용). 두 속도가 같으면 영향이 없습니다.'],
  ),
  'trem.depth': H(
    ['Depth', 'How far the level dips below the full level.', 'Amp: g ∈ [1 − depth, 1] (depth 1 dips to silence). dB: the level dips by up to the given number of dB, so equal steps sound even.', 'amp: g = 1 − d(1 − m)   ·   dB: g = 10^(−D(1 − m)/20)'],
    ['깊이', '음량이 최대에서 얼마나 내려가는지.', '진폭: g ∈ [1 − 깊이, 1] (깊이 1은 무음까지). dB: 최대 지정한 dB만큼 내려가며, 같은 간격이 고르게 들립니다.', 'amp: g = 1 − d(1 − m)   ·   dB: g = 10^(−D(1 − m)/20)'],
  ),
  'trem.fadeIn': H(
    ['Fade-in (s)', 'The depth grows from 0 to full over this time.', 'Lets a voice start steady and let the tremolo emerge gradually. 0 = full depth from the start.'],
    ['페이드인 (초)', '깊이가 이 시간 동안 0에서 최대로 커집니다.', '보이스가 안정적으로 시작한 뒤 트레몰로가 서서히 나타나게 합니다. 0이면 처음부터 최대 깊이입니다.'],
  ),
  'trem.phase': H(
    ['Start phase', 'Where in the LFO cycle the modulation starts (0–1).', 'With the sine shape 0.25 starts at full level, 0.75 starts at the lowest level.'],
    ['시작 위상', '변조가 LFO 주기의 어느 지점에서 시작하는지 (0–1).', '사인 파형에서 0.25는 최대 음량, 0.75는 최저 음량에서 시작합니다.'],
  ),
  'trem.sync': H(
    ['Phase sync', 'Restart the cycle at each voice, or follow the global timeline.', 'Restart per voice: every voice starts at its own start phase. Global timeline: the phase is rate × time on the timeline, so voices that overlap pulse together.'],
    ['위상 동기', '보이스마다 주기를 다시 시작할지, 전체 타임라인을 따를지.', '보이스마다 재시작: 모든 보이스가 각자의 시작 위상에서 출발합니다. 전체 타임라인: 위상이 타임라인 시간 × 속도라서 겹치는 보이스들이 함께 맥동합니다.'],
  ),
  'trem.smooth': H(
    ['Edge softness', 'Rounds the corners of the square and saw shapes.', '0 = hard edges (can click at high depth), 1 = very soft.'],
    ['모서리 부드러움', '사각·톱니 파형의 모서리를 둥글게 합니다.', '0 = 날카로운 모서리(깊이가 크면 클릭이 날 수 있음), 1 = 매우 부드러움.'],
  ),
  'trem.seed': H(
    ['Random seed', 'Picks the repeatable random sequence of the Random shape.', 'The same seed always gives the same pattern, in live playback and in WAV export.'],
    ['랜덤 시드', '랜덤 파형의 재현 가능한 난수열을 고릅니다.', '같은 시드는 실시간 재생과 WAV 내보내기에서 항상 같은 패턴을 냅니다.'],
  ),
  'trem.formula': H(
    ['ƒ(x) formula', 'Your own LFO shape as a function of the cycle position x ∈ [0, 1).', 'The same formula language as the timbre ƒ(x), e.g. sin(2*pi*x), saw(x), pulse(x, 0.2), exp(-4*x). The result is rescaled to span the full depth; an invalid formula falls back to a sine.'],
    ['ƒ(x) 수식', '한 주기 위치 x ∈ [0, 1)의 함수로 쓰는 나만의 LFO 파형.', '음색 ƒ(x)와 같은 수식 문법입니다. 예: sin(2*pi*x), saw(x), pulse(x, 0.2), exp(-4*x). 결과는 전체 깊이를 채우도록 정규화되며, 잘못된 수식은 사인으로 대체됩니다.'],
  ),
  'trem.preview': H(
    ['Tremolo preview', 'The resulting level over the whole voice.', 'Pink: tremolo × gain envelope. Dashed green: the gain envelope alone.'],
    ['트레몰로 미리보기', '보이스 전체에 걸친 결과 음량.', '분홍색: 트레몰로 × 게인 엔벨로프. 초록 점선: 게인 엔벨로프만.'],
  ),

  // ---------------- Voice cards / 보이스 카드
  'gliss.grapher': H(
    ['Multi-Voice Grapher', 'All Glissando voices as cards; the badge shows how many there are.', 'Pick the active voice here, add / duplicate / delete voices, open the Unified Matrix and set legato joins.'],
    ['다중 보이스 그래퍼', '모든 글리산도 보이스를 카드로 보여 줍니다. 배지는 보이스 수입니다.', '여기서 활성 보이스를 고르고, 보이스를 추가·복제·삭제하며, 통합 매트릭스와 레가토 연결을 설정합니다.'],
  ),
  'gliss.voiceCard': H(
    ['Voice card', 'Click to make this voice active; the editors below then edit it.', 'Ctrl/⌘+click adds or removes it from the selection, Shift+click selects a range (used by Group Apply). Double-click renames it. The small number is its curve engine; a struck-through name means it is silent (muted, or another voice is soloed).'],
    ['보이스 카드', '누르면 이 보이스가 활성 보이스가 되고, 아래 편집기들이 이 보이스를 편집합니다.', 'Ctrl/⌘+클릭은 선택에 더하거나 빼고, Shift+클릭은 범위를 선택합니다(그룹 적용에 사용). 더블클릭하면 이름을 바꿉니다. 작은 숫자는 곡선 엔진 번호이고, 이름에 줄이 그어져 있으면 소리가 나지 않는 상태(뮤트, 또는 다른 보이스가 솔로)입니다.'],
  ),
  'gliss.voiceReorder': H(
    ['Reorder handle', 'Drag a card onto another card to change the voice order.', 'Order affects the card strip, the matrix and legato joins between neighbouring voices.'],
    ['순서 변경 손잡이', '카드를 다른 카드 위로 드래그해 보이스 순서를 바꿉니다.', '순서는 카드 목록, 매트릭스, 이웃 보이스 사이의 레가토 연결에 영향을 줍니다.'],
  ),
  'gliss.soloMute': H(
    ['Solo / Mute', 'S plays only the soloed voices; M silences this voice.', 'When any voice is soloed, every non-soloed voice is silent. Both also apply to WAV export.'],
    ['솔로 / 뮤트', 'S는 솔로된 보이스만 재생하고, M은 이 보이스를 끕니다.', '솔로된 보이스가 하나라도 있으면 솔로가 아닌 보이스는 모두 소리가 나지 않습니다. WAV 내보내기에도 똑같이 적용됩니다.'],
  ),

  // ---------------- Version gallery items / 버전 갤러리 항목
  'ver.item': H(
    ['Version', 'One backup of the Glissando voices, taken together with a screenshot.', '#number, the time it was taken, and “clean” when the screenshot used the Axes + lines mode. The thumbnail is the screenshot image.'],
    ['버전', '스크린샷과 함께 저장된 글리산도 보이스 백업 하나.', '번호, 저장 시각, 그리고 “축 + 선” 모드로 찍었다면 “clean” 표시가 붙습니다. 썸네일은 스크린샷 이미지입니다.'],
  ),
  'ver.restore': H(
    ['Restore', 'Replace the current Glissando voices with this version.', 'Restoring is undoable (Ctrl/⌘+Z). Other studios and output settings are not touched.'],
    ['복원', '현재 글리산도 보이스를 이 버전으로 바꿉니다.', '복원은 실행 취소(Ctrl/⌘+Z)할 수 있습니다. 다른 스튜디오와 출력 설정은 바뀌지 않습니다.'],
  ),
  'ver.ghost': H(
    ['Ghost', 'Overlay this version faintly on the main canvas for comparison.', 'Several ghosts can be on at once. Ghosts are only drawn, never played.'],
    ['고스트', '이 버전을 메인 캔버스에 흐리게 겹쳐 비교합니다.', '여러 개를 동시에 켤 수 있습니다. 고스트는 그려지기만 하고 소리는 나지 않습니다.'],
  ),
  'ver.delete': H(
    ['Delete version', 'Remove this version from the gallery.', 'This cannot be undone.'],
    ['버전 삭제', '이 버전을 갤러리에서 지웁니다.', '실행 취소할 수 없습니다.'],
  ),
  'ver.clearAll': H(
    ['Clear all versions', 'Remove every version from the gallery.', 'This cannot be undone. The current voices are not affected.'],
    ['버전 모두 지우기', '갤러리의 모든 버전을 지웁니다.', '실행 취소할 수 없습니다. 현재 보이스에는 영향이 없습니다.'],
  ),
  'ver.shotMode': H(
    ['Screenshot mode', 'What the Screenshot button captures.', 'Full: the graph exactly as shown on screen. Axes + lines: only the axes and the curves on a white background, ready for papers or scores.'],
    ['스크린샷 모드', '스크린샷 버튼이 무엇을 찍을지 고릅니다.', '화면 그대로: 보이는 그래프 그대로. 축 + 선: 흰 배경에 축과 곡선만 남겨 논문·악보에 바로 쓸 수 있게 합니다.'],
  ),
  'ver.svg': H(
    ['SVG output', 'In Axes + lines mode, save a vector SVG instead of a PNG.', 'SVG scales without blur and can be edited in vector editors.'],
    ['SVG 저장', '축 + 선 모드에서 PNG 대신 벡터 SVG로 저장합니다.', 'SVG는 확대해도 흐려지지 않고 벡터 편집기에서 수정할 수 있습니다.'],
  ),

  // ---------------- Versions / 버전
  'gliss.versions': H(
    ['Version gallery', 'Backups made with every Screenshot: ghost-overlay them on the canvas or restore them.', 'The thumbnail is the screenshot itself. A Version is not a preset: it only backs up the Glissando voices.'],
    ['버전 갤러리', '스크린샷마다 만들어지는 백업: 캔버스에 고스트로 겹치거나 복원합니다.', '썸네일은 스크린샷 이미지 그대로입니다. 버전은 프리셋이 아니라 글리산도 보이스만 백업합니다.'],
  ),
};

/** Static controls documented by id. / id로 연결되는 정적 컨트롤 */
export const HELP_EXTRA_BY_ID = {
  btnStudioGlissando: 'app.studio.glissando', btnStudioRisset: 'app.studio.risset', btnStudioField: 'app.studio.field',
  btnStudioDraw: 'app.studio.draw', btnStudioCloud: 'app.studio.cloud', btnStudioSpace: 'app.studio.space', btnStudioTempo: 'app.studio.tempo',
  btnStudioChaos: 'app.studio.chaos', btnStudioFractal: 'app.studio.fractal', btnStudioWave: 'app.studio.wave',
  btnPlay: 'app.play', btnLoop: 'app.loop', btnStop: 'app.stop', btnCueReset: 'app.cue',
  btnUndo: 'app.undo', btnRedo: 'app.undo', btnScreenshot: 'app.screenshot',
  btnNewProject: 'app.newProject', btnSaveProject: 'app.saveLoad', btnLoadProject: 'app.saveLoad', btnExportWav: 'app.exportWav',
  btnLangToggle: 'app.lang', btnLayoutToggle: 'app.layout',
  btnZoomOut: 'app.uiZoom', btnZoomIn: 'app.uiZoom', inputUiZoom: 'app.uiZoom',
  btnManager: 'app.manager', btnHelpMode: 'app.helpMode',
  btnAddVoice: 'gliss.voiceEdit', btnDupVoice: 'gliss.voiceEdit', btnDelVoice: 'gliss.voiceEdit',
  btnToggleMatrix: 'gliss.matrix',
  btnViewPiano: 'gliss.view', btnViewNorm: 'gliss.view', selectGridSub: 'gliss.grid',
  btnLocateMode: 'gliss.locate', btnLocateSnap: 'gliss.snap', btnScrubAudio: 'gliss.scrub', btnShowDeriv: 'gliss.deriv',
  btnPitchZoomOut: 'gliss.zoom', btnPitchZoomIn: 'gliss.zoom', btnTimeZoomOut: 'gliss.zoom', btnTimeZoomIn: 'gliss.zoom',
  btnCornerZoomOut: 'gliss.zoom', btnCornerZoomIn: 'gliss.zoom', btnFitAll: 'gliss.zoom',
  mainCanvas: 'gliss.canvas',
  btnGainModePoints: 'gliss.gainMode', btnGainModeEngine: 'gliss.gainMode',
  btnGainReset: 'gliss.gainPresets', btnGainCresc: 'gliss.gainPresets', btnGainDecresc: 'gliss.gainPresets', btnGainSwell: 'gliss.gainPresets',
  gainCanvas: 'gliss.gainCanvas',
  btnTargetCurve: 'gliss.target', btnTargetAmp: 'gliss.target',
  btnReverse: 'gliss.reverse', btnInverse: 'gliss.reverse',
  inputAmpMin: 'gliss.ampRange', inputAmpMax: 'gliss.ampRange', btnAmpAutoFit: 'gliss.ampRange',
  btnGroupApply: 'gliss.groupApply', btnScaleLog: 'gliss.scale', btnScaleLin: 'gliss.scale',
  btnAudioPos: 'gliss.audioTarget', btnAudioVel: 'gliss.audioTarget',
  inputF0Note: 'gliss.f0', sliderF0Midi: 'gliss.f0', inputF0Hz: 'gliss.f0', inputF0Fine: 'gliss.f0',
  inputF1Note: 'gliss.f1', sliderF1Midi: 'gliss.f1', inputF1Hz: 'gliss.f1', inputF1Fine: 'gliss.f1',
  inputStart: 'gliss.timing', sliderStart: 'gliss.timing', inputDuration: 'gliss.timing', sliderDuration: 'gliss.timing', btnToggleDurMode: 'gliss.timing',
  inputBaseGain: 'gliss.baseGain', sliderBaseGain: 'gliss.baseGain',
  btnTimbreMix: 'gliss.timbreMode', btnTimbreFunc: 'gliss.timbreMode', btnTimbreSample: 'gliss.timbreSample',
  sliderTimbreSine: 'gliss.timbreMix', sliderTimbreTri: 'gliss.timbreMix', sliderTimbreSaw: 'gliss.timbreMix', sliderTimbreSqr: 'gliss.timbreMix', sliderTimbreRich: 'gliss.timbreMix',
  selectTimbreSource: 'gliss.timbreFunc', selectTimbreVoice: 'gliss.timbreFunc', inputTimbreExpr: 'gliss.timbreFunc', timbreFuncCanvas: 'gliss.timbreFunc',
  btnClearVersions: 'ver.clearAll',
  btnShotFull: 'ver.shotMode',
  btnShotClean: 'ver.shotMode',
  btnShotSvg: 'ver.svg',
  unifiedMatrixPanel: 'gliss.matrix',
};
