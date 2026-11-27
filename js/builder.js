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
  query,
  where,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import { createSurveyApp } from './surveyRunner.js';
import { resolveAccess, fetchMySurveys, isUmag, norm, POLICY_NOTICE } from './access.js';
import { collectionManifest } from './manifest.js';
import { diffItems, describeRisks, logEntry, mergeRetired } from './revisions.js';

let me = { role: 'none', email: '' };   // set by resolveAccess() on sign-in
const isSuper = () => me.role === 'super';

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
const fAdmins = el('f-admins');
const fRandomize = el('f-randomize');
const fTheme = el('f-theme');
const fConsentLevel = el('f-consentLevel');
const fConsentItem = el('f-consentItem');
const fConsentContact = el('f-consentContact');
const consentFields = el('consentFields');
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
  duration: 'Duración (años, meses, días)',
  time: 'Hora',
  single_choice: 'Opción única',
  multi_choice: 'Opción múltiple',
  ranking: 'Ranking (ordenar prioridades)',
  slider: 'Escala deslizante (slider)',
  yes_no: 'Sí / No',
  file: 'Archivo (solo nombre, no sube el archivo)',
  task_rt: 'Tarea cognitiva — Tiempo de reacción',
  task_stroop: 'Tarea cognitiva — Stroop',
  task_gonogo: 'Tarea cognitiva — Go / No-Go'
};
const TYPE_ORDER = ['info', 'text', 'email', 'url', 'phone', 'number', 'date', 'time', 'duration',
  'single_choice', 'multi_choice', 'ranking', 'slider', 'yes_no', 'file', 'task_rt', 'task_stroop', 'task_gonogo'];
const NO_REQUIRED_TYPES = new Set(['info', 'task_rt', 'task_stroop', 'task_gonogo']);
const TEXTLIKE_TYPES = new Set(['text', 'email', 'url', 'phone']);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Survey ids may also keep hyphens (e.g. espacios-telares-1); item ids stay
// underscore-only so CSV column names remain R/Stata friendly.
function slugifySurveyId(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Auth ─────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  me = await resolveAccess(db, user);
  if (user && me.role !== 'none') {
    authCard.classList.add('hidden');
    listView.classList.remove('hidden');
    userChip.classList.remove('hidden');
    userEmailEl.textContent = user.email;
    el('policyBanner').textContent = isSuper()
      ? 'Administración: ves todas las encuestas. Panel de supervisión en super.html.'
      : POLICY_NOTICE + ' Ves las encuestas que creaste y las que te compartieron.';
    deleteSurveyBtn.classList.toggle('hidden', !isSuper());
    loadSurveyList();
  } else {
    authCard.classList.remove('hidden');
    listView.classList.add('hidden');
    editorView.classList.add('hidden');
    if (user) {
      authError.textContent = 'Esta cuenta no puede crear ni editar encuestas. ' + POLICY_NOTICE;
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
    adminEmails: [],
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
    if (isSuper()) {
      const snap = await getDocs(collection(db, 'surveys'));
      surveysCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      surveysCache = await fetchMySurveys(db, me.email);
    }
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
          <div class="small">${escapeHtml(s.id)} · ${(s.items || []).length} ítems${s.ownerEmail && s.ownerEmail !== me.email ? ` · de ${escapeHtml(s.ownerEmail)}` : ''}</div>
        </div>
        <span class="badge ${s.published ? 'badge-ok' : 'badge-off'}">${s.published ? 'Publicada' : 'Borrador'}</span>
      </div>
      <div class="survey-card-actions mt-8">
        <button type="button" class="btn btn-outline btn-sm" data-act="edit">Editar</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="run" ${s.published ? '' : 'disabled'}>Abrir encuesta</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="enc" ${s.published ? '' : 'disabled'}>Copiar enlace encuestador</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="export">Exportar JSON</button>
      </div>`;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(structuredClone(s)));
    const runBtn = card.querySelector('[data-act="run"]');
    if (s.published) runBtn.addEventListener('click', () => window.open(`encuesta.html?survey=${encodeURIComponent(s.id)}`, '_blank'));
    card.querySelector('[data-act="export"]').addEventListener('click', () => exportSurvey(s));
    const encBtn = card.querySelector('[data-act="enc"]');
    if (s.published) encBtn.addEventListener('click', async () => {
      const url = new URL(`encuestador.html?survey=${encodeURIComponent(s.id)}`, location.href).href;
      try { await navigator.clipboard.writeText(url); encBtn.textContent = 'Enlace copiado ✓'; }
      catch { prompt('Copia el enlace:', url); }
    });
    surveyListContainer.appendChild(card);
  });
}

// The survey definition only: no account emails, change log or server timestamps,
// so the file can be passed on. "Importar JSON" takes it back.
const EXPORT_OMIT = new Set(['ownerEmail', 'adminEmails', 'changeLog', 'createdAt', 'updatedAt', 'updatedBy', 'listed']);
function exportSurvey(s) {
  const def = Object.fromEntries(Object.entries(s).filter(([k]) => !EXPORT_OMIT.has(k)));
  const url = URL.createObjectURL(new Blob([JSON.stringify(def, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${s.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        ...(parsed.settings || {}), // keeps extras such as settings.thankYou
        randomizeItems: (parsed.settings && parsed.settings.randomizeItems) || false,
        splash: {
          enabled: !!(parsed.settings && parsed.settings.splash && parsed.settings.splash.enabled),
          image: (parsed.settings && parsed.settings.splash && (parsed.settings.splash.image || parsed.settings.splash.imageSrc || parsed.settings.splash.src)) || '',
          durationMs: (parsed.settings && parsed.settings.splash && parsed.settings.splash.durationMs) || 1000
        }
      },
      optionSets: parsed.optionSets || {},
      items: parsed.items,
      adminEmails: isSuper() ? parseEmailList((parsed.adminEmails || []).join(',')) : [],   // viewers are a super-admin field
      _isNew: true
    };
    const existing = surveysCache.find(s => s.id === slugifySurveyId(draft.id));
    if (existing && confirm(`Ya existe la encuesta "${existing.id}". ¿Aplicar el archivo como una edición de ella?\n\nSe conservan responsable, historial de revisiones y estado de publicación; nada cambia hasta que guardes.\n(Cancelar = abrir como encuesta nueva.)`)) {
      openEditor(structuredClone(existing));
      Object.assign(currentSurvey, {
        title: draft.title, description: draft.description,
        settings: draft.settings, optionSets: draft.optionSets, items: draft.items
      });
      const original = savedSnapshot;
      openEditor(currentSurvey);
      savedSnapshot = original;   // diff and revision are computed against the stored survey
      syncSaveStatus();
      return;
    }
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
  fAdmins.value = (survey.adminEmails || []).join(', ');
  el('legacyAdminsGroup').classList.toggle('hidden', !isSuper());
  el('ownerLine').textContent = survey._isNew ? `${me.email} (tú, al guardar)` : (survey.ownerEmail || 'sin responsable (encuesta anterior al nuevo sistema: administración)');
  loadCollabs(survey);
  const stg = survey.settings || {};
  el('f-evEnabled').checked = !(stg.paradata && stg.paradata.events === false);
  el('f-evMisses').checked = !(stg.paradata && stg.paradata.misses === false);
  el('f-devInfo').checked = !(stg.collect && stg.collect.deviceInfo === false);
  el('f-geo').value = (stg.collect && ['coarse', 'precise'].includes(stg.collect.geolocation)) ? stg.collect.geolocation : 'off';
  renderManifest();
  fRandomize.value = String((survey.settings && survey.settings.randomizeItems) || false);
  fTheme.value = (survey.settings && survey.settings.theme) || '';
  const consent = (survey.settings && survey.settings.consent) || {};
  fConsentLevel.value = consent.enabled ? (consent.level || 'personal') : '';
  fConsentItem.value = consent.itemId || '';
  fConsentContact.value = consent.contact || '';
  consentFields.classList.toggle('hidden', !consent.enabled);
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
fAdmins.addEventListener('input', () => { currentSurvey.adminEmails = parseEmailList(fAdmins.value); syncSaveStatus(); });

// ── Optional data collection (settings.paradata / settings.collect) ─────────
function syncCollect() {
  const st = currentSurvey.settings;
  const events = el('f-evEnabled').checked, misses = el('f-evMisses').checked;
  if (events && misses) delete st.paradata; else st.paradata = { events, misses: events && misses };
  const geo = el('f-geo').value, dev = el('f-devInfo').checked;
  if (geo === 'off' && dev) delete st.collect; else st.collect = { geolocation: geo, deviceInfo: dev };
  el('f-evMisses').disabled = !events;
  renderManifest();
  syncSaveStatus();
}
['f-evEnabled', 'f-evMisses', 'f-devInfo', 'f-geo'].forEach(id => el(id).addEventListener('change', syncCollect));

function renderManifest() {
  if (!currentSurvey) return;
  const m = collectionManifest(currentSurvey);
  const box = el('manifestBox');
  box.innerHTML = m.rows.map(r => `<div style="margin-bottom:4px"><strong>${escapeHtml(r.group)}:</strong> ${escapeHtml(r.text)}</div>`).join('') +
    m.warnings.map(w => `<div class="danger" style="margin-top:6px">⚠ ${escapeHtml(w)}</div>`).join('');
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', renderManifest));

// ── Colleagues with access (collab/<surveyId>__<email>) ─────────────────────
async function loadCollabs(survey) {
  const list = el('collabList'), add = el('collabAdd'), hint = el('collabHint');
  const saved = !survey._isNew;
  add.classList.toggle('hidden', !saved);
  hint.classList.toggle('hidden', false);
  list.textContent = saved ? 'Cargando…' : '';
  if (!saved) return;
  try {
    const snap = await getDocs(query(collection(db, 'collab'), where('surveyId', '==', survey.id)));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
    list.innerHTML = rows.length ? '' : 'Nadie más por ahora.';
    rows.forEach(c => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'justify-content:space-between;margin-bottom:4px';
      row.innerHTML = `<span>${escapeHtml(c.email)} · ${c.role === 'editor' ? 'edita' : 've respuestas'}</span><button type="button" class="btn btn-outline btn-sm">Quitar</button>`;
      row.querySelector('button').onclick = async () => {
        try { await deleteDoc(doc(db, 'collab', c.id)); loadCollabs(survey); } catch (e) { console.error(e); alert('No se pudo quitar.'); }
      };
      list.appendChild(row);
    });
  } catch (e) {
    console.warn('collab', e);
    list.textContent = 'Solo la persona responsable (o la administración) ve esta lista.';
    add.classList.add('hidden');
  }
}
el('collabAddBtn').addEventListener('click', async () => {
  const email = norm(el('collabEmail').value);
  if (!/^\S+@\S+\.\S+$/.test(email)) { alert('Escribe un correo válido.'); return; }
  if (!isUmag(email) && !isSuper()) { alert('Por ahora solo se puede dar acceso a cuentas @umag.cl. Para otra cuenta, pide una excepción a la administración.'); return; }
  try {
    await setDoc(doc(db, 'collab', `${currentSurvey.id}__${email}`), {
      surveyId: currentSurvey.id, email, role: el('collabRole').value, addedBy: me.email, createdAt: serverTimestamp()
    });
    el('collabEmail').value = '';
    loadCollabs(currentSurvey);
  } catch (e) {
    console.error(e);
    alert('No se pudo agregar. Solo la persona responsable de la encuesta puede dar acceso.');
  }
});

// Per-survey admins (see firestore.rules isSurveyAdmin): lowercase, deduped.
function parseEmailList(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))];
}
fTheme.addEventListener('change', () => {
  if (fTheme.value) currentSurvey.settings.theme = fTheme.value; else delete currentSurvey.settings.theme;
  syncSaveStatus();
});
// settings.consent — see js/consent.js and docs/CONSENT.md.
function syncConsent() {
  if (fConsentLevel.value) {
    currentSurvey.settings.consent = {
      enabled: true, level: fConsentLevel.value,
      itemId: fConsentItem.value.trim(), contact: fConsentContact.value.trim()
    };
  } else {
    delete currentSurvey.settings.consent;
  }
  consentFields.classList.toggle('hidden', !fConsentLevel.value);
  syncSaveStatus();
}
fConsentLevel.addEventListener('change', () => {
  // Pre-fill with the item that ends the survey on "no", the usual consent question.
  if (fConsentLevel.value && !fConsentItem.value) {
    const gate = (currentSurvey.items || []).find(it => Array.isArray(it.exitOnAnswer));
    if (gate) fConsentItem.value = gate.id;
  }
  syncConsent();
});
fConsentItem.addEventListener('input', syncConsent);
fConsentContact.addEventListener('input', syncConsent);
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
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="hand-${item.id}" data-f="handoff" ${item.handoff ? 'checked' : ''} />
        <label for="hand-${item.id}">Privada en modo encuestador (la persona responde por sí misma)</label>
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
      <div class="field-grid field-group">
        <div>
          <label class="field">Modo de respuesta</label>
          <select class="input" data-f="response">
            <option value="text" ${(!item.response || item.response === 'text') ? 'selected' : ''}>Solo texto</option>
            <option value="either" ${item.response === 'either' ? 'selected' : ''}>Texto o audio (elige quien responde)</option>
            <option value="audio" ${item.response === 'audio' ? 'selected' : ''}>Solo audio (micrófono)</option>
          </select>
        </div>
        <div>
          <label class="field">Máx. segundos de audio</label>
          <input class="input" type="number" min="10" max="180" data-f="maxSeconds" value="${item.maxSeconds ?? ''}" placeholder="90" />
        </div>
      </div>
      <p class="small">El audio se guarda en Firestore (≤ ~700 KB por clip). Máximo 180 s; por defecto 90 s. Si el dispositivo no puede grabar, se muestra el campo de texto.</p>
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

  const isListType = item.type === 'multi_choice' || item.type === 'ranking';
  if (item.type === 'multi_choice') {
    extra += `
      <div class="field-group"><label class="field">Máximo de selecciones (vacío = sin límite)</label>
        <input class="input" type="number" min="1" data-f="maxSelect" value="${item.maxSelect ?? ''}" /></div>`;
  }
  if (item.type === 'ranking') {
    extra += `
      <div class="field-group"><label class="field">Posiciones a ordenar</label>
        <input class="input" type="number" min="1" data-f="maxRank" value="${item.maxRank ?? 3}" /></div>`;
  }

  if (baseType === 'single_choice' || isListType) {
    const sourceSelect = isListType ? '' : `
      <div class="field-group">
        <label class="field">Origen de las opciones</label>
        <select class="select" data-f="optionSource">
          <option value="" ${!usingSharedScale ? 'selected' : ''}>Opciones propias de este ítem</option>
          ${scaleNames.map(n => `<option value="${n}" ${item.type === n ? 'selected' : ''}>Escala compartida: ${escapeHtml(n)}</option>`).join('')}
        </select>
      </div>`;
    extra += sourceSelect;

    if (isListType || !usingSharedScale) {
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
      ${(item.followUp || item.showIf || item.section) ? `<p class="small mt-8">Este ítem trae lógica definida en el JSON importado (${[item.section && 'sección', item.followUp && 'campo "especifica"', item.showIf && 'condición de visibilidad'].filter(Boolean).join(', ')}). Se conserva al guardar.</p>` : ''}
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
    if (!['single_choice', 'multi_choice', 'ranking'].includes(newType)) delete item.options;
    if (!TEXTLIKE_TYPES.has(newType)) { delete item.long; }
    if (newType !== 'text') { delete item.response; delete item.maxSeconds; }
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
  const handEl = body.querySelector('[data-f="handoff"]');
  if (handEl) handEl.addEventListener('change', e => { if (e.target.checked) item.handoff = true; else delete item.handoff; });

  const placeholderEl = body.querySelector('[data-f="placeholder"]');
  if (placeholderEl) placeholderEl.addEventListener('input', e => { item.placeholder = e.target.value; });

  const maxLenEl = body.querySelector('[data-f="maxLength"]');
  if (maxLenEl) maxLenEl.addEventListener('input', e => { item.maxLength = e.target.value ? Number(e.target.value) : undefined; });

  const longEl = body.querySelector('[data-f="long"]');
  if (longEl) longEl.addEventListener('change', e => { item.long = e.target.checked; });

  const responseEl = body.querySelector('[data-f="response"]');
  if (responseEl) responseEl.addEventListener('change', e => { item.response = e.target.value === 'text' ? undefined : e.target.value; });
  const maxSecondsEl = body.querySelector('[data-f="maxSeconds"]');
  if (maxSecondsEl) maxSecondsEl.addEventListener('input', e => { item.maxSeconds = e.target.value ? Math.min(180, Number(e.target.value)) : undefined; });

  const allowedCharsEl = body.querySelector('[data-f="allowedChars"]');
  if (allowedCharsEl) allowedCharsEl.addEventListener('input', e => { item.allowedChars = e.target.value || undefined; });

  const minEl = body.querySelector('[data-f="min"]');
  if (minEl) minEl.addEventListener('input', e => { item.min = e.target.value === '' ? undefined : Number(e.target.value); });

  const maxEl = body.querySelector('[data-f="max"]');
  if (maxEl) maxEl.addEventListener('input', e => { item.max = e.target.value === '' ? undefined : Number(e.target.value); });

  const maxSelectEl = body.querySelector('[data-f="maxSelect"]');
  if (maxSelectEl) maxSelectEl.addEventListener('input', e => { item.maxSelect = e.target.value ? Number(e.target.value) : undefined; });
  const maxRankEl = body.querySelector('[data-f="maxRank"]');
  if (maxRankEl) maxRankEl.addEventListener('input', e => { item.maxRank = e.target.value ? Number(e.target.value) : undefined; });

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
      row.querySelector('[data-f="opt"]').addEventListener('input', e => {
        // Keep {code, label, exclusive} objects intact — only the label changes.
        const o = item.options[i];
        if (o && typeof o === 'object') o.label = e.target.value;
        else item.options[i] = e.target.value;
        refreshHead();
      });
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
  const id = slugifySurveyId(fId.value);
  if (!id) { alert('El ID de la encuesta es obligatorio (minúsculas, números, guiones y guiones bajos).'); fId.focus(); return; }
  if (!fTitle.value.trim()) { alert('El título es obligatorio.'); fTitle.focus(); return; }
  if (currentSurvey._isNew && surveysCache.some(s => s.id === id)) {
    if (!confirm(`Ya existe una encuesta con el ID "${id}". ¿Sobrescribirla?`)) return;
  }

  currentSurvey.id = id;
  currentSurvey.title = fTitle.value.trim();

  // What does this edit do to data already collected? (js/revisions.js)
  const nextItems = JSON.parse(JSON.stringify(currentSurvey.items || []));
  const prev = currentSurvey._isNew ? null : JSON.parse(savedSnapshot || 'null');
  const diff = prev ? diffItems(prev.items || [], nextItems) : null;
  if (diff && diff.changed) {
    const risks = describeRisks(diff);
    if (risks && !confirm(`Esta encuesta ya puede tener respuestas. Con este cambio:\n\n${risks}\n\n¿Guardar de todos modos?`)) return;
  }
  const baseRev = Number(currentSurvey.revision) || 0;
  const newRev = !prev ? 1 : (diff && diff.changed ? baseRev + 1 : (baseRev || 1));
  const log = diff && diff.changed ? [...(currentSurvey.changeLog || []), logEntry(newRev, diff, me.email)].slice(-200) : (currentSurvey.changeLog || []);
  const retired = diff ? mergeRetired(currentSurvey.retiredItems || [], diff, nextItems, newRev) : (currentSurvey.retiredItems || []);

  const payload = {
    revision: newRev,
    changeLog: log,
    retiredItems: retired,
    title: currentSurvey.title,
    description: currentSurvey.description || '',
    published: !!currentSurvey.published,
    // Legacy viewer list and owner: only a super admin sets them; for everyone else the
    // fields are left out (merge keeps what is stored, and the rules would reject a change).
    ...(isSuper() && { adminEmails: parseEmailList((currentSurvey.adminEmails || []).join(',')) }),
    ...(currentSurvey._isNew && { ownerEmail: me.email, ...(!isSuper() && { adminEmails: [] }) }),
    settings: currentSurvey.settings,
    optionSets: currentSurvey.optionSets || {},
    // JSON round-trip drops `undefined` fields (cleared inputs), which
    // Firestore would otherwise reject.
    items: JSON.parse(JSON.stringify(currentSurvey.items || [])),
    updatedAt: serverTimestamp(),
    updatedBy: (auth.currentUser && auth.currentUser.email) || null,
    ...(currentSurvey._isNew && { createdAt: serverTimestamp() })
  };

  saveSurveyBtn.disabled = true;
  saveStatus.textContent = 'Guardando…';
  try {
    // mergeFields replaces each field whole (merge:true would keep removed settings and scales)
    // and leaves the fields we don't send (owner, listed) untouched.
    await setDoc(doc(db, 'surveys', id), payload, currentSurvey._isNew ? {} : { mergeFields: Object.keys(payload) });
    if (currentSurvey._isNew) currentSurvey.ownerEmail = me.email;
    currentSurvey.revision = newRev; currentSurvey.changeLog = log; currentSurvey.retiredItems = retired;
    currentSurvey._isNew = false;
    fId.disabled = true;
    deleteSurveyBtn.classList.remove('hidden');
    savedSnapshot = JSON.stringify(currentSurvey);
    saveStatus.textContent = 'Guardado ✓';
    await loadSurveyList();
  } catch (e) {
    console.error(e);
    saveStatus.textContent = '';
    alert(e && e.code === 'permission-denied'
      ? (currentSurvey._isNew
          ? `No se pudo crear: el ID "${currentSurvey.id}" probablemente ya lo usa otra encuesta. Elige otro ID.`
          : 'No tienes permiso para editar esta encuesta (solo la persona responsable o quien tenga permiso de edición).')
      : 'No se pudo guardar. Revisa la consola para más detalles.');
  } finally {
    saveSurveyBtn.disabled = false;
  }
});

deleteSurveyBtn.addEventListener('click', () => {
  if (currentSurvey._isNew) { closeEditorBtn.click(); return; }
  alert('Eliminar una encuesta con todos sus datos se hace desde super.html (administración), con confirmación y opciones. Aquí solo se puede despublicar.');
  location.href = 'super.html';
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
  if (previewApp && previewApp.stop) previewApp.stop();
  previewOverlay.classList.remove('visible');
});
