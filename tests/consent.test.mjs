// Pure-logic tests for js/consent.js — run with `npm test` (no emulator needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSecret, normalizeSecret, formatSecret, deriveKeys, consentText, consentSettings,
  createConsentRecord, withdrawUrl, ERASABLE_FIELDS, STUB_FIELDS
} from '../js/consent.js';

const survey = {
  id: 's1', title: 'Encuesta', settings: { consent: { enabled: true, level: 'sensitive', itemId: 'consent' } },
  items: [
    { id: 'intro', type: 'info', prompt: 'Bienvenida\n<b>Texto</b> informativo' },
    { id: 'consent', type: 'single_choice', prompt: '¿Aceptas?', instruction: 'Contacto: x',
      options: [{ code: 1, label: 'Sí, acepto' }, { code: 2, label: 'No' }], exitOnAnswer: [2] },
    { id: 'after', type: 'info', prompt: 'Esto no es parte del consentimiento' }
  ]
};

test('secrets are 16 unambiguous characters and survive human retyping', () => {
  const s = generateSecret();
  assert.match(s, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.equal(normalizeSecret(formatSecret(s).toLowerCase()), s);
  assert.equal(normalizeSecret('O0Il-1111-2222-3333'), '0011111122223333');
  assert.equal(normalizeSecret('too-short'), null);
  assert.equal(normalizeSecret('UUUU-UUUU-UUUU-UUUU'), null);
});

test('keys are deterministic and the id does not reveal the proof', async () => {
  const a = await deriveKeys('0123456789ABCDEF');
  const b = await deriveKeys('0123456789ABCDEF');
  const c = await deriveKeys('0123456789ABCDEG');
  assert.deepEqual(a, b);
  assert.match(a.consentId, /^[a-f0-9]{64}$/);
  assert.notEqual(a.consentId, a.proof);
  assert.notEqual(a.consentId, c.consentId);
});

test('consent text covers what was shown up to the consent item, and the choice', () => {
  const text = consentText(survey, 'consent', 1);
  assert.ok(text.includes('Texto informativo'));
  assert.ok(text.includes('¿Aceptas?'));
  assert.ok(text.includes('Respuesta: Sí, acepto'));
  assert.ok(!text.includes('no es parte'));
  assert.ok(!text.includes('<b>'));
});

test('settings: off unless explicitly enabled; unknown level falls back to personal', () => {
  assert.equal(consentSettings({ settings: {} }), null);
  assert.equal(consentSettings({ settings: { consent: { level: 'sensitive' } } }), null);
  assert.equal(consentSettings({ settings: { consent: { enabled: true, level: 'x' } } }).level, 'personal');
});

test('a consent record carries no secret and links to its response', async () => {
  const rec = await createConsentRecord({ survey, responseId: 'r1', answers: { consent: 1 }, audioItems: ['q9'] });
  assert.equal((await deriveKeys(rec.secret)).consentId, rec.consentId);
  assert.ok(!JSON.stringify(rec.doc).includes(rec.secret));
  assert.equal(rec.doc.responseId, 'r1');
  assert.equal(rec.doc.level, 'sensitive');
  assert.deepEqual(rec.doc.audioItems, ['q9']);
  assert.equal(await createConsentRecord({ survey: { id: 'x', settings: {}, items: [] }, responseId: 'r', answers: {} }), null);
});

test('the withdrawal link keeps the code in the fragment', () => {
  const url = new URL(withdrawUrl('0123456789ABCDEF', 'https://lamp-umag.github.io/samplux/index.html?survey=a'));
  assert.equal(url.pathname, '/samplux/retirar.html');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#c=0123-4567-89AB-CDEF');
});

test('erasable and stub field lists do not overlap', () => {
  assert.equal(ERASABLE_FIELDS.filter(f => STUB_FIELDS.includes(f)).length, 0);
});
