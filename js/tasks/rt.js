import { sleep, rand, mean } from './helpers.js';

const N_PRACTICE = 3;
const N_TEST     = 20;
const MIN_WAIT   = 1000;
const MAX_WAIT   = 3500;
const MAX_RT     = 1500;

function renderWait(container, phase, index, total) {
  container.innerHTML = `
    <div class="trial-wrap">
      <header class="trial-header">
        <span class="phase-badge">${phase === 'practice' ? 'Práctica' : 'Prueba'}</span>
        <div class="progress-track"><div class="progress-fill" style="width:${(index/total)*100}%"></div></div>
        <span class="trial-counter">${index + 1} / ${total}</span>
      </header>
      <div class="stimulus-area rt-area" id="rt-tap-zone">
        <div id="rt-inner" class="rt-waiting">
          <div class="rt-ring"></div>
          <p class="rt-label">Espera…</p>
        </div>
      </div>
    </div>`;
}

function renderReady(container) {
  const inner = container.querySelector('#rt-inner');
  if (!inner) return;
  inner.className = 'rt-ready';
  inner.innerHTML = `<div class="rt-circle"></div><p class="rt-label">¡Toca!</p>`;
}

function renderTooEarly(container) {
  const inner = container.querySelector('#rt-inner');
  if (!inner) return;
  inner.className = 'rt-early';
  inner.innerHTML = `<p class="rt-label early">¡Muy pronto!</p><p class="rt-sublabel">Espera la señal verde.</p>`;
}

async function runRTTrial(container, index, total, phase) {
  renderWait(container, phase, index, total);
  const zone = container.querySelector('#rt-tap-zone');

  const delay = rand(MIN_WAIT, MAX_WAIT);

  const earlyPromise = new Promise(r => {
    zone.addEventListener('pointerdown', function h() {
      zone.removeEventListener('pointerdown', h);
      r(true);
    });
  });
  const waitPromise = sleep(delay).then(() => false);
  const tooEarly = await Promise.race([earlyPromise, waitPromise]);

  if (tooEarly) {
    renderTooEarly(container);
    await sleep(1200);
    return null;
  }

  renderReady(container);
  const t0 = performance.now();

  const rt = await new Promise(r => {
    const tid = setTimeout(() => r(null), MAX_RT);
    zone.addEventListener('pointerdown', function h() {
      clearTimeout(tid);
      zone.removeEventListener('pointerdown', h);
      r(Math.round(performance.now() - t0));
    });
  });

  // Feedback
  if (phase === 'practice' && rt !== null) {
    const inner = container.querySelector('#rt-inner');
    if (inner) {
      inner.className = 'rt-done';
      inner.innerHTML = `<p class="rt-label">${rt} ms</p>`;
    }
    await sleep(700);
  } else if (rt !== null) {
    // Test mode: flash white to confirm the tap registered
    const inner = container.querySelector('#rt-inner');
    if (inner) {
      inner.className = 'rt-hit';
      inner.innerHTML = `<div class="rt-circle rt-circle-flash"></div>`;
    }
    await sleep(320);
  } else {
    await sleep(400);
  }

  return rt;
}

export async function run(container) {
  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#F59E0B22;color:#F59E0B">⚡</div>
      <h2>Tiempo de Reacción</h2>
      <p>Aparecerá un círculo verde en la pantalla. Tócalo lo más rápido que puedas.</p>
      <p class="hint">⚠️ No toques antes de que aparezca — ¡se registrará como error!</p>
      <button class="btn-task-primary" id="btn-go">Comenzar práctica →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  for (let i = 0; i < N_PRACTICE; i++) {
    await runRTTrial(container, i, N_PRACTICE, 'practice');
    await sleep(400);
  }

  container.innerHTML = `
    <div class="test-intro">
      <h2>¡Práctica lista!</h2>
      <p>Ahora la prueba real: ${N_TEST} ensayos. Sin retroalimentación.</p>
      <button class="btn-task-primary" id="btn-go">Iniciar →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-go').addEventListener('click', r, { once: true }));

  const rts = [];
  let i = 0;
  while (rts.length < N_TEST) {
    const rt = await runRTTrial(container, rts.length, N_TEST, 'test');
    if (rt !== null) rts.push({ trial_index: i, rt_ms: rt });
    i++;
    await sleep(rand(300, 600));
  }

  const validRTs = rts.map(r => r.rt_ms).filter(Boolean);
  const summary = {
    n_trials:   rts.length,
    mean_rt_ms: mean(validRTs),
    min_rt_ms:  validRTs.length ? Math.min(...validRTs) : null,
    max_rt_ms:  validRTs.length ? Math.max(...validRTs) : null,
    sd_rt_ms:   validRTs.length > 1
      ? Math.round(Math.sqrt(validRTs.reduce((s, v) => s + Math.pow(v - mean(validRTs), 2), 0) / validRTs.length))
      : null,
  };

  container.innerHTML = `
    <div class="test-intro">
      <div class="test-intro-icon" style="background:#F59E0B22;color:#F59E0B">⚡</div>
      <h2>¡Tarea completada!</h2>
      <p>TR promedio: <strong style="color:#F59E0B">${summary.mean_rt_ms ?? '—'} ms</strong></p>
      <button class="btn-task-primary" id="btn-done">Continuar →</button>
    </div>`;
  await new Promise(r => container.querySelector('#btn-done').addEventListener('click', r, { once: true }));

  return { trials: rts, summary };
}
