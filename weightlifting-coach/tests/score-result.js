/* Scores result files (docs/result-format.md) against the truth, with the web app's own analysis code.
     node --import ./tests/dom-stub.js tests/score-result.js [samples/x.engine.json ...]
   With no arguments: every samples/*.engine*.json. */
import { readdirSync, readFileSync } from 'node:fs';
import { S } from '../js/state.js';
import { score } from './score.js';

export function scoreResult(file) {
  const res = JSON.parse(readFileSync(file, 'utf8')), name = file.split('/').pop().split('.')[0];
  const truth = JSON.parse(readFileSync(`samples/${name}.truth.json`, 'utf8'));
  // the same as loadResult() in js/app.js
  Object.assign(S, { src: { fps: res.video.fps }, radius: res.plate.radiusPx, lift: res.lift, facing: res.facing, points: [], times: [], smooth: true });
  res.points.forEach((p, j) => { if (p) S.points[res.first + j] = { x: p[0], y: p[1], score: 1, ...(p[2] ? { low: true } : {}) }; });
  res.times.forEach((t, j) => { if (t != null) S.times[res.first + j] = t; });
  const s = score(truth);
  return { file: file.split('/').pop(), seconds: res.producer.seconds, radiusErrPct: +((res.plate.radiusPx / truth.plateRadiusPx - 1) * 100).toFixed(2), ratio: res.plate.axisRatio, ...s };
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('samples').filter(f => /\.engine(-owl)?\.json$/.test(f)).sort().map(f => `samples/${f}`);
for (const f of files) {
  const r = scoreResult(f), s = r.smoothed;
  console.log(`${r.file.padEnd(28)} ${String(r.seconds).padStart(6)} s  radius ${r.radiusErrPct} %  ratio ${r.ratio}  tracked ${r.tracked}/${r.frames} low ${r.lowConfidence}  ` +
    `pos ${s.rmsePosCm}/${s.maxPosCm} cm  h ${s.pullHeightErrCm}  drop ${s.dropErrCm}  v ${s.peakVelErrPct} %  vRMSE ${s.rmseVelPull}  frames lo/pk/ct ${s.liftoffFrameErr}/${s.peakFrameErr}/${s.catchFrameErr}`);
}
