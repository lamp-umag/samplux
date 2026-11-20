// samplux — encuestador-lab.html: tune the look of interviewer mode on a fake survey,
// keep it on this device, or download a zip (preferences + notes + a snapshot) to share.
import { DEFAULTS, loadPrefs, savePrefs, resetPrefs, applyPrefs } from './encPrefs.js';
import { staticBody } from './encCards.js';
import { makeZip } from './zip.js';

const $ = id => document.getElementById(id);
const scale5 = ['Nunca', 'A veces', 'Seguido', 'Siempre'].map((label, i) => ({ code: i + 1, label }));
const ITEMS = [
  { id: 'intro', type: 'info', prompt: 'SECCIÓN 1 — Datos generales' },
  { id: 'genero', type: 'single_choice', prompt: '¿Con qué género te identificas?', required: true, options: [{ code: 1, label: 'Mujer' }, { code: 2, label: 'Hombre' }, { code: 3, label: 'No binario' }, { code: 4, label: 'Prefiero no decirlo' }] },
  { id: 'edad', type: 'number', prompt: '¿Cuántos años tienes?' },
  { id: 'wb1', type: 'likert', prompt: 'Me siento tranquilo/a y en paz.', options: scale5 },
  { id: 'wb2', type: 'likert', prompt: 'Tengo energía para hacer lo que me importa.', options: scale5 },
  { id: 'intereses', type: 'multi_choice', prompt: '¿Qué temas te interesan? (marca todos los que apliquen)', options: ['Salud', 'Deporte', 'Música', 'Lectura', 'Viajes', 'Tecnología', 'Cocina', 'Cine'].map((label, i) => ({ code: i + 1, label })) },
  { id: 'pantallas', type: 'yes_no', prompt: '¿Usas pantallas más de 4 horas al día?' },
  { id: 'comentario', type: 'text', prompt: '¿Algún comentario sobre esta encuesta?' }
];
const answers = {};
let index = 1;
let prefs = loadPrefs();

const optionsFor = it => (it.type === 'yes_no' ? [] : it.options || []);
const view = { answers, optionsFor, hasAudio: () => false };
const plain = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

function stateOf(it, i) {
  if (it.type === 'info') return 'info';
  const v = answers[it.id];
  if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) return 'answered';
  return i < index ? 'skipped' : 'pending';
}

function activeBody(it) {
  const box = document.createElement('div');
  box.append(el('div', 'q', it.prompt));
  const opts = el('div', 'options');
  const next = () => { index = Math.min(ITEMS.length - 1, index + 1); render(); };
  if (it.type === 'info') { /* nothing to answer */ }
  else if (it.type === 'yes_no' || it.options) {
    const list = it.type === 'yes_no' ? [{ code: 'yes', label: 'Sí' }, { code: 'no', label: 'No' }] : it.options;
    const multi = it.type === 'multi_choice';
    list.forEach(o => {
      const cur = answers[it.id];
      const sel = multi ? (cur || []).includes(o.code) : cur === o.code;
      const b = el('button', 'opt' + (sel ? ' selected' : ''), o.label);
      b.onclick = () => {
        if (multi) { const s = new Set(answers[it.id] || []); s.has(o.code) ? s.delete(o.code) : s.add(o.code); answers[it.id] = [...s]; render(); }
        else { answers[it.id] = o.code; render(); setTimeout(next, 140); }
      };
      opts.append(b);
    });
  } else {
    const input = document.createElement('input');
    input.type = it.type === 'number' ? 'number' : 'text';
    input.value = answers[it.id] ?? '';
    input.oninput = () => { answers[it.id] = input.value; };
    opts.append(input);
  }
  box.append(opts);
  const c = el('div', 'controls');
  const back = el('button', 'btn secondary', '← Atrás'); back.onclick = () => { index = Math.max(0, index - 1); render(); };
  const nx = el('button', 'btn primary', 'Siguiente →'); nx.onclick = next;
  c.append(back, nx);
  box.append(c);
  return box;
}

function render() {
  const track = $('track');
  let n = 0;
  track.replaceChildren(...ITEMS.map((it, i) => {
    if (it.type !== 'info') n += 1;
    const state = stateOf(it, i);
    const active = i === index;
    const card = el('div', `enc-card ${state}${active ? ' active' : ''}`);
    const head = el('div', 'enc-card-head');
    head.append(el('span', 'n', it.type === 'info' ? 'Texto' : `${n}${it.required ? ' *' : ''}`));
    if (!active) head.append(el('span', 'tag', state === 'answered' ? '✓' : state === 'skipped' ? 'sin responder' : ''));
    card.append(head);
    if (active) card.append(activeBody(it));
    else {
      if (prefs.cardStyle === 'deck') card.append(staticBody(it, view));
      else {
        card.append(el('div', 'enc-card-prompt', plain(it.prompt).slice(0, 120)));
        const v = answers[it.id];
        card.append(el('div', 'enc-card-answer', state === 'answered' ? [].concat(v).map(c => (optionsFor(it).find(o => o.code === c) || { label: c === 'yes' ? 'Sí' : c === 'no' ? 'No' : c }).label).join(' · ') : ''));
      }
      card.onclick = () => { index = i; render(); };
    }
    card.style.zIndex = active ? '1000' : String(i);
    return card;
  }));
  const active = track.querySelector('.active');
  if (active) requestAnimationFrame(() => active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: prefs.layout === 'vertical' ? 'center' : 'nearest' }));
}

/* ── controls ─────────────────────────────────────────── */
const NUM = ['activeW', 'activeBorder', 'fontScale', 'compactW', 'deckW', 'deckH', 'overlap', 'scale', 'opacity', 'gap'];
function syncControls() {
  NUM.forEach(k => { const i = $(k); i.value = prefs[k]; i.previousElementSibling.textContent = prefs[k]; });
  $('shadow').value = prefs.shadow ? 1 : 0; $('shadow').previousElementSibling.textContent = prefs.shadow ? 'sí' : 'no';
  document.querySelectorAll('#cLayout button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.layout));
  document.querySelectorAll('#cCards button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.cardStyle));
}
function update() { applyPrefs(prefs); syncControls(); render(); }

NUM.forEach(k => $(k).addEventListener('input', e => { prefs[k] = Number(e.target.value); update(); }));
$('shadow').addEventListener('input', e => { prefs.shadow = e.target.value === '1'; update(); });
document.querySelectorAll('#cLayout button').forEach(b => b.onclick = () => { prefs.layout = b.dataset.v; update(); });
document.querySelectorAll('#cCards button').forEach(b => b.onclick = () => { prefs.cardStyle = b.dataset.v; update(); });
const PRESETS = {
  compact: { cardStyle: 'compact', gap: 12, scale: 1, opacity: 1 },
  soft: { cardStyle: 'deck', deckW: 300, overlap: 120, scale: 0.94, opacity: 0.92, gap: 0, deckH: 190 },
  tight: { cardStyle: 'deck', deckW: 340, overlap: 220, scale: 0.88, opacity: 0.85, gap: 0, deckH: 150 }
};
document.querySelectorAll('#presets button').forEach(b => b.onclick = () => { Object.assign(prefs, PRESETS[b.dataset.p]); update(); });

const say = t => { $('msg').textContent = t; setTimeout(() => { if ($('msg').textContent === t) $('msg').textContent = ''; }, 4000); };
$('saveBtn').onclick = () => { savePrefs(prefs); say('Guardado: el modo encuestador de este dispositivo usará estos valores.'); };
$('resetBtn').onclick = () => { resetPrefs(); prefs = { ...DEFAULTS }; update(); say('Valores originales restaurados.'); };

$('zipBtn').onclick = async () => {
  const stamp = new Date().toISOString();
  const info = { savedAt: stamp, preferences: prefs, defaultsForReference: DEFAULTS,
    device: { viewport: `${innerWidth}x${innerHeight}`, pixelRatio: devicePixelRatio, touch: navigator.maxTouchPoints > 0, userAgent: navigator.userAgent } };
  const css = (await Promise.all(['css/app.css', 'css/encuestador.css'].map(u => fetch(u).then(r => r.text()).catch(() => '')))).join('\n');
  const vars = document.body.getAttribute('style') || '';
  const snapshot = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Snapshot del modo encuestador</title><style>${css}</style></head>` +
    `<body class="enc" data-layout="${prefs.layout}" data-cards="${prefs.cardStyle}" style="${vars}"><div class="enc-track" style="padding-top:24px">${$('track').innerHTML}</div></body></html>`;
  const rows = Object.entries(prefs).map(([k, v]) => `| ${k} | ${v} | ${DEFAULTS[k]} |`).join('\n');
  const md = `# Preferencias del modo encuestador\n\nGuardado: ${stamp}\nPantalla: ${info.device.viewport} (táctil: ${info.device.touch ? 'sí' : 'no'})\n\n## Mis notas\n\n${$('notes').value.trim() || '(sin notas)'}\n\n## Valores\n\n| parámetro | mío | original |\n|---|---|---|\n${rows}\n`;
  const blob = makeZip([
    { name: 'preferencias.json', data: JSON.stringify(info, null, 2) },
    { name: 'notas.md', data: md },
    { name: 'snapshot.html', data: snapshot }
  ]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `samplux-encuestador-preferencias-${stamp.slice(0, 10)}.zip`;
  a.click();
  say('Zip descargado: contiene preferencias.json, notas.md y snapshot.html.');
};

update();
