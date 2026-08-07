import { app, db } from './firebaseClient.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

const EXPORT_META_ROOT = 'response_export_meta';

const ALLOWED_EMAILS = new Set([
  'hermanelgueta@gmail.com',
  'herman.elgueta@umag.cl'
]);

const auth = getAuth(app);

const loginBtn = document.getElementById('loginBtn');
const authCard = document.getElementById('authCard');
const contentCard = document.getElementById('contentCard');
const authError = document.getElementById('authError');
const userChip = document.getElementById('userChip');
const userEmailEl = document.getElementById('userEmail');
const userStatusDot = document.getElementById('userStatusDot');
const surveyTableBody = document.getElementById('surveyTableBody');
const surveyCountChip = document.getElementById('surveyCountChip');
const surveyCountLabel = document.getElementById('surveyCountLabel');
const refreshBtn = document.getElementById('refreshBtn');
const refreshSpinner = document.getElementById('refreshSpinner');
const caseReviewCard = document.getElementById('caseReviewCard');
const closeCaseReviewBtn = document.getElementById('closeCaseReviewBtn');
const caseSurveyChip = document.getElementById('caseSurveyChip');
const caseTableBody = document.getElementById('caseTableBody');
const excludeFilterSelect = document.getElementById('excludeFilterSelect');
const dedupeFilterSelect = document.getElementById('dedupeFilterSelect');
const refreshCasesBtn = document.getElementById('refreshCasesBtn');

let activeCaseSurveyMeta = null;
let activeCaseRows = [];
let activeCaseDedupeMap = new Map();

function mergeExportMetaIntoData(data, meta) {
  if (!meta || typeof meta !== 'object') return data;
  const out = { ...data };
  if (typeof meta.excludedFromExport === 'boolean') out.excludedFromExport = meta.excludedFromExport;
  if (meta.excludeReason !== undefined) out.excludeReason = meta.excludeReason;
  if (meta.excludeNote !== undefined) out.excludeNote = meta.excludeNote;
  return out;
}

async function fetchExportFlagsMap(surveyId) {
  try {
    const colRef = collection(db, `${EXPORT_META_ROOT}/${surveyId}/flags`);
    const snap = await getDocs(colRef);
    const map = new Map();
    snap.forEach(d => map.set(d.id, d.data()));
    return map;
  } catch (e) {
    console.warn('No se pudieron leer flags de exportación.', e);
    return new Map();
  }
}

function setLoading(isLoading) {
  refreshBtn.disabled = isLoading;
  refreshSpinner.classList.toggle('hidden', !isLoading);
}

function requireAuthorized(user) {
  if (!user) return false;
  const email = user.email || '';
  const ok = ALLOWED_EMAILS.has(email.toLowerCase());
  if (!ok) {
    authError.textContent = 'Tu cuenta de Google no está autorizada para acceder a este panel.';
    authError.classList.remove('hidden');
    userChip.classList.remove('hidden');
    userEmailEl.textContent = email || '(sin correo)';
    userStatusDot.classList.add('warn');
    authCard.classList.remove('hidden');
    contentCard.classList.add('hidden');
  }
  return ok;
}

async function fetchSurveyIndex() {
  const res = await fetch('surveys/index.json?_=' + Date.now());
  const data = await res.json();
  return data.surveys || [];
}

async function fetchSurveyDefinition(surveyMeta) {
  if (!surveyMeta || !surveyMeta.file) return null;
  try {
    const res = await fetch(`surveys/${surveyMeta.file}?_=${Date.now()}`);
    const def = await res.json();
    return await resolveSurveyExtends(def);
  } catch (e) {
    console.warn('No se pudo leer la definición de la encuesta:', surveyMeta.file, e);
    return null;
  }
}

async function resolveSurveyExtends(rawSurvey) {
  if (!rawSurvey || typeof rawSurvey !== 'object') return rawSurvey;
  const extendsSpec = rawSurvey.extends;
  if (!extendsSpec) return rawSurvey;

  const baseFile = typeof extendsSpec === 'string'
    ? extendsSpec
    : extendsSpec && typeof extendsSpec === 'object' ? extendsSpec.file : null;

  if (!baseFile) return rawSurvey;

  try {
    const res = await fetch(`surveys/${baseFile}?_=${Date.now()}`);
    const base = await res.json();
    const merged = structuredClone(base);

    function mergeSettings(baseSettings, overrideSettings) {
      if (!overrideSettings || typeof overrideSettings !== 'object') return baseSettings;
      const out = structuredClone(baseSettings || {});
      for (const [key, value] of Object.entries(overrideSettings)) {
        if (key === 'splash' && value && typeof value === 'object' && out.splash && typeof out.splash === 'object') {
          out.splash = { ...out.splash, ...value };
        } else {
          out[key] = value;
        }
      }
      return out;
    }

    if (rawSurvey.id) merged.id = rawSurvey.id;
    if (rawSurvey.title) merged.title = rawSurvey.title;
    if (rawSurvey.description) merged.description = rawSurvey.description;
    if (rawSurvey.settings) merged.settings = mergeSettings(merged.settings, rawSurvey.settings);
    if (rawSurvey.optionSets) {
      merged.optionSets = { ...(merged.optionSets || {}), ...(rawSurvey.optionSets || {}) };
    }
    if (Array.isArray(rawSurvey.items)) merged.items = rawSurvey.items;

    if (rawSurvey.removeRutQuestions) {
      const rutRegex = /\bR\s*\.?\s*U\s*\.?\s*T\b/i;
      merged.items = (merged.items || []).filter(it => {
        const prompt = it && typeof it.prompt === 'string' ? it.prompt : '';
        const id = it && typeof it.id === 'string' ? it.id : '';
        return !rutRegex.test(prompt) && !/\brut\b/i.test(id);
      });
    }

    if (Array.isArray(rawSurvey.removeItemIds) && rawSurvey.removeItemIds.length > 0) {
      const idsToRemove = new Set(rawSurvey.removeItemIds.filter(Boolean));
      merged.items = (merged.items || []).filter(it => !idsToRemove.has(it && it.id));
    }

    return merged;
  } catch (e) {
    console.warn('No se pudo resolver survey.extends:', extendsSpec, e);
    return rawSurvey;
  }
}

async function countResponsesForSurvey(surveyId) {
  const colRef = collection(db, `responses/${surveyId}/entries`);
  const [snap, flagsMap] = await Promise.all([getDocs(colRef), fetchExportFlagsMap(surveyId)]);
  let n = 0;
  snap.forEach(d => {
    const data = mergeExportMetaIntoData(d.data(), flagsMap.get(d.id));
    if (!data?.excludedFromExport) n += 1;
  });
  return n;
}

function buildCsv(rows, delimiter = ',') {
  return rows.map(row =>
    row.map(value => {
      if (value == null) return '';
      const s = String(value);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(delimiter)
  ).join('\r\n');
}

function downloadCsv(filename, rows) {
  const csvText = buildCsv(rows);
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function normalizeScalar(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function normalizeAnswerValue(v) {
  if (Array.isArray(v)) return v.map(normalizeAnswerValue).sort();
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeAnswerValue(v[k]);
    return out;
  }
  return normalizeScalar(v);
}

function stableStringify(obj) {
  if (obj == null) return '';
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}

function answerFingerprint(answers) {
  return stableStringify(normalizeAnswerValue(answers || {}));
}

function getCreatedAtMs(data) {
  if (data?.createdAt?.toDate) return data.createdAt.toDate().getTime();
  if (data?.browserData?.timestamp) {
    const ts = Date.parse(data.browserData.timestamp);
    return Number.isNaN(ts) ? 0 : ts;
  }
  return 0;
}

function answerCompleteness(answers) {
  const obj = answers && typeof answers === 'object' ? answers : {};
  const keys = Object.keys(obj);
  if (!keys.length) return 0;
  let filled = 0;
  for (const k of keys) {
    const v = obj[k];
    const ok = Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '';
    if (ok) filled += 1;
  }
  return filled / keys.length;
}

function compareByLatestThenCompleteness(a, b) {
  const tDiff = getCreatedAtMs(b.data) - getCreatedAtMs(a.data);
  if (tDiff !== 0) return tDiff;
  return answerCompleteness(b.data?.answers) - answerCompleteness(a.data?.answers);
}

function dedupeConfidence(base, candidate) {
  const baseCode = normalizeScalar(base.data?.serverCode);
  const candCode = normalizeScalar(candidate.data?.serverCode);
  const sameServerCode = !!baseCode && baseCode === candCode;
  const sameFingerprint = answerFingerprint(base.data?.answers) === answerFingerprint(candidate.data?.answers);
  const dtMs = Math.abs(getCreatedAtMs(base.data) - getCreatedAtMs(candidate.data));
  const closeInTime = dtMs <= (5 * 60 * 1000);
  const sameUa = normalizeScalar(base.data?.ua || base.data?.browserData?.userAgent) === normalizeScalar(candidate.data?.ua || candidate.data?.browserData?.userAgent);
  const sameTz = normalizeScalar(base.data?.browserData?.timezone) === normalizeScalar(candidate.data?.browserData?.timezone);
  const sameTech = sameUa && sameTz;

  if ((sameServerCode && sameFingerprint) || (sameFingerprint && closeInTime && sameTech)) return 'high';
  if ((sameServerCode && closeInTime) || (sameFingerprint && closeInTime)) return 'medium';
  return 'low';
}

function buildDedupeAnnotations(docs) {
  const sorted = [...docs].sort(compareByLatestThenCompleteness);
  const map = new Map();
  const used = new Set();

  for (let i = 0; i < sorted.length; i++) {
    const keep = sorted[i];
    if (used.has(keep.id)) continue;
    map.set(keep.id, { confidence: 'low', isDuplicate: false, keepId: keep.id });
    used.add(keep.id);

    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j];
      if (used.has(candidate.id)) continue;
      const conf = dedupeConfidence(keep, candidate);
      if (conf === 'high' || conf === 'medium') {
        map.set(candidate.id, { confidence: conf, isDuplicate: true, keepId: keep.id });
        used.add(candidate.id);
      }
    }
  }

  for (const d of sorted) {
    if (!map.has(d.id)) map.set(d.id, { confidence: 'low', isDuplicate: false, keepId: d.id });
  }
  return map;
}

function dedupeDocsForExport(docs) {
  const annotations = buildDedupeAnnotations(docs);
  const kept = docs.filter(d => {
    const ann = annotations.get(d.id);
    return !ann?.isDuplicate;
  });
  return { kept, annotations };
}

async function exportSurveyCsv({ surveyMeta, includeParadata, includeExcluded = false, dedupeMode = 'none' }) {
  setLoading(true);
  try {
    const surveyDef = await fetchSurveyDefinition(surveyMeta);
    const itemOrder = Array.isArray(surveyDef?.items)
      ? surveyDef.items.map(it => it && it.id).filter(Boolean)
      : [];

    const colRef = collection(db, `responses/${surveyMeta.id}/entries`);
    const snap = await getDocs(colRef);
    const flagsMap = await fetchExportFlagsMap(surveyMeta.id);

    const docs = [];
    snap.forEach(d => {
      const data = mergeExportMetaIntoData(d.data(), flagsMap.get(d.id));
      docs.push({ id: d.id, data });
    });

    if (!docs.length) {
      alert('No hay respuestas para esta encuesta todavía.');
      return;
    }

    let docsToExport = docs.filter(({ data }) => includeExcluded || !data?.excludedFromExport);
    let dedupeAnnotations = new Map();
    if (dedupeMode === 'smart') {
      const deduped = dedupeDocsForExport(docsToExport);
      docsToExport = deduped.kept;
      dedupeAnnotations = deduped.annotations;
    }

    docsToExport = docsToExport.slice().sort(compareByLatestThenCompleteness);

    const allAnswerKeys = new Set();
    docsToExport.forEach(({ data }) => {
      if (data.answers && typeof data.answers === 'object') {
        Object.keys(data.answers).forEach(k => allAnswerKeys.add(k));
      }
    });

    const answerKeyList = Array.from(allAnswerKeys);
    const orderedKeys = itemOrder.length ? itemOrder.slice() : [];
    const extraKeys = itemOrder.length
      ? answerKeyList.filter(id => !itemOrder.includes(id)).sort()
      : answerKeyList.sort();
    const finalAnswerKeys = [...orderedKeys, ...extraKeys];

    const baseHeaders = ['responseId', 'surveyId', 'serverCode', 'createdAt', 'isExcluded', 'excludeReason', 'excludeNote'];
    const dedupeHeaders = dedupeMode === 'smart'
      ? ['dedupe_isDuplicate', 'dedupe_confidence', 'dedupe_keepId']
      : [];
    const answerHeaders = finalAnswerKeys.map(k => `ans_${k}`);
    const paradataHeaders = [];

    if (includeParadata) {
      const coreParadata = [
        'totalTime_ms', 'nav_back_count', 'answer_change_count',
        'answer_change_events_truncated', 'answer_change_events_json',
        'presentationOrder', 'ua', 'path', 'browser_language',
        'browser_platform', 'browser_timezone', 'browser_userAgent',
        'browser_screen', 'browser_referrer'
      ];
      const perItemTimeHeaders = itemOrder.map(id => `${id}_TIME`);
      const perItemChangeHeaders = itemOrder.map(id => `${id}_CHANGE_COUNT`);
      paradataHeaders.push(
        ...coreParadata, ...perItemTimeHeaders, ...perItemChangeHeaders,
        'raw_itemTimes', 'raw_responseTimestamps', 'raw_itemAnswerChangeCount'
      );
    }

    const headerRow = [...baseHeaders, ...dedupeHeaders, ...answerHeaders, ...paradataHeaders];
    const rows = [headerRow];

    for (const { id, data } of docsToExport) {
      const answers = data.answers || {};
      const row = [];

      row.push(id);
      row.push(data.surveyId || surveyMeta.id);
      row.push(data.serverCode || '');
      const createdAt = data.createdAt && data.createdAt.toDate
        ? data.createdAt.toDate().toISOString()
        : data.browserData?.timestamp || '';
      row.push(createdAt);
      row.push(data.excludedFromExport ? '1' : '0');
      row.push(data.excludeReason || '');
      row.push(data.excludeNote || '');

      if (dedupeMode === 'smart') {
        const ann = dedupeAnnotations.get(id) || { isDuplicate: false, confidence: 'low', keepId: id };
        row.push(ann.isDuplicate ? '1' : '0');
        row.push(ann.confidence || 'low');
        row.push(ann.keepId || id);
      }

      for (const key of answerHeaders) {
        const itemId = key.replace(/^ans_/, '');
        const value = answers[itemId];
        if (Array.isArray(value)) row.push(value.join('|'));
        else row.push(value != null ? value : '');
      }

      if (includeParadata) {
        const itemTimes = data.itemTimes || {};
        const itemAnswerChanges = data.itemAnswerChangeCount || {};

        row.push(data.totalTime != null ? data.totalTime : '');
        row.push(data.navBackCount != null ? data.navBackCount : '');
        row.push(data.answerChangeCount != null ? data.answerChangeCount : '');
        row.push(data.answerChangeEventsTruncated ? '1' : '0');
        row.push(
          Array.isArray(data.answerChangeEvents) && data.answerChangeEvents.length
            ? JSON.stringify(data.answerChangeEvents)
            : ''
        );
        row.push(data.presentationOrder ? JSON.stringify(data.presentationOrder) : '');
        row.push(data.ua || '');
        row.push(data.path || '');

        const b = data.browserData || {};
        row.push(b.language || '');
        row.push(b.platform || '');
        row.push(b.timezone || '');
        row.push(b.userAgent || '');
        row.push(
          b.screenWidth != null && b.screenHeight != null
            ? `${b.screenWidth}x${b.screenHeight} (${b.screenColorDepth || ''} bits)`
            : ''
        );
        row.push(b.referrer || '');

        for (const itemId of itemOrder) row.push(itemTimes[itemId] != null ? itemTimes[itemId] : '');
        for (const itemId of itemOrder) row.push(itemAnswerChanges[itemId] != null ? itemAnswerChanges[itemId] : 0);

        row.push(data.itemTimes ? JSON.stringify(data.itemTimes) : '');
        row.push(data.responseTimestamps ? JSON.stringify(data.responseTimestamps) : '');
        row.push(data.itemAnswerChangeCount ? JSON.stringify(data.itemAnswerChangeCount) : '');
      }

      rows.push(row);
    }

    const suffix = includeParadata ? 'datos_paradata' : 'datos';
    const dedupeSuffix = dedupeMode === 'smart' ? '_dedupe' : '_raw';
    const exclSuffix = includeExcluded ? '_incl_excluidos' : '_sin_excluidos';
    const filename = `${surveyMeta.id}_${suffix}${dedupeSuffix}${exclSuffix}.csv`;
    downloadCsv(filename, rows);
  } catch (err) {
    console.error(err);
    alert('Ocurrió un error al armar el CSV. Revisa la consola para más detalles.');
  } finally {
    setLoading(false);
  }
}

function formatIsoFromData(data) {
  const ms = getCreatedAtMs(data);
  return ms ? new Date(ms).toISOString() : '';
}

function formatTotalTimeDisplay(data) {
  const raw = data?.totalTime;
  if (raw == null || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return '—';
  const sec = Math.floor(n / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const human = m > 0 ? `${m}m ${s}s` : `${s}s`;
  return `${human} (${Math.round(n)} ms)`;
}

async function updateExclusionForCase({ surveyId, responseId, excluded, reason, note }) {
  const ref = doc(db, `${EXPORT_META_ROOT}/${surveyId}/flags/${responseId}`);
  await setDoc(
    ref,
    {
      surveyId,
      responseId,
      excludedFromExport: !!excluded,
      excludeReason: excluded ? (reason || 'other') : '',
      excludeNote: excluded ? (note || '') : '',
      reviewedAt: serverTimestamp(),
      reviewedBy: auth.currentUser?.email || ''
    },
    { merge: true }
  );
}

function applyCaseFilters(rows) {
  const excludedFilter = excludeFilterSelect?.value || 'all';
  const dedupeFilter = dedupeFilterSelect?.value || 'all';
  return rows.filter(({ data, id }) => {
    const isExcluded = !!data?.excludedFromExport;
    const ann = activeCaseDedupeMap.get(id) || { confidence: 'low' };
    if (excludedFilter === 'included' && isExcluded) return false;
    if (excludedFilter === 'excluded' && !isExcluded) return false;
    if (dedupeFilter !== 'all' && ann.confidence !== dedupeFilter) return false;
    return true;
  });
}

function renderCaseTable() {
  if (!activeCaseSurveyMeta) return;
  const rows = applyCaseFilters(activeCaseRows)
    .slice()
    .sort(compareByLatestThenCompleteness);
  caseTableBody.innerHTML = '';

  if (!rows.length) {
    caseTableBody.innerHTML = '<tr><td colspan="11" class="small muted">No hay casos para este filtro.</td></tr>';
    return;
  }

  for (const rowData of rows) {
    const { id, data } = rowData;
    const tr = document.createElement('tr');
    const ann = activeCaseDedupeMap.get(id) || { confidence: 'low', isDuplicate: false, keepId: id };
    const completeness = Math.round(answerCompleteness(data.answers) * 100);
    const backs = data.navBackCount != null ? data.navBackCount : '—';
    const changes = data.answerChangeCount != null ? data.answerChangeCount : '—';

    tr.innerHTML = `
      <td><code>${id}</code></td>
      <td class="small">${formatIsoFromData(data)}</td>
      <td class="small" title="Tiempo desde inicio hasta envío">${formatTotalTimeDisplay(data)}</td>
      <td class="small text-right">${backs}</td>
      <td class="small text-right">${changes}</td>
      <td class="small">${data.serverCode || ''}</td>
      <td class="small">${completeness}%</td>
      <td class="small">${ann.confidence.toUpperCase()}${ann.isDuplicate ? ` (→ ${ann.keepId})` : ''}</td>
      <td></td>
      <td></td>
      <td></td>
    `;

    const excludeCell = tr.children[8];
    const reasonCell = tr.children[9];
    const noteCell = tr.children[10];

    const excludeCb = document.createElement('input');
    excludeCb.type = 'checkbox';
    excludeCb.checked = !!data.excludedFromExport;
    excludeCell.appendChild(excludeCb);

    const reasonSel = document.createElement('select');
    reasonSel.className = 'select';
    const reasonOptions = ['pilot', 'test', 'duplicate', 'invalid', 'other'];
    reasonOptions.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if ((data.excludeReason || 'other') === r) opt.selected = true;
      reasonSel.appendChild(opt);
    });
    reasonSel.disabled = !excludeCb.checked;
    reasonCell.appendChild(reasonSel);

    const noteInput = document.createElement('input');
    noteInput.className = 'input';
    noteInput.type = 'text';
    noteInput.placeholder = 'Nota opcional';
    noteInput.value = data.excludeNote || '';
    noteInput.disabled = !excludeCb.checked;
    noteCell.appendChild(noteInput);

    let saveTimer = null;
    const queueSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await updateExclusionForCase({
            surveyId: activeCaseSurveyMeta.id,
            responseId: id,
            excluded: excludeCb.checked,
            reason: reasonSel.value,
            note: noteInput.value.trim()
          });
          data.excludedFromExport = excludeCb.checked;
          data.excludeReason = excludeCb.checked ? reasonSel.value : '';
          data.excludeNote = excludeCb.checked ? noteInput.value.trim() : '';
        } catch (e) {
          console.error(e);
          alert('No se pudo guardar la exclusión. Revisa las reglas de Firestore para response_export_meta.');
        }
      }, 450);
    };

    excludeCb.addEventListener('change', () => {
      reasonSel.disabled = !excludeCb.checked;
      noteInput.disabled = !excludeCb.checked;
      queueSave();
    });
    reasonSel.addEventListener('change', queueSave);
    noteInput.addEventListener('input', queueSave);

    caseTableBody.appendChild(tr);
  }
}

async function openCaseReview(surveyMeta) {
  activeCaseSurveyMeta = surveyMeta;
  caseSurveyChip.classList.remove('hidden');
  caseSurveyChip.textContent = surveyMeta.id;
  caseReviewCard.classList.remove('hidden');
  caseTableBody.innerHTML = '<tr><td colspan="11" class="small muted">Cargando casos...</td></tr>';

  try {
    const colRef = collection(db, `responses/${surveyMeta.id}/entries`);
    const snap = await getDocs(colRef);
    const flagsMap = await fetchExportFlagsMap(surveyMeta.id);
    const docs = [];
    snap.forEach(d =>
      docs.push({ id: d.id, data: mergeExportMetaIntoData(d.data(), flagsMap.get(d.id)) })
    );
    docs.sort(compareByLatestThenCompleteness);
    activeCaseRows = docs;
    activeCaseDedupeMap = buildDedupeAnnotations(docs);
    renderCaseTable();
  } catch (e) {
    console.error(e);
    caseTableBody.innerHTML = '<tr><td colspan="11" class="small danger">No se pudieron cargar los casos.</td></tr>';
  }
}

async function renderTable() {
  setLoading(true);
  surveyTableBody.innerHTML = `
    <tr><td colspan="4" class="small muted">Cargando encuestas desde surveys/index.json…</td></tr>
  `;

  try {
    const surveys = await fetchSurveyIndex();
    if (!surveys.length) {
      surveyTableBody.innerHTML = `
        <tr><td colspan="4" class="small muted">No se encontraron encuestas en surveys/index.json.</td></tr>
      `;
      surveyCountChip.classList.add('hidden');
      return;
    }

    surveyCountChip.classList.remove('hidden');
    surveyCountLabel.textContent = `${surveys.length} encuesta${surveys.length === 1 ? '' : 's'}`;

    const countsMap = new Map();
    for (const s of surveys) {
      const n = await countResponsesForSurvey(s.id);
      countsMap.set(s.id, n);
    }

    surveyTableBody.innerHTML = '';

    for (const s of surveys) {
      const tr = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.innerHTML = `<code>${s.id}</code>`;

      const tdTitle = document.createElement('td');
      const desc = s.description ? `<div class="small muted">${s.description}</div>` : '';
      tdTitle.innerHTML = `<div>${s.title || '(sin título)'}</div>${desc}`;

      const tdCount = document.createElement('td');
      tdCount.className = 'text-right';
      tdCount.innerHTML = `<span class="badge">${countsMap.get(s.id) ?? 0}</span>`;

      const tdActions = document.createElement('td');
      tdActions.style.whiteSpace = 'nowrap';

      const btnData = document.createElement('button');
      btnData.className = 'btn btn-outline btn-sm';
      btnData.textContent = 'CSV datos';
      btnData.addEventListener('click', () =>
        exportSurveyCsv({ surveyMeta: s, includeParadata: false, dedupeMode: 'none', includeExcluded: false })
      );

      const btnDataDedupe = document.createElement('button');
      btnDataDedupe.className = 'btn btn-outline btn-sm';
      btnDataDedupe.style.marginLeft = '8px';
      btnDataDedupe.textContent = 'CSV datos (dedupe)';
      btnDataDedupe.addEventListener('click', () =>
        exportSurveyCsv({ surveyMeta: s, includeParadata: false, dedupeMode: 'smart', includeExcluded: false })
      );

      const btnFull = document.createElement('button');
      btnFull.className = 'btn btn-outline btn-sm';
      btnFull.style.marginLeft = '8px';
      btnFull.textContent = 'CSV + paradata (dedupe)';
      btnFull.addEventListener('click', () =>
        exportSurveyCsv({ surveyMeta: s, includeParadata: true, dedupeMode: 'smart', includeExcluded: false })
      );

      const btnCases = document.createElement('button');
      btnCases.className = 'btn btn-outline btn-sm';
      btnCases.style.marginLeft = '8px';
      btnCases.textContent = 'Gestionar casos';
      btnCases.addEventListener('click', () => openCaseReview(s));

      tdActions.append(btnData, btnDataDedupe, btnFull, btnCases);
      tr.append(tdId, tdTitle, tdCount, tdActions);
      surveyTableBody.appendChild(tr);
    }
  } catch (err) {
    console.error(err);
    surveyTableBody.innerHTML = `
      <tr><td colspan="4" class="small danger">Error al leer surveys/index.json o Firestore.</td></tr>
    `;
  } finally {
    setLoading(false);
  }
}

loginBtn?.addEventListener('click', async () => {
  authError.classList.add('hidden');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error(err);
    authError.textContent = 'No se pudo completar el inicio de sesión con Google.';
    authError.classList.remove('hidden');
  }
});

refreshBtn?.addEventListener('click', () => renderTable());
closeCaseReviewBtn?.addEventListener('click', () => {
  caseReviewCard.classList.add('hidden');
  activeCaseSurveyMeta = null;
});
excludeFilterSelect?.addEventListener('change', () => renderCaseTable());
dedupeFilterSelect?.addEventListener('change', () => renderCaseTable());
refreshCasesBtn?.addEventListener('click', () => {
  if (activeCaseSurveyMeta) openCaseReview(activeCaseSurveyMeta);
});

userChip?.addEventListener('click', async () => {
  try { await signOut(auth); } catch (_) {}
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authCard.classList.remove('hidden');
    contentCard.classList.add('hidden');
    userChip.classList.add('hidden');
    authError.classList.add('hidden');
    return;
  }

  const email = user.email || '';
  userChip.classList.remove('hidden');
  userEmailEl.textContent = email;
  userStatusDot.classList.remove('warn');

  if (!requireAuthorized(user)) return;

  authError.classList.add('hidden');
  authCard.classList.add('hidden');
  contentCard.classList.remove('hidden');
  await renderTable();
});
