import { sleep, rand, pct, mean } from './helpers.js';

const N_PRACTICE  = 10;
const N_TEST      = 40;
const GO_RATIO    = 0.70;
const FIX_MS      = 400;
const STIM_MS     = 1000;
const FEEDBACK_MS = 600;

function genTrials(n) {
  const nGo   = Math.round(n * GO_RATIO);
  const nNoGo = n - nGo;
  return [...Array(nGo).fill('go'), ...Array(nNoGo).fill('nogo')]
    .sort(() => Math.random() - 0.5);
}

async function runTrial(container, type, index, total, phase) {
  container.innerHTML = `
    <div class="trial-wrap">
      <header class="trial-header">
        <span class="phase-badge">${phase === 'practice' ? 'Práctica' : 'Prueba'}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${(index/total)*100}%"></div></div>
        <span class="trial-counter">${index + 1} / ${total}</span>
      </header>
      <div class="stimulus-area gonogo-area" id="gg-zone">
        <div id="gg-fix" class="fixation">+</div>
        <div id="gg-stim" class="gonogo-stim hidden"></div>
        <div id="gg-fb" class="feedback-overlay hidden"></div>
      </div>
    </div>`;

  const fix  = container.querySelector('#gg-fix');
  const stim = container.querySelector('#gg-stim');
  const fb   = container.querySelector('#gg-fb');
  const zone = container.querySelector('#gg-zone');

  await sleep(FIX_MS);
  fix.classList.add('hidden');

  stim.innerHTML = type === 'go'
    ? '<div class="gg-circle go-circle"></div>'
    : '<div class="gg-x no-go-x">✕</div>';
  stim.classList.remove('hidden');

  const t0 = performance.now();
  let tapped = false;

  const result = await new Promise(resolve => {
    const tid = setTimeout(() => {
      zone.removeEventListener('pointerdown', tapHandler);
      resolve({ tapped: false, rt: null });
    }, STIM_MS);

    function tapHandler() {
      if (tapped) return;
      tapped = true;
      clearTimeout(tid);
      zone.removeEventListener('pointerdown', tapHandler);
      resolve({ tapped: true, rt: Math.round(performance.now() - t0) });
    }
    zone.addEventListener('pointerdown', tapHandler);
  });

  stim.classList.add('hidden');

  const correct = type === 'go' ? result.tapped : !result.tapped;
  let outcome;
  if (type === 'go')   outcome = result.tapped ? 'hit' : 'miss';
  else                  outcome = result.tapped ? 'false_alarm' : 'correct_rejection';

  if (phase === 'practice') {
    const msgs = {
      hit:               '¡Correcto!',
      miss:              'No respondiste',
      false_alarm:       '¡Debías inhibirte!',
      correct_rejection: '¡Bien inhibido!',
    };
    fb.className = `feedback-overlay ${correct ? 'correct' : 'incorrect'}`;
    fb.textContent = msgs[outcome];
    fb.classList.remove('hidden');
    await sleep(FEEDBACK_MS);
    fb.classList.add('hidden');
  }

  await sleep(rand(200, 400));
  return { trial_index: index, type, outcome, correct, rt_ms: result.rt };
}

export async function run(container) {
  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#22C55E22;color:#22C55E">🚦</div>
      <h2>Go / No-Go</h2>
      <div class="gonogo-legend">
        <div class="gg-legend-item"><div class="gg-circle go-circle sm"></div><span>Toca cuando veas el círculo verde</span></div>
        <div class="gg-legend-item"><div class="gg-x no-go-x sm">✕</div><span><strong>No toques</strong> cuando veas la X roja</span></div>
      </div>
      <p class="hint">La mayoría de veces verás el círculo. ¡Ojo con los No-Go!</p>
      <button class="btn-task-primary" id="btn-go">Comenzar práctica →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  const practiceSeq = genTrials(N_PRACTICE);
  for (let i = 0; i < practiceSeq.length; i++)
    await runTrial(container, practiceSeq[i], i, N_PRACTICE, 'practice');

  container.innerHTML = `
    <div class="test-intro">
      <h2>¡Práctica lista!</h2>
      <p>${N_TEST} ensayos sin retroalimentación.</p>
      <button class="btn-task-primary" id="btn-go">Iniciar prueba →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  const testSeq = genTrials(N_TEST);
  const trials  = [];
  for (let i = 0; i < testSeq.length; i++)
    trials.push(await runTrial(container, testSeq[i], i, testSeq.length, 'test'));

  const hits   = trials.filter(t => t.outcome === 'hit').length;
  const misses = trials.filter(t => t.outcome === 'miss').length;
  const fas    = trials.filter(t => t.outcome === 'false_alarm').length;
  const crs    = trials.filter(t => t.outcome === 'correct_rejection').length;

  const summary = {
    n_trials:            trials.length,
    hits, misses,
    false_alarms:        fas,
    correct_rejections:  crs,
    hit_rate:            pct(hits, hits + misses),
    false_alarm_rate:    pct(fas, fas + crs),
    mean_rt_hits:        mean(trials.filter(t => t.outcome === 'hit').map(t => t.rt_ms).filter(Boolean)),
  };

  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#22C55E22;color:#22C55E">🚦</div>
      <h2>¡Tarea completada!</h2>
      <p>Falsas alarmas: <strong style="color:#22C55E">${summary.false_alarm_rate ?? '—'}%</strong> &nbsp;·&nbsp; Hits: <strong style="color:#22C55E">${summary.hit_rate ?? '—'}%</strong></p>
      <button class="btn-task-primary" id="btn-done">Continuar →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-done').addEventListener('click', r, { once: true }));

  return { trials, summary };
}
