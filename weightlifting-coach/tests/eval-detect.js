/* Scores automatic plate detection on the first frame of each generated clip, under Node:
     node --import ./tests/dom-stub.js tests/eval-detect.js
   Three runs per clip: no body model; a prior from the true joints; the same with joint noise like MediaPipe's
   (σ = 2 % of the lifter's height). The browser uses MediaPipe itself (see docs/baseline.md). */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../js/config.js';
import { detectPlate, platePrior } from '../js/plate.js';

const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(3);
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());

export function frameData(name, frame = 0) {
  const T = JSON.parse(readFileSync(`samples/${name}.truth.json`, 'utf8')), W = T.W, H = T.H;
  const rgb = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', `samples/${name}.mp4`, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2];
  const k = Math.min(1, CONFIG.detect.workPx / Math.max(W, H)), w = Math.round(W * k), h = Math.round(H * k);
  const small = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', `samples/${name}.mp4`, '-vf', `select=eq(n\\,${frame}),scale=${w}:${h}:flags=area`, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const work = { g: Float32Array.from(small), w, h, sx: w / W, sy: h / H };
  const crop = (cx, cy, half) => {
    const x0 = Math.max(0, Math.floor(cx - half)), y0 = Math.max(0, Math.floor(cy - half));
    const cw = Math.min(W, Math.ceil(cx + half) + 1) - x0, ch = Math.min(H, Math.ceil(cy + half) + 1) - y0;
    if (cw < 8 || ch < 8) return null;
    const cg = new Float32Array(cw * ch), rgba = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const o = (y0 + y) * W + x0 + x, q = y * cw + x;
      cg[q] = g[o]; rgba[4 * q] = rgb[3 * o]; rgba[4 * q + 1] = rgb[3 * o + 1]; rgba[4 * q + 2] = rgb[3 * o + 2]; rgba[4 * q + 3] = 255;
    }
    return { g: cg, rgba, w: cw, h: ch, x0, y0 };
  };
  return { T, W, H, work, crop };
}

/* MediaPipe-style landmarks from the truth joints (the generator draws ankle, heel and toe from these). */
export function landmarks(T, frame, noisePx) {
  const F = T.perFrame[frame], L = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
  const n = () => noisePx * gauss(), put = (i, [x, y]) => { L[i] = { x: x + n(), y: y + n(), v: 0.9 }; };
  const ank = [T.start.x - 0.03 * T.pxPerM, 1200 - 0.08 * T.pxPerM];
  for (const s of [0, 1]) {
    put(11 + s, F.shoulder); put(23 + s, F.hip); put(25 + s, F.knee); put(27 + s, ank);
    put(15 + s, [F.x, F.y]); put(29 + s, [ank[0] - 30, ank[1] + 40]); put(31 + s, [ank[0] + 70, ank[1] + 40]);
  }
  return L;
}

export function evalDetect(name) {
  const { T, W, H, work, crop } = frameData(name), out = { name };
  for (const [mode, noise] of [['none', null], ['truePose', 0], ['noisyPose', 0.02 * 1.75 * T.pxPerM]]) {
    const prior = noise == null ? {} : platePrior(landmarks(T, 0, noise));
    const t0 = performance.now(), [b] = detectPlate(work, crop, W, H, prior), ms = Math.round(performance.now() - t0);
    out[mode] = b ? {
      centreErrPx: +Math.hypot(b.x - T.start.x, b.y - T.start.y).toFixed(2), radiusErrPct: +((b.r / T.plateRadiusPx - 1) * 100).toFixed(2),
      ratio: +b.ratio.toFixed(3), trueRatio: T.axisRatio, score: +b.score.toFixed(2), expectedR: prior.expectedR ? Math.round(prior.expectedR) : null, ms,
    } : { found: false, ms };
  }
  return out;
}

if (process.argv[1].endsWith('eval-detect.js'))
  for (const n of process.argv.slice(2).length ? process.argv.slice(2) : ['snatch60', 'snatch30hard', 'cj30', 'snatch30occl']) console.log(JSON.stringify(evalDetect(n)));
