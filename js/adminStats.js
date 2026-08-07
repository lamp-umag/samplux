// adminStats.js — authenticated, in-depth statistics panel.
// Mirrors admin.js auth gating and exclusion-flag awareness, but focuses on
// distributions, response timing, per-item timing, and speeder detection.

import { app } from './firebaseClient.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  fetchSurveyIndex, fetchSurveyDefinition, fetchResponses, fetchExportFlags, mergeFlags,
  getCreatedAtMs, completenessVsSurvey, answerableItems,
  variableDistribution, summarize, histogram, niceBinCount, quantile,
  fmtDuration, fmtNum, fmtPct, fmtDate,
  renderBarRows, renderHistogram, renderTimeline, dailyCounts, escapeHtml,
  cognitiveItems, renderCognitiveTask, itemKind,
  COGNITIVE_METRICS, COGNITIVE_LABELS, resolveItemOptions
} from './statsCore.js';

const ALLOWED_EMAILS = new Set(['hermanelgueta@gmail.com', 'herman.elgueta@umag.cl']);
const auth = getAuth(app);

const el = id => document.getElementById(id);
const loginBtn = el('loginBtn');
const authCard = el('authCard');
const authError = el('authError');
const userChip = el('userChip');
const userEmail = el('userEmail');
const userStatusDot = el('userStatusDot');
const controlsCard = el('controlsCard');
const timeCard = el('timeCard');
const itemTimeCard = el('itemTimeCard');
const varCard = el('varCard');
const cogCard = el('cogCard');
const surveySelect = el('surveySelect');
const includeExcluded = el('includeExcluded');
const refreshBtn = el('refreshBtn');
const refreshSpinner = el('refreshSpinner');
const kpis = el('kpis');

let surveys = [];
const cacheDef = new Map();
// last rendered context, used by the download buttons
let lastDef = null, lastResponses = [], lastMeta = null;

/* ---- auth ---- */
loginBtn?.addEventListener('click', async () => {
  authError.classList.add('hidden');
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    authError.textContent = 'No se pudo iniciar sesión: ' + (e?.message || e);
    authError.classList.remove('hidden');
  }
});

onAuthStateChanged(auth, async (user) => {
  const email = (user?.email || '').toLowerCase();
  if (user && ALLOWED_EMAILS.has(email)) {
    userChip.classList.remove('hidden');
    userEmail.textContent = user.email;
    userStatusDot.classList.remove('warn');
    authCard.classList.add('hidden');
    controlsCard.classList.remove('hidden');
    timeCard.classList.remove('hidden');
    itemTimeCard.classList.remove('hidden');
    varCard.classList.remove('hidden');
    cogCard.classList.remove('hidden');
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
    [controlsCard, timeCard, itemTimeCard, varCard, cogCard].forEach(c => c.classList.add('hidden'));
  }
});

/* ---- data load ---- */
async function boot() {
  try {
    surveys = await fetchSurveyIndex();
  } catch (e) {
    kpis.innerHTML = `<div class="small danger">No se pudo cargar surveys/index.json.</div>`;
    return;
  }
  surveySelect.innerHTML = surveys
    .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title || s.id)}</option>`).join('');
  surveySelect.addEventListener('change', render);
  includeExcluded.addEventListener('change', render);
  refreshBtn.addEventListener('click', () => render(true));
  el('dlCsvBtn').addEventListener('click', downloadNeatCsv);
  el('dlMetaBtn').addEventListener('click', downloadMetadata);
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

function kpi(value, label, warn = false) {
  return `<div class="kpi"><div class="kpi-value${warn ? ' warn' : ''}">${value}</div><div class="kpi-label">${label}</div></div>`;
}

async function render(force = false) {
  const meta = surveys.find(s => s.id === surveySelect.value);
  if (!meta) return;
  setLoading(true);
  try {
    const [docsRaw, flags, def] = await Promise.all([
      fetchResponses(meta.id), fetchExportFlags(meta.id), loadDef(meta, force === true)
    ]);

    // merge exclusion flags
    const all = docsRaw.map(d => ({ id: d.id, data: mergeFlags(d.data, flags.get(d.id)) }));
    const excludedCount = all.filter(r => r.data?.excludedFromExport).length;
    const responses = includeExcluded.checked ? all : all.filter(r => !r.data?.excludedFromExport);

    if (!all.length) {
      kpis.innerHTML = `<div class="kpi" style="grid-column:1/-1;"><div class="kpi-value">0</div><div class="kpi-label">Sin respuestas</div></div>`;
      el('timeSummary').textContent = '';
      ['timeHist', 'speedBuckets', 'timeline', 'itemTimeBody', 'varList'].forEach(id => el(id).innerHTML = '');
      el('itemTimeBody').innerHTML = '<tr><td colspan="6" class="small muted">Sin datos.</td></tr>';
      return;
    }

    const answerable = answerableItems(def);
    const answerableIds = answerable.map(i => i.id);

    // remember context for the download buttons
    lastDef = def; lastResponses = responses; lastMeta = meta;

    // ----- timing -----
    const times = responses.map(r => Number(r.data?.totalTime)).filter(v => Number.isFinite(v) && v > 0);
    const tSum = summarize(times);
    const comp = responses.map(r => completenessVsSurvey(r.data?.answers, answerableIds));
    const compSum = summarize(comp);

    // ----- KPIs -----
    kpis.innerHTML = [
      kpi(fmtNum(all.length, 0), 'Respuestas'),
      kpi(fmtNum(excludedCount, 0), 'Excluidas', excludedCount > 0),
      kpi(tSum.n ? fmtDuration(tSum.median) : '—', 'Tiempo mediano'),
      kpi(tSum.n ? fmtDuration(tSum.mean) : '—', 'Tiempo promedio'),
      kpi(compSum.n ? fmtPct(compSum.mean) : '—', 'Completitud media')
    ].join('');

    // ----- total time card -----
    el('timeMeta').textContent = `${tSum.n} con tiempo registrado`;
    el('timeSummary').innerHTML = tSum.n ? `
      media ${fmtDuration(tSum.mean)} · mediana ${fmtDuration(tSum.median)} · DE ${fmtDuration(tSum.sd)}
      · min ${fmtDuration(tSum.min)} · P25 ${fmtDuration(tSum.q1)} · P75 ${fmtDuration(tSum.q3)} · máx ${fmtDuration(tSum.max)}`
      : 'No hay tiempos de respuesta registrados (paradata deshabilitado o sin datos).';

    if (tSum.n) {
      renderHistogram(el('timeHist'),
        histogram(times.map(t => t / 1000), niceBinCount(times.length)),
        { fmt: (sec) => fmtDuration(sec * 1000) });
    } else {
      el('timeHist').innerHTML = '';
    }

    // ----- speed buckets (speeders / slow) -----
    renderSpeedBuckets(el('speedBuckets'), times, tSum);

    // ----- timeline -----
    renderTimeline(el('timeline'), dailyCounts(responses));

    // ----- per-item timing -----
    renderItemTiming(el('itemTimeBody'), answerable, responses);

    // ----- cognitive tasks -----
    const cogs = cognitiveItems(def);
    const cogList = el('cogList');
    if (cogs.length) {
      cogCard.classList.remove('hidden');
      cogList.innerHTML = '';
      for (const item of cogs) {
        const block = document.createElement('div');
        block.className = 'var-block';
        cogList.appendChild(block);
        renderCognitiveTask(block, item, responses);
      }
      el('cogMeta').textContent = `${cogs.length} tarea${cogs.length === 1 ? '' : 's'} · ${responses.length} respuestas`;
    } else {
      cogList.innerHTML = '<div class="sc-empty">Esta encuesta no incluye tareas cognitivas.</div>';
      el('cogMeta').textContent = '';
    }

    // ----- variable distributions -----
    renderVariables(el('varList'), def, answerable, responses);
    el('varMeta').textContent = `${answerable.length} variables · ${responses.length} respuestas`;
  } catch (e) {
    console.error(e);
    kpis.innerHTML = `<div class="small danger">Error al cargar: ${escapeHtml(e?.message || e)}</div>`;
  } finally {
    setLoading(false);
  }
}

function renderSpeedBuckets(container, times, tSum) {
  if (!tSum.n) { container.innerHTML = '<div class="sc-empty">Sin tiempos para clasificar.</div>'; return; }
  // Outlier-aware buckets using the IQR fences + fixed "very fast" floor.
  const fastFence = Math.max(tSum.q1 - 1.5 * (tSum.q3 - tSum.q1), 0);
  const slowFence = tSum.q3 + 1.5 * (tSum.q3 - tSum.q1);
  const veryFastFloor = 60 * 1000; // under 1 min is suspicious for most surveys
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

function renderItemTiming(tbody, answerable, responses) {
  tbody.innerHTML = '';
  const rows = [];
  for (const item of answerable) {
    const vals = responses
      .map(r => Number((r.data?.itemTimes || {})[item.id]))
      .filter(v => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    const changes = responses
      .map(r => Number((r.data?.itemAnswerChangeCount || {})[item.id]))
      .filter(v => Number.isFinite(v));
    const totalChanges = changes.reduce((a, b) => a + b, 0);
    if (!vals.length) continue;
    rows.push({
      id: item.id,
      n: vals.length,
      median: quantile(vals, 0.5),
      q1: quantile(vals, 0.25),
      q3: quantile(vals, 0.75),
      max: vals[vals.length - 1],
      changes: totalChanges
    });
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="small muted">No hay tiempos por ítem (paradata deshabilitado o sin datos).</td></tr>';
    return;
  }
  rows.sort((a, b) => b.median - a.median);
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td class="text-right">${r.n}</td>
      <td class="text-right">${(r.median / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.q1 / 1000).toFixed(1)}–${(r.q3 / 1000).toFixed(1)}s</td>
      <td class="text-right">${(r.max / 1000).toFixed(1)}s</td>
      <td class="text-right">${r.changes}</td>
    </tr>`).join('');
}

function renderVariables(container, def, answerable, responses) {
  container.innerHTML = '';
  for (const item of answerable) {
    const dist = variableDistribution(def, item, responses);
    const block = document.createElement('div');
    block.className = 'var-block';

    if (dist.kind === 'numeric') {
      const s = dist.summary;
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)} <code>${escapeHtml(item.id)}</code></div>`;
      if (s.n) {
        block.innerHTML += `<div class="var-numeric-line">n=${s.n} · media ${fmtNum(s.mean)} · mediana ${fmtNum(s.median)} · DE ${fmtNum(s.sd)} · min ${fmtNum(s.min)} · max ${fmtNum(s.max)}</div><div class="vh"></div>`;
        container.appendChild(block);
        renderHistogram(block.querySelector('.vh'), dist.hist, { fmt: (v) => fmtNum(v, 0) });
        continue;
      }
      block.innerHTML += `<div class="var-numeric-line">Sin respuestas numéricas.</div>`;
    } else if (dist.kind === 'categorical' || dist.kind === 'multi') {
      const tag = dist.multi ? ' <span class="small">(selección múltiple)</span>' : '';
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)} <code>${escapeHtml(item.id)}</code>${tag}</div>
        <div class="var-numeric-line">${dist.answered}/${dist.total} respondieron</div><div class="vb"></div>`;
      container.appendChild(block);
      renderBarRows(block.querySelector('.vb'), dist.rows);
      continue;
    } else {
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)} <code>${escapeHtml(item.id)}</code> <span class="small">(texto libre)</span></div>
        <div class="var-numeric-line">${dist.answered}/${dist.total} respondieron</div>`;
    }
    container.appendChild(block);
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
  if (typeof v === 'object') return JSON.stringify(v); // shouldn't happen for answerable items
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

function buildNeatCsvRows(def, responses, surveyId) {
  const answerable = answerableItems(def);
  const cogs = cognitiveItems(def);
  const answerableIds = answerable.map(i => i.id);

  const header = [
    'responseId', 'surveyId', 'createdAt', 'isExcluded', 'excludeReason', 'excludeNote',
    'totalTime_s', 'completeness_pct', 'navBackCount', 'answerChangeCount',
    ...answerable.map(it => it.id),
    ...cogs.flatMap(it => (COGNITIVE_METRICS[it.type] || []).map(m => `${it.id}__${m.key}`)),
    ...answerable.map(it => `${it.id}__time_s`)
  ];

  const rows = [header];
  // newest first, like the admin exports
  const ordered = responses.slice().sort((a, b) => getCreatedAtMs(b.data) - getCreatedAtMs(a.data));

  for (const r of ordered) {
    const d = r.data || {};
    const ans = d.answers || {};
    const itimes = d.itemTimes || {};
    const row = [];

    row.push(r.id, surveyId, isoOf(d), d.excludedFromExport ? '1' : '0', d.excludeReason || '', d.excludeNote || '');
    const tt = Number(d.totalTime);
    row.push(Number.isFinite(tt) ? (tt / 1000).toFixed(1) : '');
    row.push(Math.round(completenessVsSurvey(ans, answerableIds) * 100));
    row.push(d.navBackCount ?? '', d.answerChangeCount ?? '');

    for (const it of answerable) row.push(flatAnswer(ans[it.id]));

    for (const it of cogs) {
      const a = ans[it.id];
      const sum = a && a.summary ? a.summary : {};
      for (const m of (COGNITIVE_METRICS[it.type] || [])) {
        const v = Number(sum[m.key]);
        row.push(Number.isFinite(v) ? v : '');
      }
    }

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
  const cogs = cognitiveItems(def);

  L.push('CODEBOOK / DICCIONARIO DE VARIABLES');
  L.push('='.repeat(60));
  L.push(`Encuesta:     ${def.title || surveyId}`);
  L.push(`survey_id:    ${surveyId}`);
  if (def.description) L.push(`Descripción:  ${def.description}`);
  L.push(`Exportado:    ${new Date().toISOString()}`);
  L.push(`Respuestas:   ${responses.length}`);
  L.push(`Variables:    ${answerable.length} ítems de respuesta · ${cogs.length} tareas cognitivas`);
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
    ['totalTime_s', 'tiempo total de respuesta (segundos)'],
    ['completeness_pct', 'porcentaje de ítems de respuesta completados'],
    ['navBackCount', 'número de veces que retrocedió'],
    ['answerChangeCount', 'número de veces que cambió una respuesta'],
    ['<id>__time_s', 'tiempo dedicado al ítem <id> (segundos)']
  ];
  for (const [c, d] of metaCols) L.push(`  ${c.padEnd(20)} ${d}`);
  L.push('');
  L.push('ÍTEMS DE RESPUESTA (en orden de aplicación)');
  L.push('-'.repeat(60));

  const items = Array.isArray(def.items) ? def.items : [];
  let idx = 0;
  for (const item of items) {
    const kind = itemKind(def, item);
    if (kind === 'info') {
      const p = typeof item.prompt === 'string' ? item.prompt.split('\n')[0] : '';
      if (/^SECCIÓN/i.test(p)) { L.push(''); L.push(`== ${p} ==`); }
      continue;
    }
    if (kind === 'task') continue; // cognitive tasks documented separately below

    idx += 1;
    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s*\n\s*/g, ' ').trim() : '';
    L.push('');
    L.push(`[${idx}] ${item.id}  (${item.type})`);
    if (prompt) L.push(`     Pregunta: ${prompt}`);
    if (kind === 'numeric') {
      const rng = [];
      if (item.min != null) rng.push(`min ${item.min}`);
      if (item.max != null) rng.push(`max ${item.max}`);
      L.push(`     Tipo: numérico${rng.length ? ' · ' + rng.join(', ') : ''}`);
    } else if (kind === 'categorical' || kind === 'multi') {
      const opts = resolveItemOptions(def, item);
      L.push(`     Tipo: ${kind === 'multi' ? 'selección múltiple (valores separados por "; ")' : 'opción única'}`);
      L.push('     Códigos:');
      for (const o of opts) L.push(`        ${String(o.code).padEnd(6)} = ${o.label}`);
    } else {
      L.push('     Tipo: texto libre');
    }
  }

  if (cogs.length) {
    L.push('');
    L.push('TAREAS COGNITIVAS (columnas <id>__<métrica>)');
    L.push('-'.repeat(60));
    for (const item of cogs) {
      L.push('');
      L.push(`${item.id}  —  ${COGNITIVE_LABELS[item.type] || item.type}`);
      for (const m of (COGNITIVE_METRICS[item.type] || [])) {
        L.push(`     ${`${item.id}__${m.key}`.padEnd(34)} ${m.desc}`);
      }
    }
  }

  L.push('');
  L.push('='.repeat(60));
  L.push('Generado por samplux · admin-stats.html');
  return L.join('\n');
}

function downloadNeatCsv() {
  if (!lastDef || !lastResponses.length) { alert('No hay datos cargados para exportar.'); return; }
  const rows = buildNeatCsvRows(lastDef, lastResponses, lastMeta.id);
  const scope = includeExcluded.checked ? 'con_excluidas' : 'sin_excluidas';
  downloadBlob(`${lastMeta.id}_completo_${scope}.csv`, rowsToCsv(rows), 'text/csv');
}

function downloadMetadata() {
  if (!lastDef) { alert('Selecciona una encuesta primero.'); return; }
  const text = buildMetadataText(lastDef, lastResponses, lastMeta.id);
  downloadBlob(`${lastMeta.id}_metadata.txt`, text, 'text/plain');
}
