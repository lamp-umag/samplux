import { sleep, shuffle, rand, mean, pct } from './helpers.js';

const COLORS = {
  rojo:     { label: 'Rojo',     hex: '#EF4444' },
  azul:     { label: 'Azul',     hex: '#3B82F6' },
  verde:    { label: 'Verde',    hex: '#22C55E' },
  amarillo: { label: 'Amarillo', hex: '#EAB308' },
};
const KEYS        = Object.keys(COLORS);
const PRACTICE_N  = 6;
const TEST_N      = 36;
const FIX_MS      = 500;
const MAX_RT      = 3000;
const FEEDBACK_MS = 900;
const ITI_MIN     = 300;
const ITI_MAX     = 600;

function genTrials(n) {
  const pool = [];
  for (const ink of KEYS)
    for (const word of KEYS)
      pool.push({ word, ink, condition: word === ink ? 'congruent' : 'incongruent' });
  const out = [];
  while (out.length < n) out.push(...shuffle(pool));
  return shuffle(out.slice(0, n));
}

function renderTrialShell(container, phase, index, total) {
  container.innerHTML = `
    <div class="trial-wrap">
      <header class="trial-header">
        <span class="phase-badge">${phase === 'practice' ? 'Práctica' : 'Prueba'}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${(index/total)*100}%"></div></div>
        <span class="trial-counter">${index + 1} / ${total}</span>
      </header>
      <div class="stimulus-area" id="t-stim-area">
        <div id="t-fix"  class="fixation hidden">+</div>
        <div id="t-word" class="stimulus-word hidden"></div>
        <div id="t-feedback" class="feedback-overlay hidden"></div>
      </div>
      <footer class="response-buttons" id="t-btns">
        ${KEYS.map(c => `<button class="resp-btn" data-color="${c}" style="--btn-color:${COLORS[c].hex}">${COLORS[c].label}</button>`).join('')}
      </footer>
    </div>`;
}

function waitForResponse(container, maxMs) {
  return new Promise(resolve => {
    let done = false;
    const t0 = performance.now();

    container.querySelectorAll('.resp-btn').forEach(b => b.disabled = false);

    const tid = setTimeout(() => {
      if (done) return;
      done = true;
      container.querySelectorAll('.resp-btn').forEach(b => b.disabled = true);
      resolve({ response: null, rt: maxMs });
    }, maxMs);

    container.addEventListener('pointerdown', function handler(e) {
      const btn = e.target.closest('.resp-btn');
      if (!btn || btn.disabled || done) return;
      done = true;
      clearTimeout(tid);
      container.removeEventListener('pointerdown', handler);
      container.querySelectorAll('.resp-btn').forEach(b => b.disabled = true);
      resolve({ response: btn.dataset.color, rt: Math.round(performance.now() - t0) });
    });
  });
}

async function runTrial(container, trial, index, total, phase) {
  renderTrialShell(container, phase, index, total);

  const fix  = container.querySelector('#t-fix');
  const word = container.querySelector('#t-word');
  const fb   = container.querySelector('#t-feedback');
  const btns = container.querySelector('#t-btns');

  btns.querySelectorAll('.resp-btn').forEach(b => b.disabled = true);
  fix.classList.remove('hidden');
  await sleep(FIX_MS);

  fix.classList.add('hidden');
  word.textContent = trial.word.toUpperCase();
  word.style.color = COLORS[trial.ink].hex;
  word.classList.remove('hidden');

  const { response, rt } = await waitForResponse(container, MAX_RT);
  const correct = response === trial.ink;

  word.classList.add('hidden');

  if (phase === 'practice') {
    fb.className = `feedback-overlay ${correct ? 'correct' : 'incorrect'}`;
    fb.textContent = correct ? '¡Correcto!' : 'Incorrecto';
    fb.classList.remove('hidden');
    await sleep(FEEDBACK_MS);
    fb.classList.add('hidden');
  }

  await sleep(rand(ITI_MIN, ITI_MAX));

  return {
    trial_index: index,
    word: trial.word,
    ink_color: trial.ink,
    condition: trial.condition,
    response,
    correct,
    rt_ms: response ? rt : null,
  };
}

export async function run(container) {
  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#6366F122;color:#6366F1">🎨</div>
      <h2>Test de Stroop</h2>
      <p>Verás una <strong>palabra de color</strong> escrita en una tinta diferente.<br/>
         Toca el botón del color de la <strong>tinta</strong>, no lo que dice la palabra.</p>
      <div class="stroop-example">
        <span style="color:#3B82F6;font-size:2rem;font-weight:900;">ROJO</span>
        <span style="color:#94A3B8;font-size:1.2rem;">→ toca</span>
        <button class="resp-btn" style="--btn-color:#3B82F6;pointer-events:none;opacity:1">Azul</button>
      </div>
      <p class="hint">Primero harás ${PRACTICE_N} ensayos de práctica con retroalimentación.</p>
      <button class="btn-task-primary" id="btn-go">Comenzar práctica →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  const practiceTrials = genTrials(PRACTICE_N);
  for (let i = 0; i < practiceTrials.length; i++)
    await runTrial(container, practiceTrials[i], i, PRACTICE_N, 'practice');

  container.innerHTML = `
    <div class="test-intro">
      <h2>¡Práctica lista!</h2>
      <p>Ahora la prueba real. <strong>Sin retroalimentación</strong> durante los ensayos.</p>
      <button class="btn-task-primary" id="btn-go">Iniciar prueba →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  const testTrials = genTrials(TEST_N);
  const trials = [];
  for (let i = 0; i < testTrials.length; i++) {
    const res = await runTrial(container, testTrials[i], i, TEST_N, 'test');
    trials.push(res);
  }

  const byC    = cond => trials.filter(t => t.condition === cond && t.rt_ms !== null);
  const cong   = byC('congruent');
  const incong = byC('incongruent');
  const rtC    = mean(cong.map(t => t.rt_ms));
  const rtI    = mean(incong.map(t => t.rt_ms));
  const effect = rtC !== null && rtI !== null ? rtI - rtC : null;

  const summary = {
    n_trials:             trials.length,
    mean_rt_congruent:    rtC,
    mean_rt_incongruent:  rtI,
    stroop_effect_ms:     effect,
    accuracy_congruent:   pct(cong.filter(t => t.correct).length,   trials.filter(t => t.condition === 'congruent').length),
    accuracy_incongruent: pct(incong.filter(t => t.correct).length, trials.filter(t => t.condition === 'incongruent').length),
  };

  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#6366F122;color:#6366F1">🎨</div>
      <h2>¡Tarea completada!</h2>
      <p>Efecto Stroop: <strong style="color:#6366F1">${effect !== null ? (effect > 0 ? '+' : '') + effect + ' ms' : '—'}</strong></p>
      <button class="btn-task-primary" id="btn-done">Continuar →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-done').addEventListener('click', r, { once: true }));

  return { trials, summary };
}
