/* Tracks any video with the browser pipeline's tracker (js/ncc.js) under Node and writes a result file
   (docs/result-format.md) with exact frame times from ffprobe, for comparing with the engine:
     node --import ./tests/dom-stub.js tests/track-video.js samples/clip.mov x y r [frame] [lift] [facing]
   writes samples/clip.browser.json. Frames are decoded by ffmpeg (rotation applied), so resampling differs
   slightly from the browser's canvas. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CONFIG } from '../js/config.js';
import { BarTracker } from '../js/ncc.js';

const [file, X, Y, Rs, F = '0', lift = 'snatch', facing = '1'] = process.argv.slice(2);
const x0 = +X, y0 = +Y, R = +Rs, start = +F;
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height:stream_side_data=rotation:frame=best_effort_timestamp_time', '-of', 'json', file], { maxBuffer: 1 << 28 }));
const st = probe.streams[0], rot = Math.abs((st.side_data_list || []).find(d => d.rotation != null)?.rotation || 0);
const [W, H] = rot === 90 || rot === 270 ? [st.height, st.width] : [st.width, st.height];
const times = probe.frames.map(f => +f.best_effort_timestamp_time), t0 = times[0];

const T = CONFIG.tracking, s = Math.min(1, Math.max(0.1, T.workScalePx / R));
const w = Math.round(W * s), h = Math.round(H * s), sx = w / W, sy = h / H;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', `scale=${w}:${h}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 31 });
const full = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 32 - 1 });
const n = Math.min(raw.length / (w * h), full.length / (W * H), times.length);
const frame = i => ({ g: Float32Array.from(raw.subarray(i * w * h, (i + 1) * w * h)), w, h, sx, sy });
const roi = (i, cx, cy, half) => {
  const ax = Math.max(0, Math.floor(cx - half)), ay = Math.max(0, Math.floor(cy - half));
  const rw = Math.min(W, Math.ceil(cx + half) + 1) - ax, rh = Math.min(H, Math.ceil(cy + half) + 1) - ay, g = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) g[y * rw + x] = full[i * W * H + (ay + y) * W + ax + x];
  return { g, w: rw, h: rh, x0: ax, y0: ay };
};

const ts = Math.min(61, Math.max(15, Math.round(T.tplRadii * R * s) | 1));
const tk = new BarTracker({ ...T, fps: (n - 1) / (times[n - 1] - t0) });
const t1 = Date.now();
const err = tk.init(frame(start), x0, y0, ts, R);
if (err) throw new Error(err);
const points = []; points[start] = [x0, y0, 0];
let lastGood = start, refound = 0;
for (let i = start + 1; i < n; i++) {
  const r = tk.step(frame(i));
  if (r.lost) break;
  if (r.low) points[i] = [+r.x.toFixed(3), +r.y.toFixed(3), 1];
  else { const f = tk.finish(roi(i, r.x, r.y, R * 1.15 + 4)); points[i] = [+f.x.toFixed(3), +f.y.toFixed(3), 0]; lastGood = i; }
  if (r.refound) refound++;
}
points.length = lastGood + 1;
const out = {
  format: 'wlcoach-result', version: 1, source: 'browser',
  producer: { name: 'tests/track-video.js', version: '1', device: 'cpu', models: {}, seconds: +((Date.now() - t1) / 1000).toFixed(1), refound },
  video: { name: file.split('/').pop(), W, H, fps: +((n - 1) / (times[n - 1] - t0)).toFixed(3), frames: n },
  lift, facing: +facing, weightKg: null,
  plate: { frame: start, radiusPx: R, axisRatio: null, found: 'hint' },
  first: 0, points: Array.from(points, p => p || null), times: times.slice(0, points.length).map(t => +(t - t0).toFixed(5)),
};
const dest = file.replace(/\.[^.]+$/, '.browser.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`${dest}: ${points.filter(Boolean).length}/${n} frames, ${points.filter(p => p && p[2]).length} low, ${refound} re-found, lost after ${lastGood}, ${out.producer.seconds} s`);
