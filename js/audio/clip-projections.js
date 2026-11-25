/**
 * Flexatone — audio/clip-projections.js
 * Layer 3 (audio): the clip studios' projections (studios/projection.js). A clip studio's Master View lines are the
 * ones its adapter in audio/studio-clips.js already provides (`clipStudioLines`), so that is its projection:
 * Draw · Cloud · Space · Tempo · Chaos · Fractal · Wave · Grid. A studio whose adapter gives no lines is a block.
 * 계층 3 (audio): 클립 스튜디오의 투영 = studio-clips.js 어댑터의 마스터 뷰 선.
 */

import { registerProjection } from '../studios/projection.js';
import { clipStudioLines, resolveClipParams, isClipStudio } from './studio-clips.js';

const CLIP_STUDIOS = ['draw', 'cloud', 'space', 'tempo', 'chaos', 'fractal', 'wave', 'grid'];

for (const studio of CLIP_STUDIOS) {
  if (!isClipStudio(studio)) continue;
  registerProjection(studio, { paths: (doc) => clipStudioLines(studio, resolveClipParams(studio, doc)) || [] });
}
