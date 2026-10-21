// adminStats.js — samplux admin dashboard (admin.html).
//
// Ported from lamp-umag/perseg's tabbed admin-stats (KPIs, raw/net/corrected
// time, per-item timing, per-variable distributions, case review with
// exclusion + dedupe, CSV/codebook download) and adapted to samplux:
//   - surveys come from Firestore (surveys/<id>), drafts included;
//   - open-ended answers can be read inline in the Variables tab (teaser +
//     expandable drawer with search and an optional tag per response);
//   - follow-up "especifica" answers, ranking items and cognitive tasks are
//     understood by the stats, the CSV and the codebook;
//   - a raw JSON export keeps the full paradata (browserData, change events…)
//     that the old admin.html CSV exports used to provide.
//
// Writes: only response_export_meta/<surveyId>/flags/<responseId> (exclusion
// flags). Never writes to responses/... or surveys/....

import { app, db } from './firebaseClient.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  doc, setDoc, serverTimestamp, collection, getDocs, query, where
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import {
  fetchSurveyIndex, fetchSurveyDefinition, fetchResponses, fetchExportFlags, mergeFlags,
  getCreatedAtMs, completenessVsSurvey, answerableItems, itemKind, resolveItemOptions,
  variableDistribution, summarize, histogram, niceBinCount,
  fmtDuration, fmtNum, fmtPct, fmtSummaryLine, cleanPrompt,
  renderBarRows, renderHistogram, renderTimeline, dailyCounts, escapeHtml,
  exportItems, followUpItem, textEntries, rankingSize,
  cognitiveItems, renderCognitiveTask, COGNITIVE_METRICS, COGNITIVE_LABELS
} from './statsCore.js';

const EXPORT_META_ROOT = 'response_export_meta';

// Global admins (every survey + builder). Keep in sync with ALLOWED_EMAILS in
// js/builder.js and isAdmin() in firestore.rules. Per-survey admins are NOT
// listed here: they live in surveys/<id>.adminEmails (set in the builder) and
// are enforced by isSurveyAdmin() in firestore.rules.
const ALLOWED_EMAILS = new Set([
  'hermanelgueta@gmail.com',
  'herman.elgueta@umag.cl'
]);

// "Interruption" correction thresholds — see the explanation text rendered
// into #corrTimeExplain, kept in sync with this comment:
//   - Any item is allowed up to NORMAL_CAP_MS before it's considered a
//     likely interruption (phone put down, distracted, etc.).
//   - Free-text items (comments, open-ended orientation questions) get a
//     more generous LONG_CAP_MS, since composing a thoughtful answer can
//     genuinely take a couple of minutes.
//   - Only the time ABOVE the cap is trimmed off (assumed dead time); time
//     up to the cap still counts as real engagement.
//   - The very first and last item are excluded entirely already (that's
//     what "net time" does), so they're skipped here too.
const NORMAL_CAP_MS = 60 * 1000;
const LONG_CAP_MS = 120 * 1000;

const auth = getAuth(app);

const el = id => document.getElementById(id);
const loginBtn = el('loginBtn');
const authCard = el('authCard');
const authError = el('authError');
const appShell = el('appShell');
const userChip = el('userChip');
const userEmail = el('userEmail');
const userStatusDot = el('userStatusDot');
const surveySelect = el('surveySelect');
const includeExcluded = el('includeExcluded');
const includeDuplicates = el('includeDuplicates');
const refreshBtn = el('refreshBtn');
const refreshSpinner = el('refreshSpinner');
const kpis = el('kpis');
const validExplain = el('validExplain');
const excludeFilterSelect = el('excludeFilterSelect');
const dedupeFilterSelect = el('dedupeFilterSelect');
const refreshCasesBtn = el('refreshCasesBtn');
const caseTableBody = el('caseTableBody');
const casosMeta = el('casosMeta');
const itemTimeBody = el('itemTimeBody');
const itemTimeHeadRow = el('itemTimeHeadRow');

let surveys = [];
const cacheDef = new Map();
// Context remembered across tab switches / re-sorts, so those don't refetch.
let lastDef = null;
let lastAllDocs = [];       // every doc for the selected survey, flags merged in
let lastDedupeMap = new Map();
let lastResponses = [];     // "valid" subset per the two checkboxes at the top
let lastMeta = null;
let itemTimeRows = [];
let varFilter = 'all';        // Variables tab: all | closed | open
let textTagItemId = '';       // Variables tab: categorical item used to tag each open answer
let itemTimeSort = { key: 'median', dir: 'desc' };

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset.tab}`).classList.add('active');
    hideVarTooltip();
  });
});

/* ------------------------------------------------------------------ */
/* Variable-name tooltip: hover to see the question (desktop), or tap  */
/* it on mobile — shown as a fixed-position bubble so it never gets    */
/* clipped by a table's horizontal-scroll wrapper and never reflows    */
/* the surrounding layout.                                             */
/* ------------------------------------------------------------------ */

const varTooltipEl = el('varTooltip');
let activeTipTrigger = null;

function positionVarTooltip(trigger) {
  const rect = trigger.getBoundingClientRect();
  const tipRect = varTooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.top - tipRect.height - 8;
  if (top < 8) top = rect.bottom + 8;
  varTooltipEl.style.left = `${left}px`;
  varTooltipEl.style.top = `${top}px`;
}

function showVarTooltip(trigger) {
  const text = trigger.dataset.tip;
  if (!text) return;
  varTooltipEl.textContent = text;
  activeTipTrigger = trigger;
  varTooltipEl.classList.add('open');
  positionVarTooltip(trigger);
}

function hideVarTooltip() {
  activeTipTrigger = null;
  varTooltipEl.classList.remove('open');
}

// Touch browsers (notably mobile Safari) synthesize a mouseover right before
// a tap's click event, so a single click/mouseover handler would show the
// tooltip on mouseover and immediately toggle it back off on the click that
// follows. Branching on hover support keeps hover-only and tap-only devices
// on separate, non-conflicting code paths.
const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function attachVarTooltips(container) {
  if (supportsHover) {
    container.addEventListener('mouseover', (e) => {
      const trigger = e.target.closest('.var-tip');
      if (trigger) showVarTooltip(trigger);
    });
    container.addEventListener('mouseout', (e) => {
      const trigger = e.target.closest('.var-tip');
      if (trigger && !trigger.contains(e.relatedTarget)) hideVarTooltip();
    });
    container.addEventListener('focusin', (e) => {
      const trigger = e.target.closest('.var-tip');
      if (trigger) showVarTooltip(trigger);
    });
    container.addEventListener('focusout', (e) => {
      const trigger = e.target.closest('.var-tip');
      if (trigger) hideVarTooltip();
    });
  } else {
    container.addEventListener('click', (e) => {
      const trigger = e.target.closest('.var-tip');
      if (!trigger) return;
      e.stopPropagation();
      if (activeTipTrigger === trigger) hideVarTooltip();
      else showVarTooltip(trigger);
    });
  }
}

document.addEventListener('click', hideVarTooltip);
window.addEventListener('scroll', hideVarTooltip, true);
window.addEventListener('resize', hideVarTooltip);

attachVarTooltips(itemTimeBody);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

loginBtn?.addEventListener('click', async () => {
  authError.classList.add('hidden');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (e) {
    authError.textContent = 'No se pudo iniciar sesión: ' + (e?.message || e);
    authError.classList.remove('hidden');
  }
});

userChip?.addEventListener('click', async () => {
  try { await signOut(auth); } catch (_) { /* ignore */ }
});

// Surveys a per-survey admin can open: published surveys whose adminEmails
// include them (the rules let anyone list published surveys; drafts stay hidden).
async function fetchSurveysForSurveyAdmin(email) {
  const snap = await getDocs(query(collection(db, 'surveys'), where('published', '==', true)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => Array.isArray(s.adminEmails) && s.adminEmails.map(e => String(e).toLowerCase()).includes(email));
}

let accessScope = null; // 'global' | 'survey'

onAuthStateChanged(auth, async (user) => {
  const email = (user?.email || '').toLowerCase();
  accessScope = null;
  if (user && ALLOWED_EMAILS.has(email)) {
    accessScope = 'global';
  } else if (user && user.emailVerified) {
    try {
      surveys = await fetchSurveysForSurveyAdmin(email);
      if (surveys.length) accessScope = 'survey';
    } catch (e) {
      console.warn('No se pudieron revisar los permisos por encuesta.', e);
    }
  }
  if (accessScope) {
    document.querySelectorAll('[data-global-only]').forEach(n => n.classList.toggle('hidden', accessScope !== 'global'));
    userChip.classList.remove('hidden');
    userEmail.textContent = user.email;
    userStatusDot.classList.remove('warn');
    authCard.classList.add('hidden');
    appShell.classList.remove('hidden');
    await boot();
  } else {
    if (user) {
      authError.textContent = 'Tu cuenta de Google no está autorizada para acceder a este panel.';
      authError.classList.remove('hidden');
      userChip.classList.remove('hidden');
      userEmail.textContent = user.email || '(sin correo)';
      userStatusDot.classList.add('warn');
    }
    authCard.classList.remove('hidden');
    appShell.classList.add('hidden');
  }
});

/* ------------------------------------------------------------------ */
/* Boot + top-level data load                                          */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    if (accessScope === 'global') surveys = await fetchSurveyIndex();
  } catch (e) {
    kpis.innerHTML = `<div class="small danger">No se pudieron cargar las encuestas desde Firestore.</div>`;
    return;
  }
  surveys.sort((a, b) => (b.published === true) - (a.published === true) || String(a.title || a.id).localeCompare(String(b.title || b.id)));
  surveySelect.innerHTML = surveys
    .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title || s.id)}${s.published ? '' : ' (borrador)'}</option>`).join('');
  const wanted = new URL(location.href).searchParams.get('survey');
  if (wanted && surveys.some(s => s.id === wanted)) surveySelect.value = wanted;
  surveySelect.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('survey', surveySelect.value);
    history.replaceState({}, '', url);
    textTagItemId = '';
    render(true);
  });
  el('varFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    varFilter = btn.dataset.filter;
    el('varFilter').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    applyVarFilter();
  });
  el('textTagSelect').addEventListener('change', (e) => {
    textTagItemId = e.target.value;
    if (lastDef) renderVariables(el('varList'), lastDef, answerableItems(lastDef), lastResponses);
  });
  el('toggleTextsBtn').addEventListener('click', () => {
    const drawers = [...document.querySelectorAll('#varList details.tx-drawer')];
    const open = !drawers.every(d => d.open);
    drawers.forEach(d => { d.open = open; });
    el('toggleTextsBtn').textContent = open ? 'Cerrar todos los textos' : 'Abrir todos los textos';
  });
  el('dlJsonBtn').addEventListener('click', downloadRawJson);
  el('dlDeviceBtn').addEventListener('click', downloadDeviceCsv);
  el('loadAudiosBtn').addEventListener('click', loadAudios);
  el('dlAudiosBtn').addEventListener('click', downloadAudiosZip);
  includeExcluded.addEventListener('change', () => render());
  includeDuplicates.addEventListener('change', () => render());
  refreshBtn.addEventListener('click', () => render(true));
  excludeFilterSelect.addEventListener('change', renderCaseTable);
  dedupeFilterSelect.addEventListener('change', renderCaseTable);
  refreshCasesBtn.addEventListener('click', () => render(true));
  el('dlCsvBtn').addEventListener('click', downloadNeatCsv);
  el('dlMetaBtn').addEventListener('click', downloadMetadata);
  itemTimeHeadRow.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (itemTimeSort.key === key) {
        itemTimeSort.dir = itemTimeSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        itemTimeSort = { key, dir: 'desc' };
      }
      renderItemTimeTable();
    });
  });
  if (surveys.length) render();
}

function setLoading(on) {
  refreshBtn.disabled = on;
  refreshSpinner.classList.toggle('hidden', !on);
}

async function loadDef(meta, force) {
  if (!force && cacheDef.has(meta.id)) return cacheDef.get(meta.id);
  const def = await fetchSurveyDefinition(meta);
  cacheDef.set(meta.id, def);
  return def;
}

// Completeness only counts unconditional items: an item hidden by showIf (or a
// follow-up box) was never shown to most people, so it shouldn't count as missing.
function completenessIds(def) {
  return answerableItems(def).filter(i => !i.showIf).map(i => i.id);
}

function kpi(value, label, warn = false) {
  return `<div class="kpi${warn ? ' warn' : ''}"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
}

/* ------------------------------------------------------------------ */
/* Dedupe + exclusion (same algorithm as perseg/pausa's admin pages)   */
/* ------------------------------------------------------------------ */

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

function compareByLatestThenCompleteness(a, b) {
  const tDiff = getCreatedAtMs(b.data) - getCreatedAtMs(a.data);
  if (tDiff !== 0) return tDiff;
  return rawCompleteness(b.data?.answers) - rawCompleteness(a.data?.answers);
}

// Mirrors statsCore's answerCompleteness (looks only at keys present in the
// doc) — used only to break sorting ties for dedupe "keep" selection.
function rawCompleteness(answers) {
  const obj = answers && typeof answers === 'object' ? answers : {};
  const keys = Object.keys(obj);
  if (!keys.length) return 0;
  let filled = 0;
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '') filled += 1;
  }
  return filled / keys.length;
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

async function updateExclusionForCase({ surveyId, responseId, excluded, reason, note }) {
  const ref = doc(db, `${EXPORT_META_ROOT}/${surveyId}/flags/${responseId}`);
  await setDoc(ref, {
    surveyId,
    responseId,
    excludedFromExport: !!excluded,
    excludeReason: excluded ? (reason || 'other') : '',
    excludeNote: excluded ? (note || '') : '',
    reviewedAt: serverTimestamp(),
    reviewedBy: auth.currentUser?.email || ''
  }, { merge: true });
}

/* ------------------------------------------------------------------ */
/* Net time + corrected ("estimated") time                            */
/* ------------------------------------------------------------------ */

function firstLastItemIds(data, def) {
  const order = Array.isArray(data?.presentationOrder) ? data.presentationOrder : null;
  if (order && order.length >= 2) return { firstId: order[0], lastId: order[order.length - 1] };
  const items = Array.isArray(def?.items) ? def.items : [];
  if (!items.length) return { firstId: null, lastId: null };
  return { firstId: items[0].id, lastId: items[items.length - 1].id };
}

function computeNetTime(data, def) {
  const total = Number(data?.totalTime);
  if (!Number.isFinite(total) || total <= 0) return null;
  const itimes = data?.itemTimes || {};
  const { firstId, lastId } = firstLastItemIds(data, def);
  const introMs = firstId != null && Number.isFinite(Number(itimes[firstId])) ? Number(itimes[firstId]) : 0;
  const closingMs = (lastId != null && lastId !== firstId && Number.isFinite(Number(itimes[lastId])))
    ? Number(itimes[lastId]) : 0;
  const net = Math.max(total - introMs - closingMs, 0);
  return { total, introMs, closingMs, net, firstId, lastId };
}

function isLongFormItem(item) {
  return !!item && item.type === 'text';
}

// Builds on top of computeNetTime: also trims the time ABOVE a plausible
// per-item ceiling from every other item, on the theory that a huge dwell
// time on a single quick item usually means the respondent was interrupted
// (put the phone down, got distracted) rather than genuinely thinking that
// long about one Likert item.
function computeCorrectedTime(data, def) {
  const net = computeNetTime(data, def);
  if (!net) return null;
  const itemsById = new Map((Array.isArray(def?.items) ? def.items : []).map(it => [it.id, it]));
  const itimes = data?.itemTimes || {};
  let excess = 0;
  let slowCount = 0;
  for (const [id, raw] of Object.entries(itimes)) {
    if (id === net.firstId || id === net.lastId) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const cap = isLongFormItem(itemsById.get(id)) ? LONG_CAP_MS : NORMAL_CAP_MS;
    if (v > cap) {
      excess += (v - cap);
      slowCount += 1;
    }
  }
  const corrected = Math.max(net.net - excess, 0);
  return { ...net, excess, slowCount, corrected };
}

/* ------------------------------------------------------------------ */
/* Main render                                                         */
/* ------------------------------------------------------------------ */

async function render(force = false) {
  const meta = surveys.find(s => s.id === surveySelect.value);
  if (!meta) return;
  setLoading(true);
  try {
    const [docsRaw, flags, def] = await Promise.all([
      fetchResponses(meta.id), fetchExportFlags(meta.id), loadDef(meta, force === true)
    ]);

    const all = docsRaw.map(d => ({ id: d.id, data: mergeFlags(d.data, flags.get(d.id)) }));
    const dedupeMap = buildDedupeAnnotations(all);

    const excludedCount = all.filter(r => r.data?.excludedFromExport).length;
    const duplicateCount = all.filter(r => dedupeMap.get(r.id)?.isDuplicate).length;

    const responses = all.filter(r => {
      if (!includeExcluded.checked && r.data?.excludedFromExport) return false;
      if (!includeDuplicates.checked && dedupeMap.get(r.id)?.isDuplicate) return false;
      return true;
    });

    lastDef = def; lastAllDocs = all; lastDedupeMap = dedupeMap; lastResponses = responses; lastMeta = meta;

    if (!all.length) {
      kpis.innerHTML = kpi(0, 'Entradas totales');
      validExplain.textContent = 'Sin respuestas todavía.';
      ['timeSummary', 'timeHist', 'netTimeSummary', 'netTimeHist', 'corrTimeSummary', 'corrTimeHist',
        'speedBuckets', 'timeline', 'varList'].forEach(id => el(id).innerHTML = '');
      itemTimeRows = [];
      renderItemTimeTable();
      renderCaseTable();
      return;
    }

    const answerable = answerableItems(def);
    const answerableIds = completenessIds(def);

    // ----- timing (computed over the "valid" / filtered set) -----
    const times = responses.map(r => Number(r.data?.totalTime)).filter(v => Number.isFinite(v) && v > 0);
    const tSum = summarize(times);

    const netList = responses.map(r => computeNetTime(r.data, def)).filter(Boolean);
    const netTimes = netList.map(s => s.net);
    const netSum = summarize(netTimes);

    const corrList = responses.map(r => computeCorrectedTime(r.data, def)).filter(Boolean);
    const corrTimes = corrList.map(s => s.corrected);
    const corrSum = summarize(corrTimes);

    const comp = responses.map(r => completenessVsSurvey(r.data?.answers, answerableIds));
    const compSum = summarize(comp);

    // ----- KPIs -----
    kpis.innerHTML = [
      kpi(fmtNum(all.length, 0), 'Entradas totales'),
      kpi(fmtNum(responses.length, 0), 'Casos válidos'),
      kpi(fmtNum(excludedCount, 0), 'Excluidas', excludedCount > 0),
      kpi(fmtNum(duplicateCount, 0), 'Duplicadas', duplicateCount > 0),
      kpi(corrSum.n ? fmtDuration(corrSum.median) : '—', 'Tiempo corregido (mediana)'),
      kpi(compSum.n ? fmtPct(compSum.mean) : '—', 'Completitud media')
    ].join('');
    validExplain.textContent =
      `${all.length} entradas en total → ${responses.length} casos válidos ` +
      `(excluye ${excludedCount} marcadas como excluidas${includeExcluded.checked ? ' [incluidas ahora]' : ''} y ` +
      `${duplicateCount} detectadas como duplicadas${includeDuplicates.checked ? ' [incluidas ahora]' : ''}).`;

    // ----- raw time -----
    el('timeSummary').textContent = fmtSummaryLine(tSum, fmtDuration) || 'No hay tiempos de respuesta registrados.';
    if (tSum.n) {
      renderHistogram(el('timeHist'), histogram(times.map(t => t / 1000), niceBinCount(times.length)),
        { fmt: (sec) => fmtDuration(sec * 1000) });
    } else {
      el('timeHist').innerHTML = '';
    }

    // ----- net time -----
    el('netTimeExplain').textContent =
      'Tiempo bruto menos el tiempo dedicado al primer ítem (bienvenida) y al último ítem de cada respuesta — ' +
      'descuenta encuestas dejadas abiertas antes de entregarse, y demoras al final por mala conexión antes de poder enviar.';
    el('netTimeSummary').textContent = fmtSummaryLine(netSum, fmtDuration) || 'Sin datos suficientes.';
    if (netSum.n) {
      renderHistogram(el('netTimeHist'), histogram(netTimes.map(t => t / 1000), niceBinCount(netTimes.length)),
        { fmt: (sec) => fmtDuration(sec * 1000) });
    } else {
      el('netTimeHist').innerHTML = '';
    }

    // ----- corrected time -----
    const interruptedCount = corrList.filter(s => s.slowCount > 0).length;
    el('corrTimeExplain').textContent =
      `Tiempo neto menos el exceso por encima de un tope plausible por ítem: ${Math.round(NORMAL_CAP_MS / 1000)}s ` +
      `para la mayoría de los ítems, ${Math.round(LONG_CAP_MS / 1000)}s para ítems de texto libre (preguntas ` +
      `abiertas). Solo se descuenta lo que excede ese tope — no todo el tiempo del ítem — ` +
      `bajo el supuesto de que superarlo probablemente significa que la persona fue interrumpida y retomó la ` +
      `encuesta después. ${interruptedCount} de ${corrList.length} casos válidos tienen al menos un ítem así.`;
    el('corrTimeSummary').textContent = fmtSummaryLine(corrSum, fmtDuration) || 'Sin datos suficientes.';
    if (corrSum.n) {
      renderHistogram(el('corrTimeHist'), histogram(corrTimes.map(t => t / 1000), niceBinCount(corrTimes.length)),
        { fmt: (sec) => fmtDuration(sec * 1000) });
    } else {
      el('corrTimeHist').innerHTML = '';
    }
    renderSpeedBuckets(el('speedBuckets'), corrTimes, corrSum);
    renderTimeline(el('timeline'), dailyCounts(responses));

    // ----- per-item timing -----
    itemTimeRows = buildItemTimeRows(answerable, responses);
    renderItemTimeTable();

    // ----- variable distributions -----
    renderVariables(el('varList'), def, answerable, responses);
    const openCount = answerable.filter(i => itemKind(def, i) === 'text').length
      + answerable.filter(i => followUpItem(def, i)).length;
    el('varMeta').textContent = `${answerable.length} variables · ${openCount} abiertas · ${responses.length} casos válidos`;

    // ----- casos tab -----
    renderCaseTable();
  } catch (e) {
    console.error(e);
    kpis.innerHTML = `<div class="small danger">Error al cargar: ${escapeHtml(e?.message || e)}</div>`;
  } finally {
    setLoading(false);
  }
}

function renderSpeedBuckets(container, times, tSum) {
  if (!tSum.n) { container.innerHTML = '<div class="sc-empty">Sin tiempos para clasificar.</div>'; return; }
  const fastFence = Math.max(tSum.q1 - 1.5 * tSum.iqr, 0);
  const slowFence = tSum.q3 + 1.5 * tSum.iqr;
  const veryFastFloor = 60 * 1000;
  let veryFast = 0, fast = 0, normal = 0, slow = 0;
  for (const t of times) {
    if (t < veryFastFloor) veryFast += 1;
    else if (t < fastFence) fast += 1;
    else if (t > slowFence) slow += 1;
    else normal += 1;
  }
  const rows = [
    { label: `Muy rápido (< 1 min)`, count: veryFast, pct: veryFast / times.length },
    { label: `Rápido (atípico bajo)`, count: fast, pct: fast / times.length },
    { label: `Normal`, count: normal, pct: normal / times.length },
    { label: `Lento (atípico alto > ${fmtDuration(slowFence)})`, count: slow, pct: slow / times.length }
  ];
  renderBarRows(container, rows);
}

/* ------------------------------------------------------------------ */
/* Ítems tab: sortable per-item timing table                          */
/* ------------------------------------------------------------------ */

function buildItemTimeRows(answerable, responses) {
  const rows = [];
  for (const item of answerable) {
    const vals = responses
      .map(r => Number((r.data?.itemTimes || {})[item.id]))
      .filter(v => Number.isFinite(v) && v >= 0);
    const changes = responses
      .map(r => Number((r.data?.itemAnswerChangeCount || {})[item.id]))
      .filter(v => Number.isFinite(v))
      .reduce((a, b) => a + b, 0);
    if (!vals.length) continue;
    const s = summarize(vals);
    rows.push({ id: item.id, prompt: cleanPrompt(item.prompt), n: s.n, mean: s.mean, sd: s.sd, median: s.median, iqr: s.iqr, max: s.max, changes });
  }
  return rows;
}

function renderItemTimeTable() {
  itemTimeHeadRow.querySelectorAll('th.sortable').forEach(th => {
    th.querySelector('.arrow')?.remove();
    if (th.dataset.sort === itemTimeSort.key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = itemTimeSort.dir === 'desc' ? '▼' : '▲';
      th.appendChild(arrow);
    }
  });

  if (!itemTimeRows.length) {
    itemTimeBody.innerHTML = '<tr><td colspan="8" class="small muted">No hay tiempos por ítem (sin datos para los filtros actuales).</td></tr>';
    return;
  }

  const { key, dir } = itemTimeSort;
  const sorted = itemTimeRows.slice().sort((a, b) => {
    const av = key === 'id' ? a.id : a[key];
    const bv = key === 'id' ? b.id : b[key];
    let cmp;
    if (typeof av === 'string') cmp = av.localeCompare(bv);
    else cmp = av - bv;
    return dir === 'desc' ? -cmp : cmp;
  });

  itemTimeBody.innerHTML = sorted.map(r => `
    <tr>
      <td><code class="var-tip" tabindex="0" data-tip="${escapeHtml(r.prompt || r.id)}">${escapeHtml(r.id)}</code></td>
      <td class="text-right">${r.n}</td>
      <td class="text-right">${(r.mean / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.sd / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.median / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.iqr / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.max / 1000).toFixed(1)}s</td>
      <td class="text-right">${r.changes}</td>
    </tr>`).join('');
}

/* ------------------------------------------------------------------ */
/* Variables tab                                                       */
/* ------------------------------------------------------------------ */

function answerLabel(def, item, value) {
  if (value == null || value === '') return '';
  const opts = resolveItemOptions(def, item);
  const list = Array.isArray(value) ? value : [value];
  return list.map(v => (opts.find(o => String(o.code) === String(v)) || { label: String(v) }).label).join(', ');
}

function normalizeForSearch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Open-ended answers: a short teaser of the latest quotes, then a <details>
// drawer with every answer (newest first), a search box and an optional tag
// per answer (e.g. the respondent's carrera). Collapsed by default so the
// charts stay scannable.
function textDrawerHtml(def, entries, { noun = 'respuestas' } = {}) {
  if (!entries.length) return `<div class="tx-empty">Nadie ha escrito aún.</div>`;
  const tagItem = textTagItemId ? (def.items || []).find(i => i.id === textTagItemId) : null;
  const itemHtml = (e) => {
    let tag = tagItem ? answerLabel(def, tagItem, (e.data?.answers || {})[tagItem.id]) : '';
    const tagOther = tagItem?.followUp ? (e.data?.answers || {})[tagItem.followUp.id] : '';
    if (tag && tagOther) tag = `${tag}: ${String(tagOther).trim()}`; // e.g. "Otra: Enfermería"
    const date = e.ms ? new Date(e.ms).toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }) : '';
    return `<li class="tx-item" data-search="${escapeHtml(normalizeForSearch(e.text + ' ' + tag))}">
      <p>${escapeHtml(e.text)}</p>
      <div class="tx-meta">${tag ? `<span class="tx-tag">${escapeHtml(tag)}</span>` : ''}<span>${date}</span><code>${escapeHtml(String(e.id).slice(0, 8))}</code></div>
    </li>`;
  };
  if (entries.length <= 2) return `<ol class="tx-list tx-list-inline">${entries.map(itemHtml).join('')}</ol>`;
  const teaser = entries.slice(0, 2).map(e => `<blockquote class="tx-quote">${escapeHtml(e.text)}</blockquote>`).join('');
  return `
    <div class="tx-teaser">${teaser}</div>
    <details class="tx-drawer">
      <summary><span class="tx-open-label">Ver las ${entries.length} ${noun}</span><span class="tx-close-label">Ocultar ${noun}</span><span class="tx-chevron" aria-hidden="true">▾</span></summary>
      ${entries.length > 6 ? `<div class="tx-tools"><input type="search" class="input tx-search" placeholder="Buscar en las ${noun}…" /><span class="small tx-count">${entries.length} de ${entries.length}</span></div>` : ''}
      <ol class="tx-list">${entries.map(itemHtml).join('')}</ol>
    </details>`;
}

function wireTextDrawers(container) {
  container.querySelectorAll('.tx-search').forEach(input => {
    const drawer = input.closest('.tx-drawer');
    const items = [...drawer.querySelectorAll('.tx-item')];
    const count = drawer.querySelector('.tx-count');
    input.addEventListener('input', () => {
      const q = normalizeForSearch(input.value.trim());
      let shown = 0;
      items.forEach(li => {
        const hit = !q || li.dataset.search.includes(q);
        li.hidden = !hit;
        if (hit) shown += 1;
      });
      count.textContent = `${shown} de ${items.length}`;
    });
  });
}

function renderRankingRows(container, dist) {
  const max = Math.max(1, ...dist.rows.map(r => r.points));
  const k = dist.rankSize;
  container.innerHTML = dist.rows.map(r => {
    const w = Math.round((r.points / max) * 100);
    const byRank = r.byRank.map((c, i) => `${i + 1}º ${c}`).join(' · ');
    return `
      <div class="sc-bar-row sc-rank-row">
        <div class="sc-bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}<span class="rank-break">${byRank}</span></div>
        <div class="sc-bar-track"><div class="sc-bar-fill" style="width:${w}%"></div></div>
        <div class="sc-bar-meta">${r.points} pts</div>
      </div>`;
  }).join('') + `<div class="small mt-8">Puntaje: 1º lugar = ${k} pts${k > 1 ? `, 2º = ${k - 1}` : ''}${k > 2 ? ' y así' : ''}. Bajo cada opción: cuántas veces quedó en cada lugar.</div>`;
}

function syncTextTagSelect(def) {
  const sel = el('textTagSelect');
  const cats = answerableItems(def).filter(i => itemKind(def, i) === 'categorical');
  sel.innerHTML = `<option value="">— sin etiqueta —</option>` +
    cats.map(i => `<option value="${escapeHtml(i.id)}" ${i.id === textTagItemId ? 'selected' : ''}>${escapeHtml(cleanPrompt(i.prompt) || i.id)}</option>`).join('');
  el('textTagWrap').classList.toggle('hidden', !cats.length);
}

function applyVarFilter() {
  document.querySelectorAll('#varList .var-block').forEach(b => {
    const open = b.dataset.open === '1';
    b.hidden = (varFilter === 'open' && !open) || (varFilter === 'closed' && b.dataset.kind === 'text');
  });
  document.querySelectorAll('#varList .var-section').forEach(h => {
    let n = h.nextElementSibling, any = false;
    while (n && !n.classList.contains('var-section')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
    h.hidden = !any;
  });
}

function renderVariables(container, def, answerable, responses) {
  container.innerHTML = '';
  syncTextTagSelect(def);
  const tasks = new Set(cognitiveItems(def).map(i => i.id));
  const ordered = (def.items || []).filter(it => answerable.includes(it) || tasks.has(it.id));
  let lastSection = null;

  for (const item of ordered) {
    if (item.section && item.section !== lastSection) {
      const h = document.createElement('div');
      h.className = 'var-section';
      h.textContent = item.section;
      container.appendChild(h);
      lastSection = item.section;
    }
    const block = document.createElement('div');
    block.className = 'var-block';

    if (tasks.has(item.id)) {
      block.dataset.kind = 'task';
      container.appendChild(block);
      renderCognitiveTask(block, item, responses);
      continue;
    }

    const dist = variableDistribution(def, item, responses);
    const fu = followUpItem(def, item);
    const fuEntries = fu ? textEntries(responses, fu.id) : [];
    block.dataset.kind = dist.kind;
    block.dataset.open = (dist.kind === 'text' || fuEntries.length) ? '1' : '0';
    const cond = item.showIf ? ' <span class="tag-cond" title="Solo se muestra si se cumple una condición previa">condicional</span>' : '';
    const head = (tag = '') => `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)} <code>${escapeHtml(item.id)}</code>${tag}${cond}</div>
      <div class="var-numeric-line">${dist.answered}/${dist.total} respondieron</div>`;

    if (dist.kind === 'numeric') {
      const line = fmtSummaryLine(dist.summary, (v) => fmtNum(v, 1));
      block.innerHTML = head() + (line ? `<div class="var-numeric-line">${line}</div><div class="vh"></div>` : `<div class="var-numeric-line">Sin respuestas numéricas.</div>`);
      container.appendChild(block);
      if (line) renderHistogram(block.querySelector('.vh'), dist.hist, { fmt: (v) => fmtNum(v, 0) });
    } else if (dist.kind === 'categorical' || dist.kind === 'multi' || dist.kind === 'ranking') {
      const tag = dist.kind === 'multi' ? ` <span class="small">(selección múltiple${item.maxSelect ? `, hasta ${item.maxSelect}` : ''})</span>`
        : dist.kind === 'ranking' ? ` <span class="small">(ranking de ${dist.rankSize})</span>` : '';
      block.innerHTML = head(tag) + `<div class="vb"></div>`;
      if (fu) {
        block.innerHTML += `<div class="tx tx-followup">
          <div class="tx-label">«${escapeHtml(fu.whenLabels.join(' / '))}» · ${fuEntries.length} ${fuEntries.length === 1 ? 'especificación' : 'especificaciones'}</div>
          ${fuEntries.length ? textDrawerHtml(def, fuEntries, { noun: 'especificaciones' }) : ''}
        </div>`;
      }
      container.appendChild(block);
      if (dist.kind === 'ranking') renderRankingRows(block.querySelector('.vb'), dist);
      else renderBarRows(block.querySelector('.vb'), dist.rows);
    } else {
      const entries = textEntries(responses, item.id);
      const clips = audioMetaEntries(responses, item.id);
      const modeTag = clips.length || item.response === 'audio' || item.response === 'either' ? ' (texto libre / audio)' : ' (texto libre)';
      block.innerHTML = head(` <span class="small">${modeTag}</span>`) + `<div class="tx">${textDrawerHtml(def, entries)}</div>`;
      if (clips.length || item.response === 'audio' || item.response === 'either') {
        block.dataset.open = '1';
        const kb = Math.round(clips.reduce((n, c) => n + (c.meta.bytes || 0), 0) / 1024);
        block.insertAdjacentHTML('beforeend', `<div class="tx tx-audio">
          <div class="tx-label">🎙️ ${clips.length} ${clips.length === 1 ? 'audio' : 'audios'} · ${kb} KB</div>
          ${clips.length ? `<div class="row" style="gap:8px;margin:8px 0;">
              <button type="button" class="btn btn-outline btn-sm" data-au-load="${escapeHtml(item.id)}">Cargar para escuchar</button>
              <button type="button" class="btn btn-outline btn-sm" data-au-zip="${escapeHtml(item.id)}" disabled>⬇ .zip de este ítem</button>
            </div><div class="au-list"></div>` : '<div class="tx-empty">Nadie ha grabado aún.</div>'}
        </div>`);
      }
      container.appendChild(block);
    }
  }
  wireTextDrawers(container);
  wireItemAudio(container, responses);
  applyVarFilter();
  el('toggleTextsBtn').textContent = 'Abrir todos los textos';
}

/* ------------------------------------------------------------------ */
/* Casos tab: case review table (ported from admin.html)              */
/* ------------------------------------------------------------------ */

function applyCaseFilters(rows) {
  const excludedFilter = excludeFilterSelect?.value || 'all';
  const dedupeFilter = dedupeFilterSelect?.value || 'all';
  return rows.filter(({ data, id }) => {
    const isExcluded = !!data?.excludedFromExport;
    const ann = lastDedupeMap.get(id) || { confidence: 'low' };
    if (excludedFilter === 'included' && isExcluded) return false;
    if (excludedFilter === 'excluded' && !isExcluded) return false;
    if (dedupeFilter !== 'all' && ann.confidence !== dedupeFilter) return false;
    return true;
  });
}

function formatTotalTimeDisplay(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
  return fmtDuration(Number(ms));
}

function fmtCaseDate(data) {
  const ms = getCreatedAtMs(data);
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderCaseTable() {
  if (!lastMeta) return;
  casosMeta.textContent = `${lastAllDocs.length} entradas totales`;
  const rows = applyCaseFilters(lastAllDocs).slice().sort(compareByLatestThenCompleteness);
  caseTableBody.innerHTML = '';

  if (!rows.length) {
    caseTableBody.innerHTML = '<tr><td colspan="12" class="small muted">No hay casos para este filtro.</td></tr>';
    return;
  }

  const answerableIds = completenessIds(lastDef);

  for (const rowData of rows) {
    const { id, data } = rowData;
    const tr = document.createElement('tr');
    const ann = lastDedupeMap.get(id) || { confidence: 'low', isDuplicate: false, keepId: id };
    const completeness = Math.round(completenessVsSurvey(data.answers, answerableIds) * 100);
    const corr = computeCorrectedTime(data, lastDef);
    const timesText = corr
      ? `${formatTotalTimeDisplay(corr.total)} / ${formatTotalTimeDisplay(corr.net)} / ${formatTotalTimeDisplay(corr.corrected)}`
      : '—';

    const backs = data.navBackCount != null ? data.navBackCount : '—';
    const changes = data.answerChangeCount != null ? data.answerChangeCount : '—';

    tr.innerHTML = `
      <td><code>${escapeHtml(id)}</code></td>
      <td class="small">${fmtCaseDate(data)}</td>
      <td class="small" title="bruto / neto / corregido">${timesText}</td>
      <td class="small text-right" title="Ítems con tiempo por encima del tope (ver pestaña Resumen)">${corr ? corr.slowCount : '—'}</td>
      <td class="small text-right">${backs}</td>
      <td class="small text-right">${changes}</td>
      <td class="small">${escapeHtml(data.serverCode || '')}</td>
      <td class="small text-right">${completeness}%</td>
      <td class="small">${ann.confidence.toUpperCase()}${ann.isDuplicate ? ` → <code>${escapeHtml(ann.keepId)}</code>` : ''}</td>
      <td></td><td></td><td></td>
    `;

    const excludeCell = tr.children[9];
    const reasonCell = tr.children[10];
    const noteCell = tr.children[11];

    const excludeCb = document.createElement('input');
    excludeCb.type = 'checkbox';
    excludeCb.checked = !!data.excludedFromExport;
    excludeCell.appendChild(excludeCb);

    const reasonSel = document.createElement('select');
    reasonSel.className = 'select';
    ['pilot', 'test', 'duplicate', 'invalid', 'other'].forEach(r => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
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
            surveyId: lastMeta.id,
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
          alert('No se pudo guardar la exclusión (revisa la consola). ' + (e?.message || e));
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

/* ------------------------------------------------------------------ */
/* Downloads: neat CSV + metadata codebook                            */
/* ------------------------------------------------------------------ */

function isoOf(d) {
  if (d?.createdAt?.toDate) return d.createdAt.toDate().toISOString();
  return d?.browserData?.timestamp || '';
}

function flatAnswer(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows) {
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

function downloadBlob(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Answer columns for one exported item: ranking items are split into one
// column per position (<id>_1 = most important), everything else is one column.
function answerColumns(def, item) {
  if (itemKind(def, item) === 'ranking') {
    const k = rankingSize(def, item);
    return Array.from({ length: k }, (_, i) => ({ name: `${item.id}_${i + 1}`, get: ans => (Array.isArray(ans[item.id]) ? ans[item.id][i] : '') ?? '' }));
  }
  return [{ name: item.id, get: ans => flatAnswer(ans[item.id]) }];
}

function taskColumns(def) {
  const cols = [];
  for (const t of cognitiveItems(def)) {
    for (const m of COGNITIVE_METRICS[t.type] || []) {
      cols.push({ name: `${t.id}__${m.key}`, desc: `${COGNITIVE_LABELS[t.type] || t.id}: ${m.desc}`, get: ans => ans[t.id]?.summary?.[m.key] ?? '' });
    }
  }
  return cols;
}

function buildNeatCsvRows(def, responses, surveyId) {
  const answerable = answerableItems(def);
  const answerableIds = completenessIds(def);
  const ansCols = exportItems(def).flatMap(it => answerColumns(def, it));
  const tCols = taskColumns(def);

  const header = [
    'responseId', 'surveyId', 'createdAt', 'isExcluded', 'excludeReason', 'excludeNote',
    'dedupe_isDuplicate', 'dedupe_confidence', 'dedupe_keepId',
    'totalTime_s', 'netTime_s', 'correctedTime_s', 'slowItemCount',
    'completeness_pct', 'navBackCount', 'answerChangeCount',
    ...ansCols.map(c => c.name),
    ...tCols.map(c => c.name),
    ...answerable.map(it => `${it.id}__time_s`)
  ];

  const rows = [header];
  const ordered = responses.slice().sort((a, b) => getCreatedAtMs(b.data) - getCreatedAtMs(a.data));

  for (const r of ordered) {
    const d = r.data || {};
    const ans = d.answers || {};
    const itimes = d.itemTimes || {};
    const corr = computeCorrectedTime(d, def);
    const ann = lastDedupeMap.get(r.id) || { isDuplicate: false, confidence: 'low', keepId: r.id };
    const row = [];

    row.push(r.id, surveyId, isoOf(d), d.excludedFromExport ? '1' : '0', d.excludeReason || '', d.excludeNote || '');
    row.push(ann.isDuplicate ? '1' : '0', ann.confidence || 'low', ann.keepId || r.id);
    const tt = Number(d.totalTime);
    row.push(Number.isFinite(tt) ? (tt / 1000).toFixed(1) : '');
    row.push(corr ? (corr.net / 1000).toFixed(1) : '');
    row.push(corr ? (corr.corrected / 1000).toFixed(1) : '');
    row.push(corr ? corr.slowCount : '');
    row.push(Math.round(completenessVsSurvey(ans, answerableIds) * 100));
    row.push(d.navBackCount ?? '', d.answerChangeCount ?? '');

    for (const c of ansCols) row.push(c.get(ans));
    for (const c of tCols) row.push(c.get(ans));
    for (const it of answerable) {
      const v = Number(itimes[it.id]);
      row.push(Number.isFinite(v) ? (v / 1000).toFixed(1) : '');
    }
    rows.push(row);
  }
  return rows;
}

function buildMetadataText(def, responses, surveyId) {
  const L = [];
  const answerable = answerableItems(def);

  L.push('CODEBOOK / DICCIONARIO DE VARIABLES');
  L.push('='.repeat(60));
  L.push(`Encuesta:     ${def.title || surveyId}`);
  L.push(`survey_id:    ${surveyId}`);
  if (def.description) L.push(`Descripción:  ${def.description}`);
  L.push(`Exportado:    ${new Date().toISOString()}`);
  L.push(`Respuestas:   ${responses.length}`);
  L.push(`Variables:    ${answerable.length} ítems de respuesta`);
  L.push('');
  L.push('COLUMNAS DE METADATOS Y PARADATA');
  L.push('-'.repeat(60));
  const metaCols = [
    ['responseId', 'identificador único de la respuesta'],
    ['surveyId', 'identificador de la encuesta'],
    ['createdAt', 'fecha y hora de envío (ISO 8601)'],
    ['isExcluded', '1 = excluida en revisión de casos, 0 = incluida'],
    ['excludeReason', 'motivo de exclusión (si aplica)'],
    ['excludeNote', 'nota libre de exclusión'],
    ['dedupe_isDuplicate', '1 = detectada como probable duplicado (confianza high/medium)'],
    ['dedupe_confidence', 'high / medium / low'],
    ['dedupe_keepId', 'responseId considerado la versión "buena" del grupo duplicado'],
    ['totalTime_s', 'tiempo total bruto, desde apertura hasta envío (segundos)'],
    ['netTime_s', 'totalTime_s menos el tiempo del primer y del último ítem (segundos)'],
    ['correctedTime_s', 'netTime_s menos el exceso por ítems con tiempo anormalmente alto (ver docs/ARCHITECTURE.md)'],
    ['slowItemCount', 'número de ítems (fuera del primero/último) cuyo tiempo superó el tope esperado'],
    ['completeness_pct', 'porcentaje de ítems de respuesta completados'],
    ['navBackCount', 'número de veces que retrocedió'],
    ['answerChangeCount', 'número de veces que cambió una respuesta'],
    ['<id>__time_s', 'tiempo dedicado al ítem <id> (segundos)'],
    ...taskColumns(def).map(c => [c.name, c.desc])
  ];
  for (const [c, d] of metaCols) L.push(`  ${c.padEnd(22)} ${d}`);
  L.push('');
  L.push('ÍTEMS DE RESPUESTA (en orden del documento; el orden real puede variar por');
  L.push('la aleatorización, si está activa — ver presentationOrder en Firestore)');
  L.push('-'.repeat(60));

  const items = Array.isArray(def.items) ? def.items : [];
  let idx = 0;
  for (const item of items) {
    const kind = itemKind(def, item);
    if (kind === 'info' || kind === 'task') {
      const p = typeof item.prompt === 'string' ? item.prompt.split('\n')[0] : '';
      if (item.sectionHeader || /^SECCIÓN/i.test(p)) { L.push(''); L.push(`== ${cleanPrompt(item.prompt)} ==`); }
      continue;
    }
    idx += 1;
    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s*\n\s*/g, ' ').trim() : '';
    L.push('');
    L.push(`[${idx}] ${item.id}  (${item.type})`);
    if (item.section) L.push(`     Sección: ${item.section}`);
    if (item.instruction) L.push(`     Instrucción: ${item.instruction}`);
    if (prompt) L.push(`     Pregunta: ${prompt}`);
    if (item.showIf) {
      const clauses = Array.isArray(item.showIf.anyOf) ? item.showIf.anyOf : [item.showIf];
      L.push(`     Condición: se muestra solo si ${clauses.map(c => `${c.item} ∈ {${(c.in || ['respondido']).join(', ')}}`).join(' o ')} (si no, queda vacío)`);
    }
    if (kind === 'numeric') {
      const rng = [];
      if (item.min != null) rng.push(`min ${item.min}`);
      if (item.max != null) rng.push(`max ${item.max}`);
      L.push(`     Tipo: numérico${rng.length ? ' · ' + rng.join(', ') : ''}`);
    } else if (kind === 'categorical' || kind === 'multi' || kind === 'ranking') {
      const opts = resolveItemOptions(def, item);
      if (kind === 'ranking') {
        const k = rankingSize(def, item);
        L.push(`     Tipo: ranking de ${k} posiciones → columnas ${item.id}_1 … ${item.id}_${k} (código de la opción elegida en cada lugar; _1 = la más importante)`);
      } else if (kind === 'multi') {
        L.push(`     Tipo: selección múltiple (valores separados por "; ")${item.maxSelect ? ` · máximo ${item.maxSelect}` : ''}`);
      } else {
        L.push('     Tipo: opción única');
      }
      L.push('     Códigos:');
      for (const o of opts) L.push(`        ${String(o.code).padEnd(6)} = ${o.label}${o.exclusive ? '  (excluyente)' : ''}`);
    } else {
      L.push('     Tipo: texto libre');
    }
    const fu = followUpItem(def, item);
    if (fu) {
      L.push('');
      L.push(`     ${fu.id}  (texto libre)`);
      L.push(`        Pregunta: ${item.followUp.prompt || 'especifica'} — se pide solo si ${item.id} incluye «${fu.whenLabels.join(' / ')}»`);
    }
  }

  L.push('');
  L.push('='.repeat(60));
  L.push('Generado por samplux · admin.html');
  return L.join('\n');
}

function downloadNeatCsv() {
  if (!lastDef || !lastResponses.length) { alert('No hay datos cargados para exportar.'); return; }
  const rows = buildNeatCsvRows(lastDef, lastResponses, lastMeta.id);
  const scope = `${includeExcluded.checked ? 'con' : 'sin'}_excluidas_${includeDuplicates.checked ? 'con' : 'sin'}_duplicadas`;
  downloadBlob(`${lastMeta.id}_completo_${scope}.csv`, rowsToCsv(rows), 'text/csv');
}

// Everything Firestore has for each response (answers + full paradata:
// presentationOrder, change events, browserData…), plus the exclusion/dedupe
// annotations. Replaces the old admin.html "datos + paradata" CSV.
function downloadRawJson() {
  if (!lastMeta || !lastAllDocs.length) { alert('No hay datos cargados para exportar.'); return; }
  const out = lastAllDocs.map(({ id, data }) => {
    const ann = lastDedupeMap.get(id) || { isDuplicate: false, confidence: 'low', keepId: id };
    const { createdAt, ...rest } = data;
    return { responseId: id, createdAt: isoOf(data), ...rest, dedupe: ann };
  });
  downloadBlob(`${lastMeta.id}_crudo_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2), 'application/json');
}

function downloadMetadata() {
  if (!lastDef) { alert('Selecciona una encuesta primero.'); return; }
  const text = buildMetadataText(lastDef, lastResponses, lastMeta.id);
  downloadBlob(`${lastMeta.id}_metadata.txt`, text, 'text/plain');
}


/* ------------------------------------------------------------------ */
/* Audios tab: voice answers (responses/<survey>/audio/<resp>__<item>) */
/* ------------------------------------------------------------------ */

let audioClips = [];   // { id, data, bytes:Uint8Array }

function audioExt(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

async function loadAudios() {
  if (!lastMeta) { alert('Selecciona una encuesta primero.'); return; }
  const body = el('audioBody');
  body.innerHTML = '<tr><td colspan="6" class="small muted">Cargando…</td></tr>';
  try {
    const snap = await getDocs(collection(db, `responses/${lastMeta.id}/audio`));
    audioClips = snap.docs
      .map(d => ({ id: d.id, data: d.data(), bytes: d.data().audio.toUint8Array() }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    console.error(e);
    body.innerHTML = '<tr><td colspan="6" class="small muted">No se pudieron cargar los audios (¿permisos?).</td></tr>';
    return;
  }
  const flagsById = new Map(lastAllDocs.map(r => [r.id, r.data]));
  const totalKb = audioClips.reduce((n, c) => n + c.bytes.length, 0) / 1024;
  el('audioMeta').textContent = `${audioClips.length} audios · ${(totalKb / 1024).toFixed(1)} MB`;
  el('dlAudiosBtn').disabled = !audioClips.length;
  if (!audioClips.length) {
    body.innerHTML = '<tr><td colspan="6" class="small muted">Sin audios en esta encuesta.</td></tr>';
    return;
  }
  body.innerHTML = audioClips.map((c, i) => {
    const r = flagsById.get(c.data.responseId);
    return `<tr>
      <td class="small">${escapeHtml(c.data.responseId)}</td>
      <td>${escapeHtml(c.data.itemId)}</td>
      <td class="text-right">${fmtDuration(c.data.durationMs)}</td>
      <td class="text-right">${Math.round(c.bytes.length / 1024)}</td>
      <td>${r?.excludedFromExport ? 'sí' : ''}</td>
      <td><button type="button" class="btn btn-outline btn-sm" data-play="${i}">▶</button>
          <button type="button" class="btn btn-outline btn-sm" data-dl="${i}">⬇</button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => downloadClip(audioClips[Number(b.dataset.dl)])));
  body.querySelectorAll('[data-play]').forEach(btn => btn.addEventListener('click', () => {
    const c = audioClips[Number(btn.dataset.play)];
    const url = URL.createObjectURL(new Blob([c.bytes], { type: c.data.mime }));
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    a.play();
  }));
}

async function downloadAudiosZip() {
  const btn = el('dlAudiosBtn');
  btn.disabled = true; btn.textContent = 'Preparando .zip…';
  try {
    await zipAudioClips(audioClips, `${lastMeta.id}_audios`);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ Descargar todo (.zip)';
  }
}

// Build + save a .zip of clips ({id, data, bytes}) with a manifest.csv.
async function zipAudioClips(clips, baseName) {
  if (!clips.length) return;
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip();
    const flagsById = new Map(lastAllDocs.map(r => [r.id, r.data]));
    const rows = [['filename', 'surveyId', 'responseId', 'itemId', 'mime', 'bytes', 'durationMs', 'serverCode', 'excludedFromExport']];
    for (const c of clips) {
      const filename = `${lastMeta.id}__${c.id}.${audioExt(c.data.mime)}`;
      zip.file(filename, c.bytes);
      const r = flagsById.get(c.data.responseId);
      rows.push([filename, lastMeta.id, c.data.responseId, c.data.itemId, c.data.mime, c.bytes.length,
        c.data.durationMs, r?.serverCode ?? '', r?.excludedFromExport ? 1 : 0]);
    }
    zip.file('manifest.csv', rowsToCsv(rows));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });   // audio is already compressed
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${baseName}_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    alert('No se pudo crear el .zip.');
  }
}

// Audio metadata recorded on the response docs (no bytes) for one item.
function audioMetaEntries(responses, itemId) {
  const out = [];
  for (const r of responses) {
    const meta = (r.data?.audio || {})[itemId];
    if (meta) out.push({ id: r.id, meta, data: r.data });
  }
  return out;
}

function downloadClip(c) {
  const url = URL.createObjectURL(new Blob([c.bytes], { type: c.data.mime }));
  const a = document.createElement('a');
  a.href = url; a.download = `${lastMeta.id}__${c.id}.${audioExt(c.data.mime)}`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Variables tab: "Cargar para escuchar" fetches this item's clips on demand and
// renders a player + download button per clip, next to any typed text.
function wireItemAudio(container, responses) {
  const included = new Map(responses.map(r => [r.id, r]));
  container.querySelectorAll('[data-au-load]').forEach(btn => {
    const itemId = btn.dataset.auLoad;
    const block = btn.closest('.tx-audio');
    const list = block.querySelector('.au-list');
    const zipBtn = block.querySelector('[data-au-zip]');
    let loaded = [];
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Cargando…';
      try {
        const snap = await getDocs(query(collection(db, `responses/${lastMeta.id}/audio`), where('itemId', '==', itemId)));
        loaded = snap.docs
          .map(d => ({ id: d.id, data: d.data(), bytes: d.data().audio.toUint8Array() }))
          .filter(c => included.has(c.data.responseId))
          .sort((a, b) => (included.get(b.data.responseId) ? getCreatedAtMs(included.get(b.data.responseId).data) : 0) -
                          (included.get(a.data.responseId) ? getCreatedAtMs(included.get(a.data.responseId).data) : 0));
      } catch (e) {
        console.error(e);
        btn.disabled = false; btn.textContent = 'Reintentar (error al cargar)';
        return;
      }
      btn.textContent = `${loaded.length} cargados`;
      zipBtn.disabled = !loaded.length;
      list.innerHTML = loaded.map((c, i) => {
        const typed = String((included.get(c.data.responseId)?.data?.answers || {})[itemId] || '').trim();
        return `<div class="au-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border,#ddd);">
          <code>${escapeHtml(c.data.responseId.slice(0, 8))}</code>
          <span class="small">${fmtDuration(c.data.durationMs)} · ${Math.round(c.bytes.length / 1024)} KB</span>
          <audio controls preload="none" data-au-i="${i}" style="flex:1;min-width:200px;max-width:100%;"></audio>
          <button type="button" class="btn btn-outline btn-sm" data-au-dl="${i}">⬇</button>
          ${typed ? `<div class="small" style="flex-basis:100%;">Texto: ${escapeHtml(typed)}</div>` : ''}
        </div>`;
      }).join('');
      list.querySelectorAll('audio').forEach(a => {
        const c = loaded[Number(a.dataset.auI)];
        a.src = URL.createObjectURL(new Blob([c.bytes], { type: c.data.mime }));
      });
      list.querySelectorAll('[data-au-dl]').forEach(b => b.addEventListener('click', () => downloadClip(loaded[Number(b.dataset.auDl)])));
    });
    zipBtn.addEventListener('click', async () => {
      zipBtn.disabled = true;
      await zipAudioClips(loaded, `${lastMeta.id}_${itemId}_audios`);
      zipBtn.disabled = false;
    });
  });
}


/* ------------------------------------------------------------------ */
/* Device / technical info CSV ("bonus" paradata, one row per response) */
/* ------------------------------------------------------------------ */

// Best-effort User-Agent parsing. UAs are frozen/reduced by modern browsers
// (e.g. iOS always says 'iPhone OS 18_x', desktop Safari says 10_15_7), so treat
// OS versions as approximate; the raw userAgent column is always included.
function parseUserAgent(ua = '') {
  const m = (re) => { const r = ua.match(re); return r ? r[1] : ''; };
  let os = '', osVersion = '', device = 'desktop';
  if (/iPhone|iPod/.test(ua)) { os = 'iOS'; device = 'phone'; osVersion = m(/OS (\d+[_\d]*)/).replace(/_/g, '.'); }
  else if (/iPad/.test(ua)) { os = 'iPadOS'; device = 'tablet'; osVersion = m(/OS (\d+[_\d]*)/).replace(/_/g, '.'); }
  else if (/Android/.test(ua)) { os = 'Android'; device = /Mobile/.test(ua) ? 'phone' : 'tablet'; osVersion = m(/Android (\d+[.\d]*)/); }
  else if (/Windows/.test(ua)) { os = 'Windows'; osVersion = m(/Windows NT (\d+[.\d]*)/); }
  else if (/Mac OS X/.test(ua)) { os = 'macOS'; osVersion = m(/Mac OS X (\d+[_.\d]*)/).replace(/_/g, '.'); }
  else if (/CrOS/.test(ua)) { os = 'ChromeOS'; }
  else if (/Linux/.test(ua)) { os = 'Linux'; }

  let browser = '', browserVersion = '';
  if (/EdgA?\/|Edg\//.test(ua)) { browser = 'Edge'; browserVersion = m(/Edg[A]?\/(\d+[.\d]*)/); }
  else if (/OPR\/|Opera/.test(ua)) { browser = 'Opera'; browserVersion = m(/OPR\/(\d+[.\d]*)/); }
  else if (/SamsungBrowser/.test(ua)) { browser = 'Samsung Internet'; browserVersion = m(/SamsungBrowser\/(\d+[.\d]*)/); }
  else if (/FxiOS|Firefox/.test(ua)) { browser = 'Firefox'; browserVersion = m(/(?:FxiOS|Firefox)\/(\d+[.\d]*)/); }
  else if (/CriOS|Chrome/.test(ua)) { browser = 'Chrome'; browserVersion = m(/(?:CriOS|Chrome)\/(\d+[.\d]*)/); }
  else if (/Safari/.test(ua)) { browser = 'Safari'; browserVersion = m(/Version\/(\d+[.\d]*)/); }

  // In-app browsers (webviews) often restrict the mic and behave differently.
  const inApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|; wv\)|WhatsApp|Telegram/i.test(ua)
    ? (ua.match(/FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|WhatsApp|Telegram|; wv\)/i) || [''])[0].replace(/[;)\s/]/g, '') : '';
  return { device, os, osVersion, browser, browserVersion, inApp };
}

// { a: { b: 1 }, c: [1, 2] } -> { 'a.b': 1, c: '1; 2' }
function flattenObject(obj, prefix = '', out = {}) {
  if (obj == null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null) out[key] = '';
    else if (Array.isArray(v)) out[key] = v.join('; ');
    else if (typeof v === 'object' && !v.toDate) flattenObject(v, key, out);
    else out[key] = v;
  }
  return out;
}

function downloadDeviceCsv() {
  if (!lastMeta || !lastAllDocs.length) { alert('No hay datos cargados para exportar.'); return; }
  const ordered = lastResponses.slice().sort((a, b) => getCreatedAtMs(b.data) - getCreatedAtMs(a.data));
  const fixed = ['responseId', 'surveyId', 'createdAt', 'serverCode', 'isExcluded', 'totalTime_s',
    'device', 'os', 'osVersion', 'browser', 'browserVersion', 'inAppBrowser'];
  const dynamicCols = [];
  const seen = new Set(fixed);
  const records = ordered.map(({ id, data: d }) => {
    const ua = parseUserAgent(d.browserData?.userAgent || d.ua || '');
    const flat = {
      ...flattenObject(d.browserData, 'browser'),
      ...flattenObject(d.deviceInfo, 'device_info'),
      ...flattenObject({ tabHiddenCount: d.tabHiddenCount, tabHiddenMs: d.tabHiddenMs, navBackCount: d.navBackCount, answerChangeCount: d.answerChangeCount }, 'paradata'),
      ...flattenObject(d.audio, 'audio'),
      path: d.path ?? ''
    };
    for (const k of Object.keys(flat)) if (!seen.has(k)) { seen.add(k); dynamicCols.push(k); }
    const tt = Number(d.totalTime);
    return {
      responseId: id, surveyId: lastMeta.id, createdAt: isoOf(d), serverCode: d.serverCode ?? '',
      isExcluded: d.excludedFromExport ? 1 : 0, totalTime_s: Number.isFinite(tt) ? (tt / 1000).toFixed(1) : '',
      device: ua.device, os: ua.os, osVersion: ua.osVersion, browser: ua.browser, browserVersion: ua.browserVersion,
      inAppBrowser: ua.inApp, ...flat
    };
  });
  const header = [...fixed, ...dynamicCols];
  const rows = [header, ...records.map(r => header.map(h => r[h] ?? ''))];
  downloadBlob(`${lastMeta.id}_dispositivos_${new Date().toISOString().slice(0, 10)}.csv`, rowsToCsv(rows), 'text/csv');
}
