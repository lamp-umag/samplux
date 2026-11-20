// ─────────────────────────────────────────────────────────────
// samplux — paradata/metadata split (see docs/ACCESS.md)
// ─────────────────────────────────────────────────────────────
// A response is stored as two documents written together:
//   responses/<survey>/entries/<id>   answers + what analysis of the answers needs
//   responses/<survey>/paradata/<id>  everything about HOW and WHERE they were given
// Only accounts with the paradata permission can read the second one (firestore.rules).
// ─────────────────────────────────────────────────────────────

// Top-level fields that stay on the entry. Everything else of a payload is paradata.
// KEEP IN SYNC with STUB_FIELDS in js/consent.js.
export const ENTRY_FIELDS = ['surveyId', 'answers', 'audio', 'consentId', 'presentationOrder', 'surveyRevision'];

// Fields that, on old responses (stored before the split), sit inline on the entry.
export const PARADATA_FIELDS = [
  'serverCode', 'totalTime', 'itemTimes', 'responseTimestamps', 'navBackCount', 'answerChangeCount',
  'itemAnswerChangeCount', 'answerChangeEvents', 'answerChangeEventsTruncated', 'browserData', 'deviceInfo',
  'tabHiddenCount', 'tabHiddenMs', 'ua', 'path', 'interviewer',
  'events', 'eventsTruncated', 'missTapCount', 'geo', 'schema', 'submittedAt'
];

export function splitPayload(payload) {
  const entry = {};
  const paradata = { surveyId: payload.surveyId, schema: 2, submittedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (ENTRY_FIELDS.includes(k)) entry[k] = v; else paradata[k] = v;
  }
  return { entry, paradata };
}

/** Drops paradata fields from a response read by someone without the permission (old inline ones). */
export function stripParadata(data) {
  const out = { ...data };
  for (const f of PARADATA_FIELDS) delete out[f];
  return out;
}
