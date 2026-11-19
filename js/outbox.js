// samplux — offline outbox for interviewer mode (IndexedDB).
// A finished case is stored here first and uploaded when there is a connection, so
// fieldwork never depends on the network. Records are the plain submissions built by
// surveyRunner.js (payload + audio blobs + consent record), minus the withdrawal secret.
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { uploadSubmission } from './surveyRunner.js';

const DB_NAME = 'samplux-outbox';
const STORE = 'submissions';
const UPLOAD_TIMEOUT_MS = 45000;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'responseId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const idb = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = idb.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally { idb.close(); }
}

export const pending = () => tx('readonly', s => s.getAll());
export const pendingCount = () => tx('readonly', s => s.count());
const put = rec => tx('readwrite', s => s.put(rec));
const remove = id => tx('readwrite', s => s.delete(id));

export function enqueue(sub) {
  return put({
    surveyId: sub.surveyId,
    responseId: sub.responseId,
    entry: sub.entry,
    paradata: sub.paradata,
    clips: sub.clips || [],
    consent: sub.consent ? { consentId: sub.consent.consentId, doc: sub.consent.doc } : null,
    uploaded: {},
    queuedAt: new Date().toISOString()
  });
}

const timeout = ms => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms));

let running = null;

/** Uploads everything that is queued. Returns { sent, left, error }. Concurrent calls share one run. */
export function syncOutbox(db, onChange = () => {}) {
  if (!running) running = run(db, onChange).finally(() => { running = null; });
  return running;
}

async function run(db, onChange) {
  let sent = 0;
  let error = null;
  for (const rec of await pending()) {
    if (!navigator.onLine) { error = 'offline'; break; }
    try {
      await Promise.race([uploadSubmission(db, rec), timeout(UPLOAD_TIMEOUT_MS)]);
      await remove(rec.responseId);
      sent += 1;
    } catch (e) {
      if (e.code === 'permission-denied' && rec.consent && await consentWithdrawn(db, rec.consent.consentId)) {
        // The participant withdrew before this case reached the server: it must not be uploaded.
        await remove(rec.responseId);
        continue;
      }
      error = e.code || e.message || 'error';
      await put({ ...rec, lastError: error, lastTriedAt: new Date().toISOString() });   // keeps `uploaded` progress
      if (e.code === 'timeout' || e.code === 'unavailable') break;                      // no point hammering a dead link
    }
    onChange();
  }
  const left = await pendingCount();
  onChange();
  return { sent, left, error: left ? error : null };
}

async function consentWithdrawn(db, consentId) {
  try {
    const snap = await getDoc(doc(db, 'consents', consentId));
    return snap.exists() && snap.data().status === 'withdrawn';
  } catch { return false; }
}

/** Human-readable backup of the queue (audio left out), in case a device has to be handed in. */
export async function exportBackup() {
  const records = (await pending()).map(r => ({
    surveyId: r.surveyId, responseId: r.responseId, queuedAt: r.queuedAt, lastError: r.lastError || null,
    entry: r.entry, paradata: r.paradata, audioClips: (r.clips || []).map(c => ({ itemId: c.itemId, bytes: c.blob?.size ?? null }))
  }));
  return new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json' });
}
