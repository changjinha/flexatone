/**
 * Flexatone — ui/workspaces.js
 * Layer 4 (ui): registers the UI/audio tier of each studio with ui/studio-host.js.
 * 계층 4 (ui): 각 스튜디오의 UI·오디오 계층을 studio-host에 등록.
 *
 * Kept separate from studio-host so adding a studio is one import + one registerWorkspace call.
 * 스튜디오 추가 = import 1줄 + registerWorkspace 1회.
 */

import { registerWorkspace } from './studio-host.js';
import { mountFieldWorkspace } from '../studios/field/field-panels.js';
import { startFieldAudio, isFieldPlaying, toggleFieldPlay, toggleFieldPause, stopFieldAudio, exportFieldWav } from '../studios/field/field-audio.js';
import { mountRissetWorkspace } from '../studios/risset/risset-panels.js';
import { isRissetPlaying, toggleRissetAudio, stopRissetAudio, exportRissetWav } from '../studios/risset/risset-audio.js';
import { mountDrawWorkspace } from '../studios/draw/draw-panels.js';
import { startDrawAudio, isDrawPlaying, toggleDrawPlay, toggleDrawPause, stopDrawAudio, exportDrawWav } from '../studios/draw/draw-audio.js';
import { mountCloudWorkspace } from '../studios/cloud/cloud-panels.js';
import { startCloudAudio, isCloudPlaying, toggleCloudPlay, toggleCloudPause, stopCloudAudio, exportCloudWav } from '../studios/cloud/cloud-audio.js';
import { mountSpaceWorkspace } from '../studios/space/space-panels.js';
import { startSpaceAudio, isSpacePlaying, toggleSpacePlay, toggleSpacePause, stopSpaceAudio, exportSpaceWav } from '../studios/space/space-audio.js';
import { mountTempoWorkspace } from '../studios/tempo/tempo-panels.js';
import { startTempoAudio, isTempoPlaying, toggleTempoPlay, toggleTempoPause, stopTempoAudio, exportTempoWav } from '../studios/tempo/tempo-audio.js';
import { mountChaosWorkspace } from '../studios/chaos/chaos-panels.js';
import { startChaosAudio, isChaosPlaying, toggleChaosPlay, toggleChaosPause, stopChaosAudio, exportChaosWav } from '../studios/chaos/chaos-audio.js';
import { mountFractalWorkspace } from '../studios/fractal/fractal-panels.js';
import { startFractalAudio, isFractalPlaying, toggleFractalPlay, toggleFractalPause, stopFractalAudio, exportFractalWav } from '../studios/fractal/fractal-audio.js';
import { mountWaveWorkspace } from '../studios/wave/wave-panels.js';
import { startWaveAudio, isWavePlaying, toggleWavePlay, toggleWavePause, stopWaveAudio, exportWaveWav } from '../studios/wave/wave-audio.js';
import { mountGridWorkspace } from '../studios/grid/grid-panels.js';
import { startGridAudio, isGridPlaying, toggleGridPlay, toggleGridPause, stopGridAudio, exportGridWav } from '../studios/grid/grid-audio.js';

registerWorkspace('field', {
  mount: mountFieldWorkspace,
  transport: {
    isPlaying: isFieldPlaying,
    playFrom: (sec) => startFieldAudio(sec), // Locate drop: play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleFieldPlay,
    togglePause: toggleFieldPause,
    stop: stopFieldAudio,
    exportWav: () => exportFieldWav(),
  },
});

// Risset is a continuous field: Play/Space/Enter all toggle the live engine (no cue/playhead).
// 리세는 연속 음장: 재생·Space·Enter 모두 실시간 엔진 토글.
registerWorkspace('risset', {
  mount: mountRissetWorkspace,
  transport: {
    isPlaying: isRissetPlaying,
    togglePlay: toggleRissetAudio,
    togglePause: toggleRissetAudio,
    stop: stopRissetAudio,
    exportWav: () => exportRissetWav(),
  },
});

registerWorkspace('draw', {
  mount: mountDrawWorkspace,
  transport: {
    isPlaying: isDrawPlaying,
    playFrom: (sec) => startDrawAudio(sec), // Locate drop: play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleDrawPlay,
    togglePause: toggleDrawPause,
    stop: stopDrawAudio,
    exportWav: () => exportDrawWav(),
  },
});

// Cloud: stochastic glissando cloud — cue/playhead transport like Field. / 클라우드: 필드와 같은 큐·재생 헤드
registerWorkspace('cloud', {
  mount: mountCloudWorkspace,
  transport: {
    isPlaying: isCloudPlaying,
    playFrom: (sec) => startCloudAudio(sec), // play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleCloudPlay,
    togglePause: toggleCloudPause,
    stop: stopCloudAudio,
    exportWav: () => exportCloudWav(),
  },
});

// Space: Doppler / retarded-time scene — cue/playhead transport like Field. / 스페이스: 필드와 같은 큐·재생 헤드
registerWorkspace('space', {
  mount: mountSpaceWorkspace,
  transport: {
    isPlaying: isSpacePlaying,
    playFrom: (sec) => startSpaceAudio(sec), // Locate drop: play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleSpacePlay,
    togglePause: toggleSpacePause,
    stop: stopSpaceAudio,
    exportWav: () => exportSpaceWav(),
  },
});

// Tempo: tempo canons (one subject, several tempo curves) — cue/playhead transport like Field. / 템포: 필드와 같은 큐·재생 헤드
registerWorkspace('tempo', {
  mount: mountTempoWorkspace,
  transport: {
    isPlaying: isTempoPlaying,
    playFrom: (sec) => startTempoAudio(sec), // Locate drop: play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleTempoPlay,
    togglePause: toggleTempoPause,
    stop: stopTempoAudio,
    exportWav: () => exportTempoWav(),
  },
});

// Chaos: chaotic attractors sonified as glissandi — cue/playhead transport like Field. / 카오스: 필드와 같은 큐·재생 헤드
registerWorkspace('chaos', {
  mount: mountChaosWorkspace,
  transport: {
    isPlaying: isChaosPlaying,
    playFrom: (sec) => startChaosAudio(sec), // play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleChaosPlay,
    togglePause: toggleChaosPause,
    stop: stopChaosAudio,
    exportWav: () => exportChaosWav(),
  },
});

// Fractal: self-similar glissandi baked at edit time — cue/playhead transport like Field. / 프랙탈: 필드와 같은 큐·재생 헤드
registerWorkspace('fractal', {
  mount: mountFractalWorkspace,
  transport: {
    isPlaying: isFractalPlaying,
    playFrom: (sec) => startFractalAudio(sec), // play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleFractalPlay,
    togglePause: toggleFractalPause,
    stop: stopFractalAudio,
    exportWav: () => exportFractalWav(),
  },
});

// Wave: PDE field baked at edit time — cue/playhead transport like Field. / 웨이브: 필드와 같은 큐·재생 헤드
registerWorkspace('wave', {
  mount: mountWaveWorkspace,
  transport: {
    isPlaying: isWavePlaying,
    playFrom: (sec) => startWaveAudio(sec), // play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleWavePlay,
    togglePause: toggleWavePause,
    stop: stopWaveAudio,
    exportWav: () => exportWaveWav(),
  },
});

// Grid: painted raster + image effects, baked at edit time — cue/playhead transport like Field. / 그리드: 필드와 같은 큐·재생 헤드
registerWorkspace('grid', {
  mount: mountGridWorkspace,
  transport: {
    isPlaying: isGridPlaying,
    playFrom: (sec) => startGridAudio(sec), // play from sec, cue untouched / 큐 고정 재생
    togglePlay: toggleGridPlay,
    togglePause: toggleGridPause,
    stop: stopGridAudio,
    exportWav: () => exportGridWav(),
  },
});
