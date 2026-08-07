// statsCore.js — shared, theme-agnostic helpers for stats.html and admin-stats.html
// Pure compute + Firestore fetch + dependency-free DOM rendering.
// No auth here, so it can be imported by both the public and admin pages.

import { db } from './firebaseClient.js';
import {
  collection,
  getDocs
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

const EXPORT_META_ROOT = 'response_export_meta';

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

export async function fetchSurveyIndex() {
  const res = await fetch('surveys/index.json?_=' + Date.now());
  const data = await res.json();
  return data.surveys || [];
}

export async function fetchSurveyDefinition(meta) {
  if (!meta || !meta.file) return null;
  try {
    const res = await fetch(`surveys/${meta.file}?_=${Date.now()}`);
    const def = await res.json();
    return await resolveSurveyExtends(def);
  } catch (e) {
    console.warn('No se pudo leer la definición de la encuesta:', meta.file, e);
    return null;
  }
}

// Minimal extends resolution: merge items + optionSets + remove rules.
async function resolveSurveyExtends(raw) {
  if (!raw || typeof raw !== 'object' || !raw.extends) return raw;
  const baseFile = typeof raw.extends === 'string'
    ? raw.extends
    : (raw.extends && typeof raw.extends === 'object' ? raw.extends.file : null);
  if (!baseFile) return raw;
  try {
    const res = await fetch(`surveys/${baseFile}?_=${Date.now()}`);
    const base = await res.json();
    const merged = structuredClone(base);
    if (raw.id) merged.id = raw.id;
    if (raw.title) merged.title = raw.title;
    if (raw.description) merged.description = raw.description;
    if (raw.optionSets) merged.optionSets = { ...(merged.optionSets || {}), ...raw.optionSets };
    if (Array.isArray(raw.items)) merged.items = raw.items;
    if (Array.isArray(raw.removeItemIds) && raw.removeItemIds.length) {
      const drop = new Set(raw.removeItemIds.filter(Boolean));
      merged.items = (merged.items || []).filter(it => !drop.has(it && it.id));
    }
    if (raw.removeRutQuestions) {
      const rut = /\bR\s*\.?\s*U\s*\.?\s*T\b/i;
      merged.items = (merged.items || []).filter(it => {
        const p = it && typeof it.prompt === 'string' ? it.prompt : '';
        const id = it && typeof it.id === 'string' ? it.id : '';
        return !rut.test(p) && !/\brut\b/i.test(id);
      });
    }
    return merged;
  } catch (e) {
    console.warn('No se pudo resolver extends:', e);
    return raw;
  }
}

export async function fetchResponses(surveyId) {
  const colRef = collection(db, `responses/${surveyId}/entries`);
  const snap = await getDocs(colRef);
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, data: d.data() }));
  return docs;
}

export async function fetchExportFlags(surveyId) {
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

export function mergeFlags(data, meta) {
  if (!meta || typeof meta !== 'object') return data;
  const out = { ...data };
  if (typeof meta.excludedFromExport === 'boolean') out.excludedFromExport = meta.excludedFromExport;
  if (meta.excludeReason !== undefined) out.excludeReason = meta.excludeReason;
  if (meta.excludeNote !== undefined) out.excludeNote = meta.excludeNote;
  return out;
}

/* ------------------------------------------------------------------ */
/* Response-level helpers                                              */
/* ------------------------------------------------------------------ */

export function getCreatedAtMs(data) {
  if (data?.createdAt?.toDate) return data.createdAt.toDate().getTime();
  if (data?.browserData?.timestamp) {
    const ts = Date.parse(data.browserData.timestamp);
    return Number.isNaN(ts) ? 0 : ts;
  }
  return 0;
}

export function answerCompleteness(answers) {
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

// Completeness relative to the survey's real answerable items (more honest
// than answerCompleteness, which only looks at the keys present in the doc).
export function completenessVsSurvey(answers, answerableIds) {
  if (!answerableIds || !answerableIds.length) return answerCompleteness(answers);
  const obj = answers && typeof answers === 'object' ? answers : {};
  let filled = 0;
  for (const id of answerableIds) {
    const v = obj[id];
    const ok = Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '';
    if (ok) filled += 1;
  }
  return filled / answerableIds.length;
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values) {
  const arr = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const n = arr.length;
  if (!n) return { n: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    min: arr[0],
    q1: quantile(arr, 0.25),
    median: quantile(arr, 0.5),
    q3: quantile(arr, 0.75),
    max: arr[n - 1],
    sorted: arr
  };
}

// Freedman–Diaconis-ish bin count, clamped to a sane range.
export function niceBinCount(n) {
  if (n <= 1) return 1;
  return Math.max(5, Math.min(20, Math.ceil(Math.sqrt(n))));
}

export function histogram(values, binCount) {
  const arr = values.filter(v => Number.isFinite(v));
  const n = arr.length;
  if (!n) return { bins: [], maxCount: 0, n: 0 };
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const k = binCount || niceBinCount(n);
  if (min === max) {
    return { bins: [{ x0: min, x1: max, count: n }], maxCount: n, n };
  }
  const width = (max - min) / k;
  const bins = Array.from({ length: k }, (_, i) => ({
    x0: min + i * width,
    x1: min + (i + 1) * width,
    count: 0
  }));
  for (const v of arr) {
    let idx = Math.floor((v - min) / width);
    if (idx >= k) idx = k - 1;
    if (idx < 0) idx = 0;
    bins[idx].count += 1;
  }
  const maxCount = Math.max(...bins.map(b => b.count));
  return { bins, maxCount, n };
}

/* ------------------------------------------------------------------ */
/* Item / variable helpers                                            */
/* ------------------------------------------------------------------ */

export function resolveItemOptions(survey, item) {
  if (!item) return [];
  if (item.type === 'yes_no') return [{ code: 'yes', label: 'Sí' }, { code: 'no', label: 'No' }];
  const raw = (survey && survey.optionSets && survey.optionSets[item.type]) || item.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((opt, idx) => {
    if (typeof opt === 'string') return { code: idx + 1, label: opt };
    const label = opt.label ?? String(opt.code ?? opt.value ?? opt);
    const code = opt.code ?? opt.value ?? (idx + 1);
    return { code, label };
  });
}

export function itemKind(survey, item) {
  const t = item && item.type;
  if (!t) return 'text';
  if (t === 'info') return 'info';
  if (t === 'task_rt' || t === 'task_stroop' || t === 'task_gonogo') return 'task';
  if (t === 'number' || t === 'slider') return 'numeric';
  if (t === 'multi_choice') return 'multi';
  if (t === 'yes_no' || t === 'single_choice') return 'categorical';
  if ((survey && survey.optionSets && survey.optionSets[t]) || Array.isArray(item.options)) return 'categorical';
  return 'text';
}

// Items that actually collect an answer (excludes info + cognitive tasks).
export function answerableItems(survey) {
  const items = Array.isArray(survey?.items) ? survey.items : [];
  return items.filter(it => {
    const k = itemKind(survey, it);
    return k !== 'info' && k !== 'task' && it && it.id;
  });
}

// Build the distribution payload for a single item across all responses.
export function variableDistribution(survey, item, responses) {
  const kind = itemKind(survey, item);
  const id = item.id;
  const values = responses.map(r => (r.data?.answers || {})[id]);
  const answeredCount = values.filter(v =>
    Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== ''
  ).length;
  const base = { id, kind, prompt: cleanPrompt(item.prompt), total: responses.length, answered: answeredCount };

  if (kind === 'numeric') {
    const nums = values.map(v => Number(v)).filter(v => Number.isFinite(v));
    return { ...base, summary: summarize(nums), hist: histogram(nums) };
  }

  if (kind === 'categorical' || kind === 'multi') {
    const opts = resolveItemOptions(survey, item);
    const counts = new Map();
    opts.forEach(o => counts.set(String(o.code), 0));
    let other = 0;
    for (const v of values) {
      const list = Array.isArray(v) ? v : (v == null || String(v).trim() === '' ? [] : [v]);
      for (const code of list) {
        const key = String(code);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
        else other += 1;
      }
    }
    const denom = kind === 'multi' ? Math.max(answeredCount, 1) : Math.max(answeredCount, 1);
    const rows = opts.map(o => {
      const c = counts.get(String(o.code)) || 0;
      return { label: o.label, count: c, pct: c / denom };
    });
    if (other > 0) rows.push({ label: '(otro / fuera de escala)', count: other, pct: other / denom });
    return { ...base, rows, multi: kind === 'multi' };
  }

  // text-like
  return base;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

export function fmtDuration(ms) {
  if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 0) return '—';
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtNum(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-CL', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function cleanPrompt(p) {
  if (typeof p !== 'string') return '';
  return p.split('\n')[0].replace(/^SECCIÓN.*/i, '').trim() || p.split('\n')[0];
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Rendering (dependency-free; styled via shared .sc-* CSS classes)   */
/* ------------------------------------------------------------------ */

// Horizontal bar list for categorical distributions.
export function renderBarRows(container, rows, { showPct = true } = {}) {
  const max = Math.max(1, ...rows.map(r => r.count));
  container.innerHTML = rows.map(r => {
    const w = Math.round((r.count / max) * 100);
    const meta = showPct ? `${r.count} · ${fmtPct(r.pct)}` : `${r.count}`;
    return `
      <div class="sc-bar-row">
        <div class="sc-bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
        <div class="sc-bar-track"><div class="sc-bar-fill" style="width:${w}%"></div></div>
        <div class="sc-bar-meta">${meta}</div>
      </div>`;
  }).join('');
}

// Vertical histogram for numeric / timing distributions.
export function renderHistogram(container, hist, { fmt = (v) => fmtNum(v, 0) } = {}) {
  if (!hist || !hist.bins.length) {
    container.innerHTML = '<div class="sc-empty">Sin datos numéricos.</div>';
    return;
  }
  const max = Math.max(1, hist.maxCount);
  const bars = hist.bins.map(b => {
    const h = Math.round((b.count / max) * 100);
    const lo = fmt(b.x0);
    const hi = fmt(b.x1);
    return `
      <div class="sc-hist-col" title="${lo}–${hi}: ${b.count}">
        <div class="sc-hist-count">${b.count || ''}</div>
        <div class="sc-hist-bar" style="height:${Math.max(h, b.count ? 4 : 0)}%"></div>
      </div>`;
  }).join('');
  const first = fmt(hist.bins[0].x0);
  const last = fmt(hist.bins[hist.bins.length - 1].x1);
  container.innerHTML = `
    <div class="sc-hist">${bars}</div>
    <div class="sc-hist-axis"><span>${first}</span><span>${last}</span></div>`;
}

// Simple SVG area/line for responses over time.
export function renderTimeline(container, points) {
  // points: [{ ms, count }] sorted ascending by ms
  if (!points.length) {
    container.innerHTML = '<div class="sc-empty">Sin respuestas registradas.</div>';
    return;
  }
  const W = 600, H = 120, pad = 4;
  const xs = points.map(p => p.ms);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxY = Math.max(1, ...points.map(p => p.count));
  const spanX = maxX - minX || 1;
  const px = ms => pad + ((ms - minX) / spanX) * (W - 2 * pad);
  const py = c => (H - pad) - (c / maxY) * (H - 2 * pad);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.ms).toFixed(1)},${py(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${px(maxX).toFixed(1)},${H - pad} L${px(minX).toFixed(1)},${H - pad} Z`;
  const dots = points.map(p =>
    `<circle cx="${px(p.ms).toFixed(1)}" cy="${py(p.count).toFixed(1)}" r="2.5" class="sc-tl-dot"></circle>`
  ).join('');
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="sc-timeline" preserveAspectRatio="none">
      <path d="${area}" class="sc-tl-area"></path>
      <path d="${line}" class="sc-tl-line" fill="none"></path>
      ${dots}
    </svg>
    <div class="sc-hist-axis"><span>${fmtDate(minX)}</span><span>${fmtDate(maxX)}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* Cognitive tasks (Stroop / RT / Go-No-Go)                            */
/* ------------------------------------------------------------------ */

export const COGNITIVE_TASK_TYPES = ['task_rt', 'task_stroop', 'task_gonogo'];

export const COGNITIVE_LABELS = {
  task_rt: 'Tiempo de Reacción',
  task_stroop: 'Test de Stroop',
  task_gonogo: 'Go / No-Go'
};

// Summary metrics each task stores under answers[id].summary, with display
// metadata + codebook descriptions. Order = how they appear in tables/CSV.
export const COGNITIVE_METRICS = {
  task_rt: [
    { key: 'mean_rt_ms', label: 'TR medio', unit: 'ms', digits: 0, desc: 'tiempo de reacción medio (ms)' },
    { key: 'sd_rt_ms', label: 'DE del TR', unit: 'ms', digits: 0, desc: 'desviación estándar del TR (ms)' },
    { key: 'min_rt_ms', label: 'TR mínimo', unit: 'ms', digits: 0, desc: 'tiempo de reacción más rápido (ms)' },
    { key: 'max_rt_ms', label: 'TR máximo', unit: 'ms', digits: 0, desc: 'tiempo de reacción más lento (ms)' },
    { key: 'n_trials', label: 'Nº ensayos', unit: '', digits: 0, desc: 'número de ensayos válidos' }
  ],
  task_stroop: [
    { key: 'stroop_effect_ms', label: 'Efecto Stroop', unit: 'ms', digits: 0, desc: 'efecto Stroop = TR incongruente − congruente (ms)' },
    { key: 'mean_rt_congruent', label: 'TR congruente', unit: 'ms', digits: 0, desc: 'TR medio en ensayos congruentes (ms)' },
    { key: 'mean_rt_incongruent', label: 'TR incongruente', unit: 'ms', digits: 0, desc: 'TR medio en ensayos incongruentes (ms)' },
    { key: 'accuracy_congruent', label: 'Precisión congruente', unit: '%', digits: 0, desc: 'precisión en ensayos congruentes (%)' },
    { key: 'accuracy_incongruent', label: 'Precisión incongruente', unit: '%', digits: 0, desc: 'precisión en ensayos incongruentes (%)' },
    { key: 'n_trials', label: 'Nº ensayos', unit: '', digits: 0, desc: 'número de ensayos de prueba' }
  ],
  task_gonogo: [
    { key: 'false_alarm_rate', label: 'Tasa falsas alarmas', unit: '%', digits: 0, desc: 'tasa de falsas alarmas — respondió ante No-Go (%)' },
    { key: 'hit_rate', label: 'Tasa de aciertos', unit: '%', digits: 0, desc: 'tasa de aciertos — respondió ante Go (%)' },
    { key: 'mean_rt_hits', label: 'TR aciertos', unit: 'ms', digits: 0, desc: 'TR medio en aciertos (ms)' },
    { key: 'hits', label: 'Aciertos', unit: '', digits: 0, desc: 'número de aciertos (hits)' },
    { key: 'false_alarms', label: 'Falsas alarmas', unit: '', digits: 0, desc: 'número de falsas alarmas' },
    { key: 'n_trials', label: 'Nº ensayos', unit: '', digits: 0, desc: 'número de ensayos de prueba' }
  ]
};

// Which metric to plot as the headline distribution per task.
export const COGNITIVE_PRIMARY = {
  task_rt: 'mean_rt_ms',
  task_stroop: 'stroop_effect_ms',
  task_gonogo: 'false_alarm_rate'
};

export function isCognitiveTask(item) {
  return !!item && COGNITIVE_TASK_TYPES.includes(item.type);
}

export function cognitiveItems(survey) {
  const items = Array.isArray(survey?.items) ? survey.items : [];
  return items.filter(isCognitiveTask);
}

// Per-metric value arrays + summaries across all responses for one task item.
export function cognitiveMetricValues(item, responses) {
  const specs = COGNITIVE_METRICS[item.type] || [];
  return specs.map(spec => {
    const values = responses.map(r => {
      const a = (r.data?.answers || {})[item.id];
      const v = a && a.summary ? a.summary[spec.key] : undefined;
      return Number(v);
    }).filter(Number.isFinite);
    return { ...spec, values, summary: summarize(values) };
  });
}

export function cognitiveCompletedCount(item, responses) {
  return responses.filter(r => {
    const a = (r.data?.answers || {})[item.id];
    return a && a.summary;
  }).length;
}

// Renders one cognitive task: a metric table + a histogram of the primary metric.
// Theme-agnostic; relies on .sc-metric-table / .sc-* classes defined per page.
export function renderCognitiveTask(container, item, responses) {
  const metrics = cognitiveMetricValues(item, responses);
  const title = COGNITIVE_LABELS[item.type] || item.id;
  const nDone = cognitiveCompletedCount(item, responses);

  const fmtVal = (v, m) => {
    if (!Number.isFinite(v)) return '—';
    const u = m.unit ? ` ${m.unit}` : '';
    return `${fmtNum(v, m.digits ?? 0)}${u}`;
  };

  const body = metrics.map(m => {
    const s = m.summary;
    return `<tr>
      <td>${escapeHtml(m.label)}</td>
      <td class="text-right">${s.n || 0}</td>
      <td class="text-right">${fmtVal(s.mean, m)}</td>
      <td class="text-right">${fmtVal(s.median, m)}</td>
      <td class="text-right">${Number.isFinite(s.sd) ? fmtNum(s.sd, m.digits ?? 0) : '—'}</td>
      <td class="text-right">${fmtVal(s.min, m)} – ${fmtVal(s.max, m)}</td>
    </tr>`;
  }).join('');

  const primary = metrics.find(m => m.key === COGNITIVE_PRIMARY[item.type]);

  container.innerHTML = `
    <div class="var-prompt">${escapeHtml(title)} <code>${escapeHtml(item.id)}</code></div>
    <div class="var-numeric-line">${nDone}/${responses.length} completaron la tarea</div>
    <table class="sc-metric-table">
      <thead><tr>
        <th>Métrica</th><th class="text-right">n</th><th class="text-right">Media</th>
        <th class="text-right">Mediana</th><th class="text-right">DE</th><th class="text-right">Rango</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${primary ? `<div class="sc-metric-hist-label">Distribución · ${escapeHtml(primary.label)}</div><div class="sc-metric-hist"></div>` : ''}`;

  if (primary) {
    const host = container.querySelector('.sc-metric-hist');
    if (primary.summary.n) {
      renderHistogram(host, histogram(primary.values, niceBinCount(primary.values.length)),
        { fmt: (v) => fmtNum(v, primary.digits ?? 0) });
    } else {
      host.innerHTML = '<div class="sc-empty">Sin datos suficientes.</div>';
    }
  }
}

// Bucket response createdAt into per-day counts.
export function dailyCounts(responses) {
  const byDay = new Map();
  for (const r of responses) {
    const ms = getCreatedAtMs(r.data);
    if (!ms) continue;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  return Array.from(byDay.entries())
    .map(([key, count]) => ({ ms: Date.parse(key + 'T00:00:00'), count }))
    .sort((a, b) => a.ms - b.ms);
}
