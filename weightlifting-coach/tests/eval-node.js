/* Fast tracker + smoother check without a browser: decodes a generated clip with ffmpeg at the tracker's
   working scale and runs the same BarTracker and path code. Frame times come from the truth file's frame
   rate (the browser run uses real presentation times). Resampling differs slightly from the browser's canvas,
   so treat eval-sample.js in the browser as the reference.
     node --import ./tests/dom-stub.js tests/eval-node.js [clip ...] */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { S } from '../js/state.js';
import { CONFIG } from '../js/config.js';
import { BarTracker } from '../js/ncc.js';
import { score } from './score.js';

export function trackClip(name) {
  const truth = JSON.parse(readFileSync(`samples/${name}.truth.json`, 'utf8')), T = CONFIG.tracking;
  const R = truth.plateRadiusPx, s = Math.min(1, Math.max(0.1, T.workScalePx / R));
  const w = Math.round(truth.W * s), h = Math.round(truth.H * s), sx = w / truth.W, sy = h / truth.H;
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', `samples/${name}.mp4`, '-vf', `scale=${w}:${h}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const full = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', `samples/${name}.mp4`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 31 });
  const frame = i => ({ g: Float32Array.from(raw.subarray(i * w * h, (i + 1) * w * h)), w, h, sx, sy });
  const W = truth.W, H = truth.H;
  const roi = (i, cx, cy, half) => {   // same crop as grabRoi in the browser
    const x0 = Math.max(0, Math.floor(cx - half)), y0 = Math.max(0, Math.floor(cy - half));
    const rw = Math.min(W, Math.ceil(cx + half) + 1) - x0, rh = Math.min(H, Math.ceil(cy + half) + 1) - y0, g = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) g[y * rw + x] = full[i * W * H + (y0 + y) * W + x0 + x];
    return { g, w: rw, h: rh, x0, y0 };
  };
  const ts = Math.min(61, Math.max(15, Math.round(T.tplRadii * R * s) | 1));
  const tk = new BarTracker({ ...T, fps: truth.fps }), a = truth.start;
  Object.assign(S, { src: { fps: truth.fps }, radius: R, lift: truth.lift, facing: truth.facing, times: [], points: [], smooth: true });
  const err = tk.init(frame(a.frame), a.x, a.y, ts, R);
  if (err) throw new Error(err);
  S.points[a.frame] = { x: a.x, y: a.y, score: 1 };
  let refound = 0, lastGood = a.frame;
  for (let i = a.frame + 1; i < truth.frames; i++) {
    const r = tk.step(frame(i));
    if (r.lost) break;
    if (r.low) S.points[i] = { x: r.x, y: r.y, score: r.score, low: true };
    else { const f = tk.finish(process.env.NOREFINE ? null : roi(i, r.x, r.y, R * 1.15 + 4)); S.points[i] = { x: f.x, y: f.y, score: r.score }; lastGood = i; }
    if (r.refound) refound++;
  }
  S.points.length = lastGood + 1;
  return { name, refound, ...score(truth) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('eval-node.js'))
  for (const n of process.argv.slice(2).length ? process.argv.slice(2) : ['snatch60', 'snatch30hard', 'cj30']) console.log(JSON.stringify(trackClip(n)));
