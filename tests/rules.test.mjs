// Firestore security-rules tests for the consent registry. Needs the emulator:
//   npm run test:rules        (starts it through firebase-tools)
// or point FIRESTORE_EMULATOR_HOST at one that is already running.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, deleteField, serverTimestamp, Bytes
} from 'firebase/firestore';
import { deriveKeys, ERASABLE_FIELDS } from '../js/consent.js';

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let env, anon, admin, surveyAdmin, stranger;

const SECRET = '0123456789ABCDEF';
const response = extra => ({
  surveyId: 'pub', answers: { q1: 3, mail: 'a@b.cl' }, totalTime: 1000, itemTimes: { q1: 5 },
  browserData: { userAgent: 'x' }, deviceInfo: { a: 1 }, ua: 'x', path: '/', serverCode: null,
  createdAt: serverTimestamp(), ...extra
});
const consentDoc = extra => ({
  v: 1, surveyId: 'pub', surveyTitle: 'Pública', responseId: 'r1', status: 'granted', level: 'sensitive',
  itemId: 'consent', text: 'acepto', textHash: 'abc', contact: '', audioItems: ['voz'], mode: 'self',
  clientGrantedAt: '2026-11-16T00:00:00Z', grantedAt: serverTimestamp(), ...extra
});
const stub = via => {
  const u = { answers: {}, withdrawn: true, withdrawnAt: serverTimestamp(), withdrawnVia: via };
  for (const f of ERASABLE_FIELDS) u[f] = deleteField();
  return u;
};
const clip = () => ({
  surveyId: 'pub', responseId: 'r1', itemId: 'voz', mime: 'audio/webm', durationMs: 10, size: 3,
  audio: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])), createdAt: serverTimestamp()
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'samplux-rules-test',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host, port: Number(port) }
  });
  anon = env.unauthenticatedContext().firestore();
  admin = env.authenticatedContext('admin', { email: 'herman.elgueta@umag.cl', email_verified: true }).firestore();
  surveyAdmin = env.authenticatedContext('sa', { email: 'equipo@umag.cl', email_verified: true }).firestore();
  stranger = env.authenticatedContext('x', { email: 'otra@gmail.com', email_verified: true }).firestore();
});
after(() => env.cleanup());

let keys;
beforeEach(async () => {
  await env.clearFirestore();
  keys = await deriveKeys(SECRET);
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'surveys/pub'), { title: 'Pública', published: true, adminEmails: ['equipo@umag.cl'] });
    await setDoc(doc(db, 'surveys/draft'), { title: 'Borrador', published: false });
  });
});

async function submit() {
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/audio/r1__voz'), clip()));
  await assertSucceeds(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc()));
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/entries/r1'), response({ consentId: keys.consentId, audio: { voz: { docId: 'r1__voz' } } })));
}
const withdraw = (db = anon, proof = keys.proof) =>
  updateDoc(doc(db, `consents/${keys.consentId}`), { status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'code', proof });

test('a participant submits; the public cannot read responses or list consents', async () => {
  await submit();
  await assertFails(getDoc(doc(anon, 'responses/pub/entries/r1')));
  await assertFails(getDocs(collection(anon, 'consents')));
  await assertFails(getDocs(collection(stranger, 'consents')));
  await assertSucceeds(getDoc(doc(anon, `consents/${keys.consentId}`)));   // only reachable by knowing the id
  await assertSucceeds(getDocs(collection(admin, 'consents')));
});

test('consent registration is validated', async () => {
  await assertFails(setDoc(doc(anon, 'consents/not-a-hash'), consentDoc()));
  await assertFails(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc({ status: 'withdrawn' })));
  await assertFails(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc({ surveyId: 'draft' })));
  await assertFails(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc({ extra: 1 })));
  await assertFails(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc({ text: 'x'.repeat(8001) })));
});

test('withdrawal needs the proof derived from the code', async () => {
  await submit();
  const other = await deriveKeys('FEDCBA9876543210');
  await assertFails(withdraw(anon, other.proof));
  await assertFails(withdraw(anon, keys.consentId));            // knowing the public id is not enough
  await assertFails(withdraw(stranger, other.proof));
  await assertFails(updateDoc(doc(anon, `consents/${keys.consentId}`), { status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'admin' }));
  await assertFails(updateDoc(doc(anon, `consents/${keys.consentId}`), { text: 'otro texto' }));
  await assertSucceeds(withdraw());
  await assertFails(updateDoc(doc(anon, `consents/${keys.consentId}`), { status: 'granted' }));   // final
  await assertFails(deleteDoc(doc(anon, `consents/${keys.consentId}`)));
});

test('a response can only be erased after its consent is withdrawn, and only to a stub', async () => {
  await submit();
  const ref = doc(anon, 'responses/pub/entries/r1');
  await assertFails(updateDoc(ref, stub('code')));
  await assertFails(deleteDoc(doc(anon, 'responses/pub/audio/r1__voz')));
  await assertSucceeds(withdraw());
  await assertFails(updateDoc(ref, { answers: { q1: 5 } }));                                   // no tampering
  await assertFails(updateDoc(ref, { ...stub('code'), answers: { q1: 1 } }));
  await assertFails(updateDoc(ref, { ...stub('code'), ua: 'kept' }));                          // nothing may survive
  await assertFails(updateDoc(ref, { ...stub('code'), consentId: 'x' }));
  await assertSucceeds(deleteDoc(doc(anon, 'responses/pub/audio/r1__voz')));
  await assertSucceeds(updateDoc(ref, stub('code')));
  await assertSucceeds(updateDoc(ref, stub('code')));                                          // idempotent
  const left = (await getDoc(doc(admin, 'responses/pub/entries/r1'))).data();
  assert.deepEqual(Object.keys(left).sort(), ['answers', 'consentId', 'createdAt', 'surveyId', 'withdrawn', 'withdrawnAt', 'withdrawnVia']);
  assert.deepEqual(left.answers, {});
});

test('withdrawing one consent does not unlock anybody else\'s response', async () => {
  await submit();
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'responses/pub/entries/r2'), response({ consentId: 'f'.repeat(64) })));
  await assertSucceeds(withdraw());
  await assertFails(updateDoc(doc(anon, 'responses/pub/entries/r2'), stub('code')));
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'responses/pub/entries/r3'), response()));
  await assertFails(updateDoc(doc(anon, 'responses/pub/entries/r3'), stub('code')));           // no consent at all
});

test('admins can erase (manual requests); strangers cannot', async () => {
  await submit();
  await assertFails(updateDoc(doc(stranger, 'responses/pub/entries/r1'), stub('admin')));
  await assertFails(updateDoc(doc(stranger, `consents/${keys.consentId}`), { status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'admin', requestId: 'q', by: 'x' }));
  await assertSucceeds(updateDoc(doc(surveyAdmin, `consents/${keys.consentId}`), { status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'admin', requestId: 'q', by: 'equipo@umag.cl' }));
  await assertSucceeds(deleteDoc(doc(surveyAdmin, 'responses/pub/audio/r1__voz')));
  await assertSucceeds(updateDoc(doc(surveyAdmin, 'responses/pub/entries/r1'), stub('admin')));
  await assertFails(deleteDoc(doc(admin, 'responses/pub/entries/r1')));                        // the stub stays
});

test('an identical re-send is accepted, a different one is not', async () => {
  await submit();
  const ref = doc(anon, 'responses/pub/entries/r1');
  const same = response({ consentId: keys.consentId, audio: { voz: { docId: 'r1__voz' } } });
  await assertSucceeds(setDoc(ref, same));
  await assertFails(setDoc(ref, { ...same, answers: { q1: 1 } }));
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/audio/r1__voz'), clip()));
  await assertFails(setDoc(doc(anon, 'responses/pub/audio/r1__voz'), { ...clip(), durationMs: 99 }));
});

test('a response queued offline is refused once its consent was withdrawn', async () => {
  await assertSucceeds(setDoc(doc(anon, `consents/${keys.consentId}`), consentDoc()));
  await assertSucceeds(withdraw());
  await assertFails(setDoc(doc(anon, 'responses/pub/entries/r1'), response({ consentId: keys.consentId })));
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/entries/r9'), response()));             // unrelated ones still fine
});

test('interviewer block is accepted on a response', async () => {
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/entries/i1'), response({ interviewer: { mode: 'encuestador', interviewerId: 'E1' } })));
});

test('withdrawal requests: anyone files, only admins read and resolve', async () => {
  const req = { surveyId: 'pub', surveyTitle: 'Pública', email: 'a@b.cl', when: 'ayer', details: '', status: 'pending', createdAt: serverTimestamp() };
  const ref = await assertSucceeds(addDoc(collection(anon, 'withdrawal_requests'), req));
  await assertFails(addDoc(collection(anon, 'withdrawal_requests'), { ...req, status: 'resolved' }));
  await assertFails(addDoc(collection(anon, 'withdrawal_requests'), { ...req, details: 'x'.repeat(2001) }));
  await assertFails(getDoc(doc(anon, ref.path)));
  await assertFails(getDoc(doc(stranger, ref.path)));
  await assertSucceeds(getDoc(doc(surveyAdmin, ref.path)));
  await assertSucceeds(getDocs(collection(admin, 'withdrawal_requests')));
  await assertFails(updateDoc(doc(stranger, ref.path), { status: 'resolved' }));
  await assertSucceeds(updateDoc(doc(admin, ref.path), { status: 'resolved', resolution: 'borrada', resolvedBy: 'x', resolvedAt: serverTimestamp(), note: '' }));
  await assertFails(updateDoc(doc(admin, ref.path), { email: 'otro@b.cl' }));
});
