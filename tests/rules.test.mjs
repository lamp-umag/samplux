// Firestore security-rules tests for the consent registry. Needs the emulator:
//   npm run test:rules        (starts it through firebase-tools)
// or point FIRESTORE_EMULATOR_HOST at one that is already running.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, deleteField, serverTimestamp, Bytes
} from 'firebase/firestore';
import { deriveKeys, ERASABLE_FIELDS } from '../js/consent.js';

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let env, anon, admin, surveyAdmin, stranger, ctxAs;

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
  const as = (uid, email, extra = {}) =>
    env.authenticatedContext(uid, { email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...extra }).firestore();
  admin = as('admin', 'herman.elgueta@umag.cl');
  surveyAdmin = as('sa', 'equipo@umag.cl');
  stranger = as('x', 'otra@gmail.com');
  ctxAs = as;
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
  await assertFails(deleteDoc(doc(surveyAdmin, 'responses/pub/entries/r1')));                  // survey staff leave the stub
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

/* ───────── Access model: staff, owners, collaborators, paradata ───────── */
const mkSurvey = extra => ({ title: 'Mía', published: true, items: [], settings: {}, ...extra });

test('any @umag.cl account creates surveys as owner; others cannot', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl');
  await assertSucceeds(setDoc(doc(ana, 'surveys/ana1'), mkSurvey({ ownerEmail: 'ana@umag.cl' })));
  await assertFails(setDoc(doc(ana, 'surveys/ana2'), mkSurvey({ ownerEmail: 'otra@umag.cl' })));       // not on someone else's behalf
  await assertFails(setDoc(doc(ana, 'surveys/ana3'), mkSurvey({ ownerEmail: 'ana@umag.cl', adminEmails: ['x@y.cl'] })));
  await assertFails(setDoc(doc(ana, 'surveys/ana4'), mkSurvey()));                                       // owner required
  const gmail = ctxAs('g', 'ana@gmail.com');
  await assertFails(setDoc(doc(gmail, 'surveys/g1'), mkSurvey({ ownerEmail: 'ana@gmail.com' })));
  await assertFails(setDoc(doc(anon, 'surveys/a1'), mkSurvey({ ownerEmail: 'a@umag.cl' })));
  await assertFails(setDoc(doc(ctxAs('t', 'ana@umag.cl', { email_verified: false }), 'surveys/t1'), mkSurvey({ ownerEmail: 'ana@umag.cl' })));
  await assertFails(setDoc(doc(ctxAs('p', 'ana@umag.cl', { firebase: { sign_in_provider: 'password' } }), 'surveys/p1'), mkSurvey({ ownerEmail: 'ana@umag.cl' })));
  await assertFails(setDoc(doc(ctxAs('lookalike', 'ana@umag.cl.evil.com'), 'surveys/l1'), mkSurvey({ ownerEmail: 'ana@umag.cl.evil.com' })));
  await assertFails(setDoc(doc(ctxAs('lookalike2', 'ana@xumag.cl'), 'surveys/l2'), mkSurvey({ ownerEmail: 'ana@xumag.cl' })));
});

test('an exemption lets a specific non-umag address create surveys', async () => {
  const gmail = ctxAs('g', 'invitada@gmail.com');
  await assertFails(setDoc(doc(gmail, 'surveys/g1'), mkSurvey({ ownerEmail: 'invitada@gmail.com' })));
  await assertSucceeds(setDoc(doc(admin, 'access/invitada@gmail.com'), { exempt: true, note: 'colaboradora externa' }));
  await assertSucceeds(setDoc(doc(gmail, 'surveys/g1'), mkSurvey({ ownerEmail: 'invitada@gmail.com' })));
});

test('owners edit their survey; the owner and legacy viewers are locked; only admins delete', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl'), bea = ctxAs('bea', 'bea@umag.cl');
  await assertSucceeds(setDoc(doc(ana, 'surveys/s1'), mkSurvey({ ownerEmail: 'ana@umag.cl', published: false })));
  await assertSucceeds(updateDoc(doc(ana, 'surveys/s1'), { title: 'Nuevo', published: true }));
  await assertFails(updateDoc(doc(bea, 'surveys/s1'), { title: 'Hackeado' }));
  await assertFails(updateDoc(doc(ana, 'surveys/s1'), { ownerEmail: 'bea@umag.cl' }));
  await assertFails(updateDoc(doc(ana, 'surveys/s1'), { adminEmails: ['bea@umag.cl'] }));
  await assertFails(deleteDoc(doc(ana, 'surveys/s1')));
  await assertSucceeds(updateDoc(doc(admin, 'surveys/s1'), { ownerEmail: 'bea@umag.cl' }));
  await assertSucceeds(deleteDoc(doc(admin, 'surveys/s1')));
});

test('owners list their own surveys; unpublished ones stay hidden from others', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl'), bea = ctxAs('bea', 'bea@umag.cl');
  await assertSucceeds(setDoc(doc(ana, 'surveys/d1'), mkSurvey({ ownerEmail: 'ana@umag.cl', published: false })));
  await assertSucceeds(getDocs(query(collection(ana, 'surveys'), where('ownerEmail', '==', 'ana@umag.cl'))));
  await assertFails(getDocs(collection(ana, 'surveys')));                                 // can't list everything
  await assertSucceeds(getDoc(doc(ana, 'surveys/d1')));
  await assertFails(getDoc(doc(bea, 'surveys/d1')));
  await assertSucceeds(getDocs(query(collection(bea, 'surveys'), where('published', '==', true))));
  await assertSucceeds(getDocs(collection(admin, 'surveys')));
});

test('collaborators: owner adds @umag.cl colleagues, only admins add anyone else', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl'), bea = ctxAs('bea', 'bea@umag.cl'), cat = ctxAs('cat', 'cat@umag.cl');
  await assertSucceeds(setDoc(doc(ana, 'surveys/s1'), mkSurvey({ ownerEmail: 'ana@umag.cl', published: false })));
  const c = (email, role = 'viewer', by = 'ana@umag.cl') => ({ surveyId: 's1', email, role, addedBy: by, createdAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(ana, 'collab/s1__bea@umag.cl'), c('bea@umag.cl')));
  await assertFails(setDoc(doc(ana, 'collab/s1__ext@gmail.com'), c('ext@gmail.com')));    // non-umag: not by the owner
  await assertFails(setDoc(doc(bea, 'collab/s1__cat@umag.cl'), c('cat@umag.cl', 'viewer', 'bea@umag.cl')));  // not the owner
  await assertFails(setDoc(doc(ana, 'collab/wrong-id'), c('cat@umag.cl')));
  await assertSucceeds(setDoc(doc(admin, 'collab/s1__ext@gmail.com'), c('ext@gmail.com', 'viewer', 'herman.elgueta@umag.cl')));
  // viewer reads, cannot edit; once promoted to editor, can
  await assertSucceeds(getDoc(doc(bea, 'surveys/s1')));
  await assertFails(updateDoc(doc(bea, 'surveys/s1'), { title: 'x' }));
  await assertSucceeds(updateDoc(doc(ana, 'collab/s1__bea@umag.cl'), { role: 'editor' }));
  await assertSucceeds(updateDoc(doc(bea, 'surveys/s1'), { title: 'x' }));
  await assertFails(updateDoc(doc(bea, 'surveys/s1'), { ownerEmail: 'bea@umag.cl' }));
  // finding the surveys I was added to, and who is on mine
  await assertSucceeds(getDocs(query(collection(bea, 'collab'), where('email', '==', 'bea@umag.cl'))));
  await assertFails(getDocs(query(collection(cat, 'collab'), where('email', '==', 'bea@umag.cl'))));
  await assertSucceeds(getDocs(query(collection(ana, 'collab'), where('surveyId', '==', 's1'))));
  await assertSucceeds(deleteDoc(doc(ana, 'collab/s1__bea@umag.cl')));
  await assertFails(updateDoc(doc(bea, 'surveys/s1'), { title: 'y' }));
});

test('answers follow ownership; paradata needs an explicit grant', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl'), bea = ctxAs('bea', 'bea@umag.cl');
  await assertSucceeds(setDoc(doc(ana, 'surveys/s1'), mkSurvey({ ownerEmail: 'ana@umag.cl' })));
  await assertSucceeds(setDoc(doc(anon, 'responses/s1/entries/r1'), { surveyId: 's1', answers: { q: 1 }, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(anon, 'responses/s1/paradata/r1'), { surveyId: 's1', totalTime: 5000, events: [{ t: 1, k: 'miss' }] }));
  await assertFails(setDoc(doc(anon, 'responses/s1/paradata/r2'), { surveyId: 'other', totalTime: 1 }));
  await assertSucceeds(getDoc(doc(ana, 'responses/s1/entries/r1')));
  await assertFails(getDoc(doc(bea, 'responses/s1/entries/r1')));
  await assertFails(getDoc(doc(ana, 'responses/s1/paradata/r1')));                         // owner without grant
  await assertFails(getDocs(collection(ana, 'responses/s1/paradata')));
  await assertSucceeds(setDoc(doc(admin, 'access/ana@umag.cl'), { paradata: true }));
  await assertSucceeds(getDoc(doc(ana, 'responses/s1/paradata/r1')));
  await assertSucceeds(getDocs(collection(ana, 'responses/s1/paradata')));
  await assertFails(getDoc(doc(bea, 'responses/s1/paradata/r1')));                          // grant is not survey access
  await assertSucceeds(setDoc(doc(admin, 'access/bea@umag.cl'), { paradata: true }));
  await assertFails(getDoc(doc(bea, 'responses/s1/paradata/r1')));
  await assertSucceeds(getDoc(doc(admin, 'responses/s1/paradata/r1')));
  await assertFails(updateDoc(doc(anon, 'responses/s1/paradata/r1'), { totalTime: 1 }));
  await assertSucceeds(setDoc(doc(anon, 'responses/s1/paradata/r1'), { surveyId: 's1', totalTime: 5000, events: [{ t: 1, k: 'miss' }] }));   // identical retry
});

test('access switches: users read only their own, only admins write', async () => {
  const ana = ctxAs('ana', 'ana@umag.cl');
  await assertSucceeds(setDoc(doc(admin, 'access/ana@umag.cl'), { paradata: true }));
  await assertSucceeds(getDoc(doc(ana, 'access/ana@umag.cl')));
  await assertSucceeds(getDoc(doc(ctxAs('zoe', 'zoe@umag.cl'), 'access/zoe@umag.cl')));     // own record, even if it does not exist yet
  await assertFails(getDoc(doc(ana, 'access/bea@umag.cl')));
  await assertFails(setDoc(doc(ana, 'access/ana@umag.cl'), { paradata: true, exempt: true }));
  await assertFails(getDocs(collection(ana, 'access')));
  await assertSucceeds(getDocs(collection(admin, 'access')));
});

test('withdrawn responses lose their paradata too', async () => {
  await submit();
  await assertSucceeds(setDoc(doc(anon, 'responses/pub/paradata/r1'), { surveyId: 'pub', totalTime: 1 }));
  await assertFails(deleteDoc(doc(anon, 'responses/pub/paradata/r1')));
  await assertSucceeds(withdraw());
  await assertSucceeds(deleteDoc(doc(anon, 'responses/pub/paradata/r1')));
});

test('only a super admin can purge a survey\'s records (entries, consents, requests)', async () => {
  await submit();
  const req = await assertSucceeds(addDoc(collection(anon, 'withdrawal_requests'), { surveyId: 'pub', email: 'a@b.cl', status: 'pending', createdAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(surveyAdmin, 'responses/pub/entries/r1')));
  await assertFails(deleteDoc(doc(surveyAdmin, `consents/${keys.consentId}`)));
  await assertFails(deleteDoc(doc(surveyAdmin, req.path)));
  await assertSucceeds(deleteDoc(doc(admin, 'responses/pub/entries/r1')));
  await assertSucceeds(deleteDoc(doc(admin, `consents/${keys.consentId}`)));
  await assertSucceeds(deleteDoc(doc(admin, req.path)));
  await assertSucceeds(deleteDoc(doc(admin, 'responses/pub/audio/r1__voz')));
});
