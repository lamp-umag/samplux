// ─────────────────────────────────────────────────────────────
// samplux — consent registry & withdrawal (see docs/CONSENT.md)
// ─────────────────────────────────────────────────────────────
// A participant is never asked who they are. On submit they receive a random
// withdrawal code (the "comprobante"); everything else is derived from it:
//
//   secret     16 random Crockford-base32 chars, shown as XXXX-XXXX-XXXX-XXXX
//   proof      sha256("samplux-consent-v1:" + secret)   (hex)
//   consentId  sha256(proof)                             (hex)  → consents/<consentId>
//
// Firestore only ever stores consentId. Whoever holds the code can find the
// consent record and withdraw it: firestore.rules checks sha256(proof) ==
// consentId, so nobody can withdraw (or even look up) someone else's consent.
// Once a consent is withdrawn the rules let its response be blanked to a stub
// and its audio deleted — no server code involved.
//
// This module has no Firebase imports so it also runs under `node --test`.
// ─────────────────────────────────────────────────────────────

export const CONSENT_VERSION = 1;
export const CONSENT_LEVELS = {
  anonymous: 'Datos anónimos',
  personal: 'Datos personales',
  sensitive: 'Datos sensibles'
};

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const SECRET_LENGTH = 16;                           // 80 bits

// Every top-level field a response document can carry besides the stub fields.
// Withdrawal deletes all of them; firestore.rules then verifies that nothing but
// STUB_FIELDS is left. KEEP IN SYNC with the payload in surveyRunner.js.
export const ERASABLE_FIELDS = [
  'audio', 'surveyRevision', 'serverCode', 'totalTime', 'itemTimes', 'presentationOrder', 'responseTimestamps',
  'navBackCount', 'answerChangeCount', 'itemAnswerChangeCount', 'answerChangeEvents',
  'answerChangeEventsTruncated', 'browserData', 'deviceInfo', 'tabHiddenCount', 'tabHiddenMs',
  'ua', 'path', 'interviewer'
];
export const STUB_FIELDS = ['surveyId', 'answers', 'consentId', 'createdAt', 'withdrawn', 'withdrawnAt', 'withdrawnVia'];

export function consentSettings(survey) {
  const c = survey && survey.settings && survey.settings.consent;
  if (!c || c.enabled !== true) return null;
  return {
    level: Object.hasOwn(CONSENT_LEVELS, c.level) ? c.level : 'personal',
    itemId: typeof c.itemId === 'string' && c.itemId ? c.itemId : null,
    contact: typeof c.contact === 'string' ? c.contact : ''
  };
}

export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

export function generateSecret() {
  // 256 % 32 === 0, so the modulo is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  return Array.from(bytes, b => ALPHABET[b % 32]).join('');
}

/** Accepts what a person types or pastes: any case, dashes/spaces, O→0, I/L→1. Returns null if invalid. */
export function normalizeSecret(input) {
  const s = String(input ?? '').toUpperCase().replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== SECRET_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export function formatSecret(secret) {
  return String(secret).match(/.{1,4}/g).join('-');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveKeys(secret) {
  const proof = await sha256Hex(`samplux-consent-v${CONSENT_VERSION}:${secret}`);
  const consentId = await sha256Hex(proof);
  return { proof, consentId };
}

export function withdrawUrl(secret, base) {
  const origin = base || (typeof location !== 'undefined' ? location.href : 'https://lamp-umag.github.io/samplux/');
  const url = new URL('retirar.html', origin);
  url.hash = `c=${formatSecret(secret)}`;   // fragment: never sent to a server or kept in logs
  return url.href;
}

function plainText(html) {
  return String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/**
 * The text the participant agreed to: every information screen shown up to the
 * consent item, the consent question itself and the option they chose.
 */
export function consentText(survey, itemId, answerCode) {
  const items = (survey && survey.items) || [];
  const idx = itemId ? items.findIndex(it => it && it.id === itemId) : -1;
  if (idx < 0) return '';
  const parts = [];
  for (const it of items.slice(0, idx)) {
    if (it && it.type === 'info' && it.prompt) parts.push(plainText(it.prompt));
  }
  const item = items[idx];
  if (item.instruction) parts.push(plainText(item.instruction));
  parts.push(plainText(item.prompt));
  const options = (survey.optionSets && survey.optionSets[item.type]) || item.options || [];
  const chosen = options.find(o => o && typeof o === 'object' && String(o.code ?? o.value) === String(answerCode));
  if (chosen) parts.push(`Respuesta: ${chosen.label}`);
  else if (item.type === 'yes_no' && answerCode != null) parts.push(`Respuesta: ${answerCode === 'yes' ? 'Sí' : 'No'}`);
  return parts.filter(Boolean).join('\n\n').slice(0, 6000);
}

/**
 * Builds the consent record for one response. Returns
 *   { secret, consentId, doc }  — `doc` goes to consents/<consentId> (grantedAt is added on upload).
 */
export async function createConsentRecord({ survey, responseId, answers, audioItems, grantedAtClient, mode }) {
  const cfg = consentSettings(survey);
  if (!cfg || !cryptoAvailable()) return null;
  const secret = generateSecret();
  const { consentId } = await deriveKeys(secret);
  const text = consentText(survey, cfg.itemId, cfg.itemId ? answers[cfg.itemId] : null);
  return {
    secret,
    consentId,
    doc: {
      v: CONSENT_VERSION,
      surveyId: survey.id,
      surveyTitle: String(survey.title || survey.id).slice(0, 200),
      responseId,
      status: 'granted',
      level: cfg.level,
      itemId: cfg.itemId,
      text,
      textHash: text ? await sha256Hex(text) : null,
      contact: cfg.contact.slice(0, 300),
      audioItems: (audioItems || []).slice(0, 50),
      mode: mode || 'self',
      clientGrantedAt: grantedAtClient || new Date().toISOString()
    }
  };
}

/** Plain-text receipt a participant can download or mail to themselves. */
export function receiptText({ secret, surveyTitle, url, contact }) {
  return [
    'COMPROBANTE DE PARTICIPACIÓN — samplux · LAMP, Universidad de Magallanes',
    '',
    `Encuesta: ${surveyTitle}`,
    `Fecha: ${new Date().toLocaleString('es-CL')}`,
    '',
    `Código de retiro: ${formatSecret(secret)}`,
    `Enlace directo:   ${url}`,
    '',
    'Con este código puedes retirar tu consentimiento en cualquier momento y sin dar',
    'explicaciones. Al hacerlo, tus respuestas se eliminan de inmediato.',
    'Guárdalo: es la única forma de identificar tus respuestas, porque no registramos tu nombre.',
    ...(contact ? ['', `Contacto: ${contact}`] : [])
  ].join('\n');
}

// ── Receipts remembered on this device (never used in interviewer mode) ──
const LS_KEY = 'samplux.receipts';

export function rememberReceipt(entry) {
  try {
    const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    list.push(entry);
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(-50)));
  } catch { /* storage blocked: the on-screen receipt is still there */ }
}
export function listReceipts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
export function forgetReceipt(secret) {
  try {
    const list = listReceipts().filter(r => r.secret !== secret);
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}
