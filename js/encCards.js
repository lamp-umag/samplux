// samplux — full-content "preview" body for non-active cards in interviewer mode (deck style).
// Pure DOM, no Firebase: used by encuestador.js and by the lab.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

/**
 * @param item   survey item
 * @param view   { answers, optionsFor(item), hasAudio(item) }
 */
export function staticBody(item, view) {
  const box = document.createDocumentFragment();
  const q = el('div', 'enc-card-q');
  q.innerHTML = item.prompt || item.title || item.id;    // survey text is sanitized by the runner (js/sanitize.js)
  box.append(q);
  if (item.type === 'info' || /^task_/.test(item.type || '')) return box;

  const v = view.answers[item.id];
  const options = view.optionsFor(item);
  const chosen = new Set((Array.isArray(v) ? v : v == null ? [] : [v]).map(String));
  if (item.type === 'yes_no') {
    const list = el('div', 'enc-mini-opts');
    [['yes', 'Sí'], ['no', 'No']].forEach(([c, l]) => list.append(el('span', 'enc-mini-opt' + (chosen.has(c) ? ' sel' : ''), l)));
    box.append(list);
  } else if (options.length) {
    const list = el('div', 'enc-mini-opts');
    options.slice(0, 6).forEach(o => list.append(el('span', 'enc-mini-opt' + (chosen.has(String(o.code)) ? ' sel' : ''), clip(String(o.label), 38))));
    if (options.length > 6) list.append(el('span', 'enc-mini-more', `+${options.length - 6}`));
    box.append(list);
  } else {
    const text = v == null || v === '' ? (view.hasAudio(item) ? '🎙 audio grabado' : '') : String(v);
    box.append(el('div', 'enc-mini-text' + (text ? ' has' : ''), text ? clip(text, 160) : '—'));
  }
  return box;
}
