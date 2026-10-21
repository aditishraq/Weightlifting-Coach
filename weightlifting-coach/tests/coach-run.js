/* Runs the AI coach on a result file and prints the answer and the grounding check:
     node --import ./tests/dom-stub.js tests/coach-run.js samples/clip.engine.json [samples/clip.pose-rtmpose.json] [model] [url]
   Same summary, prompt and checks as the Coach tab. */
import { readFileSync } from 'node:fs';
import { S } from '../js/state.js';
import { CONFIG } from '../js/config.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from '../js/path.js';
import { TRIPLE, finishPose, jointAng, jp, lean } from '../js/pose.js';
import { evaluate } from '../js/checks.js';
import { buildMessages, chat, checkAnswer, notesFor, parseAnswer, referenceFor, schemaFor, summarise } from '../js/coach.js';
import { compare, measures } from '../js/reference.js';

const [file, poseFile, model = 'qwen3:14b', url = 'http://127.0.0.1:11434/v1'] = process.argv.slice(2);
const res = JSON.parse(readFileSync(file, 'utf8'));
Object.assign(S, { src: { fps: res.video.fps }, radius: res.plate.radiusPx, lift: res.lift, facing: res.facing, smooth: true, kg: res.weightKg,
  axisRatio: res.plate.axisRatio, points: [], times: [], pose: [], poseS: [] });
res.points.forEach((p, j) => { if (p) S.points[res.first + j] = { x: p[0], y: p[1], score: 1, ...(p[2] ? { low: true } : {}) }; });
res.times.forEach((t, j) => { if (t != null) S.times[res.first + j] = t; });
const frames = res.pose ? res.pose.frames : poseFile ? JSON.parse(readFileSync(poseFile, 'utf8')).frames.map(L => L && L.flat()) : [];
frames.forEach((f, j) => { if (f) { const L = []; for (let k = 0; k < 33; k++) L.push({ x: f[k * 4], y: f[k * 4 + 1], z: f[k * 4 + 2], v: f[k * 4 + 3] }); S.pose[j] = L; } });
if (S.pose.some(Boolean)) finishPose();
S.tech = evaluate();

const seen = (i, names) => names.every(n => { const p = jp(i, n); return p && p.v >= CONFIG.checks.minVis; });
const angles = i => {
  if (!S.poseS[i]) return null;
  const o = {}; for (const j of ['hip', 'knee', 'elbow']) if (seen(i, TRIPLE[j])) o[j] = jointAng(i, j);
  if (seen(i, ['shoulder', 'hip'])) o.backFromVertical = lean(i);
  return Object.keys(o).length ? o : null;
};
const pts = pathPoints(), an = analyse(pts), ph = barPhases(pts);
const summary = summarise({ lift: S.lift, weightKg: S.kg, a: an, ph, tech: S.tech, c: cmPerPx(), t: timeOf, angles,
  reference: compare(S.lift, measures(an, ph, pts, cmPerPx(), S.facing, S.axisRatio || 1)) });
const faults = S.tech.checks.filter(c => c.status === 'fault' || c.status === 'watch').map(c => c.id);
const messages = buildMessages(summary, notesFor(readFileSync('knowledge/coaching.md', 'utf8'), [...faults, 'turnover']),
  referenceFor(readFileSync('knowledge/good-lift.md', 'utf8'), S.lift));
console.log(`prompt: ${messages.map(m => m.content).join('').length} characters; findings ${S.tech.checks.map(c => `${c.id}:${c.status}`).join(' ')}`);
const t0 = Date.now(), text = await chat({ url, model }, messages, schemaFor(summary));
const ans = parseAnswer(text);
console.log(`answer in ${((Date.now() - t0) / 1000).toFixed(0)} s:\n${JSON.stringify(ans, null, 2)}`);
const issues = checkAnswer(ans, summary);
console.log(issues.length ? `GROUNDING ISSUES:\n- ${issues.join('\n- ')}` : 'grounding check: no issues');
