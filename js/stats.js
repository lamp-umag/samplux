// stats.js — public statistics page.
// Reads responses, shows only aggregates (no individual answers / PII).

import {
  fetchSurveyIndex, fetchSurveyDefinition, fetchResponses,
  getCreatedAtMs, completenessVsSurvey, answerableItems,
  variableDistribution, summarize, histogram, niceBinCount,
  fmtDuration, fmtNum, fmtPct, fmtDate,
  renderBarRows, renderHistogram, renderTimeline, dailyCounts, escapeHtml,
  cognitiveItems, renderCognitiveTask
} from './statsCore.js';

const kpis = document.getElementById('kpis');
const overviewMeta = document.getElementById('overviewMeta');
const globalTimeline = document.getElementById('globalTimeline');
const surveySelect = document.getElementById('surveySelect');
const surveyBody = document.getElementById('surveyBody');

const cacheResponses = new Map(); // surveyId -> docs
const cacheDef = new Map();       // surveyId -> def

function kpi(value, label) {
  return `<div class="kpi"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
}

async function loadResponses(surveyId) {
  if (cacheResponses.has(surveyId)) return cacheResponses.get(surveyId);
  const docs = await fetchResponses(surveyId);
  cacheResponses.set(surveyId, docs);
  return docs;
}

async function loadDef(meta) {
  if (cacheDef.has(meta.id)) return cacheDef.get(meta.id);
  const def = await fetchSurveyDefinition(meta);
  cacheDef.set(meta.id, def);
  return def;
}

async function init() {
  let surveys = [];
  try {
    surveys = await fetchSurveyIndex();
  } catch (e) {
    kpis.innerHTML = `<div class="notice">No se pudo cargar el índice de encuestas.</div>`;
    return;
  }

  // Populate selector
  surveySelect.innerHTML = surveys
    .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title || s.id)}</option>`)
    .join('');

  // ---- Global overview: fetch all surveys' responses ----
  let allDocs = [];
  let totalTimes = [];
  let permissionDenied = false;
  for (const s of surveys) {
    try {
      const docs = await loadResponses(s.id);
      docs.forEach(d => { d._surveyId = s.id; });
      allDocs = allDocs.concat(docs);
    } catch (e) {
      if (String(e?.code || e).includes('permission')) permissionDenied = true;
      else console.warn('Error leyendo', s.id, e);
    }
  }

  if (permissionDenied && !allDocs.length) {
    kpis.innerHTML = '';
    overviewMeta.textContent = '';
    document.getElementById('timelineWrap').classList.add('hidden');
    surveyBody.innerHTML = `<div class="notice">
      Las estadísticas públicas no están habilitadas. Las reglas de Firestore restringen la lectura de respuestas
      a administradores autenticados. Usa el <a href="admin-stats.html" style="color:var(--foreground);">panel avanzado</a>.
    </div>`;
    kpis.innerHTML = `<div class="notice" style="grid-column:1/-1;">Sin acceso público a los datos.</div>`;
    return;
  }

  for (const d of allDocs) {
    const t = Number(d.data?.totalTime);
    if (Number.isFinite(t) && t > 0) totalTimes.push(t);
  }

  const dates = allDocs.map(d => getCreatedAtMs(d.data)).filter(Boolean).sort((a, b) => a - b);
  const tSummary = summarize(totalTimes);

  kpis.innerHTML = [
    kpi(fmtNum(allDocs.length, 0), 'Respuestas totales'),
    kpi(fmtNum(surveys.length, 0), 'Encuestas'),
    kpi(tSummary.n ? fmtDuration(tSummary.median) : '—', 'Tiempo mediano'),
    kpi(tSummary.n ? fmtDuration(tSummary.mean) : '—', 'Tiempo promedio')
  ].join('');

  overviewMeta.textContent = dates.length
    ? `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`
    : 'Sin fechas registradas';

  renderTimeline(globalTimeline, dailyCounts(allDocs));

  // ---- Per-survey detail ----
  surveySelect.addEventListener('change', () => renderSurvey(surveys.find(s => s.id === surveySelect.value)));
  if (surveys.length) renderSurvey(surveys[0]);
}

async function renderSurvey(meta) {
  if (!meta) return;
  surveyBody.innerHTML = `<div class="small"><span class="spinner"></span> Cargando ${escapeHtml(meta.title || meta.id)}…</div>`;

  let docs, def;
  try {
    [docs, def] = await Promise.all([loadResponses(meta.id), loadDef(meta)]);
  } catch (e) {
    surveyBody.innerHTML = `<div class="notice">No se pudieron cargar las respuestas de esta encuesta.</div>`;
    return;
  }

  if (!docs.length) {
    surveyBody.innerHTML = `<div class="notice">Aún no hay respuestas para <b>${escapeHtml(meta.title || meta.id)}</b>.</div>`;
    return;
  }

  const responses = docs.map(d => ({ id: d.id, data: d.data }));
  const answerable = answerableItems(def);
  const answerableIds = answerable.map(it => it.id);

  // Total time
  const times = responses.map(r => Number(r.data?.totalTime)).filter(v => Number.isFinite(v) && v > 0);
  const tSum = summarize(times);

  // Completeness
  const comp = responses.map(r => completenessVsSurvey(r.data?.answers, answerableIds));
  const compSum = summarize(comp);

  const parts = [];

  // summary line
  parts.push(`<div class="summary-line">
    <div class="stat"><b>${responses.length}</b> respuestas</div>
    ${tSum.n ? `<div class="stat">Tiempo mediano <b>${fmtDuration(tSum.median)}</b></div>` : ''}
    ${tSum.n ? `<div class="stat">Rango <b>${fmtDuration(tSum.min)}</b>–<b>${fmtDuration(tSum.max)}</b></div>` : ''}
    ${compSum.n ? `<div class="stat">Completitud media <b>${fmtPct(compSum.mean)}</b></div>` : ''}
  </div>`);

  // total time histogram
  if (tSum.n) {
    parts.push(`<div class="subhead">Distribución del tiempo total de respuesta</div>
      <div class="var-numeric-line">
        media ${fmtDuration(tSum.mean)} · mediana ${fmtDuration(tSum.median)} · DE ${fmtDuration(tSum.sd)}
        · P25 ${fmtDuration(tSum.q1)} · P75 ${fmtDuration(tSum.q3)}
      </div>
      <div id="timeHist"></div>`);
  }

  // responses over time
  parts.push(`<div class="subhead">Respuestas por día</div><div id="svTimeline"></div>`);

  // cognitive tasks
  const cogs = cognitiveItems(def);
  if (cogs.length) {
    parts.push(`<div class="subhead">Tareas cognitivas</div><div id="cogList"></div>`);
  }

  // variable distributions
  parts.push(`<div class="subhead">Distribución de variables</div><div id="varList"></div>`);

  surveyBody.innerHTML = parts.join('');

  if (tSum.n) {
    renderHistogram(document.getElementById('timeHist'),
      histogram(times.map(t => t / 1000), niceBinCount(times.length)),
      { fmt: (sec) => fmtDuration(sec * 1000) });
  }
  renderTimeline(document.getElementById('svTimeline'), dailyCounts(responses));

  if (cogs.length) {
    const cogList = document.getElementById('cogList');
    cogList.innerHTML = '';
    for (const item of cogs) {
      const block = document.createElement('div');
      block.className = 'var-block';
      cogList.appendChild(block);
      renderCognitiveTask(block, item, responses);
    }
  }

  // variables
  const varList = document.getElementById('varList');
  varList.innerHTML = '';
  for (const item of answerable) {
    const dist = variableDistribution(def, item, responses);
    const block = document.createElement('div');
    block.className = 'var-block';

    if (dist.kind === 'numeric') {
      const s = dist.summary;
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)}</div>`;
      if (s.n) {
        block.innerHTML += `<div class="var-numeric-line">
          n=${s.n} · media ${fmtNum(s.mean)} · mediana ${fmtNum(s.median)} · DE ${fmtNum(s.sd)}
          · min ${fmtNum(s.min)} · max ${fmtNum(s.max)}</div><div class="vh"></div>`;
        varList.appendChild(block);
        renderHistogram(block.querySelector('.vh'), dist.hist, { fmt: (v) => fmtNum(v, 0) });
        continue;
      } else {
        block.innerHTML += `<div class="var-numeric-line">Sin respuestas numéricas.</div>`;
      }
    } else if (dist.kind === 'categorical' || dist.kind === 'multi') {
      const tag = dist.multi ? ' <span class="small">(selección múltiple)</span>' : '';
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)}${tag}</div>
        <div class="var-numeric-line">${dist.answered}/${dist.total} respondieron</div><div class="vb"></div>`;
      varList.appendChild(block);
      renderBarRows(block.querySelector('.vb'), dist.rows);
      continue;
    } else {
      // text-like: response rate only (no content shown publicly)
      block.innerHTML = `<div class="var-prompt">${escapeHtml(dist.prompt || item.id)}
        <span class="small">(texto libre)</span></div>
        <div class="var-numeric-line">${dist.answered}/${dist.total} respondieron · contenido no mostrado</div>`;
    }
    varList.appendChild(block);
  }
}

init();
