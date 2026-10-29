import { collection, serverTimestamp, getDocs, query, where, doc, getDoc, setDoc, Bytes } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { collectDeviceInfo, watchVisibility } from './deviceInfo.js';
import { audioSupported, mountAudioWidget, clampMaxSeconds, extensionForMime } from './audioRecorder.js';
import { run as runRT }     from './tasks/rt.js';
import { run as runStroop } from './tasks/stroop.js';
import { run as runGoNoGo } from './tasks/gonogo.js';

// Item-level extensions (ported from perseg + added for espacios-telares-1;
// see docs/ARCHITECTURE.md §2):
// - `item.section`: short label shown above the question (block / topic kicker).
// - `item.sectionHeader === true`: renders an `info` item as a section header
//   without requiring its prompt to start with "SECCIÓN".
// - `item.followUp`: { id, whenCode, prompt, long } — conditional text box shown
//   on the same step when the answer includes `whenCode` (e.g. "Otro, ¿cuál?").
//   Works on single_choice/optionSet items, yes_no, multi_choice and ranking.
// - `item.showIf`: { item, in: [codes] } or { anyOf: [ ...clauses ] } — the item
//   is skipped (and its answer cleared) unless a previous answer matches.
// - `item.exitOnAnswer`: [codes] — ends the survey without saving (consent).
// - multi_choice: `maxSelect` (e.g. "hasta 3") and per-option `exclusive: true`
//   (e.g. "Nada", "No ocurre" — deselects everything else).
// - `ranking`: tap options in order of priority; `maxRank` (default 3). Stored
//   as an ordered array of codes, most important first.
// - `text` item `response`: "text" (default) | "audio" | "either" — lets the
//   respondent answer by recording their voice (`maxSeconds`, default 90, max 180).
//   Clips are stored as Firestore Bytes in responses/<surveyId>/audio/<responseId>__<itemId>;
//   the response doc gets `audio: { itemId: { docId, mime, bytes, durationMs, reRecords } }`.
//   Typed text (if any) still goes to answers[itemId]. See docs/ARCHITECTURE.md.
// - `text` item `audioNote`: small note shown under the recorder while voice mode is active
//   (e.g. "el audio se elimina tras la transcripción").
// - settings.randomizeItems "blocks": block → instrument → item randomization; see shuffleByBlocks.
// - `number` item `integer: true`: rejects non-integers (with `min`/`max`/`rangeHelp`).
// - choice items `grid: N`: lay options out in N columns (long scales / lists on one screen).
// - `number` item `decimal: true`: free-form decimal entry, comma or point (e.g. hours/minutes).
// - `task_rt` item: `title`, `desc`, `prompt` (launch-screen explanation), `taskConfig: { nPractice, nTest, maxFailures }`.
// - survey.settings.thankYou: HTML that replaces the default thank-you message.
export const APP_CONFIG = {
  enableParadata: true,
  maxAnswerChangeEvents: 50,
  randomization: {
    enabled: false
  },
  messages: {
    thankYou: '<div class="q center">¡Muchas gracias!</div><div class="info-text center">Tus respuestas han sido registradas correctamente.\n\nPuedes cerrar esta ventana o <a href=".">volver al inicio</a>.</div>',
    declined: '<div class="q center">Gracias por tu tiempo.</div><div class="info-text center">No se ha guardado ninguna respuesta.\n\nPuedes cerrar esta ventana cuando quieras.</div>'
  }
};

export function createSurveyApp({ db, elements }) {
  const {
    header,
    homeSection,
    listContainer,
    runnerSection,
    metaContainer,
    bar,
    questionContainer,
    optionsContainer,
    controlsContainer,
    footnoteContainer,
    splashOverlay
  } = elements;

  let survey = null;
  let currentIndex = 0;
  let answers = {};
  let startTime = null;
  let itemStartTime = null;
  let itemTimes = {};
  let responseTimestamps = {};
  let presentationOrder = null;
  let stepEntrySnapshot = {};
  let navBackCount = 0;
  let answerChangeCount = 0;
  let answerChangeEvents = [];
  let answerChangeEventsTruncated = false;
  let itemAnswerChangeCount = {};
  let audioClips = {};          // itemId -> { blob, mime, durationMs, reRecords }
  let audioCleanup = null;      // stops an in-flight recording when the step changes
  let visibilityWatch = null;   // tab-hidden paradata (see deviceInfo.js)
  let submission = null;        // { responseId, uploaded:Set } — stable across submit retries

  function cloneAnswerValue(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (Array.isArray(v)) return v.slice();
    if (typeof v === 'object') return { ...v };
    return v;
  }

  function isEmptyAnswer(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  }

  function answersEqual(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      const sa = [...a].map(String).sort();
      const sb = [...b].map(String).sort();
      return sa.every((v, i) => v === sb[i]);
    }
    return String(a) === String(b);
  }

  function shouldRecordOpinionChange(before, after) {
    if (answersEqual(before, after)) return false;
    if (isEmptyAnswer(before) && !isEmptyAnswer(after)) return false;
    return true;
  }

  function serializeForEvent(v) {
    if (v === undefined) return null;
    if (v === null) return null;
    if (Array.isArray(v)) return v.slice().sort();
    if (typeof v === 'string') {
      const s = v.trim();
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
    return v;
  }

  function recordStepAnswerChangeIfAny(item) {
    if (!item || item.type === 'info') return;
    const before = stepEntrySnapshot[item.id];
    const after = answers[item.id];
    if (!shouldRecordOpinionChange(before, after)) return;
    answerChangeCount += 1;
    itemAnswerChangeCount[item.id] = (itemAnswerChangeCount[item.id] || 0) + 1;
    const maxEv = APP_CONFIG.maxAnswerChangeEvents ?? 50;
    if (answerChangeEvents.length >= maxEv) {
      answerChangeEventsTruncated = true;
      return;
    }
    answerChangeEvents.push({
      itemId: item.id,
      from: serializeForEvent(before),
      to: serializeForEvent(after),
      at: new Date().toISOString()
    });
  }

  function leaveCurrentItemParadata(item) {
    if (!APP_CONFIG.enableParadata || !item) return;
    if (itemStartTime) {
      const delta = Date.now() - itemStartTime;
      itemTimes[item.id] = (itemTimes[item.id] || 0) + delta;
      responseTimestamps[item.id] = new Date().toISOString();
    }
    if (item.type !== 'info') {
      recordStepAnswerChangeIfAny(item);
    }
  }

  async function loadSurveyIndex() {
    const q = query(collection(db, 'surveys'), where('published', '==', true));
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, title: data.title, description: data.description || '' };
    });
  }

  function qsParam(name) {
    const url = new URL(location.href);
    return url.searchParams.get(name);
  }

  function showHome(items) {
    header.style.display = 'flex';
    homeSection.style.display = 'block';
    runnerSection.style.display = 'none';
    if (listContainer) listContainer.innerHTML = '';

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'survey-item';
      row.innerHTML = `
        <div>
          <h3>${item.title}</h3>
          <p>${item.description || ''}</p>
        </div>
        <div>
          <button data-id="${item.id}">Comenzar</button>
        </div>
      `;
      row.querySelector('button').addEventListener('click', () => {
        const url = new URL(location.href);
        url.searchParams.set('survey', item.id);
        history.pushState({}, '', url);
        startSurveyById(item.id);
      });
      if (listContainer) listContainer.appendChild(row);
    });
  }

  async function startSurveyById(id) {
    const snap = await getDoc(doc(db, 'surveys', id));
    if (!snap.exists() || snap.data().published !== true) {
      alert('Encuesta no encontrada');
      return;
    }
    let data = { id: snap.id, ...snap.data() };
    data = await resolveSurveyExtends(data);
    const prepared = prepareSurvey(data);
    startSurvey(prepared);
  }

  async function previewSurvey(rawSurvey) {
    let data = structuredClone(rawSurvey);
    data = await resolveSurveyExtends(data);
    const prepared = prepareSurvey(data);
    startSurvey(prepared);
  }

  function shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function isSectionHeader(item) {
    if (!item || item.type !== 'info') return false;
    if (item.sectionHeader === true) return true;
    return typeof item.prompt === 'string' && item.prompt.startsWith('SECCIÓN');
  }

  /* ── Conditional display (item.showIf) ─────────────────── */

  function answerAsList(v) {
    if (Array.isArray(v)) return v;
    if (v == null || String(v).trim() === '') return [];
    return [v];
  }

  function matchesClause(clause) {
    if (!clause || !clause.item) return true;
    const list = answerAsList(answers[clause.item]);
    if (Array.isArray(clause.in)) {
      const wanted = clause.in.map(String);
      return list.some(v => wanted.includes(String(v)));
    }
    return list.length > 0; // no `in`: "was answered at all"
  }

  function isItemVisible(item) {
    const cond = item && item.showIf;
    if (!cond) return true;
    if (Array.isArray(cond.anyOf)) return cond.anyOf.some(matchesClause);
    return matchesClause(cond);
  }

  function clearItemAnswers(item) {
    delete answers[item.id];
    delete audioClips[item.id];
    if (item.followUp && item.followUp.id) delete answers[item.followUp.id];
  }

  // Next visible index after `from` (clears answers of skipped items, so a
  // changed earlier answer never leaves stale conditional data behind).
  function nextVisibleIndex(from, { clear = false } = {}) {
    let i = from + 1;
    while (i < survey.items.length && !isItemVisible(survey.items[i])) {
      if (clear) clearItemAnswers(survey.items[i]);
      i += 1;
    }
    return i;
  }

  function prevVisibleIndex(from) {
    let i = from - 1;
    while (i > 0 && !isItemVisible(survey.items[i])) i -= 1;
    return Math.max(0, i);
  }

  // randomizeItems: "blocks" — three-level randomization for long, multi-instrument surveys.
  //   item.block  : big section id. Runs of consecutive items sharing a block form a block;
  //                 items WITHOUT `block` are fixed anchors (consent, tasks, sensitive sections)
  //                 and split the survey into independent segments.
  //   item.scale  : instrument id inside a block. `item.unit` (optional) overrides it for shuffling,
  //                 so items of different scales can be mixed as one unit; `item.lead: true` keeps
  //                 a non-info item pinned to the front of its unit (like the instructions).
  // Per segment: block order is shuffled (settings.shuffleBlocks, default true); inside a block
  // the instrument order is shuffled (settings.shuffleScales, default true); inside an
  // instrument the items are shuffled (settings.shuffleItems, default true) — except that leading
  // `info` items (the instrument's instructions) stay first, and an instrument where any item has
  // `noShuffle: true` keeps its authored order (gating questions, mixed response formats).
  function shuffleByBlocks(items, settings = {}) {
    const on = key => settings[key] !== false;
    const groupRuns = (arr, keyFn) => {
      const runs = [];
      for (const it of arr) {
        const k = keyFn(it);
        const last = runs[runs.length - 1];
        if (last && last.key === k) last.items.push(it); else runs.push({ key: k, items: [it] });
      }
      return runs;
    };
    const shuffleScale = unit => {
      let lead = 0;
      while (lead < unit.length && (unit[lead].type === 'info' || unit[lead].lead)) lead++;
      if (!on('shuffleItems') || unit.some(it => it.noShuffle)) return unit;
      return [...unit.slice(0, lead), ...shuffle(unit.slice(lead))];
    };
    const shuffleBlock = blockItems => {
      let units = groupRuns(blockItems, it => it.unit || it.scale || it.id).map(r => shuffleScale(r.items));
      if (on('shuffleScales')) units = shuffle(units);
      return units.flat();
    };
    const out = [];
    let segment = [];
    const flush = () => {
      if (!segment.length) return;
      let blocks = groupRuns(segment, it => it.block).map(r => shuffleBlock(r.items));
      if (on('shuffleBlocks')) blocks = shuffle(blocks);
      out.push(...blocks.flat());
      segment = [];
    };
    for (const it of items) {
      if (it.block) segment.push(it);
      else { flush(); out.push(it); }
    }
    flush();
    return out;
  }

  function applyRandomization(surveyCopy) {
    const mode = surveyCopy.settings && surveyCopy.settings.randomizeItems;
    if (!mode || mode === false) {
      surveyCopy._presentationOrder = surveyCopy.items.map(it => it.id);
      return surveyCopy;
    }

    const items = surveyCopy.items;

    if (mode === 'within_scale') {
      const result = [];
      let i = 0;
      while (i < items.length) {
        const it = items[i];
        if (!it.scale) {
          result.push(it);
          i++;
          continue;
        }
        const scale = it.scale;
        const block = [];
        while (i < items.length && items[i].scale === scale) {
          block.push(items[i]);
          i++;
        }
        result.push(...shuffle(block));
      }
      surveyCopy.items = result;
    } else if (mode === 'within_section') {
      const sections = [];
      let section = [];
      for (let k = 0; k < items.length; k++) {
        if (isSectionHeader(items[k]) && section.length > 0) {
          sections.push(section);
          section = [];
        }
        section.push(items[k]);
      }
      if (section.length) sections.push(section);
      const result = [];
      for (const sec of sections) {
        const headers = [];
        const rest = [];
        for (const it of sec) {
          if (it.type === 'info') headers.push(it);
          else rest.push(it);
        }
        result.push(...headers, ...shuffle(rest));
      }
      surveyCopy.items = result;
    } else if (mode === 'between_scales') {
      const scaleBlocks = [];
      const noScaleItems = [];
      let i = 0;
      while (i < items.length) {
        const it = items[i];
        if (!it.scale) {
          noScaleItems.push(it);
          i++;
          continue;
        }
        const scale = it.scale;
        const block = [];
        while (i < items.length && items[i].scale === scale) {
          block.push(items[i]);
          i++;
        }
        scaleBlocks.push(block);
      }
      surveyCopy.items = noScaleItems.concat(...shuffle(scaleBlocks));
    } else if (mode === 'blocks') {
      surveyCopy.items = shuffleByBlocks(items, surveyCopy.settings);
    } else if (mode === 'between_dimensions') {
      const dimBlocks = [];
      const noDimItems = [];
      let i = 0;
      while (i < items.length) {
        const it = items[i];
        if (!it.dimension) {
          noDimItems.push(it);
          i++;
          continue;
        }
        const dim = it.dimension;
        const block = [];
        while (i < items.length && items[i].dimension === dim) {
          block.push(items[i]);
          i++;
        }
        dimBlocks.push(block);
      }
      surveyCopy.items = noDimItems.concat(...shuffle(dimBlocks));
    }

    surveyCopy._presentationOrder = surveyCopy.items.map(it => it.id);
    return surveyCopy;
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

      if (rawSurvey.contactEmailRelocation && typeof rawSurvey.contactEmailRelocation === 'object') {
        const cfg = rawSurvey.contactEmailRelocation;
        const sourceId = typeof cfg.sourceId === 'string' ? cfg.sourceId : 'correo_contacto';
        const insertBeforeId = typeof cfg.insertBeforeId === 'string' ? cfg.insertBeforeId : 'comentario_final';
        const items = Array.isArray(merged.items) ? merged.items : [];
        const sourceIndex = items.findIndex(it => it && it.id === sourceId);
        if (sourceIndex >= 0) {
          const emailItem = structuredClone(items[sourceIndex]);
          if (typeof cfg.required === 'boolean') emailItem.required = cfg.required;
          if (typeof cfg.prompt === 'string' && cfg.prompt.trim()) emailItem.prompt = cfg.prompt;
          items.splice(sourceIndex, 1);
          const targetIndex = items.findIndex(it => it && it.id === insertBeforeId);
          if (targetIndex >= 0) items.splice(targetIndex, 0, emailItem);
          else items.push(emailItem);
          merged.items = items;
        }
      }

      if (rawSurvey.introConsentPdfReplace && typeof rawSurvey.introConsentPdfReplace === 'object') {
        const from = rawSurvey.introConsentPdfReplace.from;
        const to = rawSurvey.introConsentPdfReplace.to;
        if (typeof from === 'string' && typeof to === 'string') {
          const introItem = (merged.items || []).find(it => it && it.id === 'intro');
          if (introItem && typeof introItem.prompt === 'string') {
            introItem.prompt = introItem.prompt.split(from).join(to);
          }
        }
      }

      return merged;
    } catch (e) {
      console.warn('No se pudo resolver survey.extends:', extendsSpec, e);
      return rawSurvey;
    }
  }

  function prepareSurvey(rawSurvey) {
    const surveyCopy = structuredClone(rawSurvey);
    return applyRandomization(surveyCopy);
  }

  function showSplashOverlay() {
    if (!splashOverlay) return;
    splashOverlay.classList.add('visible');
  }

  function hideSplashOverlay() {
    if (!splashOverlay) return;
    splashOverlay.classList.remove('visible');
  }

  function startSurvey(data) {
    survey = data;
    // Optional per-survey look (settings.theme, e.g. "telares"); CSS is scoped to #runner.
    if (runnerSection && runnerSection.dataset) {
      const theme = survey.settings && survey.settings.theme;
      if (theme) runnerSection.dataset.theme = theme; else delete runnerSection.dataset.theme;
    }
    currentIndex = 0;
    answers = {};
    startTime = Date.now();
    itemTimes = {};
    responseTimestamps = {};
    stepEntrySnapshot = {};
    navBackCount = 0;
    answerChangeCount = 0;
    answerChangeEvents = [];
    answerChangeEventsTruncated = false;
    itemAnswerChangeCount = {};
    audioClips = {};
    submission = null;
    if (visibilityWatch) visibilityWatch.stop();
    visibilityWatch = watchVisibility();
    presentationOrder = Array.isArray(survey._presentationOrder)
      ? survey._presentationOrder
      : survey.items.map(it => it.id);
    homeSection.style.display = 'none';
    runnerSection.style.display = 'block';
    header.style.display = 'none';
    hideSplashOverlay();

    const splashCfg = survey.settings && survey.settings.splash;
    const shouldShowSplash = splashCfg && splashCfg.enabled;
    const progressEl = bar && bar.parentElement;

    if (shouldShowSplash) {
      const duration = typeof splashCfg.durationMs === 'number' ? splashCfg.durationMs : 1000;
      const splashImgSrc = splashCfg && (splashCfg.image || splashCfg.imageSrc || splashCfg.src);
      const splashImgEl = splashOverlay ? splashOverlay.querySelector('img') : null;
      if (splashImgEl && splashImgSrc) {
        splashImgEl.src = splashImgSrc;
        if (progressEl) progressEl.style.opacity = '0';
        showSplashOverlay();
        setTimeout(() => {
          hideSplashOverlay();
          if (progressEl) progressEl.style.opacity = '';
          renderStep();
        }, duration);
      } else {
        if (progressEl) progressEl.style.opacity = '';
        renderStep();
      }
    } else {
      if (progressEl) progressEl.style.opacity = '';
      renderStep();
    }
  }

  function renderStep() {
    const total = survey.items.length;
    const step = Math.min(currentIndex, total);
    const percent = Math.round((step / total) * 100);
    bar.style.width = `${percent}%`;
    metaContainer.innerHTML = '';
    optionsContainer.innerHTML = '';
    controlsContainer.innerHTML = '';
    footnoteContainer.innerHTML = '';

    if (currentIndex >= total) {
      questionContainer.innerHTML = '<div class="q center">¿Listo para enviar?</div>';
      const back = button('← Atrás', 'secondary');
      back.onclick = () => {
        if (APP_CONFIG.enableParadata) navBackCount += 1;
        currentIndex = prevVisibleIndex(total);
        renderStep();
      };
      const send = button('Enviar respuestas', 'primary');
      send.onclick = submitResponses;
      controlsContainer.append(back, send);
      return;
    }

    if (audioCleanup) { audioCleanup(); audioCleanup = null; }
    const item = survey.items[currentIndex];
    const isLastItem = nextVisibleIndex(currentIndex) >= survey.items.length;
    itemStartTime = Date.now();
    if (item && item.type !== 'info') {
      stepEntrySnapshot[item.id] = cloneAnswerValue(answers[item.id]);
    }

    if (item.section) {
      metaContainer.innerHTML = `<div class="kicker">${item.section}</div>`;
    }

    if (item.type === 'info') {
      const lines = item.prompt.split('\n');
      const headerText = lines[0];
      const content = lines.slice(1).join('\n').trim();

      if (isSectionHeader(item)) {
        questionContainer.innerHTML = `
          <div class="section-header">${headerText}</div>
          <div class="info-text">${content}</div>
        `;
      } else {
        questionContainer.innerHTML = `<div class="info-text">${item.prompt}</div>`;
      }
    } else {
      const instruction = item.instruction ? `<div class="item-instruction">${item.instruction}</div>` : '';
      questionContainer.innerHTML = instruction + `<div class="q">${item.prompt}</div>`;
    }

    const goNext = () => {
      leaveCurrentItemParadata(item);
      currentIndex = nextVisibleIndex(currentIndex, { clear: true });
      renderStep();
    };

    const goPrev = () => {
      leaveCurrentItemParadata(item);
      if (APP_CONFIG.enableParadata) navBackCount += 1;
      currentIndex = prevVisibleIndex(currentIndex);
      renderStep();
    };

    renderControlsForItem({ item, goNext, goPrev, isLastItem });

    if (item.help && item.type !== 'text') {
      footnoteContainer.innerText = item.help;
    }
  }

  function filterByAllowedChars(value, allowedChars) {
    if (!allowedChars || typeof allowedChars !== 'string') return value;
    const set = new Set(allowedChars.split(''));
    let out = '';
    for (const ch of value) {
      if (set.has(ch)) out += ch;
    }
    return out;
  }

  function renderControlsForItem({ item, goNext, goPrev, isLastItem }) {
    // `grid: N` lays single/multi-choice options out in N columns (keeps long scales on one screen).
    optionsContainer.style.cssText = item.grid > 1
      ? `display:grid;grid-template-columns:repeat(${Number(item.grid)},1fr);gap:8px;`
      : '';
    if (isSingleChoiceItem(item) || item.type === 'yes_no') {
      const options = item.type === 'yes_no'
        ? [{ label: 'Sí', code: 'yes' }, { label: 'No', code: 'no' }]
        : normalizeOptions(item);
      const followUp = createFollowUp(item);
      const selectedCode = answers[item.id] ?? null;
      options.forEach(opt => {
        const el = document.createElement('button');
        el.className = 'opt' + (String(selectedCode) === String(opt.code) ? ' selected' : '');
        el.textContent = opt.label;
        el.onclick = () => {
          answers[item.id] = opt.code;
          optionsContainer.querySelectorAll('.opt').forEach(b => b.classList.remove('selected'));
          el.classList.add('selected');

          if (Array.isArray(item.exitOnAnswer) && item.exitOnAnswer.map(String).includes(String(opt.code))) {
            leaveCurrentItemParadata(item);
            endSurveyWithoutSaving(item.exitMessage);
            return;
          }
          if (followUp && followUp.matches(opt.code)) {
            followUp.show(true);
            return; // stay on this step so the text box can be filled in
          }
          if (followUp) followUp.hide();
          setTimeout(goNext, 120);
        };
        optionsContainer.appendChild(el);
      });
      if (followUp) followUp.sync(selectedCode);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && answers[item.id] == null) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'multi_choice') {
      const options = normalizeOptions(item);
      const followUp = createFollowUp(item);
      const maxSelect = Number(item.maxSelect) > 0 ? Number(item.maxSelect) : null;
      const prev = Array.isArray(answers[item.id]) ? new Set(answers[item.id].map(String)) : new Set();
      const buttons = new Map();

      // Store codes in option order and with their original type (numbers stay numbers).
      const commit = () => {
        answers[item.id] = options.filter(o => prev.has(String(o.code))).map(o => o.code);
        buttons.forEach((b, key) => b.classList.toggle('selected', prev.has(key)));
        if (followUp) followUp.sync(answers[item.id]);
        if (maxSelect) footnoteContainer.innerText = `${prev.size} de ${maxSelect} seleccionadas`;
      };

      options.forEach(opt => {
        const key = String(opt.code);
        const el = document.createElement('button');
        el.className = 'opt';
        el.textContent = opt.label;
        el.onclick = () => {
          if (prev.has(key)) {
            prev.delete(key);
          } else if (opt.exclusive) {
            prev.clear();
            prev.add(key);
          } else {
            const regular = options.filter(o => !o.exclusive && prev.has(String(o.code))).length;
            if (maxSelect && regular >= maxSelect) {
              footnoteContainer.innerText = `Puedes elegir hasta ${maxSelect}. Quita una para cambiarla.`;
              el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
              return;
            }
            options.filter(o => o.exclusive).forEach(o => prev.delete(String(o.code)));
            prev.add(key);
          }
          commit();
          if (followUp && opt.code != null && followUp.matches(opt.code) && prev.has(key)) followUp.focus();
        };
        buttons.set(key, el);
        optionsContainer.appendChild(el);
      });
      if (prev.size || maxSelect) commit();
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && prev.size === 0) return;
        if (!prev.size) delete answers[item.id];
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'ranking') {
      const options = normalizeOptions(item);
      const followUp = createFollowUp(item);
      const maxRank = Number(item.maxRank) > 0 ? Math.min(Number(item.maxRank), options.length) : Math.min(3, options.length);
      const byKey = new Map(options.map(o => [String(o.code), o]));
      let order = Array.isArray(answers[item.id])
        ? answers[item.id].map(String).filter(k => byKey.has(k)).slice(0, maxRank)
        : [];
      const buttons = new Map();

      const commit = () => {
        if (order.length) answers[item.id] = order.map(k => byKey.get(k).code);
        else delete answers[item.id];
        buttons.forEach((b, key) => {
          const pos = order.indexOf(key);
          b.classList.toggle('selected', pos >= 0);
          b.querySelector('.rank-badge').textContent = pos >= 0 ? String(pos + 1) : '';
        });
        if (followUp) followUp.sync(answers[item.id]);
        footnoteContainer.innerText = order.length >= maxRank
          ? `Listo: ${maxRank} de ${maxRank}. Toca una para quitarla y reordenar.`
          : `Elige la n.º ${order.length + 1} de ${maxRank}.`;
      };

      options.forEach(opt => {
        const key = String(opt.code);
        const el = document.createElement('button');
        el.className = 'opt opt-rank';
        el.innerHTML = '<span class="rank-badge"></span><span class="rank-label"></span>';
        el.querySelector('.rank-label').textContent = opt.label;
        el.onclick = () => {
          const pos = order.indexOf(key);
          if (pos >= 0) {
            order.splice(pos, 1);
          } else {
            if (order.length >= maxRank) {
              el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
              return;
            }
            order.push(key);
          }
          commit();
          if (followUp && followUp.matches(opt.code) && order.includes(key)) followUp.focus();
        };
        buttons.set(key, el);
        optionsContainer.appendChild(el);
      });
      commit();
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && order.length < maxRank) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'number') {
      // `decimal: true`: free-form entry (accepts "6,5" and "6.5", no range blocking); the
      // value is stored as a normalized Number, or as the raw text if it can't be parsed.
      const free = item.decimal === true;
      const input = document.createElement('input');
      input.type = free ? 'text' : 'number';
      input.inputMode = free ? 'decimal' : 'numeric';
      input.placeholder = item.placeholder || '';
      if (!free && typeof item.min === 'number') input.min = String(item.min);
      if (!free && typeof item.max === 'number') input.max = String(item.max);
      if (answers[item.id] != null) input.value = answers[item.id];
      const parseFree = raw => {
        const t = String(raw).trim().replace(',', '.');
        if (t === '') return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : String(raw).trim();
      };
      input.addEventListener('input', () => { answers[item.id] = free ? parseFree(input.value) : input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (free) {
          const v = parseFree(input.value);
          if (item.required && v == null) return;
          if (v == null) delete answers[item.id]; else answers[item.id] = v;
          goNext();
          return;
        }
        if (item.required && (input.value === '' || isNaN(Number(input.value)))) return;
        const num = input.value === '' ? null : Number(input.value);
        if (num != null && typeof item.min === 'number' && num < item.min) {
          footnoteContainer.innerText = item.rangeHelp || `El valor mínimo permitido es ${item.min}.`;
          return;
        }
        if (num != null && typeof item.max === 'number' && num > item.max) {
          footnoteContainer.innerText = item.rangeHelp || `El valor máximo permitido es ${item.max}.`;
          return;
        }
        if (num != null && item.integer === true && !Number.isInteger(num)) {
          footnoteContainer.innerText = item.rangeHelp || 'Ingresa un número entero.';
          return;
        }
        if (num == null) delete answers[item.id]; else answers[item.id] = num;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'info') {
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = goNext;
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'text') {
      const input = document.createElement(item.long ? 'textarea' : 'input');
      if (input.tagName.toLowerCase() === 'input') input.type = 'text';
      input.placeholder = item.placeholder || '';
      input.maxLength = item.maxLength || 500;
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('input', () => {
        const original = input.value;
        let v = original;
        let hadInvalid = false;
        if (item.allowedChars) {
          const filtered = filterByAllowedChars(original, item.allowedChars);
          if (filtered !== original) {
            hadInvalid = true;
            v = filtered;
            input.value = v;
          }
        }
        answers[item.id] = v;
        if (hadInvalid) {
          footnoteContainer.innerText = item.help || '';
        } else if (footnoteContainer.innerText === (item.help || '')) {
          footnoteContainer.innerText = '';
        }
      });
      // Audio mode: "audio" (voice only) or "either" (respondent picks). Falls back to
      // text when the browser can't record (e.g. in-app webviews, no HTTPS).
      const wanted = item.response === 'audio' || item.response === 'either';
      const canRecord = wanted && audioSupported();
      if (canRecord) {
        const maxSeconds = clampMaxSeconds(item.maxSeconds);
        const audioArea = document.createElement('div');
        // `audioNote`: small privacy/usage note shown only while the voice option is active.
        const audioNote = item.audioNote ? document.createElement('div') : null;
        if (audioNote) { audioNote.className = 'tiny'; audioNote.style.marginTop = '8px'; audioNote.textContent = item.audioNote; }
        let mounted = false;
        const mountAudio = () => {
          if (mounted) return;
          mounted = true;
          audioCleanup = mountAudioWidget(audioArea, {
            maxSeconds,
            clip: audioClips[item.id] || null,
            onChange: clip => { if (clip) audioClips[item.id] = clip; else delete audioClips[item.id]; }
          });
        };
        if (item.response === 'either') {
          const tabs = document.createElement('div');
          tabs.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
          const tText = button('✍️ Escribir', 'secondary');
          const tAudio = button('🎙️ Hablar', 'secondary');
          const setMode = mode => {
            const audioMode = mode === 'audio';
            input.style.display = audioMode ? 'none' : '';
            audioArea.style.display = audioMode ? '' : 'none';
            if (audioNote) audioNote.style.display = audioMode ? '' : 'none';
            tText.classList.toggle('primary', !audioMode); tText.classList.toggle('secondary', audioMode);
            tAudio.classList.toggle('primary', audioMode); tAudio.classList.toggle('secondary', !audioMode);
            if (audioMode) mountAudio();
          };
          tText.onclick = () => setMode('text');
          tAudio.onclick = () => setMode('audio');
          tabs.append(tText, tAudio);
          optionsContainer.append(tabs, input, audioArea, ...(audioNote ? [audioNote] : []));
          setMode(audioClips[item.id] && !answers[item.id] ? 'audio' : 'text');
        } else {
          input.style.display = 'none';
          optionsContainer.append(audioArea, ...(audioNote ? [audioNote] : []));
          mountAudio();
        }
      } else {
        optionsContainer.appendChild(input);
      }
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button(isLastItem ? 'Enviar →' : 'Siguiente →', 'primary');
      next.onclick = () => {
        const hasText = answers[item.id] && String(answers[item.id]).trim() !== '';
        if (item.required && !hasText && !audioClips[item.id]) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'email') {
      const input = document.createElement('input');
      input.type = 'email';
      input.placeholder = item.placeholder || 'ejemplo@correo.com';
      input.maxLength = item.maxLength || 100;
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('input', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'url') {
      const input = document.createElement('input');
      input.type = 'url';
      input.placeholder = item.placeholder || 'https://ejemplo.com';
      input.maxLength = item.maxLength || 200;
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('input', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'date') {
      const input = document.createElement('input');
      input.type = 'date';
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('change', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'time') {
      const input = document.createElement('input');
      input.type = 'time';
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('change', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'slider') {
      const container = document.createElement('div');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = item.min || 0;
      slider.max = item.max || 100;
      slider.step = item.step || 1;
      slider.value = answers[item.id] != null ? answers[item.id] : slider.min;
      const valueDisplay = document.createElement('div');
      valueDisplay.style.textAlign = 'center';
      valueDisplay.style.fontSize = '24px';
      valueDisplay.style.fontWeight = '700';
      valueDisplay.style.marginTop = '12px';
      valueDisplay.textContent = slider.value;
      slider.addEventListener('input', () => {
        answers[item.id] = Number(slider.value);
        valueDisplay.textContent = slider.value;
      });
      container.appendChild(slider);
      container.appendChild(valueDisplay);
      optionsContainer.appendChild(container);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && answers[item.id] == null) answers[item.id] = Number(slider.value);
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'phone') {
      const input = document.createElement('input');
      input.type = 'tel';
      input.placeholder = item.placeholder || '+56 9 1234 5678';
      input.maxLength = item.maxLength || 20;
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('input', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = item.accept || '*/*';
      input.multiple = item.multiple || false;
      input.addEventListener('change', () => {
        if (input.files.length > 0) {
          answers[item.id] = Array.from(input.files).map(f => f.name);
        } else {
          answers[item.id] = null;
        }
      });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && !answers[item.id]) return;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    // ── Cognitive task types ──────────────────────────
    if (item.type === 'task_rt' || item.type === 'task_stroop' || item.type === 'task_gonogo') {
      const TASK_INFO = {
        task_rt:     { icon: '⚡', title: 'Tiempo de Reacción', desc: '~2 min · Toca el círculo cuando aparezca',    color: '#000000' },
        task_stroop: { icon: '🎨', title: 'Test de Stroop',     desc: '~3 min · Identifica el color de la tinta',   color: '#000000' },
        task_gonogo: { icon: '🚦', title: 'Go / No-Go',          desc: '~2 min · Toca el círculo verde, no la X roja', color: '#000000' },
      };
      // Per-item overrides: `title`, `desc`, `prompt` (explanatory text shown on the launch
      // screen) and `taskConfig` ({ nPractice, nTest } for task_rt).
      const info = { ...TASK_INFO[item.type], ...(item.title && { title: item.title }), ...(item.desc && { desc: item.desc }) };
      questionContainer.innerHTML = `
        <div class="task-launch-wrap">
          <div class="task-launch-icon" style="background:${info.color}20;color:${info.color}">${info.icon}</div>
          <div class="task-launch-title">${info.title}</div>
          <div class="task-launch-desc">${info.desc}</div>
          ${item.prompt ? `<div class="info-text">${item.prompt}</div>` : ''}
        </div>`;
      optionsContainer.innerHTML = '';

      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;

      const launch = button(`Iniciar ${info.icon}`, 'primary');
      launch.onclick = async () => {
        launch.disabled = true;
        const overlay = document.createElement('div');
        overlay.className = 'task-overlay';
        document.body.appendChild(overlay);
        try {
          let result;
          if (item.type === 'task_rt')     result = await runRT(overlay, item.taskConfig);
          if (item.type === 'task_stroop') result = await runStroop(overlay);
          if (item.type === 'task_gonogo') result = await runGoNoGo(overlay);
          if (result) answers[item.id] = result;
        } catch (e) {
          console.error('[samplux] task error:', e);
        } finally {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        goNext();
      };

      controlsContainer.append(back, launch);
      return;
    }

    optionsContainer.innerHTML = '<div class="tiny">Tipo de ítem no soportado: ' + item.type + '</div>';
  }

  /** Conditional "especifica" text box tied to one or more option codes. */
  function createFollowUp(item) {
    const fu = item.followUp;
    if (!fu || !fu.id) return null;
    const codes = (Array.isArray(fu.whenCode) ? fu.whenCode : [fu.whenCode]).map(String);
    let wrap = null;
    let input = null;
    return {
      matches(value) {
        return answerAsList(value).some(v => codes.includes(String(v)));
      },
      show(focus) {
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'followup fade-in';
          wrap.style.gridColumn = '1 / -1';
          const label = document.createElement('div');
          label.className = 'item-instruction';
          label.textContent = fu.prompt || 'Por favor, especifica:';
          input = document.createElement(fu.long ? 'textarea' : 'input');
          if (input.tagName.toLowerCase() === 'input') input.type = 'text';
          input.placeholder = fu.placeholder || '';
          input.maxLength = fu.maxLength || (fu.long ? 1000 : 200);
          if (answers[fu.id] != null) input.value = answers[fu.id];
          input.addEventListener('input', () => {
            if (input.value.trim() === '') delete answers[fu.id];
            else answers[fu.id] = input.value;
          });
          wrap.append(label, input);
          optionsContainer.appendChild(wrap);
        }
        if (focus) this.focus();
      },
      focus() {
        if (input) setTimeout(() => input.focus({ preventScroll: false }), 30);
      },
      hide() {
        delete answers[fu.id];
        if (wrap) { wrap.remove(); wrap = null; input = null; }
      },
      sync(value) {
        if (this.matches(value)) this.show(false); else this.hide();
      }
    };
  }

  /** Ends the survey without writing anything (e.g. consent declined). */
  function endSurveyWithoutSaving(customMessageHtml) {
    bar.style.width = '100%';
    metaContainer.innerHTML = '';
    optionsContainer.innerHTML = '';
    controlsContainer.innerHTML = '';
    footnoteContainer.innerHTML = '';
    questionContainer.innerHTML = customMessageHtml || APP_CONFIG.messages.declined;
  }

  function button(label, kind) {
    const b = document.createElement('button');
    b.className = `btn ${kind}`;
    b.textContent = label;
    return b;
  }

  function getItemOptions(item) {
    const raw = (survey && survey.optionSets && survey.optionSets[item.type]) || item.options;
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  function normalizeOptions(item) {
    const raw = getItemOptions(item);
    if (!raw.length) return [];
    return raw.map((opt, idx) => {
      if (typeof opt === 'string') return { label: opt, code: idx + 1 };
      const label = opt.label ?? String(opt.code ?? opt.value ?? opt);
      const code = opt.code ?? opt.value ?? (idx + 1);
      return { label, code, exclusive: opt.exclusive === true };
    });
  }

  function isSingleChoiceItem(item) {
    if (item.type === 'multi_choice' || item.type === 'ranking' || item.type === 'yes_no') return false;
    const opts = getItemOptions(item);
    return opts.length > 0;
  }

  async function submitResponses() {
    if (APP_CONFIG.enableParadata && survey && currentIndex < survey.items.length) {
      const item = survey.items[currentIndex];
      leaveCurrentItemParadata(item);
    }

    // Final safety net: drop answers to items whose showIf ended up false.
    survey.items.forEach(it => { if (!isItemVisible(it)) clearItemAnswers(it); });

    const urlParams = new URLSearchParams(location.search);
    const serverCode = urlParams.get('srv') || urlParams.get('iden') || null;
    const totalTime = APP_CONFIG.enableParadata && startTime ? Date.now() - startTime : null;

    const browserData = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenColorDepth: screen.colorDepth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: new Date().toISOString(),
      referrer: document.referrer,
      url: location.href
    };

    // Audio: each clip becomes its own doc (Bytes), named <responseId>__<itemId>, so the
    // response doc stays small. Uploaded BEFORE the response doc; audio docs are immutable,
    // so `submission` remembers what already went up and a retry only sends what's missing.
    if (audioCleanup) { audioCleanup(); audioCleanup = null; }
    const entriesCol = collection(db, `responses/${survey.id}/entries`);
    if (!submission) submission = { responseId: doc(entriesCol).id, uploaded: {} };
    const audioMeta = {};
    const clipItems = Object.keys(audioClips).filter(id => survey.items.some(it => it.id === id));
    try {
      for (const itemId of clipItems) {
        const clip = audioClips[itemId];
        const docId = `${submission.responseId}__${itemId}`;
        const meta = {
          docId, mime: clip.mime, ext: extensionForMime(clip.mime), bytes: clip.blob.size,
          durationMs: clip.durationMs, reRecords: clip.reRecords || 0,
          ...(clip.mic && { mic: clip.mic })
        };
        if (!submission.uploaded[itemId]) {
          const buf = new Uint8Array(await clip.blob.arrayBuffer());
          await setDoc(doc(db, `responses/${survey.id}/audio`, docId), {
            surveyId: survey.id, responseId: submission.responseId, itemId,
            mime: meta.mime, durationMs: meta.durationMs, size: meta.bytes,
            audio: Bytes.fromUint8Array(buf), createdAt: serverTimestamp()
          });
          submission.uploaded[itemId] = true;
        }
        audioMeta[itemId] = meta;
      }
    } catch (e) {
      alert('Error al subir el audio. Intenta de nuevo.');
      console.error(e);
      return;
    }

    const deviceInfo = await collectDeviceInfo();
    const visibility = visibilityWatch ? visibilityWatch.snapshot() : null;

    const payload = {
      surveyId: survey.id,
      answers,
      ...(Object.keys(audioMeta).length > 0 && { audio: audioMeta }),
      serverCode,
      totalTime,
      itemTimes,
      ...(presentationOrder && { presentationOrder }),
      ...(Object.keys(responseTimestamps).length > 0 && { responseTimestamps }),
      ...(APP_CONFIG.enableParadata && {
        navBackCount,
        answerChangeCount,
        ...(Object.keys(itemAnswerChangeCount).length > 0 && { itemAnswerChangeCount }),
        ...(answerChangeEvents.length > 0 && { answerChangeEvents }),
        ...(answerChangeEventsTruncated && { answerChangeEventsTruncated: true })
      }),
      browserData,
      deviceInfo,
      ...(visibility && { tabHiddenCount: visibility.hiddenCount, tabHiddenMs: visibility.hiddenMs }),
      createdAt: serverTimestamp(),
      ua: navigator.userAgent,
      path: location.pathname + location.search
    };

    try {
      await setDoc(doc(entriesCol, submission.responseId), payload);
      const customThanks = survey.settings && survey.settings.thankYou;
      questionContainer.innerHTML = customThanks || APP_CONFIG.messages.thankYou;
      metaContainer.innerHTML = '';
      optionsContainer.innerHTML = '';
      controlsContainer.innerHTML = '';
      footnoteContainer.innerHTML = '';
      bar.style.width = '100%';
    } catch (e) {
      alert('Error al enviar. Intenta de nuevo.');
      console.error(e);
    }
  }

  async function init() {
    const selected = qsParam('survey');
    const items = await loadSurveyIndex();
    if (selected) {
      await startSurveyById(selected);
    } else {
      showHome(items);
    }
    document.body.style.paddingBottom = '24px';
  }

  return { init, previewSurvey };
}
