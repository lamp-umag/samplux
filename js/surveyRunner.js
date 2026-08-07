import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { run as runRT }     from './tasks/rt.js';
import { run as runStroop } from './tasks/stroop.js';
import { run as runGoNoGo } from './tasks/gonogo.js';

export const APP_CONFIG = {
  enableParadata: true,
  maxAnswerChangeEvents: 50,
  randomization: {
    enabled: false
  },
  messages: {
    thankYou: '<div class="q center">¡Muchas gracias!</div><div class="info-text center">Tus respuestas han sido registradas correctamente.\n\nPuedes cerrar esta ventana o <a href=".">volver al inicio</a>.</div>'
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
    const res = await fetch('surveys/index.json?_=' + Date.now());
    const data = await res.json();
    return data.surveys || [];
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
        startSurveyById(item.id, items);
      });
      if (listContainer) listContainer.appendChild(row);
    });
  }

  async function startSurveyById(id, indexData) {
    const meta = (indexData || await loadSurveyIndex()).find(s => s.id === id);
    if (!meta) {
      alert('Encuesta no encontrada');
      return;
    }
    const res = await fetch(`surveys/${meta.file}?_=${Date.now()}`);
    let data = await res.json();
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
    return item && item.type === 'info' && typeof item.prompt === 'string' && item.prompt.startsWith('SECCIÓN');
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
        currentIndex = total - 1;
        renderStep();
      };
      const send = button('Enviar respuestas', 'primary');
      send.onclick = submitResponses;
      controlsContainer.append(back, send);
      return;
    }

    const item = survey.items[currentIndex];
    const isLastItem = currentIndex === survey.items.length - 1;
    itemStartTime = Date.now();
    if (item && item.type !== 'info') {
      stepEntrySnapshot[item.id] = cloneAnswerValue(answers[item.id]);
    }

    if (item.type === 'info') {
      const lines = item.prompt.split('\n');
      const headerText = lines[0];
      const content = lines.slice(1).join('\n').trim();
      const isSection = headerText.startsWith('SECCIÓN');

      if (isSection) {
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
      currentIndex += 1;
      renderStep();
    };

    const goPrev = () => {
      leaveCurrentItemParadata(item);
      if (APP_CONFIG.enableParadata) navBackCount += 1;
      currentIndex = Math.max(0, currentIndex - 1);
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
    if (isSingleChoiceItem(item)) {
      const options = normalizeOptions(item);
      const selectedCode = answers[item.id] ?? null;
      options.forEach(opt => {
        const el = document.createElement('button');
        el.className = 'opt' + (String(selectedCode) === String(opt.code) ? ' selected' : '');
        el.textContent = opt.label;
        el.onclick = () => {
          answers[item.id] = opt.code;
          optionsContainer.querySelectorAll('.opt').forEach(b => b.classList.remove('selected'));
          el.classList.add('selected');
          setTimeout(goNext, 120);
        };
        optionsContainer.appendChild(el);
      });
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = goNext;
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'multi_choice') {
      const options = normalizeOptions(item);
      const prev = Array.isArray(answers[item.id]) ? new Set(answers[item.id].map(String)) : new Set();
      options.forEach(opt => {
        const el = document.createElement('button');
        const isSel = prev.has(String(opt.code));
        el.className = 'opt' + (isSel ? ' selected' : '');
        el.textContent = opt.label;
        el.onclick = () => {
          const key = String(opt.code);
          if (prev.has(key)) prev.delete(key); else prev.add(key);
          el.classList.toggle('selected');
        };
        optionsContainer.appendChild(el);
      });
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        const arr = Array.from(prev);
        if (item.required && arr.length === 0) return;
        answers[item.id] = arr;
        goNext();
      };
      controlsContainer.append(back, next);
      return;
    }

    if (item.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.placeholder = item.placeholder || '';
      if (typeof item.min === 'number') input.min = String(item.min);
      if (typeof item.max === 'number') input.max = String(item.max);
      if (answers[item.id] != null) input.value = answers[item.id];
      input.addEventListener('input', () => { answers[item.id] = input.value; });
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (input.value === '' || isNaN(Number(input.value)))) return;
        answers[item.id] = input.value === '' ? null : Number(input.value);
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
      optionsContainer.appendChild(input);
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button(isLastItem ? 'Enviar →' : 'Siguiente →', 'primary');
      next.onclick = () => {
        if (item.required && (!answers[item.id] || String(answers[item.id]).trim() === '')) return;
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

    if (item.type === 'yes_no') {
      const options = [
        { label: 'Sí', code: 'yes' },
        { label: 'No', code: 'no' }
      ];
      const selectedCode = answers[item.id] ?? null;
      options.forEach(opt => {
        const el = document.createElement('button');
        el.className = 'opt' + (selectedCode === opt.code ? ' selected' : '');
        el.textContent = opt.label;
        el.onclick = () => {
          answers[item.id] = opt.code;
          optionsContainer.querySelectorAll('.opt').forEach(b => b.classList.remove('selected'));
          el.classList.add('selected');
          setTimeout(goNext, 120);
        };
        optionsContainer.appendChild(el);
      });
      const back = button('← Atrás', 'secondary');
      back.onclick = goPrev;
      const next = button('Siguiente →', 'primary');
      next.onclick = goNext;
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
        task_rt:     { icon: '⚡', title: 'Tiempo de Reacción', desc: '~2 min · Toca el círculo cuando aparezca',    color: '#F59E0B' },
        task_stroop: { icon: '🎨', title: 'Test de Stroop',     desc: '~3 min · Identifica el color de la tinta',   color: '#6366F1' },
        task_gonogo: { icon: '🚦', title: 'Go / No-Go',          desc: '~2 min · Toca el círculo verde, no la X roja', color: '#22C55E' },
      };
      const info = TASK_INFO[item.type];
      questionContainer.innerHTML = `
        <div class="task-launch-wrap">
          <div class="task-launch-icon" style="background:${info.color}20;color:${info.color}">${info.icon}</div>
          <div class="task-launch-title">${info.title}</div>
          <div class="task-launch-desc">${info.desc}</div>
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
          if (item.type === 'task_rt')     result = await runRT(overlay);
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
      return { label, code };
    });
  }

  function isSingleChoiceItem(item) {
    if (item.type === 'multi_choice') return false;
    const opts = getItemOptions(item);
    return opts.length > 0;
  }

  async function submitResponses() {
    if (APP_CONFIG.enableParadata && survey && currentIndex < survey.items.length) {
      const item = survey.items[currentIndex];
      leaveCurrentItemParadata(item);
    }

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

    const payload = {
      surveyId: survey.id,
      answers,
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
      createdAt: serverTimestamp(),
      ua: navigator.userAgent,
      path: location.pathname + location.search
    };

    try {
      const col = collection(db, `responses/${survey.id}/entries`);
      await addDoc(col, payload);
      questionContainer.innerHTML = APP_CONFIG.messages.thankYou;
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
      await startSurveyById(selected, items);
    } else {
      showHome(items);
    }
    document.body.style.paddingBottom = '24px';
  }

  return { init };
}
