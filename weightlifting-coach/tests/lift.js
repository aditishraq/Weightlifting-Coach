/* Synthetic lifts for the unit tests. 1 px = 1 cm (radius 22.5), 30 fps, lifter faces right, floor bar centre at (200, 500).
   A clean, fault-free snatch by default; each option bends one thing so a single check should flip. */
import { S } from '../js/state.js';

export const FPS = 30, X0 = 200, Y0 = 500;
const lerp = (a, b, u) => a + (b - a) * Math.max(0, Math.min(1, u));

// Bar height in cm: still to f5, up to 100 cm at f40, down to 85 cm at f50, held to f60.
export function height(i) {
  if (i < 5) return 0;
  if (i <= 40) return (i - 5) / 35 * 100;
  if (i <= 50) return lerp(100, 85, (i - 40) / 10);
  return 85;
}
// Clean & jerk bar height: pull to 100 cm (f40), catch at 85 (f50), stand to 110 (f60), dip to 100 (f66), drive to 160 (f74).
export function cjHeight(i) {
  const seg = [[0, 0], [5, 0], [40, 100], [50, 85], [60, 110], [63, 110], [66, 100], [74, 160], [90, 160]];
  let k = 0; while (k < seg.length - 2 && i > seg[k + 1][0]) k++;
  const [a, ha] = seg[k], [b, hb] = seg[k + 1];
  return ha + (hb - ha) * Math.min(1, Math.max(0, (i - a) / (b - a)));
}

export const KNEE_F = 14, EXT_F = 32;   // bar passes the knee (h >= 25), lifter fully extended

export function makeLift(o = {}) {
  const n = o.n ?? 61, F = o.facing ?? 1;
  const points = [], poseS = [];
  for (let i = 0; i < n; i++) {
    const h = (o.height ?? height)(i);
    const bx = X0 + (o.barX ? o.barX(i) : 0), by = Y0 - h;
    points[i] = { x: bx, y: by, score: 1 };
    // first pull: torso rises with the bar; then open up to standing by EXT_F; then a squat catch
    let sh, hip, knee;
    if (i <= KNEE_F) {
      const hr = o.hipRise ?? 1;
      sh = [202, 440 - h]; hip = [170, 455 - h * hr]; knee = [215, 475];
    } else {
      const u = (i - KNEE_F) / (EXT_F - KNEE_F), hk = height(KNEE_F);
      const s0 = [202, 440 - hk], h0 = [170, 455 - hk * (o.hipRise ?? 1)];
      sh = [lerp(s0[0], 196, u), lerp(s0[1], 363, u)];
      hip = [lerp(h0[0], 198, u), lerp(h0[1], 420, u)];
      knee = [lerp(215, 200, u), lerp(475, 470, u)];
      if (o.shortExt && i >= EXT_F - 4) { hip = [212, 425]; }   // hips never open
    }
    if (o.bodyScale) {   // a bigger or smaller lifter around the same ankle and bar
      const k = o.bodyScale, sc = ([x, y]) => [200 + (x - 200) * k, 515 + (y - 515) * k];
      sh = sc(sh); hip = sc(hip); knee = sc(knee);
    }
    if (o.shoulderX) sh[0] += o.shoulderX(i);
    const foot = i > 40 ? (o.footShift ?? 0) : 0, heelUp = o.heelUp ? o.heelUp(i) : 0;
    const wrist = [bx, by], elbow = [(sh[0] + bx) / 2 + (o.elbowOut ? o.elbowOut(i) : 0), (sh[1] + by) / 2];
    const L = Array.from({ length: 33 }, () => ({ x: X0, y: 300, z: 0, v: 1 }));
    const put = (k, [x, y]) => { L[k] = { x, y, z: 0, v: o.vis ? o.vis(i, k) : 1 }; };
    put(0, [sh[0] + 10, sh[1] - 25]); put(7, [sh[0], sh[1] - 25]); put(8, [sh[0], sh[1] - 25]);
    put(11, sh); put(13, elbow); put(15, wrist); put(23, hip); put(25, knee); put(27, [200 + foot, 515]);
    put(29, [190 + foot, 522 - heelUp]); put(31, [215 + foot, 522]);
    poseS[i] = L;
  }
  if (F < 0) {   // mirror the whole scene about X0
    for (const p of points) p.x = 2 * X0 - p.x;
    for (const L of poseS) for (const q of L) q.x = 2 * X0 - q.x;
  }
  return { points, poseS: o.noPose ? [] : poseS, facing: F };
}

export function load(lift, opts = {}) {
  Object.assign(S, {
    axisRatio: opts.axisRatio ?? null,
    src: { fps: FPS }, radius: 22.5, smooth: false, lift: opts.lift ?? 'snatch', times: [],
    facing: lift.facing, points: lift.points, pose: lift.poseS, poseS: lift.poseS, poseSide: 0,
  });
}
