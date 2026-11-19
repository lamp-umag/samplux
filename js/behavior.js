// ─────────────────────────────────────────────────────────────
// samplux — interaction event log (paradata)
// ─────────────────────────────────────────────────────────────
// A compact, ordered list of what happened on screen, stored in the response's paradata
// document as `events` (the CSVs only get the summary counts). Never records what is
// typed — only that something happened, where, and when:
//   { t, k:'item', i }                 entered item `i`
//   { t, k:'miss', x, y, el, i, pt }   tap/click on something that is not a control
//   { t, k:'vis', v }                  tab hidden / visible
//   { t, k:'rot', w, h }               window resized or device rotated
//   { t, k:'geo', s }                  location step outcome
// `t` = ms since the survey started. Capped (maxEvents) so the document stays small.
// Firestore forbids nested arrays, so events are flat objects.
// ─────────────────────────────────────────────────────────────

// Things that are *meant* to be tapped. Anything else counts as a miss.
const CONTROL = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], .opt, .btn, .enc-card:not(.active):not(.locked), .task-overlay';

export function createBehaviorLog({ misses = true, maxEvents = 1500 } = {}) {
  const t0 = performance.now();
  const events = [];
  let missTapCount = 0;
  let truncated = false;
  let currentItem = null;

  const push = ev => {
    if (events.length >= maxEvents) { truncated = true; return; }
    events.push({ t: Math.round(performance.now() - t0), ...ev });
  };

  const describe = el => {
    if (!el || !el.tagName) return null;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0];
    return (el.tagName.toLowerCase() + (cls ? `.${cls}` : '')).slice(0, 40);
  };

  const onDown = e => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest(CONTROL)) return;
    missTapCount += 1;
    push({
      k: 'miss',
      x: Math.round(e.clientX / Math.max(1, window.innerWidth) * 1000) / 1000,
      y: Math.round(e.clientY / Math.max(1, window.innerHeight) * 1000) / 1000,
      el: describe(target), i: currentItem, pt: e.pointerType || null
    });
  };
  const onVis = () => push({ k: 'vis', v: document.visibilityState });
  let rotTimer = null;
  const onRot = () => { clearTimeout(rotTimer); rotTimer = setTimeout(() => push({ k: 'rot', w: window.innerWidth, h: window.innerHeight }), 250); };

  if (misses) document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', onRot);

  return {
    item(id) { currentItem = id; push({ k: 'item', i: id }); },
    note(ev) { push(ev); },
    snapshot: () => ({ events: events.slice(), missTapCount, ...(truncated && { eventsTruncated: true }) }),
    stop() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onRot);
      clearTimeout(rotTimer);
    }
  };
}
