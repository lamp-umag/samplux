export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const mean = arr =>
  arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

export const pct = (n, total) =>
  total ? Math.round((n / total) * 100) : null;

/**
 * Waits for the browser's next VSYNC frame composition after a DOM mutation
 * and returns the monotonic frame timestamp (ms). Falls back to performance.now()
 * in headless/non-window environments.
 */
export function nextPaint() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise(resolve => requestAnimationFrame(ts => resolve(
      Number.isFinite(ts) && ts > 0 ? ts : performance.now()
    )));
  }
  return Promise.resolve(performance.now());
}

/**
 * Computes reaction time (ms) from stimulus VSYNC timestamp `t0` to the OS kernel
 * input timestamp `event.timeStamp` (when on the same monotonic clock), falling back
 * to `performance.now() - t0` if the browser reports an incompatible epoch timeStamp.
 */
export function eventRtMs(event, t0) {
  const now = performance.now();
  const ts = event && Number.isFinite(event.timeStamp) ? event.timeStamp : null;
  if (ts !== null && ts >= t0 && (ts - t0) <= (now - t0 + 250)) {
    return Math.max(1, Math.round(ts - t0));
  }
  return Math.max(1, Math.round(now - t0));
}
