import { S } from './state.js';
import { BarTracker } from './ncc.js';

const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
const roiC = document.createElement('canvas');
const rctx = roiC.getContext('2d', { willReadFrequently: true });

/* ---------- Bar tracking (normalised cross-correlation, in a Worker when possible) ---------- */

export function grabGray(s) {
  const src = S.src;
  const w = Math.max(1, Math.round(src.W * s)), h = Math.max(1, Math.round(src.H * s));
  if (proc.width !== w) proc.width = w;
  if (proc.height !== h) proc.height = h;
  pctx.imageSmoothingEnabled = true; pctx.imageSmoothingQuality = 'high';
  src.draw(pctx, w, h);
  const d = pctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return { g, w, h, sx: w / src.W, sy: h / src.H };   // rounding makes the two scales differ slightly
}

/* Full-resolution grey crop of the current frame centred on (cx, cy), side 2·half + 1 px, clipped to the frame.
   With rgba, the colour pixels come too. */
export function grabRoi(cx, cy, half, rgba = false) {
  const src = S.src;
  const x0 = Math.max(0, Math.floor(cx - half)), y0 = Math.max(0, Math.floor(cy - half));
  const w = Math.min(src.W, Math.ceil(cx + half) + 1) - x0, h = Math.min(src.H, Math.ceil(cy + half) + 1) - y0;
  if (w < 8 || h < 8) return null;
  if (roiC.width !== w) roiC.width = w;
  if (roiC.height !== h) roiC.height = h;
  rctx.save(); rctx.translate(-x0, -y0); src.draw(rctx, src.W, src.H); rctx.restore();
  const d = rctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return { g, w, h, x0, y0, ...(rgba ? { rgba: d } : {}) };
}

/* { init(img, x, y, ts, radius), step(img), finish(roi) } returning promises; the image buffers are handed to the worker.
   Falls back to the main thread where module workers are unavailable. */
export async function makeTracker(cfg) {
  try {
    const w = new Worker(new URL('./track-worker.js', import.meta.url), { type: 'module' });
    const wait = new Map(); let n = 0, broken = null;
    w.onmessage = ({ data }) => { wait.get(data.id).res(data.r); wait.delete(data.id); };
    w.onerror = e => { broken = e; for (const p of wait.values()) p.rej(e); wait.clear(); };
    const call = (msg, transfer) => new Promise((res, rej) => {
      if (broken) return rej(broken);
      const id = ++n; wait.set(id, { res, rej }); w.postMessage({ id, ...msg }, transfer);
    });
    await Promise.race([call({ type: 'ping' }), new Promise((_, rej) => setTimeout(() => rej(new Error('worker timeout')), 3000))]);
    return {
      init: (img, x, y, ts, radius) => call({ type: 'init', cfg, img, x, y, ts, radius }, [img.g.buffer]),
      step: img => call({ type: 'step', img }, [img.g.buffer]),
      finish: roi => call({ type: 'finish', roi }, roi ? [roi.g.buffer] : []),
      close: () => w.terminate(),
    };
  } catch (_) {
    const tk = new BarTracker(cfg);
    return { init: async (...a) => tk.init(...a), step: async img => tk.step(img), finish: async roi => tk.finish(roi), close() {} };
  }
}
