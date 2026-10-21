import { S, clamp, fix } from './state.js';
import { barPhases, cmPerPx, pathPoints, timeOf } from './path.js';
import { CONFIG } from './config.js';
import { TRIPLE, ang, jointAng, jp, lean, midfoot } from './pose.js';

const C = CONFIG.checks;
// [good, watch] limits where smaller is better, and where bigger is better
const grade = (v, [g, w]) => v <= g ? 'good' : v <= w ? 'watch' : 'fault';
const gradeUp = (v, [g, w]) => v >= g ? 'good' : v >= w ? 'watch' : 'fault';
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };

export const GROUPS = ['First pull', 'Second pull', 'Turnover and catch', 'Jerk'];

/* Every finding: { group, id, title, status, text, frame, annot, confidence }. status is good | watch | fault |
   info | na; confidence 0..1 says how far the inputs can be trusted (null for n/a). */
export function evaluate() {
  const pts = pathPoints(), ph = barPhases(pts);
  if (!ph) return null;
  if (ph.liftoff == null) return { error: 'The bar never leaves the floor in the tracked frames. Track from the start position through the catch.' };
  const { first, last, liftoff, peak, catchIdx, jerk, h } = ph;
  const F = S.facing, c = cmPerPx(), cm = v => v * c;
  const ms = (a, b) => Math.round((timeOf(b) - timeOf(a)) * 1000);
  const hasPose = S.poseS.some(Boolean);

  /* ---- Inputs and how far to trust them ---- */
  // a joint only counts where the body model saw it
  const J = (i, n) => { const p = jp(i, n); return p && p.v >= C.minVis ? p : null; };
  const angle = (i, j) => TRIPLE[j].every(n => J(i, n)) ? jointAng(i, j) : null;
  const leanAt = i => J(i, 'shoulder') && J(i, 'hip') ? lean(i) : null;
  // Elbow angle. Filmed from the side, the near plate hides the hand, and pose models still place the wrist
  // inside the plate with high confidence; the hand is on the bar, so use the bar centre for it there.
  let barWrist = 0;
  const elbow = i => {
    const s = J(i, 'shoulder'), e = J(i, 'elbow'), w = jp(i, 'wrist'), b = pts[i];
    if (!s || !e) return null;
    if (b && (!w || Math.hypot(w.x - b.x, w.y - b.y) < S.radius)) { barWrist++; return ang(s, e, b); }
    return w && w.v >= C.minVis ? ang(s, e, w) : null;
  };
  const mid = i => J(i, 'heel') && J(i, 'toe') ? midfoot(i) : null;
  // 0.5 at the visibility cut-off, 1 from 0.9. A joint inside the plate's disc counts at half its visibility:
  // the near plate is in front of the lifter, so models guess what's behind it (the hips at full extension,
  // the feet at the start) and still report it as seen.
  const behindPlate = (i, p) => pts[i] && Math.hypot(p.x - pts[i].x, p.y - pts[i].y) < S.radius;
  const visQ = (frames, joints) => {
    const v = []; for (const i of frames) for (const n of joints) { const p = jp(i, n); if (p) v.push(behindPlate(i, p) ? p.v / 2 : p.v); }
    return v.length ? 0.5 + 0.5 * clamp((v.reduce((a, b) => a + b, 0) / v.length - C.minVis) / (0.9 - C.minVis), 0, 1) : 0;
  };
  // the share of bar positions in a span that were measured, not guessed
  const trackQ = (a, b) => { let n = 0, ok = 0; for (let i = a; i <= b; i++) if (S.points[i]) { n++; if (!S.points[i].low) ok++; } return n ? ok / n : 0; };
  // camera: 1 side-on, 0 at sideOnZero; bar distances across the frame are corrected by the ratio
  const ratio = S.axisRatio || 1, sideQ = clamp((ratio - C.sideOnZero) / (1 - C.sideOnZero), 0, 1), across = v => v / ratio;
  const oblique = `The camera isn't side-on (plate width ÷ height ${ratio.toFixed(2)}), so the bar and the lifter are at different depths and the gap between them in the picture isn't their gap on the platform.`;
  // Lifter size: femur in px from the frames where hip and knee are both seen. Distances between body points are
  // judged in femur lengths. Not in cm: the lifter stands about a metre behind the near plate, so the plate's
  // scale makes the body look 20-35 % small, and bar-only limits stay in cm for the same reason.
  const fem = [];
  for (let i = first; i <= last; i++) { const a = J(i, 'hip'), b = J(i, 'knee'); if (a && b) fem.push(Math.hypot(a.x - b.x, a.y - b.y)); }
  const femPx = fem.length >= 5 ? median(fem) : null;
  // forward of the start line, which is where the bar leaves the floor (it often rolls during the set-up)
  const fwd = i => across(cm((pts[i].x - pts[liftoff].x) * F));

  const out = [];
  const add = (group, id, title, status, text, frame, annot, confidence) => {
    const conf = status === 'na' ? null : Math.round(clamp(confidence ?? 1, 0, 1) * 100) / 100;
    if (conf != null && conf < C.minConfidence)
      return out.push({ group: GROUPS[group], id, title, status: 'na', text: `Not judged: the inputs are too uncertain (confidence ${Math.round(conf * 100)} %). What was measured: ${text}`, frame, annot, confidence: conf });
    out.push({ group: GROUPS[group], id, title, status, text, frame, annot, confidence: conf });
  };
  const na = (group, id, title, why) => add(group, id, title, 'na', why, null, null);
  const needPose = (group, id, title, joints) => na(group, id, title, hasPose
    ? `The body model couldn't see the ${joints} clearly enough on the frames this needs.` : 'Press Analyse technique to check this.');

  // Frame where the bar passes the knee, and the frame of greatest hip + knee extension before the bar peaks.
  let kneeIdx = null;
  for (let i = liftoff; i <= peak; i++) { const k = J(i, 'knee'); if (k ? pts[i].y <= k.y : h(i) >= CONFIG.phases.kneeNoPoseCm) { kneeIdx = i; break; } }
  let extIdx = null, best = -1;
  if (kneeIdx != null) for (let i = kneeIdx; i <= peak; i++) {
    const a = angle(i, 'hip'), b = angle(i, 'knee');
    if (a != null && b != null && a + b > best) { best = a + b; extIdx = i; }
  }

  // --- First pull ---
  {
    const rows = [[liftoff, 'at lift-off'], [kneeIdx, 'as the bar passes the knee']].filter(r => r[0] != null && J(r[0], 'shoulder'))
      .map(([f, where]) => ({ f, where, d: (J(f, 'shoulder').x - pts[f].x) * F }));
    if (!rows.length || !femPx) needPose(0, 'shoulders', 'Shoulders over the bar', 'shoulders, hips and knees');
    else if (ratio < C.mixedPlaneMinRatio) na(0, 'shoulders', 'Shoulders over the bar', oblique);
    else {
      const worst = rows.reduce((a, b) => b.d < a.d ? b : a);
      const st = gradeUp(worst.d / femPx, C.shouldersFemur);
      const say = r => `${fix(cm(Math.abs(r.d)))} cm ${r.d >= 0 ? 'in front of' : 'behind'} the bar ${r.where}`;
      add(0, 'shoulders', 'Shoulders over the bar', st,
        `Shoulders ${rows.map(say).join(', ')}.${st === 'good' ? '' : ' Keep them over or just ahead of the bar until it clears the knee.'}`,
        worst.f, { type: 'vs' }, visQ(rows.map(r => r.f), ['shoulder']) * sideQ ** 2 * trackQ(liftoff, kneeIdx ?? liftoff));
    }
  }
  {
    const l0 = leanAt(liftoff), l1 = kneeIdx != null ? leanAt(kneeIdx) : null;
    if (l0 == null || l1 == null) needPose(0, 'hips', 'Hips and shoulders rise together', 'shoulders and hips');
    else {
      const d = l1 - l0, st = grade(d, C.hipsLeanDeg);
      const hr = cm(J(liftoff, 'hip').y - J(kneeIdx, 'hip').y), sr = cm(J(liftoff, 'shoulder').y - J(kneeIdx, 'shoulder').y);
      add(0, 'hips', 'Hips and shoulders rise together', st,
        `Back angle ${Math.round(90 - l0)}° at lift-off, ${Math.round(90 - l1)}° at the knee. Hips rose ${fix(hr)} cm, shoulders ${fix(sr)} cm.${st === 'good' ? '' : ' The hips are coming up faster than the shoulders, which tips the chest down.'}`,
        kneeIdx, { type: 'torso' }, visQ([liftoff, kneeIdx], ['shoulder', 'hip']) * Math.sqrt(sideQ));
    }
  }
  if (kneeIdx == null) na(0, 'close1', 'Bar stays close off the floor', 'The bar did not reach knee height in the tracked frames.');
  else {
    let mx = -1e9, mn = 1e9, fm = liftoff;
    for (let i = liftoff; i <= kneeIdx; i++) { const d = fwd(i); if (d > mx) { mx = d; fm = i; } mn = Math.min(mn, d); }
    const lim = C.close1Cm, st = grade(mx, lim);
    add(0, 'close1', 'Bar stays close off the floor', st,
      mx <= lim[0] ? (mn < -C.close1BackCm ? `Bar moved ${fix(-mn)} cm back toward the lifter before the knee.` : 'Bar rose straight up to the knee.')
                   : `Bar drifted ${fix(mx)} cm forward of the start line before the knee. It should travel straight up or slightly back toward the shins.`,
      fm, { type: 'bar' }, trackQ(liftoff, kneeIdx) * Math.sqrt(sideQ));
  }
  {
    // where the heel rests: the set-up frames where it can be seen, or else (the plate often hides the feet at
    // the start) the first visible frames of the first pull, when the feet are still flat
    let span = []; for (let i = first; i <= liftoff; i++) if (J(i, 'heel')) span.push(i);
    let early = true;
    if (!span.length && kneeIdx != null) { early = false; for (let i = liftoff; i <= kneeIdx && span.length < 5; i++) if (J(i, 'heel')) span.push(i); }
    let midThigh = null;
    if (kneeIdx != null) for (let i = kneeIdx; i <= peak; i++) { const k = J(i, 'knee'), hp = J(i, 'hip'); if (k && hp && pts[i].y <= (k.y + hp.y) / 2) { midThigh = i; break; } }
    if (!span.length || midThigh == null || !femPx) needPose(0, 'heels', 'Heels stay down', 'heels');
    else {
      const base = median(span.map(i => J(i, 'heel').y));
      let up = null, rise = 0, seen = [];
      for (let i = liftoff; i <= midThigh; i++) { const p = J(i, 'heel'); if (!p) continue; seen.push(i); if ((base - p.y) / femPx > C.heelRiseFemur) { up = i; rise = cm(base - p.y); break; } }
      add(0, 'heels', 'Heels stay down', up == null ? 'good' : 'watch',
        (up == null ? 'Heels stayed on the floor until the bar passed mid-thigh.'
                    : `Heel lifted ${fix(rise)} cm at frame ${up}, before the bar reached mid-thigh. The weight may be shifting to the toes early.`)
          + (early ? '' : ' (The plate hid the feet at the start, so the heel\'s resting height comes from the first pull.)'),
        up == null ? midThigh : up, { type: 'heel', base },
        visQ([...span, ...seen], ['heel']) * (early ? 1 : 0.8) * (seen.length / Math.max(1, midThigh - liftoff + 1) > 0.5 ? 1 : 0.6));
    }
  }

  // --- Second pull ---
  if (extIdx == null) { needPose(1, 'arms', 'Arms stay long', 'hips, knees and ankles'); needPose(1, 'extension', 'Full extension', 'hips, knees and ankles'); }
  else {
    // an elbow that bends at the very end is the pull under starting; only earlier bends count
    let mn = 999, fm = liftoff;
    const used = [];
    barWrist = 0;
    for (let i = liftoff; i < extIdx && ms(i, extIdx) >= C.armsLeadMs; i++) { const a = elbow(i); if (a == null) continue; used.push(i); if (a < mn) { mn = a; fm = i; } }
    const viaBar = barWrist > used.length / 2;
    if (mn === 999) needPose(1, 'arms', 'Arms stay long', 'shoulders, elbows and wrists');
    else {
      const st = gradeUp(mn, C.armsDeg);
      add(1, 'arms', 'Arms stay long', st,
        st === 'good' ? `Elbows stayed straight until full extension (most bent: ${Math.round(mn)}°).`
                      : `Elbow bent to ${Math.round(mn)}° at frame ${fm}, ${ms(fm, extIdx)} ms before full extension. Pulling with the arms early takes power away from the legs and hips.`,
        fm, { type: 'angle', joints: ['elbow'] }, visQ(used, viaBar ? ['shoulder', 'elbow'] : ['shoulder', 'elbow', 'wrist']) * Math.sqrt(sideQ) * (viaBar ? 0.85 : 1));
    }
    const a = angle(extIdx, 'hip'), b = angle(extIdx, 'knee'), l = leanAt(extIdx);
    const st = a >= C.extHipDeg[0] && b >= C.extKneeDeg ? 'good' : a >= C.extHipDeg[1] ? 'watch' : 'fault';
    add(1, 'extension', 'Full extension', st,
      `At the top of the pull: hip ${Math.round(a)}°, knee ${Math.round(b)}° (180° is straight)${l != null && l < -C.extLeanBackDeg ? `, torso ${Math.round(-l)}° behind vertical` : ''}.${st === 'good' ? '' : ' The hips and knees did not open fully before the pull under.'}`,
      extIdx, { type: 'angle', joints: ['hip', 'knee'] }, visQ([extIdx], ['shoulder', 'hip', 'knee', 'ankle']) * Math.sqrt(sideQ));
  }
  {
    let mx = -1e9, fm = peak;
    const a0 = kneeIdx == null ? liftoff : kneeIdx;
    for (let i = a0; i <= peak; i++) { const d = fwd(i); if (d > mx) { mx = d; fm = i; } }
    const st = grade(mx, C.close2Cm);
    add(1, 'close2', 'Bar stays close at the hips', st,
      st === 'good' ? (mx <= 0 ? 'Bar stayed behind the start line through the second pull.' : `Bar stayed within ${fix(mx)} cm of the start line through the second pull.`)
                    : `Bar swung ${fix(mx)} cm in front of the start line at frame ${fm}. That usually comes from bumping it forward with the hips rather than brushing it upward.`,
      fm, { type: 'bar' }, trackQ(a0, peak) * Math.sqrt(sideQ));
  }

  // --- Turnover and catch ---
  {
    // where the feet started: visible set-up frames, or else the first pull up to the knee, when they're still flat
    let span = []; for (let i = first; i <= liftoff; i++) if (mid(i)) span.push(i);
    let early = true;
    if (!span.length && kneeIdx != null) { early = false; for (let i = liftoff; i <= kneeIdx; i++) if (mid(i)) span.push(i); }
    const mc = mid(catchIdx);
    if (!span.length || !mc || catchIdx === peak || !femPx) needPose(2, 'feet', 'Feet land in place', 'heels and toes');
    else {
      const bx = median(span.map(i => mid(i).x)), dpx = across((mc.x - bx) * F), d = cm(dpx), df = dpx / femPx;
      const st = df > C.feetFwdFemur ? 'fault' : df < -C.feetBackFemur ? 'watch' : 'good';
      add(2, 'feet', 'Feet land in place', st,
        (df > C.feetFwdFemur ? `Feet jumped ${fix(d)} cm forward. The lifter is chasing a bar that went out in front.`
        : df < -C.feetBackFemur ? `Feet jumped ${fix(-d)} cm back. A small hop back is common; this much usually means leaning back or swinging the bar.`
        : `Feet landed ${fix(Math.abs(d))} cm ${d >= 0 ? 'forward of' : 'behind'} where they started.`)
          + (early ? '' : ' (The plate hid the feet at the start, so their starting place comes from the first pull.)'),
        catchIdx, { type: 'feet', base: bx }, visQ([...span, catchIdx], ['heel', 'toe']) * Math.sqrt(sideQ) * (early ? 1 : 0.9));
    }
    if (!mc || !femPx) needPose(2, 'catchPos', 'Bar lands over mid-foot', 'heels and toes');
    else if (ratio < C.mixedPlaneMinRatio) na(2, 'catchPos', 'Bar lands over mid-foot', oblique);
    else {
      const dpx = (pts[catchIdx].x - mc.x) * F, d = cm(dpx), ad = Math.abs(d);
      const st = grade(Math.abs(dpx) / femPx, C.catchMidfootFemur);
      add(2, 'catchPos', 'Bar lands over mid-foot', st,
        `Bar is ${fix(ad)} cm ${d >= 0 ? 'in front of' : 'behind'} mid-foot at the bottom of the catch.${st === 'good' ? '' : d > 0 ? ' A bar that lands forward pulls the lifter onto the toes.' : ' A bar that lands behind the base is hard to hold.'}`,
        catchIdx, { type: 'midfoot' }, visQ([catchIdx], ['heel', 'toe']) * sideQ ** 2 * trackQ(catchIdx, catchIdx));
    }
    add(2, 'turnover', 'Turnover', 'info',
      `Bar peaked ${fix(h(peak))} cm above the start and dropped ${fix(h(peak) - h(ph.receive))} cm before it was caught${extIdx != null ? `, ${ms(extIdx, ph.receive)} ms after full extension` : ''}` +
      (h(ph.receive) - h(catchIdx) > 2 ? `, then rode down ${fix(h(ph.receive) - h(catchIdx))} cm into the bottom.` : '.'),
      peak, { type: 'bar' }, trackQ(peak, catchIdx));
  }

  // --- Jerk ---
  if (S.lift === 'cj') {
    if (!jerk) na(3, 'jerk', 'Jerk', 'No jerk found in the tracked frames. Track through the lockout to check it.');
    else {
      const { dipStart: s, dipBottom: b, top } = jerk;
      const d = across(cm((pts[b].x - pts[s].x) * F)), ls = leanAt(s), lb = leanAt(b), dl = ls != null && lb != null ? lb - ls : null;
      const dipLim = C.dipBarCm;
      let st = d > dipLim[1] || dl > C.dipLeanDeg[1] ? 'fault' : d > dipLim[0] || dl > C.dipLeanDeg[0] ? 'watch' : 'good';
      add(3, 'dip', 'Dip stays vertical', st,
        `Dip ${fix(h(s) - h(b))} cm deep. Bar moved ${fix(Math.abs(d))} cm ${d >= 0 ? 'forward' : 'back'}${dl != null ? `, torso tipped ${fix(Math.abs(dl))}° ${dl >= 0 ? 'forward' : 'back'}` : ''}.${st === 'good' ? '' : ' A dip that tips forward sends the drive out in front.'}`,
        b, { type: 'torso' }, trackQ(s, b) * Math.sqrt(sideQ) * (dl == null ? 0.8 : 1));
      const dd = across(cm((pts[top].x - pts[b].x) * F)), drLim = C.driveFwdCm;
      st = dd > drLim[1] ? 'fault' : dd > drLim[0] || dd < -C.driveBackCm ? 'watch' : 'good';
      add(3, 'drive', 'Drive goes straight up', st,
        `Bar finished ${fix(Math.abs(dd))} cm ${dd >= 0 ? 'in front of' : 'behind'} where it was at the bottom of the dip.${dd > drLim[0] ? ' The bar is being driven forward, away from the base.' : ''}`,
        top, { type: 'bar' }, trackQ(b, top) * Math.sqrt(sideQ));
      let lk = top; for (let i = b; i <= top; i++) if (h(i) >= h(top) - C.lockArriveCm) { lk = i; break; }
      barWrist = 0;
      const e0 = elbow(lk);
      let e1 = e0;
      const seen = [lk];
      for (let i = lk; i <= last && timeOf(i) - timeOf(lk) <= C.lockWindowS; i++) { const e = elbow(i); if (e != null) { seen.push(i); if (e > e1) e1 = e; } }
      if (e0 == null) needPose(3, 'lockout', 'Arms lock out', 'shoulders, elbows and wrists');
      else {
        st = e0 < C.pressOutDeg && e1 - e0 > C.pressOutGainDeg ? 'fault' : e1 < C.lockDeg ? 'watch' : 'good';
        add(3, 'lockout', 'Arms lock out', st,
          st === 'fault' ? `Elbow was at ${Math.round(e0)}° when the bar arrived overhead and straightened to ${Math.round(e1)}° afterwards. That is a press-out.`
          : st === 'watch' ? `Elbow only reached ${Math.round(e1)}° overhead (180° is straight).`
          : `Elbow locked at ${Math.round(e1)}° as the bar arrived overhead.`,
          lk, { type: 'angle', joints: ['elbow'] }, visQ(seen, ['shoulder', 'elbow']) * Math.sqrt(sideQ) * (barWrist ? 0.85 : 1));
      }
    }
  }
  return { checks: out, hasPose, femurPx: femPx, axisRatio: S.axisRatio ?? null,
           keys: { liftoff, knee: kneeIdx, ext: extIdx, peak, catch: catchIdx, jerk: jerk ? jerk.top : null } };
}
