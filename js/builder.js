import { app, db } from './firebaseClient.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import { createSurveyApp } from './surveyRunner.js';

// Keep in sync with ALLOWED_EMAILS in js/admin.js and js/adminStats.js,
// and with the isAdmin() list in firestore.rules.
const ALLOWED_EMAILS = new Set([
  'hermanelgueta@gmail.com',
  'herman.elgueta@umag.cl'
]);

const auth = getAuth(app);

const el = id => document.getElementById(id);

const authCard = el('authCard');
const loginBtn = el('loginBtn');
const authError = el('authError');
const userChip = el('userChip');
const userEmailEl = el('userEmailEl');
const listView = el('listView');
const editorView = el('editorView');
const surveyListContainer = el('surveyListContainer');
const newSurveyBtn = el('newSurveyBtn');
const importBtn = el('importBtn');
const importFile = el('importFile');
const closeEditorBtn = el('closeEditorBtn');
const saveStatus = el('saveStatus');
const deleteSurveyBtn = el('deleteSurveyBtn');
const previewBtn = el('previewBtn');
const saveSurveyBtn = el('saveSurveyBtn');

const fId = el('f-id');
const fTitle = el('f-title');
const fDescription = el('f-description');
const fPublished = el('f-published');
const fRandomize = el('f-randomize');
const fSplashEnabled = el('f-splashEnabled');
const splashFields = el('splashFields');
const fSplashImage = el('f-splashImage');
const fSplashDuration = el('f-splashDuration');

const scalesContainer = el('scalesContainer');
const addScaleBtn = el('addScaleBtn');
const itemsContainer = el('itemsContainer');
const addItemBtn = el('addItemBtn');

const previewOverlay = el('previewOverlay');
const closePreviewBtn = el('closePreviewBtn');

// ── Type catalogue ──────────────────────────────────────────
const TYPE_LABELS = {
  info: 'Texto informativo / sección',
  text: 'Texto corto o largo',
  email: 'Correo electrónico',
  url: 'URL',
  phone: 'Teléfono',
  number: 'Número',
  date: 'Fecha',
  time: 'Hora',
  single_choice: 'Opción única',
  multi_choice: 'Opción múltiple',
  slider: 'Escala deslizante (slider)',
  yes_no: 'Sí / No',
  file: 'Archivo (solo nombre, no sube el archivo)',
  task_rt: 'Tarea cognitiva — Tiempo de reacción',
  task_stroop: 'Tarea cognitiva — Stroop',
  task_gonogo: 'Tarea cognitiva — Go / No-Go'
};
const TYPE_ORDER = ['info', 'text', 'email', 'url', 'phone', 'number', 'date', 'time',
  'single_choice', 'multi_choice', 'slider', 'yes_no', 'file', 'task_rt', 'task_stroop', 'task_gonogo'];
const NO_REQUIRED_TYPES = new Set(['info', 'task_rt', 'task_stroop', 'task_gonogo']);
const TEXTLIKE_TYPES = new Set(['text', 'email', 'url', 'phone']);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Auth ─────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  if (user && ALLOWED_EMAILS.has((user.email || '').toLowerCase())) {
    authCard.classList.add('hidden');
    listView.classList.remove('hidden');
    userChip.classList.remove('hidden');
    userEmailEl.textContent = user.email;
    loadSurveyList();
  } else {
    authCard.classList.remove('hidden');
    listView.classList.add('hidden');
    editorView.classList.add('hidden');
    if (user) {
      authError.textContent = 'Tu cuenta de Google no está autorizada para acceder al constructor.';
      authError.classList.remove('hidden');
      userChip.classList.remove('hidden');
      userEmailEl.textContent = user.email || '';
    }
  }
});

loginBtn.addEventListener('click', async () => {
  authError.classList.add('hidden');
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    console.error(e);
    authError.textContent = 'No se pudo iniciar sesión. Intenta de nuevo.';
    authError.classList.remove('hidden');
  }
});

// ── State ────────────────────────────────────────────────────
let surveysCache = [];
let currentSurvey = null;
let savedSnapshot = null;
const expandedIds = new Set();

function blankSurvey() {
  return {
    id: '', title: '', description: '',
    published: false,
    settings: { randomizeItems: false, splash: { enabled: false, image: '', durationMs: 1000 } },
    optionSets: {},
    items: [],
    _isNew: true
  };
}

let itemSeq = 0;
function blankItem() {
  itemSeq += 1;
  return { id: `item_${Date.now().toString(36)}_${itemSeq}`, type: 'text', prompt: '', required: false };
}

function isDirty() {
  if (!currentSurvey) return false;
  return JSON.stringify(currentSurvey) !== savedSnapshot;
}

// ── Survey list ──────────────────────────────────────────────
async function loadSurveyList() {
  surveyListContainer.innerHTML = '<p class="muted small">Cargando…</p>';
  try {
    const snap = await getDocs(collection(db, 'surveys'));
    surveysCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSurveyList();
  } catch (e) {
    console.error(e);
    surveyListContainer.innerHTML = '<p class="danger small">No se pudieron cargar las encuestas.</p>';
  }
}

function renderSurveyList() {
  if (surveysCache.length === 0) {
    surveyListContainer.innerHTML = '<div class="empty-state">Aún no hay encuestas. Crea una nueva o importa un JSON existente.</div>';
    return;
  }
  surveyListContainer.innerHTML = '';
  surveysCache.forEach(s => {
    const card = document.createElement('div');
    card.className = 'survey-card';
    card.innerHTML = `
      <div class="survey-card-top">
        <div>
          <div style="font-weight:700;font-size:14px;">${escapeHtml(s.title || '(sin título)')}</div>
          <div class="small">${escapeHtml(s.id)} · ${(s.items || []).length} ítems</div>
        </div>
        <span class="badge ${s.published ? 'badge-ok' : 'badge-off'}">${s.published ? 'Publicada' : 'Borrador'}</span>
      </div>
      <div class="survey-card-actions mt-8">
        <button type="button" class="btn btn-outline btn-sm" data-act="edit">Editar</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="run" ${s.published ? '' : 'disabled'}>Abrir encuesta</button>
      </div>`;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(structuredClone(s)));
    const runBtn = card.querySelector('[data-act="run"]');
    if (s.published) runBtn.addEventListener('click', () => window.open(`index.html?survey=${encodeURIComponent(s.id)}`, '_blank'));
    surveyListContainer.appendChild(card);
  });
}

newSurveyBtn.addEventListener('click', () => openEditor(blankSurvey()));

importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files && importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      alert('El archivo no tiene la forma esperada de una encuesta (falta "items").');
      return;
    }
    const draft = {
      id: parsed.id || '',
      title: parsed.title || '',
      description: parsed.description || '',
      published: false,
      settings: {
        randomizeItems: (parsed.settings && parsed.settings.randomizeItems) || false,
        splash: {
          enabled: !!(parsed.settings && parsed.settings.splash && parsed.settings.splash.enabled),
          image: (parsed.settings && parsed.settings.splash && (parsed.settings.splash.image || parsed.settings.splash.imageSrc || parsed.settings.splash.src)) || '',
          durationMs: (parsed.settings && parsed.settings.splash && parsed.settings.splash.durationMs) || 1000
        }
      },
      optionSets: parsed.optionSets || {},
      items: parsed.items,
      _isNew: true
    };
    openEditor(draft);
    saveStatus.textContent = 'Importado — revisa y guarda para publicar.';
  } catch (e) {
    console.error(e);
    alert('No se pudo leer el archivo como JSON válido.');
  }
});

// ── Editor: open / close ────────────────────────────────────
function openEditor(survey) {
  currentSurvey = survey;
  expandedIds.clear();
  fId.value = survey.id || '';
  fId.disabled = !survey._isNew;
  fTitle.value = survey.title || '';
  fDescription.value = survey.description || '';
  fPublished.checked = !!survey.published;
  fRandomize.value = String((survey.settings && survey.settings.randomizeItems) || false);
  const splash = (survey.settings && survey.settings.splash) || {};
  fSplashEnabled.checked = !!splash.enabled;
  fSplashImage.value = splash.image || '';
  fSplashDuration.value = splash.durationMs || 1000;
  splashFields.classList.toggle('hidden', !splash.enabled);
  saveStatus.textContent = survey._isNew ? '' : 'Sin cambios';

  renderScales();
  renderItems();

  savedSnapshot = JSON.stringify(currentSurvey);
  listView.classList.add('hidden');
  editorView.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'details'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'details'));
  window.scrollTo(0, 0);
}

closeEditorBtn.addEventListener('click', () => {
  if (isDirty() && !confirm('Tienes cambios sin guardar. ¿Salir de todos modos?')) return;
  currentSurvey = null;
  editorView.classList.add('hidden');
  listView.classList.remove('hidden');
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
  });
});

// ── Details tab bindings ────────────────────────────────────
fTitle.addEventListener('input', () => { currentSurvey.title = fTitle.value; syncSaveStatus(); });
fDescription.addEventListener('input', () => { currentSurvey.description = fDescription.value; syncSaveStatus(); });
fPublished.addEventListener('change', () => { currentSurvey.published = fPublished.checked; syncSaveStatus(); });
fRandomize.addEventListener('change', () => {
  currentSurvey.settings.randomizeItems = fRandomize.value === 'false' ? false : fRandomize.value;
  syncSaveStatus();
});
fSplashEnabled.addEventListener('change', () => {
  currentSurvey.settings.splash.enabled = fSplashEnabled.checked;
  splashFields.classList.toggle('hidden', !fSplashEnabled.checked);
  syncSaveStatus();
});
fSplashImage.addEventListener('input', () => { currentSurvey.settings.splash.image = fSplashImage.value; syncSaveStatus(); });
fSplashDuration.addEventListener('input', () => { currentSurvey.settings.splash.durationMs = Number(fSplashDuration.value) || 1000; syncSaveStatus(); });

function syncSaveStatus() {
  saveStatus.textContent = isDirty() ? 'Cambios sin guardar' : 'Sin cambios';
}

// ── Scales (optionSets) tab ─────────────────────────────────
function renderScales() {
  const names = Object.keys(currentSurvey.optionSets || {});
  if (names.length === 0) {
    scalesContainer.innerHTML = '<p class="muted small">Sin escalas compartidas todavía.</p>';
  } else {
    scalesContainer.innerHTML = '';
    names.forEach(name => scalesContainer.appendChild(buildScaleCard(name)));
  }
}

function buildScaleCard(name) {
  const card = document.createElement('div');
  card.className = 'card';
  const opts = currentSurvey.optionSets[name] || [];
  const usedBy = (currentSurvey.items || []).filter(it => it.type === name).length;

  const rowsHtml = opts.map((o, i) => `
    <div class="opt-row" data-i="${i}">
      <input class="input opt-row-code" data-f="code" value="${escapeHtml(o.code)}" placeholder="código" />
      <input class="input" data-f="label" value="${escapeHtml(o.label)}" placeholder="etiqueta" />
      <button type="button" class="btn btn-icon btn-danger" data-act="del-opt">✕</button>
    </div>`).join('');

  card.innerHTML = `
    <div class="card-header">
      <h3>${escapeHtml(name)} ${usedBy > 0 ? `<span class="small muted">· usada por ${usedBy} ítem(s)</span>` : ''}</h3>
      <button type="button" class="btn btn-icon btn-danger" data-act="del-scale" ${usedBy > 0 ? 'disabled title="En uso — no se puede eliminar"' : ''}>🗑</button>
    </div>
    <div class="opts-list">${rowsHtml}</div>
    <button type="button" class="btn btn-outline btn-sm mt-8" data-act="add-opt">+ Opción</button>
  `;

  const list = card.querySelector('.opts-list');
  function wireRow(rowEl, index) {
    rowEl.querySelector('[data-f="code"]').addEventListener('input', e => { opts[index].code = e.target.value; });
    rowEl.querySelector('[data-f="label"]').addEventListener('input', e => { opts[index].label = e.target.value; });
    rowEl.querySelector('[data-act="del-opt"]').addEventListener('click', () => {
      opts.splice(index, 1);
      renderScales();
      renderItems();
    });
  }
  Array.from(list.children).forEach((rowEl, i) => wireRow(rowEl, i));

  card.querySelector('[data-act="add-opt"]').addEventListener('click', () => {
    opts.push({ code: opts.length + 1, label: '' });
    renderScales();
  });
  const delScaleBtn = card.querySelector('[data-act="del-scale"]');
  if (usedBy === 0) {
    delScaleBtn.addEventListener('click', () => {
      if (!confirm(`¿Eliminar la escala "${name}"?`)) return;
      delete currentSurvey.optionSets[name];
      renderScales();
      renderItems();
    });
  }
  return card;
}

addScaleBtn.addEventListener('click', () => {
  const raw = prompt('Nombre de la nueva escala (ej. acuerdo_5):');
  if (!raw) return;
  const name = slugify(raw);
  if (!name) return;
  if (currentSurvey.optionSets[name]) { alert('Ya existe una escala con ese nombre.'); return; }
  currentSurvey.optionSets[name] = [
    { code: 1, label: 'Totalmente en desacuerdo' },
    { code: 2, label: 'En desacuerdo' },
    { code: 3, label: 'Ni de acuerdo ni en desacuerdo' },
    { code: 4, label: 'De acuerdo' },
    { code: 5, label: 'Totalmente de acuerdo' }
  ];
  renderScales();
});

// ── Items tab ────────────────────────────────────────────────
function effectiveType(item) {
  if (currentSurvey.optionSets && currentSurvey.optionSets[item.type]) return 'single_choice';
  return item.type;
}

function itemPreviewText(item) {
  const p = (item.prompt || '').split('\n')[0].trim();
  return p || `(${TYPE_LABELS[effectiveType(item)] || item.type})`;
}

function renderItems() {
  itemsContainer.innerHTML = '';
  if (!currentSurvey.items.length) {
    itemsContainer.innerHTML = '<div class="empty-state">Sin ítems todavía. Agrega el primero abajo.</div>';
    return;
  }
  currentSurvey.items.forEach((item, index) => {
    itemsContainer.appendChild(buildItemCard(item, index));
  });
}

function moveItem(itemId, delta) {
  const items = currentSurvey.items;
  const i = items.findIndex(it => it.id === itemId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  renderItems();
  syncSaveStatus();
}

function removeItem(itemId) {
  if (!confirm('¿Eliminar este ítem?')) return;
  currentSurvey.items = currentSurvey.items.filter(it => it.id !== itemId);
  renderItems();
  syncSaveStatus();
}

function buildItemCard(item, index) {
  const card = document.createElement('div');
  card.className = 'item-card' + (expandedIds.has(item.id) ? ' expanded' : '');

  const head = document.createElement('div');
  head.className = 'item-card-head';
  head.innerHTML = `
    <span class="item-order">${index + 1}</span>
    <span class="item-type-badge" data-role="badge">${escapeHtml(TYPE_LABELS[effectiveType(item)] || item.type)}</span>
    <span class="item-preview-text" data-role="preview">${escapeHtml(itemPreviewText(item))}</span>
    <span class="item-controls">
      <button type="button" class="btn btn-icon btn-outline" data-act="up" title="Subir">↑</button>
      <button type="button" class="btn btn-icon btn-outline" data-act="down" title="Bajar">↓</button>
      <button type="button" class="btn btn-icon btn-danger" data-act="del" title="Eliminar">🗑</button>
    </span>`;

  const body = document.createElement('div');
  body.className = 'item-card-body';

  const badgeEl = head.querySelector('[data-role="badge"]');
  const previewEl = head.querySelector('[data-role="preview"]');
  function refreshHead() {
    badgeEl.textContent = TYPE_LABELS[effectiveType(item)] || item.type;
    previewEl.textContent = itemPreviewText(item);
  }

  renderItemBody(item, body, refreshHead);

  head.addEventListener('click', e => {
    if (e.target.closest('[data-act]')) return;
    if (expandedIds.has(item.id)) expandedIds.delete(item.id); else expandedIds.add(item.id);
    card.classList.toggle('expanded');
  });
  head.querySelector('[data-act="up"]').addEventListener('click', e => { e.stopPropagation(); moveItem(item.id, -1); });
  head.querySelector('[data-act="down"]').addEventListener('click', e => { e.stopPropagation(); moveItem(item.id, 1); });
  head.querySelector('[data-act="del"]').addEventListener('click', e => { e.stopPropagation(); removeItem(item.id); });

  card.append(head, body);
  return card;
}

function renderItemBody(item, body, refreshHead) {
  const scaleNames = Object.keys(currentSurvey.optionSets || {});
  const usingSharedScale = !!(currentSurvey.optionSets && currentSurvey.optionSets[item.type]);
  const baseType = usingSharedScale ? 'single_choice' : item.type;

  const typeOptions = TYPE_ORDER.map(t => `<option value="${t}" ${t === baseType ? 'selected' : ''}>${TYPE_LABELS[t]}</option>`).join('');

  let extra = '';

  if (item.type === 'info') {
    const rawLines = (item.prompt || '').split('\n');
    const isSection = !!(rawLines[0] && rawLines[0].trim().startsWith('SECCIÓN'));
    const sectionTitle = isSection ? rawLines[0].trim() : '';
    const bodyText = isSection ? rawLines.slice(1).join('\n').replace(/^\n+/, '') : (item.prompt || '');
    extra = `
      <div class="checkbox-row">
        <input type="checkbox" id="sec-${item.id}" data-f="isSection" ${isSection ? 'checked' : ''} />
        <label for="sec-${item.id}">Es encabezado de sección</label>
      </div>
      <div class="field-group" data-role="section-title" ${isSection ? '' : 'style="display:none;"'}>
        <label class="field">Título de sección</label>
        <input class="input" data-f="sectionTitle" value="${escapeHtml(sectionTitle)}" placeholder="SECCIÓN 1 — Bienestar" />
      </div>
      <div class="field-group">
        <label class="field">Texto</label>
        <textarea class="input" data-f="infoBody" rows="4" placeholder="Texto que se muestra en esta pantalla…">${escapeHtml(bodyText)}</textarea>
        <p class="small mt-8">Los encabezados de sección delimitan los bloques usados por la aleatorización "dentro de cada sección".</p>
      </div>`;
  } else {
    extra = `
      <div class="field-group">
        <label class="field">Pregunta / texto (prompt)</label>
        <textarea class="input" data-f="prompt" rows="2">${escapeHtml(item.prompt || '')}</textarea>
      </div>`;
  }

  if (!NO_REQUIRED_TYPES.has(item.type)) {
    extra += `
      <div class="checkbox-row">
        <input type="checkbox" id="req-${item.id}" data-f="required" ${item.required ? 'checked' : ''} />
        <label for="req-${item.id}">Obligatoria</label>
      </div>`;
  }

  if (TEXTLIKE_TYPES.has(item.type)) {
    extra += `
      <div class="field-grid field-group">
        <div><label class="field">Placeholder</label><input class="input" data-f="placeholder" value="${escapeHtml(item.placeholder || '')}" /></div>
        <div><label class="field">Máx. caracteres</label><input class="input" type="number" data-f="maxLength" value="${item.maxLength ?? ''}" /></div>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="long-${item.id}" data-f="long" ${item.long ? 'checked' : ''} ${item.type === 'text' ? '' : 'disabled'} />
        <label for="long-${item.id}">Texto largo (textarea) ${item.type === 'text' ? '' : '— solo aplica a "Texto corto o largo"'}</label>
      </div>
      ${item.type === 'text' ? `
      <div class="field-group">
        <label class="field">Caracteres permitidos (opcional)</label>
        <input class="input" data-f="allowedChars" value="${escapeHtml(item.allowedChars || '')}" placeholder="ej. 0123456789.-" />
        <p class="small mt-8">Si se define, filtra en vivo cualquier carácter fuera de esta lista (útil para RUT u otros formatos restringidos).</p>
      </div>` : ''}`;
  }

  if (item.type === 'number') {
    extra += `
      <div class="field-grid field-group">
        <div><label class="field">Placeholder</label><input class="input" data-f="placeholder" value="${escapeHtml(item.placeholder || '')}" /></div>
        <div></div>
        <div><label class="field">Mínimo</label><input class="input" type="number" data-f="min" value="${item.min ?? ''}" /></div>
        <div><label class="field">Máximo</label><input class="input" type="number" data-f="max" value="${item.max ?? ''}" /></div>
      </div>`;
  }

  if (item.type === 'slider') {
    extra += `
      <div class="field-grid field-group">
        <div><label class="field">Mínimo</label><input class="input" type="number" data-f="min" value="${item.min ?? 0}" /></div>
        <div><label class="field">Máximo</label><input class="input" type="number" data-f="max" value="${item.max ?? 100}" /></div>
        <div><label class="field">Paso</label><input class="input" type="number" data-f="step" value="${item.step ?? 1}" /></div>
      </div>`;
  }

  if (baseType === 'single_choice' || item.type === 'multi_choice') {
    const sourceSelect = item.type === 'multi_choice' ? '' : `
      <div class="field-group">
        <label class="field">Origen de las opciones</label>
        <select class="select" data-f="optionSource">
          <option value="" ${!usingSharedScale ? 'selected' : ''}>Opciones propias de este ítem</option>
          ${scaleNames.map(n => `<option value="${n}" ${item.type === n ? 'selected' : ''}>Escala compartida: ${escapeHtml(n)}</option>`).join('')}
        </select>
      </div>`;
    extra += sourceSelect;

    if (item.type === 'multi_choice' || !usingSharedScale) {
      const opts = Array.isArray(item.options) ? item.options : [];
      extra += `
        <div class="field-group" data-role="inline-options">
          <label class="field">Opciones</label>
          <div class="opts-list-inline">
            ${opts.map((o, i) => `
              <div class="opt-row" data-i="${i}">
                <input class="input" data-f="opt" value="${escapeHtml(typeof o === 'string' ? o : (o.label ?? ''))}" placeholder="Etiqueta de la opción" />
                <button type="button" class="btn btn-icon btn-danger" data-act="del-inline-opt">✕</button>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-outline btn-sm mt-8" data-act="add-inline-opt">+ Opción</button>
        </div>`;
    } else {
      extra += `<p class="muted small">Usando las opciones definidas en la escala "${escapeHtml(item.type)}" (pestaña Escalas).</p>`;
    }
  }

  extra += `
    <button type="button" class="btn btn-outline btn-sm mt-12" data-act="toggle-advanced">Opciones avanzadas ▾</button>
    <div class="mt-12 hidden" data-role="advanced">
      <div class="field-grid field-group">
        <div><label class="field">Escala (para aleatorización)</label><input class="input" data-f="scale" value="${escapeHtml(item.scale || '')}" placeholder="ej. bienestar" /></div>
        <div><label class="field">Dimensión (para aleatorización)</label><input class="input" data-f="dimension" value="${escapeHtml(item.dimension || '')}" placeholder="opcional" /></div>
      </div>
      <div class="field-group"><label class="field">Instrucción (sobre la pregunta)</label><input class="input" data-f="instruction" value="${escapeHtml(item.instruction || '')}" /></div>
      <div class="field-group"><label class="field">Ayuda (bajo la pregunta)</label><input class="input" data-f="help" value="${escapeHtml(item.help || '')}" /></div>
      <div class="field-group"><label class="field">ID del ítem</label><input class="input" data-f="id" value="${escapeHtml(item.id)}" /><p class="small mt-8">No lo cambies después de recibir respuestas — se perdería la trazabilidad de esa variable.</p></div>
    </div>`;

  body.innerHTML = `
    <div class="field-group">
      <label class="field">Tipo de ítem</label>
      <select class="select" data-f="type">${typeOptions}</select>
    </div>
    ${extra}
  `;

  wireItemBody(item, body, refreshHead);
}

function wireItemBody(item, body, refreshHead) {
  body.querySelector('[data-f="type"]').addEventListener('change', e => {
    const newType = e.target.value;
    item.type = newType;
    // reset fields that don't make sense across type switches
    if (newType !== 'single_choice' && newType !== 'multi_choice') delete item.options;
    if (!TEXTLIKE_TYPES.has(newType)) { delete item.long; }
    renderItemBody(item, body, refreshHead);
    refreshHead();
  });

  const promptEl = body.querySelector('[data-f="prompt"]');
  if (promptEl) promptEl.addEventListener('input', e => { item.prompt = e.target.value; refreshHead(); });

  if (item.type === 'info') {
    const isSecEl = body.querySelector('[data-f="isSection"]');
    const sectionTitleRoot = body.querySelector('[data-role="section-title"]');
    const sectionTitleEl = body.querySelector('[data-f="sectionTitle"]');
    const infoBodyEl = body.querySelector('[data-f="infoBody"]');
    function rebuildInfoPrompt() {
      const on = isSecEl.checked;
      sectionTitleRoot.style.display = on ? '' : 'none';
      const title = on ? (sectionTitleEl.value.trim() || 'SECCIÓN') : '';
      const bodyText = infoBodyEl.value || '';
      item.prompt = on ? `${title}\n\n${bodyText}` : bodyText;
      refreshHead();
    }
    isSecEl.addEventListener('change', rebuildInfoPrompt);
    sectionTitleEl.addEventListener('input', rebuildInfoPrompt);
    infoBodyEl.addEventListener('input', rebuildInfoPrompt);
  }

  const reqEl = body.querySelector('[data-f="required"]');
  if (reqEl) reqEl.addEventListener('change', e => { item.required = e.target.checked; });

  const placeholderEl = body.querySelector('[data-f="placeholder"]');
  if (placeholderEl) placeholderEl.addEventListener('input', e => { item.placeholder = e.target.value; });

  const maxLenEl = body.querySelector('[data-f="maxLength"]');
  if (maxLenEl) maxLenEl.addEventListener('input', e => { item.maxLength = e.target.value ? Number(e.target.value) : undefined; });

  const longEl = body.querySelector('[data-f="long"]');
  if (longEl) longEl.addEventListener('change', e => { item.long = e.target.checked; });

  const minEl = body.querySelector('[data-f="min"]');
  if (minEl) minEl.addEventListener('input', e => { item.min = e.target.value === '' ? undefined : Number(e.target.value); });

  const maxEl = body.querySelector('[data-f="max"]');
  if (maxEl) maxEl.addEventListener('input', e => { item.max = e.target.value === '' ? undefined : Number(e.target.value); });

  const stepEl = body.querySelector('[data-f="step"]');
  if (stepEl) stepEl.addEventListener('input', e => { item.step = e.target.value === '' ? undefined : Number(e.target.value); });

  const sourceEl = body.querySelector('[data-f="optionSource"]');
  if (sourceEl) sourceEl.addEventListener('change', e => {
    const scaleName = e.target.value;
    item.type = scaleName || 'single_choice';
    if (scaleName) delete item.options;
    else item.options = item.options || [];
    renderItemBody(item, body, refreshHead);
    refreshHead();
  });

  const inlineOptsRoot = body.querySelector('[data-role="inline-options"]');
  if (inlineOptsRoot) {
    if (!Array.isArray(item.options)) item.options = [];
    inlineOptsRoot.querySelectorAll('.opt-row').forEach((row, i) => {
      row.querySelector('[data-f="opt"]').addEventListener('input', e => { item.options[i] = e.target.value; refreshHead(); });
      row.querySelector('[data-act="del-inline-opt"]').addEventListener('click', () => {
        item.options.splice(i, 1);
        renderItemBody(item, body, refreshHead);
        refreshHead();
      });
    });
    const addBtn = inlineOptsRoot.querySelector('[data-act="add-inline-opt"]');
    if (addBtn) addBtn.addEventListener('click', () => {
      item.options.push('');
      renderItemBody(item, body, refreshHead);
    });
  }

  const advToggle = body.querySelector('[data-act="toggle-advanced"]');
  const advBlock = body.querySelector('[data-role="advanced"]');
  if (advToggle && advBlock) advToggle.addEventListener('click', () => advBlock.classList.toggle('hidden'));

  const scaleEl = body.querySelector('[data-f="scale"]');
  if (scaleEl) scaleEl.addEventListener('input', e => { item.scale = e.target.value || undefined; });
  const dimEl = body.querySelector('[data-f="dimension"]');
  if (dimEl) dimEl.addEventListener('input', e => { item.dimension = e.target.value || undefined; });
  const instrEl = body.querySelector('[data-f="instruction"]');
  if (instrEl) instrEl.addEventListener('input', e => { item.instruction = e.target.value || undefined; });
  const helpEl = body.querySelector('[data-f="help"]');
  if (helpEl) helpEl.addEventListener('input', e => { item.help = e.target.value || undefined; });
  const idEl = body.querySelector('[data-f="id"]');
  if (idEl) idEl.addEventListener('change', e => {
    const newId = slugify(e.target.value) || item.id;
    if (currentSurvey.items.some(it => it !== item && it.id === newId)) {
      alert('Ya existe otro ítem con ese ID.');
      e.target.value = item.id;
      return;
    }
    item.id = newId;
    e.target.value = newId;
  });
}

addItemBtn.addEventListener('click', () => {
  const item = blankItem();
  currentSurvey.items.push(item);
  expandedIds.add(item.id);
  renderItems();
  syncSaveStatus();
});

// ── Save / delete ────────────────────────────────────────────
saveSurveyBtn.addEventListener('click', async () => {
  const id = slugify(fId.value);
  if (!id) { alert('El ID de la encuesta es obligatorio (minúsculas, números y guiones bajos).'); fId.focus(); return; }
  if (!fTitle.value.trim()) { alert('El título es obligatorio.'); fTitle.focus(); return; }
  if (currentSurvey._isNew && surveysCache.some(s => s.id === id)) {
    if (!confirm(`Ya existe una encuesta con el ID "${id}". ¿Sobrescribirla?`)) return;
  }

  currentSurvey.id = id;
  currentSurvey.title = fTitle.value.trim();

  const payload = {
    title: currentSurvey.title,
    description: currentSurvey.description || '',
    published: !!currentSurvey.published,
    settings: currentSurvey.settings,
    optionSets: currentSurvey.optionSets || {},
    items: currentSurvey.items || [],
    updatedAt: serverTimestamp(),
    updatedBy: (auth.currentUser && auth.currentUser.email) || null,
    ...(currentSurvey._isNew && { createdAt: serverTimestamp() })
  };

  saveSurveyBtn.disabled = true;
  saveStatus.textContent = 'Guardando…';
  try {
    await setDoc(doc(db, 'surveys', id), payload, { merge: !currentSurvey._isNew });
    currentSurvey._isNew = false;
    fId.disabled = true;
    deleteSurveyBtn.classList.remove('hidden');
    savedSnapshot = JSON.stringify(currentSurvey);
    saveStatus.textContent = 'Guardado ✓';
    await loadSurveyList();
  } catch (e) {
    console.error(e);
    saveStatus.textContent = '';
    alert('No se pudo guardar. Revisa la consola para más detalles.');
  } finally {
    saveSurveyBtn.disabled = false;
  }
});

deleteSurveyBtn.addEventListener('click', async () => {
  if (currentSurvey._isNew) { closeEditorBtn.click(); return; }
  if (!confirm(`¿Eliminar la encuesta "${currentSurvey.title}"? Esta acción no se puede deshacer. Las respuestas ya guardadas NO se borran.`)) return;
  try {
    await deleteDoc(doc(db, 'surveys', currentSurvey.id));
    currentSurvey = null;
    editorView.classList.add('hidden');
    listView.classList.remove('hidden');
    await loadSurveyList();
  } catch (e) {
    console.error(e);
    alert('No se pudo eliminar la encuesta.');
  }
});

// ── Live preview (reuses the real survey runner) ─────────────
let previewApp = null;
function getPreviewApp() {
  if (previewApp) return previewApp;
  const dummy = () => document.createElement('div');
  previewApp = createSurveyApp({
    db,
    elements: {
      header: dummy(),
      homeSection: dummy(),
      listContainer: dummy(),
      runnerSection: dummy(),
      metaContainer: el('pv-meta'),
      bar: el('pv-bar'),
      questionContainer: el('pv-question'),
      optionsContainer: el('pv-options'),
      controlsContainer: el('pv-controls'),
      footnoteContainer: el('pv-footnote'),
      splashOverlay: null
    }
  });
  return previewApp;
}

previewBtn.addEventListener('click', () => {
  if (!currentSurvey.items || currentSurvey.items.length === 0) {
    alert('Agrega al menos un ítem antes de previsualizar.');
    return;
  }
  const draft = structuredClone(currentSurvey);
  draft.id = draft.id || '__preview__';
  previewOverlay.classList.add('visible');
  getPreviewApp().previewSurvey(draft);
});

closePreviewBtn.addEventListener('click', () => {
  previewOverlay.classList.remove('visible');
});
