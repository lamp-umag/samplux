// ─────────────────────────────────────────────────────────────
// samplux — audio recorder (MediaRecorder wrapper + widget)
// ─────────────────────────────────────────────────────────────
// Used by the `text` item when `item.response` is "audio" or "either".
// Clips are stored in Firestore as Bytes (see surveyRunner.submitResponses),
// so they must stay under MAX_AUDIO_BYTES (Firestore's 1 MiB doc limit minus
// headroom). Recording auto-stops at `maxSeconds` OR when the size cap is
// close — iOS Safari ignores audioBitsPerSecond and can produce much larger
// files than Chrome, so duration alone is not a safe limit.
// ─────────────────────────────────────────────────────────────

export const MAX_AUDIO_BYTES = 700000;      // keep in sync with firestore.rules
export const DEFAULT_MAX_SECONDS = 90;
export const HARD_MAX_SECONDS = 180;
const SIZE_STOP_THRESHOLD = 650000;         // stop a bit before the hard cap

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',   // Chrome / Android / Firefox
  'audio/mp4',                // Safari / iOS (AAC)
  'audio/webm',
  'audio/ogg;codecs=opus'
];

export function audioSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

export function extensionForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

export function clampMaxSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_SECONDS;
  return Math.min(Math.round(n), HARD_MAX_SECONDS);
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Low-level: start a recording, returns { stop(), done: Promise<{blob, mime, durationMs, stoppedBy}> }.
async function startRecording({ maxSeconds, onTick }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, {
    ...(mime && { mimeType: mime }),
    audioBitsPerSecond: 24000
  });
  const chunks = [];
  let bytes = 0;
  let stoppedBy = 'user';
  const t0 = Date.now();

  const done = new Promise(resolve => {
    rec.ondataavailable = e => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
        bytes += e.data.size;
        if (bytes >= SIZE_STOP_THRESHOLD && rec.state === 'recording') {
          stoppedBy = 'size';
          rec.stop();
        }
      }
    };
    rec.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach(t => t.stop());   // release the mic
      const type = rec.mimeType || mime || 'audio/webm';
      resolve({ blob: new Blob(chunks, { type }), mime: type, durationMs: Date.now() - t0, stoppedBy });
    };
  });

  const timer = setInterval(() => {
    const el = Date.now() - t0;
    onTick && onTick(el);
    if (el >= maxSeconds * 1000 && rec.state === 'recording') {
      stoppedBy = 'time';
      rec.stop();
    }
  }, 200);

  rec.start(1000);   // 1s timeslice so we can watch the size while recording
  return { stop: () => { if (rec.state === 'recording') rec.stop(); }, done };
}

/**
 * Renders the mic UI into `container`.
 * @param {object} opts
 * @param {number}  opts.maxSeconds
 * @param {object|null} opts.clip   existing clip {blob, mime, durationMs, reRecords} (when navigating back)
 * @param {(clip|null) => void} opts.onChange  called when the clip is set / cleared
 * @returns {() => void} cleanup (stops any recording in progress, revokes object URLs)
 */
export function mountAudioWidget(container, { maxSeconds, clip, onChange }) {
  let current = clip || null;
  let active = null;          // in-flight recording
  let playbackUrl = null;

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'audio-widget';
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;';
  container.appendChild(wrap);

  const status = document.createElement('div');
  status.className = 'tiny';
  status.style.minHeight = '1.4em';
  status.setAttribute('aria-live', 'polite');

  function revoke() { if (playbackUrl) { URL.revokeObjectURL(playbackUrl); playbackUrl = null; } }

  function mkBtn(label, kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (kind || 'secondary');
    b.textContent = label;
    return b;
  }

  function showIdle() {
    revoke();
    wrap.innerHTML = '';
    const mic = mkBtn('🎙️ Grabar respuesta', 'primary');
    mic.onclick = begin;
    wrap.append(mic);
    const hint = document.createElement('div');
    hint.className = 'tiny';
    hint.textContent = `Máximo ${fmtClock(maxSeconds * 1000)} min.`;
    wrap.append(hint, status);
  }

  function showRecorded() {
    revoke();
    wrap.innerHTML = '';
    playbackUrl = URL.createObjectURL(current.blob);
    const player = document.createElement('audio');
    player.controls = true;
    player.src = playbackUrl;
    player.style.width = '100%';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';
    const again = mkBtn('🔁 Grabar de nuevo', 'secondary');
    again.onclick = () => begin();
    const del = mkBtn('🗑️ Eliminar', 'secondary');
    del.onclick = () => { current = null; onChange(null); showIdle(); };
    row.append(again, del);
    const info = document.createElement('div');
    info.className = 'tiny';
    info.textContent = `Grabación lista (${fmtClock(current.durationMs)}).`;
    wrap.append(player, row, info, status);
  }

  async function begin() {
    status.textContent = '';
    try {
      wrap.innerHTML = '';
      const clock = document.createElement('div');
      clock.style.cssText = 'font-size:28px;font-variant-numeric:tabular-nums;';
      clock.textContent = `0:00 / ${fmtClock(maxSeconds * 1000)}`;
      const stop = mkBtn('⏹️ Detener', 'primary');
      stop.disabled = true;
      wrap.append(clock, stop, status);
      status.textContent = 'Solicitando micrófono…';

      active = await startRecording({
        maxSeconds,
        onTick: ms => { clock.textContent = `${fmtClock(ms)} / ${fmtClock(maxSeconds * 1000)}`; }
      });
      status.textContent = '🔴 Grabando…';
      stop.disabled = false;
      stop.onclick = () => active && active.stop();

      const res = await active.done;
      active = null;
      if (res.blob.size === 0) throw new Error('empty');
      if (res.blob.size > MAX_AUDIO_BYTES) {
        showIdle();
        status.textContent = 'La grabación es demasiado larga. Intenta una más corta.';
        return;
      }
      current = {
        blob: res.blob, mime: res.mime, durationMs: res.durationMs,
        reRecords: current ? (current.reRecords || 0) + 1 : 0
      };
      onChange(current);
      showRecorded();
      if (res.stoppedBy !== 'user') status.textContent = 'Se alcanzó el límite de la grabación.';
    } catch (err) {
      active = null;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (current) showRecorded(); else showIdle();
      status.textContent = denied
        ? 'No pudimos acceder al micrófono. Revisa los permisos o escribe tu respuesta.'
        : 'No se pudo grabar. Intenta de nuevo o escribe tu respuesta.';
      console.error('audio record error', err);
    }
  }

  if (current) showRecorded(); else showIdle();

  return () => {
    if (active) active.stop();
    revoke();
  };
}
