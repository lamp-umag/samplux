// samplux — Firestore side of consent withdrawal (shared by retirar.html and retiros.html).
import {
  doc, getDoc, updateDoc, deleteDoc, deleteField, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { ERASABLE_FIELDS, deriveKeys } from './consent.js';

export async function findConsent(db, secret) {
  const { proof, consentId } = await deriveKeys(secret);
  const snap = await getDoc(doc(db, 'consents', consentId));
  return snap.exists() ? { consentId, proof, data: snap.data() } : null;
}

/**
 * Blanks a response to a stub and deletes its audio. Idempotent. Returns
 *   'erased'  — the response is now a stub
 *   'absent'  — there was no response document (nothing was ever stored)
 * Throws on anything else (e.g. offline), so the caller can say it is not finished.
 */
export async function eraseResponse(db, { surveyId, responseId, clipIds = [] }, via) {
  const update = { answers: {}, withdrawn: true, withdrawnAt: serverTimestamp(), withdrawnVia: via };
  for (const field of ERASABLE_FIELDS) update[field] = deleteField();
  // Audio first: its delete rule looks the consent up through the response document.
  for (const clipId of clipIds) {
    try { await deleteDoc(doc(db, `responses/${surveyId}/audio`, clipId)); }
    catch (e) { if (e.code !== 'permission-denied' && e.code !== 'not-found') throw e; }
  }
  // Paradata next, while the entry still carries the consentId the delete rule looks up.
  try { await deleteDoc(doc(db, `responses/${surveyId}/paradata`, responseId)); }
  catch (e) { if (e.code !== 'permission-denied' && e.code !== 'not-found') throw e; }
  try {
    await updateDoc(doc(db, `responses/${surveyId}/entries`, responseId), update);
    return 'erased';
  } catch (e) {
    if (e.code === 'not-found') return 'absent';
    throw e;
  }
}

/** Withdrawal by the code holder: marks the consent withdrawn (proof checked by the rules), then erases. */
export async function withdrawWithCode(db, found) {
  const { consentId, proof, data } = found;
  if (data.status !== 'withdrawn') {
    await updateDoc(doc(db, 'consents', consentId), {
      status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'code', proof
    });
  }
  return eraseResponse(db, {
    surveyId: data.surveyId,
    responseId: data.responseId,
    clipIds: (data.audioItems || []).map(itemId => `${data.responseId}__${itemId}`)
  }, 'code');
}
