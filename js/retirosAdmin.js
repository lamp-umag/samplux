// samplux — retiros.html: admins resolve "I lost my code" withdrawal requests.
// Access follows firestore.rules: global admins see every request, per-survey
// admins (surveys/<id>.adminEmails) only those of their surveys.
import { app, db } from './firebaseClient.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  doc, getDoc, updateDoc, serverTimestamp, collection, getDocs, query, where
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import { eraseResponse } from './consentStore.js';

import { resolveAccess, fetchMySurveys } from './access.js';

const auth = getAuth(app);
const $ = id => document.getElementById(id);
let me = null;

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
const fmtDate = v => {
  const d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
  return d && !isNaN(d) ? d.toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
};

$('loginBtn').onclick = async () => {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (e) { $('authMsg').textContent = 'No se pudo iniciar sesión: ' + (e?.message || e); }
};
$('userChip').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  me = user;
  $('list').replaceChildren();
  $('userChip').classList.toggle('hidden', !user);
  if (!user) { $('auth').classList.remove('hidden'); return; }
  $('userChip').textContent = user.email;
  try {
    const requests = await loadRequests((user.email || '').toLowerCase());
    $('auth').classList.add('hidden');
    render(requests);
  } catch (e) {
    console.error(e);
    $('auth').classList.remove('hidden');
    $('authMsg').textContent = 'Esta cuenta no tiene acceso a las solicitudes de retiro.';
  }
});

async function loadRequests(email) {
  const col = collection(db, 'withdrawal_requests');
  let docs = [];
  const access = await resolveAccess(db, auth.currentUser);
  if (access.role === 'super') {
    docs = (await getDocs(col)).docs;
  } else {
    const mine = await fetchMySurveys(db, email);
    if (!mine.length) throw new Error('sin acceso');
    for (const s of mine) docs.push(...(await getDocs(query(col, where('surveyId', '==', s.id)))).docs);
  }
  return docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1)
      || (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

function render(requests) {
  if (!requests.length) {
    $('list').replaceChildren(h('p', { class: 'lead' }, 'No hay solicitudes.'));
    return;
  }
  $('list').replaceChildren(...requests.map(card));
}

function card(req) {
  const pending = req.status === 'pending';
  const body = h('div');
  const node = h('div', { class: 'card' + (pending ? ' pending' : '') },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, req.surveyTitle || req.surveyId || 'Encuesta no indicada'),
      h('span', { class: 'tag' + (pending ? '' : ' done') }, pending ? 'pendiente' : (req.resolution || req.status))),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Recibida'), h('dd', {}, fmtDate(req.createdAt)),
      h('dt', {}, 'Correo'), h('dd', {}, req.email || '—'),
      h('dt', {}, 'Cuándo'), h('dd', {}, req.when || '—'),
      h('dt', {}, 'Detalles'), h('dd', {}, req.details || '—'),
      pending ? null : [h('dt', {}, 'Resuelta'), h('dd', {}, `${fmtDate(req.resolvedAt)} · ${req.resolvedBy || ''}${req.note ? ' · ' + req.note : ''}`)]
    ),
    body
  );
  if (pending) body.append(actions(req, node));
  return node;
}

function actions(req, node) {
  const msg = h('p', { class: 'msg' });
  const cands = h('div');
  const note = h('textarea', { class: 'note', placeholder: 'Nota interna (cómo se verificó, o por qué no se pudo ubicar)', maxlength: '500' });

  const resolve = async (resolution, extra = {}) => {
    await updateDoc(doc(db, 'withdrawal_requests', req.id), {
      status: 'resolved', resolution, resolvedBy: me.email, resolvedAt: serverTimestamp(),
      note: note.value.trim(), ...extra
    });
    node.replaceWith(card({ ...req, status: 'resolved', resolution, resolvedBy: me.email, resolvedAt: new Date(), note: note.value.trim() }));
  };

  const search = h('button', { class: 'btn secondary' }, 'Buscar respuestas con este correo');
  search.onclick = async () => {
    if (!req.surveyId) { msg.textContent = 'La solicitud no indica encuesta: búscala a mano en admin.'; return; }
    search.disabled = true; msg.textContent = 'Buscando…';
    try {
      const snap = await getDocs(collection(db, `responses/${req.surveyId}/entries`));
      const wanted = String(req.email || '').trim().toLowerCase();
      const hits = snap.docs.filter(d => {
        const data = d.data();
        if (data.withdrawn === true) return false;
        return Object.values(data.answers || {}).some(v => typeof v === 'string' && v.trim().toLowerCase() === wanted);
      });
      msg.textContent = hits.length
        ? `${hits.length} respuesta(s) contienen ese correo.`
        : 'Ninguna respuesta de esa encuesta contiene ese correo. Sin correo ni código no hay forma de saber cuál es suya.';
      cands.replaceChildren(...hits.map(d => candidate(req, d, resolve, msg)));
    } catch (e) {
      console.error(e); msg.textContent = 'No se pudieron leer las respuestas: ' + (e?.message || e);
    } finally { search.disabled = false; }
  };

  const reject = h('button', { class: 'btn secondary' }, 'Cerrar: no identificable');
  reject.onclick = async () => {
    try { await resolve('no_identificable'); } catch (e) { console.error(e); msg.textContent = 'No se pudo guardar.'; }
  };
  const reply = h('a', { class: 'btn secondary', href: mailto(req.email, 'Tu solicitud de retiro de consentimiento',
    `Hola:\n\nRecibimos tu solicitud de retiro de consentimiento${req.surveyTitle ? ` para «${req.surveyTitle}»` : ''}.\n\n`) }, 'Responder por correo');

  return h('div', {}, h('div', { class: 'row' }, search, reply, reject), note, msg, cands);
}

function mailto(to, subject, body) {
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function candidate(req, snap, resolve, msg) {
  const data = snap.data();
  const verify = h('a', { class: 'btn secondary', href: mailto(req.email, 'Confirma tu retiro de consentimiento',
    `Hola:\n\nAlguien pidió retirar el consentimiento y borrar las respuestas asociadas a este correo en «${req.surveyTitle || req.surveyId}».\n\nSi fuiste tú, responde este mensaje con la palabra CONFIRMO y las borraremos. Si no fuiste tú, ignóralo: no se borrará nada.\n`) }, '1 · Pedir confirmación');
  const erase = h('button', { class: 'btn primary' }, '2 · Borrar esta respuesta');
  erase.onclick = async () => {
    if (!confirm('¿La persona ya confirmó desde su correo? El borrado no se puede deshacer.')) return;
    erase.disabled = true;
    try {
      if (data.consentId) {
        const cref = doc(db, 'consents', data.consentId);
        const c = await getDoc(cref);
        if (c.exists() && c.data().status === 'granted') {
          await updateDoc(cref, { status: 'withdrawn', withdrawnAt: serverTimestamp(), via: 'admin', requestId: req.id, by: me.email });
        }
      }
      await eraseResponse(db, {
        surveyId: req.surveyId, responseId: snap.id,
        clipIds: Object.values(data.audio || {}).map(a => a.docId).filter(Boolean)
      }, 'admin');
      await resolve('borrada', { responseId: snap.id });
    } catch (e) {
      console.error(e); erase.disabled = false;
      msg.textContent = 'No se pudo borrar: ' + (e?.message || e);
    }
  };
  return h('div', { class: 'cand' },
    h('div', {}, `Respuesta ${snap.id.slice(0, 8)}… · ${fmtDate(data.createdAt)} · ${Object.keys(data.answers || {}).length} respuestas`),
    h('div', { class: 'row', style: 'margin-top:8px' }, verify, erase));
}
