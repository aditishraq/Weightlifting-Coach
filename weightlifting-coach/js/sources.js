
/* ---------- Sources ---------- */

export function seekTo(v, t) {
  return new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    v.addEventListener('seeked', fin, { once: true });
    setTimeout(fin, 2000);
    v.currentTime = t;
  });
}

/* Seeks and resolves with the presentation time (s) of the frame now showing, from requestVideoFrameCallback,
   or null when it can't be known: no rVFC, a hidden page (rVFC doesn't fire there), or no new frame presented
   (a repeated frame in a variable-rate clip). Null frames fall back to their nominal time from the frame rate. */
function seekFrame(v, t, maxGap = Infinity) {
  if (!('requestVideoFrameCallback' in v) || document.hidden) return seekTo(v, t).then(() => null);
  // the frame showing at t started at most maxGap before it; anything else is a late callback for another frame
  const ok = mt => mt != null && mt <= t + 1e-3 && t - mt <= maxGap;
  return new Promise(res => {
    let mt = null, seeked = false, done = false, wait = null;
    const fin = () => { if (!done) { done = true; clearTimeout(wait); clearTimeout(cap); res(ok(mt) ? mt : null); } };
    v.requestVideoFrameCallback((now, md) => { mt = md.mediaTime; if (seeked) fin(); });
    v.addEventListener('seeked', () => { seeked = true; if (mt != null) fin(); else wait = setTimeout(fin, 150); }, { once: true });
    const cap = setTimeout(fin, 2000);
    v.currentTime = t;
  });
}

/* Frame interval from presentation times: seek into the clip, then to just before the frame that shows, which
   brings up the previous frame; the two times differ by one frame. Taken at three points, the shortest wins.
   Exact, and unaffected by playback being throttled. Null if the browser can't report frame times. */
async function fpsBySeek(v) {
  const ds = [];
  for (const u of [0.3, 0.55, 0.8]) {
    const a = await seekFrame(v, u * v.duration);
    if (a == null) return null;
    const b = await seekFrame(v, a - 0.0005);
    if (b != null && a - b > 0.002) ds.push(a - b);
  }
  return ds.length ? 1 / Math.min(...ds) : null;
}

const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 100, 120, 240];
const snapFps = f => COMMON_FPS.find(c => Math.abs(c - f) / c < 0.04) || Math.round(f);
// Timing playback is only a fallback, and a hidden or busy page plays in slow, irregular steps (it read 4 fps
// for a 60 fps clip): trust it only when it lands on a common camera rate.
const playedFps = f => COMMON_FPS.find(c => Math.abs(c - f) / c < 0.04) ?? null;

export async function detectFps(v) {
  const f = await fpsBySeek(v);
  return f ? snapFps(f) : detectFpsByPlay(v);
}

function detectFpsByPlay(v) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return Promise.resolve(null);
  return new Promise(res => {
    const times = []; let finished = false;
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(to); v.pause();
      let d = Infinity;
      for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.002 && x < d) d = x; }
      if (!isFinite(d)) return res(null);
      res(playedFps(1 / d));
    };
    const cb = (now, md) => { times.push(md.mediaTime); if (times.length < 14) v.requestVideoFrameCallback(cb); else finish(); };
    v.requestVideoFrameCallback(cb);
    const to = setTimeout(finish, 2000);
    v.play().catch(finish);
  });
}

/* opts.name overrides the file name (a stored video is a Blob with none); opts.fps skips frame-rate detection. */
export async function videoSource(file, opts = {}) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
  // iOS Safari won't load or paint frames for a video that isn't in the document, so park it off-screen.
  v.className = 'offstage';
  document.body.appendChild(v);
  v.src = URL.createObjectURL(file);
  v.load();
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('The video took too long to open. Try again, or try a shorter clip.')), 20000);
      v.onloadedmetadata = () => { clearTimeout(to); res(); };
      v.onerror = () => { clearTimeout(to); rej(new Error("This browser can't decode that file. Try an MP4 (H.264) or WebM video.")); };
    });
    // iOS ignores preload, so nothing is decoded until playback starts. A muted play/pause forces the first frame.
    if (v.readyState < 2) {
      await Promise.race([
        v.play().then(() => v.pause(), () => {}),
        new Promise(r => setTimeout(r, 3000)),
      ]);
      v.pause();
    }
  } catch (e) {
    URL.revokeObjectURL(v.src); v.remove();
    throw e;
  }
  if (!isFinite(v.duration)) { await seekTo(v, 1e7); await seekTo(v, 0); }
  const detected = opts.fps ? null : await detectFps(v);
  await seekTo(v, 0);
  return {
    kind: 'video', el: v, file, name: opts.name || file.name, W: v.videoWidth, H: v.videoHeight,
    fps: opts.fps || detected || 30, detected,
    times: null,   // exact frame start times (s) when known, e.g. from the local engine; else frames are 1/fps apart
    get N() { return this.times ? this.times.length : Math.max(1, Math.round(v.duration * this.fps)); },
    frameTime(i) {
      const t = this.times && this.times[i];
      return Math.min(v.duration - 0.001, t != null ? t + 0.25 / this.fps : (i + 0.5) / this.fps);
    },
    /* Resolves with the frame's presentation time in s, or null if the browser can't report it. */
    seek(i) { return seekFrame(v, this.frameTime(i), 1 / this.fps); },
    draw(ctx, w, h) { ctx.drawImage(v, 0, 0, w, h); },
    dispose() { v.pause(); URL.revokeObjectURL(v.src); v.remove(); },
  };
}

/* Synthetic snatch: a red bumper plate filmed side-on, lifter facing right. */
export function demoSource() {
  const W = 720, H = 960, FPS = 30, N = 84;
  const pxPerM = 436, floorY = 900, R = Math.round(0.225 * pxPerM), cx0 = 380;
  // [time s, horizontal m (+ = away from lifter), height m]
  const K = [[0, 0, 0], [0.4, 0, 0], [0.9, -0.045, 0.28], [1.2, -0.03, 0.55], [1.45, 0.045, 0.85],
             [1.65, 0.02, 1.02], [1.85, -0.035, 0.93], [2.1, -0.03, 0.87], [2.8, -0.03, 0.87]];
  const cr = (p0, p1, p2, p3, u) => 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  function at(t) {
    if (t >= K[K.length - 1][0]) return { x: K[K.length - 1][1], h: K[K.length - 1][2] };
    let k = 0; while (t >= K[k + 1][0]) k++;
    const u = (t - K[k][0]) / (K[k + 1][0] - K[k][0]);
    const a = K[Math.max(0, k - 1)], b = K[k], c = K[k + 1], d = K[Math.min(K.length - 1, k + 2)];
    return { x: cr(a[1], b[1], c[1], d[1], u), h: Math.max(0, cr(a[2], b[2], c[2], d[2], u)) };
  }
  const rand = seed => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let cur = 0;
  function paint(ctx, i) {
    const p = at(i / FPS);
    const x = cx0 + p.x * pxPerM, y = floorY - R - p.h * pxPerM;
    const g = ctx.createLinearGradient(0, 0, 0, floorY);
    g.addColorStop(0, '#2b2f33'); g.addColorStop(1, '#1c1e21');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, floorY);
    ctx.fillStyle = '#3b4046';
    for (const rx of [70, 630]) {
      ctx.fillRect(rx, 80, 28, floorY - 80);
      ctx.fillStyle = '#23272b';
      for (let hy = 110; hy < floorY - 20; hy += 44) ctx.fillRect(rx + 10, hy, 8, 8);
      ctx.fillStyle = '#3b4046';
    }
    ctx.fillStyle = '#8a6a45'; ctx.fillRect(0, floorY, W, H - floorY);
    ctx.strokeStyle = '#6f5436'; ctx.lineWidth = 2;
    for (let px = 40; px < W; px += 120) { ctx.beginPath(); ctx.moveTo(px, floorY); ctx.lineTo(px, H); ctx.stroke(); }
    ctx.fillStyle = 'rgba(12,13,15,.85)';
    ctx.beginPath(); ctx.ellipse(x - 40, y - 40 - p.h * 60, 80, 190, 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#1b1b1b'; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
    ctx.fillStyle = '#c8342a'; ctx.beginPath(); ctx.arc(0, 0, R * 0.92, 0, 7); ctx.fill();
    ctx.strokeStyle = '#8f2119'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, R * 0.6, 0, 7); ctx.stroke();
    ctx.rotate(0.35 * p.h + 0.02 * i);
    ctx.fillStyle = '#f4f1ea';
    ctx.font = `700 ${Math.round(R * 0.26)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('25', 0, -R * 0.44); ctx.fillText('KG', 0, R * 0.46);
    ctx.fillRect(-R * 0.72, -R * 0.05, R * 0.3, R * 0.1); ctx.fillRect(R * 0.42, -R * 0.05, R * 0.3, R * 0.1);
    ctx.fillStyle = '#b9bdc1'; ctx.beginPath(); ctx.arc(0, 0, R * 0.28, 0, 7); ctx.fill();
    ctx.fillStyle = '#7f858a'; ctx.beginPath(); ctx.arc(0, 0, R * 0.16, 0, 7); ctx.fill();
    ctx.fillStyle = '#4d5256'; ctx.beginPath(); ctx.arc(0, 0, R * 0.07, 0, 7); ctx.fill();
    ctx.restore();
    const r = rand(1000 + i * 7919);
    for (let k = 0; k < 900; k++) {
      ctx.fillStyle = r() < 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.09)';
      ctx.fillRect(r() * W, r() * H, 2, 2);
    }
  }
  return {
    kind: 'demo', name: 'Sample clip · synthetic snatch', W, H, fps: FPS, N, R,
    start: { x: cx0, y: floorY - R },
    async seek(i) { cur = i; return i / FPS; },
    draw(ctx, w, h) { ctx.save(); ctx.scale(w / W, h / H); paint(ctx, cur); ctx.restore(); },
  };
}

/* A saved lift without its video: steps through the stills captured when it was saved. */
export async function stillSource(name, stills) {
  const imgs = [];
  for (const s of stills) imgs.push({ label: s.label, bmp: await createImageBitmap(s.blob) });
  let cur = 0;
  return {
    kind: 'still', name, W: imgs[0].bmp.width, H: imgs[0].bmp.height, fps: 30, N: imgs.length,
    label: i => imgs[i].label,
    async seek(i) { cur = i; },
    draw(ctx, w, h) { ctx.drawImage(imgs[cur].bmp, 0, 0, w, h); },
  };
}
