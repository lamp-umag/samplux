// ─────────────────────────────────────────────────────────────
// samplux — interviewer mode (encuestador.html). See docs/ENCUESTADOR.md.
// ─────────────────────────────────────────────────────────────
// The survey engine is the same surveyRunner.js that participants use: this file
// only (1) draws the carousel of item cards around the item being asked, (2) lets
// the interviewer jump between items, (3) hands the device to the respondent for
// private items and tasks, (4) stores each finished case in an offline outbox and
// (5) stamps every response with an `interviewer` block.
// ─────────────────────────────────────────────────────────────
import { db } from './firebaseClient.js';
import { collection, getDocsFromServer, query, where } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { createSurveyApp } from './surveyRunner.js';
import { enqueue, syncOutbox, pendingCount, exportBackup } from './outbox.js';
import { loadPrefs, savePrefs, applyPrefs } from './encPrefs.js';
import { staticBody } from './encCards.js';
import { notifyRespondentHandoff, getNativeInterviewerTelemetry } from './nativeBridge.js';

const $ = id => document.getElementById(id);
const LS_SESSION = 'samplux.enc.session';
const LS_SURVEYS = 'samplux.enc.surveys';   // { [id]: survey definition } — for starting offline
const FETCH_TIMEOUT_MS = 6000;

const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } };
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const plain = html => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const track = $('track');
const stage = $('stage');
// Grabbed once: the stage is detached while the strip is rebuilt, so lookups by id would miss.
const questionEl = document.getElementById('question');
const optionsEl = document.getElementById('options');
const controlsEl = document.getElementById('controls');

let session = readJson(LS_SESSION, null) || {};
const prefs = loadPrefs();
if (session.layout === 'vertical' || session.layout === 'horizontal') prefs.layout = session.layout;
if (session.cardStyle === 'deck' || session.cardStyle === 'compact') prefs.cardStyle = session.cardStyle;
applyPrefs(prefs);
let layout = prefs.layout;
let cardStyle = prefs.cardStyle;
let surveyDef = null;
let caseMeta = null;          // per-case counters that end up in `interviewer`
let respondentView = false;   // the respondent is holding the device
let lastIndex = -1;

/* ── Engine ───────────────────────────────────────────── */
const app = createSurveyApp({
  db,
  elements: {
    header: document.createElement('div'),
    homeSection: document.createElement('div'),
    listContainer: null,
    runnerSection: $('runner'),
    metaContainer: $('meta'),
    bar: $('bar'),
    questionContainer: questionEl,
    optionsContainer: optionsEl,
    controlsContainer: controlsEl,
    footnoteContainer: $('footnote'),
    splashOverlay: null
  },
  hooks: {
    onRender: renderTrack,
    interviewer: () => ({
      mode: 'encuestador',
      v: 1,
      interviewerId: session.interviewerId,
      site: session.site || null,
      sessionId: session.sessionId,
      caseNumber: session.caseNumber,
      layout,
      cardStyle,
      layoutSwitches: caseMeta.layoutSwitches,
      jumps: caseMeta.jumps,
      handoffItems: caseMeta.handoffItems,
      startedAt: caseMeta.startedAt,
      online: navigator.onLine,
      ...(getNativeInterviewerTelemetry() && { nativeTelemetry: getNativeInterviewerTelemetry() })
    }),
    // Always save locally first; the upload happens in the background.
    deliver: async sub => { await enqueue(sub); sync(); },
    onSubmitted: () => finishCase('guardado'),
    onDeclined: () => finishCase('rechazo')
  }
});

/* ── Layout ───────────────────────────────────────────── */
function setLayout(next, { count = false } = {}) {
  if (count && next !== layout && caseMeta) caseMeta.layoutSwitches += 1;
  layout = next;
  document.body.dataset.layout = layout;
  document.querySelectorAll('[data-layout]').forEach(b => { if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.layout === layout); });
  session.layout = layout;
  writeJson(LS_SESSION, session);
  const active = track.querySelector('.enc-card.active');
  if (active) centre(active);
}
function centre(card) {
  requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: layout === 'vertical' ? 'center' : 'nearest' }));
}
document.querySelectorAll('#layoutToggle button, #sLayout button').forEach(b => {
  b.onclick = () => setLayout(b.dataset.layout, { count: true });
});
function setCards(next, { count = false } = {}) {
  if (count && next !== cardStyle && caseMeta) caseMeta.layoutSwitches += 1;
  cardStyle = next;
  document.body.dataset.cards = cardStyle;
  document.querySelectorAll('[data-cards]').forEach(b => { if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.cards === cardStyle); });
  session.cardStyle = cardStyle;
  writeJson(LS_SESSION, session);
  if (app.getState() && !app.getState().finished) rerenderTrack();
}
document.querySelectorAll('#styleToggle button, #sCards button').forEach(b => { b.onclick = () => setCards(b.dataset.cards, { count: true }); });

/* ── Carousel ─────────────────────────────────────────── */
const isHandoff = item => !!item && (item.handoff === true || /^task_/.test(item.type || ''));

function answerSummary(item, st) {
  const v = st.answers[item.id];
  if (isHandoff(item)) return '● respondida en privado';
  if (v == null || v === '') return st.audioClips[item.id] ? '🎙 audio grabado' : '';
  if (/^task_/.test(item.type || '')) return 'tarea completada';
  if (item.type === 'yes_no') return v === 'yes' ? 'Sí' : 'No';
  const options = st.optionsFor(item);
  const label = code => {
    const o = options.find(opt => String(opt.code) === String(code));
    return o ? o.label : String(code);
  };
  let text;
  if (Array.isArray(v)) text = item.type === 'ranking' ? v.map((c, i) => `${i + 1}. ${label(c)}`).join(' · ') : v.map(label).join(' · ');
  else if (options.length) text = label(v);
  else text = String(v);
  const extra = item.followUp && st.answers[item.followUp.id] ? ` — ${st.answers[item.followUp.id]}` : '';
  return clip(text + extra, 90);
}

function cardState(item, st) {
  if (item.type === 'info') return 'info';
  if (!st.isEmpty(item)) return 'answered';
  return st.visited.has(item.id) ? 'skipped' : 'pending';
}

let lastRender = null;
function rerenderTrack() { if (lastRender) renderTrack(lastRender); }

function renderTrack(args) {
  lastRender = args;
  const { index, item, atEnd } = args;
  const st = app.getState();
  if (!st) return;
  const items = st.survey.items;

  // Hand-off: the device changes hands when we enter or leave a run of private items.
  const wantRespondent = !atEnd && isHandoff(item);
  if (wantRespondent && !caseMeta.handoffItems.includes(item.id)) caseMeta.handoffItems.push(item.id);
  if (wantRespondent !== respondentView) {
    respondentView = wantRespondent;
    document.body.classList.toggle('respondent', respondentView);
    notifyRespondentHandoff(respondentView, item?.id || null);
    if (respondentView) {
      interstitial('🤝', 'Entrega el dispositivo', 'La siguiente parte la responde la persona encuestada por sí misma. Sus respuestas no se mostrarán a quien encuesta.', 'Soy quien responde · comenzar');
    } else {
      interstitial('↩', 'Devuelve el dispositivo', 'Gracias. Entrégaselo a la persona que te está encuestando.', 'Continuar');
    }
  }

  stage.remove();
  const cards = [];
  let number = 0;
  let answered = 0;
  let answerable = 0;
  let firstSkipped = -1;
  let activeCard = null;

  items.forEach((it, i) => {
    if (!st.isVisible(it)) return;
    const state = cardState(it, st);
    const isActive = i === index;
    if (it.type !== 'info') {
      number += 1; answerable += 1;
      if (state === 'answered') answered += 1;
      if (state === 'skipped' && !isActive && firstSkipped < 0) firstSkipped = i;
    }
    const locked = st.gateIndex >= 0 && i > st.gateIndex;
    const card = el('div', `enc-card ${state}${isActive ? ' active' : ''}${locked ? ' locked' : ''}`);
    const head = el('div', 'enc-card-head');
    head.append(el('span', 'n', it.type === 'info' ? 'Texto' : `${number}${it.required ? ' *' : ''}`));
    if (it.section) head.append(el('span', '', clip(it.section, 28)));
    if (!isActive) head.append(el('span', 'tag', state === 'answered' ? '✓' : state === 'skipped' ? 'sin responder' : ''));
    card.append(head);
    if (isActive) {
      card.append(stage);
      activeCard = card;
    } else {
      card.append(el('div', 'enc-card-prompt', clip(plain(it.type === 'info' ? String(it.prompt || '').split('\n')[0] : (it.prompt || it.title || it.id)), 120)));
      card.append(el('div', 'enc-card-answer', state === 'answered' ? answerSummary(it, st) : ''));
      if (cardStyle === 'deck') card.append(staticBody(it, { answers: st.answers, optionsFor: st.optionsFor, hasAudio: x => !!st.audioClips[x.id] }));
      if (!locked) card.onclick = () => { caseMeta.jumps += 1; app.goTo(i); };
    }
    card.style.zIndex = isActive ? '1000' : String(i);
    cards.push(card);
  });

  // The send card closes the strip.
  const endCard = el('div', `enc-card ${atEnd ? 'active' : 'pending'}${st.gateIndex >= 0 ? ' locked' : ''}`);
  endCard.append(Object.assign(el('div', 'enc-card-head'), { textContent: 'Enviar' }));
  if (atEnd) { endCard.append(stage); activeCard = endCard; review(st); }
  else {
    endCard.append(el('div', 'enc-card-prompt', 'Revisar y enviar'));
    if (st.gateIndex < 0) endCard.onclick = () => { caseMeta.jumps += 1; app.goTo(items.length); };
  }
  cards.push(endCard);

  track.replaceChildren(...cards);
  if (activeCard) centre(activeCard);
  // With a keyboard, the cursor goes straight into the field to type.
  if (!respondentView && window.matchMedia('(hover: hover)').matches) {
    stage.querySelector('input:not([type="range"]):not([type="file"]), textarea')?.focus({ preventScroll: true });
  }

  // Top bar
  const missing = $('barMissing');
  const skippedCount = cards.filter(c => c.classList.contains('skipped') && !c.classList.contains('active')).length;
  missing.textContent = skippedCount ? `${skippedCount} sin responder` : `${answered}/${answerable} respondidas`;
  missing.classList.toggle('alert', skippedCount > 0);
  missing.onclick = () => { if (firstSkipped >= 0) { caseMeta.jumps += 1; app.goTo(firstSkipped); } };
  lastIndex = index;
}

/** On the send screen: what is still empty, required items first; required ones block sending. */
function review(st) {
  const empty = st.survey.items.map((it, i) => ({ it, i }))
    .filter(({ it }) => it.type !== 'info' && st.isVisible(it) && st.isEmpty(it));
  questionEl.querySelector('.enc-review')?.remove();
  if (!empty.length) return;
  const required = empty.filter(e => e.it.required);
  const box = el('div', 'enc-review');
  box.append(el('p', '', required.length
    ? `Faltan ${required.length} pregunta(s) obligatoria(s). Tócalas para volver a ellas.`
    : `${empty.length} pregunta(s) quedaron sin responder. Puedes enviar así o volver a ellas.`));
  [...required, ...empty.filter(e => !e.it.required)].slice(0, 12).forEach(({ it, i }) => {
    const b = el('button', it.required ? 'required' : '', clip(plain(it.prompt || it.id), 90) + (it.required ? ' *' : ''));
    b.onclick = () => { caseMeta.jumps += 1; app.goTo(i); };
    box.append(b);
  });
  if (empty.length > 12) box.append(el('p', 'tiny', `…y ${empty.length - 12} más.`));
  questionEl.append(box);
  const send = controlsEl.querySelector('.btn.primary');
  if (send && required.length) send.disabled = true;
}

/* ── Hand-off screen ──────────────────────────────────── */
function interstitial(icon, title, text, button) {
  $('handoffIcon').textContent = icon;
  $('handoffTitle').textContent = title;
  $('handoffText').textContent = text;
  $('handoffBtn').textContent = button;
  $('handoff').hidden = false;
  $('handoffBtn').onclick = () => { $('handoff').hidden = true; };
}

/* ── Keyboard (desktop interviewers) ──────────────────── */
document.addEventListener('keydown', e => {
  if ($('runner').style.display !== 'block' || !$('handoff').hidden || respondentView) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const st = app.getState();
  if (!st || st.finished) return;
  if (!typing && /^[1-9]$/.test(e.key)) {
    const opt = optionsEl.querySelectorAll('.opt')[Number(e.key) - 1];
    if (opt) { e.preventDefault(); opt.click(); }
  } else if (!typing && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    const buttons = controlsEl.querySelectorAll('.btn');
    const target = e.key === 'ArrowLeft' ? buttons[0] : buttons[buttons.length - 1];
    if (target && !(e.key === 'ArrowRight' && st.currentIndex >= st.survey.items.length)) target.click();
  } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'BUTTON') {
    const next = controlsEl.querySelector('.btn.primary');
    if (next && !next.disabled && st.currentIndex < st.survey.items.length) { e.preventDefault(); next.click(); }
  }
});

/* ── Case loop ────────────────────────────────────────── */
function newCase() {
  caseMeta = { startedAt: new Date().toISOString(), jumps: 0, layoutSwitches: 0, handoffItems: [] };
  respondentView = false;
  lastIndex = -1;
  document.body.classList.remove('respondent', 'done');
  $('handoff').hidden = true;
  updateBar();
  return app.startSurveyData(surveyDef);
}

function finishCase(outcome) {
  respondentView = false;
  document.body.classList.remove('respondent');
  document.body.classList.add('done');
  $('handoff').hidden = true;
  if (outcome === 'guardado') session.completed = (session.completed || 0) + 1;
  else session.declined = (session.declined || 0) + 1;

  // Only the finished card stays on screen.
  stage.remove();
  const card = el('div', 'enc-card active answered');
  card.append(stage);
  track.replaceChildren(card);
  $('barMissing').textContent = '';
  if (outcome === 'guardado') {
    // The default thank-you talks about closing the window; here the device stays in use.
    questionEl.replaceChildren(
      el('p', 'enc-saved', `Caso ${session.caseNumber} guardado en este dispositivo.`),
      el('div', 'q', '¡Muchas gracias por participar!'));
  }
  const next = el('button', 'btn primary', 'Siguiente persona →');
  next.onclick = () => {
    session.caseNumber += 1;
    writeJson(LS_SESSION, session);
    newCase();
  };
  controlsEl.replaceChildren(next);
  writeJson(LS_SESSION, session);
  updateBar();
  window.scrollTo(0, 0);
}

function updateBar() {
  $('barTitle').textContent = surveyDef ? (surveyDef.title || surveyDef.id) : '';
  $('barCase').textContent = session.sessionId
    ? `${session.interviewerId} · caso ${session.caseNumber}${session.declined ? ` · ${session.declined} rechazo(s)` : ''}`
    : '';
}

/* ── Outbox / sync ────────────────────────────────────── */
async function refreshSync(note) {
  let n = 0;
  try { n = await pendingCount(); } catch { /* IndexedDB unavailable */ }
  const chip = $('barSync');
  chip.textContent = n ? `${n} por subir${navigator.onLine ? '' : ' · sin conexión'}` : (navigator.onLine ? 'todo subido ✓' : 'sin conexión');
  chip.classList.toggle('alert', n > 0);
  $('sBackup').hidden = n === 0;
  const status = $('sStatus');
  if (status) {
    status.querySelector('[data-k="queue"]')?.remove();
    const line = el('div');
    line.dataset.k = 'queue';
    line.innerHTML = n
      ? `<b>${n}</b> caso(s) guardados en este dispositivo, por subir.${note ? ` <span class="tiny">${note}</span>` : ''}`
      : 'No hay casos pendientes de subir.';
    status.append(line);
  }
  return n;
}
async function sync() {
  await refreshSync();
  if (!navigator.onLine) return;
  const result = await syncOutbox(db, () => refreshSync());
  await refreshSync(result.error ? `Último intento: ${result.error}.` : '');
}
$('barSync').onclick = sync;
window.addEventListener('online', sync);
window.addEventListener('offline', () => refreshSync());
setInterval(() => { if (navigator.onLine) sync(); }, 60000);

$('sBackup').onclick = async () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await exportBackup());
  a.download = `samplux-pendientes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};

/* ── Offline readiness ────────────────────────────────── */
const SHELL = [
  'encuestador.html', 'css/app.css', 'css/encuestador.css',
  'js/encuestador.js', 'js/firebaseClient.js', 'js/surveyRunner.js', 'js/outbox.js', 'js/consent.js',
  'js/receiptView.js', 'js/vendor/qrcode.js', 'js/deviceInfo.js', 'js/audioRecorder.js', 'js/nativeBridge.js',
  'js/tasks/helpers.js', 'js/tasks/rt.js', 'js/tasks/stroop.js', 'js/tasks/gonogo.js',
  'https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js'
];
async function prepareOffline() {
  const line = el('div');
  $('sStatus').prepend(line);
  if (!('serviceWorker' in navigator) || !window.caches) {
    line.textContent = 'Este navegador no permite trabajar sin conexión: se necesita internet durante la aplicación.';
    return;
  }
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (navigator.onLine) {
      const cache = await caches.open('samplux-shell-v1');
      await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' }))));
    }
    const cached = await caches.match('js/encuestador.js');
    line.innerHTML = cached
      ? '<b>Lista para usar sin conexión ✓</b> — la aplicación quedó guardada en este dispositivo.'
      : 'Aún no está guardada para usarse sin conexión: ábrela una vez con internet.';
  } catch (e) {
    console.warn('[encuestador] sin modo offline', e);
    line.textContent = 'No se pudo preparar el modo sin conexión en este navegador.';
  }
}

/* ── Setup ────────────────────────────────────────────── */
async function loadSurveys() {
  const cache = readJson(LS_SURVEYS, {});
  try {
    // FromServer: offline, a plain getDocs would answer with an empty cached result
    // and wipe the copy we keep for exactly that situation.
    const snap = await withTimeout(getDocsFromServer(query(collection(db, 'surveys'), where('published', '==', true))), FETCH_TIMEOUT_MS);
    const fresh = {};
    snap.docs.forEach(d => { fresh[d.id] = { id: d.id, ...d.data() }; });
    writeJson(LS_SURVEYS, fresh);
    // Warm the cache with any base file a survey extends, so it also resolves offline.
    Object.values(fresh).forEach(s => {
      const base = typeof s.extends === 'string' ? s.extends : s.extends?.file;
      if (base && /^[a-zA-Z0-9._-]+\.json$/.test(base)) fetch(`surveys/${base}`).catch(() => {});
    });
    return { surveys: fresh, fromCache: false };
  } catch {
    return { surveys: cache, fromCache: true };
  }
}

async function showSetup() {
  $('runner').style.display = 'none';
  $('setup').style.display = '';
  document.body.classList.remove('respondent', 'done');
  $('encBar').querySelectorAll('#barMissing,#barCase,#layoutToggle,#styleToggle,#barExit').forEach(n => { n.style.display = 'none'; });
  surveyDef = null;
  updateBar();
  $('sWho').value = session.interviewerId || '';
  $('sSite').value = session.site || '';
  setLayout(layout);
  setCards(cardStyle);

  const { surveys, fromCache } = await loadSurveys();
  const list = Object.values(surveys).sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  const wanted = new URL(location.href).searchParams.get('survey') || session.surveyId;
  $('sSurvey').replaceChildren(...list.map(s => {
    const o = el('option', '', s.title || s.id);
    o.value = s.id;
    if (s.id === wanted) o.selected = true;
    return o;
  }));
  $('sMsg').textContent = !list.length
    ? 'No hay encuestas disponibles. Conéctate a internet una vez para descargarlas.'
    : fromCache ? 'Sin conexión: se usan las encuestas guardadas en este dispositivo.' : '';
  $('sStart').disabled = !list.length;

  $('sStart').onclick = () => {
    const who = $('sWho').value.trim();
    if (!who) { $('sMsg').textContent = 'Escribe tu código o nombre: queda registrado con cada caso.'; $('sWho').focus(); return; }
    surveyDef = surveys[$('sSurvey').value];
    if (!surveyDef) return;
    session = {
      interviewerId: who, site: $('sSite').value.trim(), layout, cardStyle, surveyId: surveyDef.id,
      sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      caseNumber: 1, completed: 0, declined: 0
    };
    writeJson(LS_SESSION, session);
    $('setup').style.display = 'none';
    $('encBar').querySelectorAll('#barMissing,#barCase,#layoutToggle,#styleToggle,#barExit').forEach(n => { n.style.display = ''; });
    newCase();
  };
}

$('barExit').onclick = () => {
  const st = app.getState();
  const inProgress = st && !st.finished && Object.keys(st.answers).length > 0;
  if (inProgress && !confirm('Hay un caso sin enviar. Si terminas ahora se pierde. ¿Terminar?')) return;
  app.stop();
  showSetup();
};
window.addEventListener('beforeunload', e => {
  const st = app.getState();
  if ($('runner').style.display === 'block' && st && !st.finished && Object.keys(st.answers).length > 0) e.preventDefault();
});

$('sStatus').replaceChildren();
prepareOffline();
showSetup();
sync();
