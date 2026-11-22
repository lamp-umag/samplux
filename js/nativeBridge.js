// ─────────────────────────────────────────────────────────────
// samplux — optional bridge to the Android NDK (C++17) Lab & Field app.
// ─────────────────────────────────────────────────────────────
// In any regular browser (GitHub Pages / localhost), `window.SampluxNative` is
// undefined and every function here is a safe no-op. Inside the Android app,
// `window.SampluxNative` connects the runner to:
//   1. The C++17 NDK 120Hz VSYNC + kernel-touch + 400Hz IMU cognitive task engine
//   2. Android LockTask (Kiosk screen-pinning) + IMU physical handoff verification
//   3. Durable SQLite/disk outbox + full .zip backups (including raw audio blobs)
//   4. Passive ambient noise floor (dBA) & ambient light (lux) QC sensors
// ─────────────────────────────────────────────────────────────

function bridge() {
  return (typeof window !== 'undefined' && window.SampluxNative) ? window.SampluxNative : null;
}

export function isNativeApp() {
  return bridge() !== null;
}

export function hasNativeTasks() {
  const b = bridge();
  return !!(b && typeof b.startNativeTask === 'function');
}

/**
 * Runs a cognitive task (`task_rt`, `task_stroop`, `task_gonogo`) on the Android C++17 NDK
 * surface if available. Returns the standard `{ trials, summary }` object or `null` to
 * fall back to the web JS implementation.
 */
export async function runNativeTaskIfAvailable(taskType, config = {}) {
  const b = bridge();
  if (!b || typeof b.startNativeTask !== 'function') return null;
  try {
    const reqId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resultJson = await new Promise((resolve, reject) => {
      window.__sampluxTaskCallbacks = window.__sampluxTaskCallbacks || {};
      window.__sampluxTaskCallbacks[reqId] = { resolve, reject };
      try {
        b.startNativeTask(reqId, String(taskType), JSON.stringify(config || {}));
      } catch (err) {
        delete window.__sampluxTaskCallbacks[reqId];
        reject(err);
      }
    });
    const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
    return (parsed && parsed.trials && parsed.summary) ? parsed : null;
  } catch (e) {
    console.warn('[samplux] native task fallback to JS:', e);
    return null;
  }
}

/**
 * Notifies the Android host when `encuestador.js` enters or leaves `respondentView`
 * (`🤝 Entrega el dispositivo`). Engages Kiosk screen pinning + starts the C++ 400Hz IMU
 * physical handoff detector so paradata records whether the tablet actually changed hands.
 */
export function notifyRespondentHandoff(isRespondentView, itemId = null) {
  const b = bridge();
  if (!b) return;
  try {
    if (typeof b.setRespondentHandoff === 'function') {
      b.setRespondentHandoff(!!isRespondentView, itemId ? String(itemId) : '');
    }
  } catch { /* ignore */ }
}

/**
 * Returns the C++ IMU handoff & environmental summary for the active interviewer case,
 * or null in a normal browser.
 */
export function getNativeInterviewerTelemetry() {
  const b = bridge();
  if (!b || typeof b.getInterviewerTelemetryJson !== 'function') return null;
  try {
    const raw = b.getInterviewerTelemetryJson();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Returns a snapshot of hardware & environmental sensors collected passively by the
 * Android C++ NDK layer (ambient dBA noise floor, lux, display refresh Hz, battery temp).
 */
export function getNativeEnvironmentSnapshot() {
  const b = bridge();
  if (!b || typeof b.getEnvironmentSnapshotJson !== 'function') return null;
  try {
    const raw = b.getEnvironmentSnapshotJson();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Mirrors an outbox record (including base64-encoded audio blobs) to Android native
 * SQLite + surviving disk backup folder (`Documents/SampluxBackups/`).
 */
export async function mirrorOutboxEnqueue(sub) {
  const b = bridge();
  if (!b || typeof b.mirrorOutboxEnqueueJson !== 'function') return false;
  try {
    const serializedClips = await Promise.all((sub.clips || []).map(async c => {
      let base64 = null;
      if (c.blob && typeof c.blob.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await c.blob.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        base64 = btoa(binary);
      }
      return {
        itemId: c.itemId,
        docId: c.docId,
        mime: c.mime,
        durationMs: c.durationMs,
        size: c.blob?.size ?? 0,
        base64
      };
    }));
    b.mirrorOutboxEnqueueJson(JSON.stringify({
      surveyId: sub.surveyId,
      responseId: sub.responseId,
      entry: sub.entry,
      paradata: sub.paradata,
      consent: sub.consent ? { consentId: sub.consent.consentId, doc: sub.consent.doc } : null,
      clips: serializedClips,
      queuedAt: new Date().toISOString()
    }));
    return true;
  } catch (e) {
    console.warn('[samplux] native outbox mirror error:', e);
    return false;
  }
}

export function mirrorOutboxRemove(responseId) {
  const b = bridge();
  if (!b || typeof b.mirrorOutboxRemove !== 'function') return;
  try { b.mirrorOutboxRemove(String(responseId)); } catch { /* ignore */ }
}
