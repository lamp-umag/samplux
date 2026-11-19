// samplux — super.html: oversight of every survey + per-account permissions (super admins only).
import { app, db } from './firebaseClient.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import {
  collection, getDocs, getCountFromServer, query, orderBy, limit, doc, setDoc, updateDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import { resolveAccess, norm } from './access.js';
import { collectionManifest } from './manifest.js';

const auth = getAuth(app);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = v => {
  const d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
  return d && !isNaN(d) ? d.toLocaleDateString('es-CL', { dateStyle: 'medium' }) : '—';
};
let me = null;

$('loginBtn').onclick = async () => {
  try {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, p);
  } catch (e) { $('authMsg').textContent = 'No se pudo iniciar sesión: ' + (e?.message || e); }
};
$('userChip').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  me = await resolveAccess(db, user);
  $('userChip').classList.toggle('hidden', !user);
  $('userChip').textContent = user ? user.email : '';
  const ok = me.role === 'super';
  $('auth').classList.toggle('hidden', ok);
  $('app').classList.toggle('hidden', !ok);
  if (user && !ok) $('authMsg').textContent = 'Esta cuenta no es de administración.';
  if (ok) loadAll();
});

let surveys = [];
async function loadAll() {
  $('surveys').innerHTML = '<tr><td>Cargando…</td></tr>';
  const [sv, collabs] = await Promise.all([
    getDocs(collection(db, 'surveys')),
    getDocs(collection(db, 'collab')).catch(() => ({ docs: [] }))
  ]);
  const collabBy = new Map();
  collabs.docs.forEach(d => { const c = d.data(); (collabBy.get(c.surveyId) || collabBy.set(c.surveyId, []).get(c.surveyId)).push(c); });
  surveys = sv.docs.map(d => ({ id: d.id, ...d.data(), collabs: collabBy.get(d.id) || [] }));
  // Counts: one aggregation query per survey (cheap: no documents are downloaded).
  await Promise.all(surveys.map(async s => {
    try {
      const col = collection(db, `responses/${s.id}/entries`);
      s.count = (await getCountFromServer(col)).data().count;
      const last = await getDocs(query(col, orderBy('createdAt', 'desc'), limit(1)));
      s.last = last.docs[0]?.data().createdAt || null;
    } catch (e) { s.count = null; }
  }));
  surveys.sort((a, b) => (b.published === true) - (a.published === true) || (b.count || 0) - (a.count || 0));
  renderSurveys();
  $('grantSurvey').innerHTML = surveys.map(s => `<option value="${esc(s.id)}">${esc(s.title || s.id)}</option>`).join('');
  await loadAccess();
}

function renderSurveys() {
  const head = '<tr><th>Encuesta</th><th>Estado</th><th>Respuestas</th><th>Responsable y administradores</th><th>Recoge</th></tr>';
  const total = surveys.reduce((n, s) => n + (s.count || 0), 0);
  $('surveys').innerHTML = head + surveys.map(s => {
    const m = collectionManifest(s);
    const admins = [
      s.ownerEmail ? `<div><strong>${esc(s.ownerEmail)}</strong> <span class="sub">responsable</span></div>` : '<div class="sub">sin responsable (anterior al sistema)</div>',
      ...s.collabs.map(c => `<div>${esc(c.email)} <span class="sub">${c.role === 'editor' ? 'edita' : 've respuestas'}</span></div>`),
      ...(s.adminEmails || []).map(e => `<div>${esc(e)} <span class="sub">visor heredado</span></div>`)
    ].join('');
    const tags = [
      s.settings?.consent?.enabled ? `<span class="tag">consent: ${esc(s.settings.consent.level)}</span>` : '<span class="tag off">sin consent</span>',
      ...m.rows.filter(r => r.flag).map(r => `<span class="tag">${r.flag === 'sensitive' ? 'ubicación' : 'voz'}</span>`)
    ].join('');
    const warn = m.warnings.length ? `<div class="warn">⚠ ${esc(m.warnings[0])}</div>` : '';
    const assign = `<div><button class="btn secondary" data-owner="${esc(s.id)}" style="padding:4px 10px;font-size:12px;margin-top:6px">${s.ownerEmail ? 'Cambiar responsable' : 'Asignar responsable'}</button></div>`;
    const detail = `<details><summary>detalle</summary>${m.rows.map(r => `<div class="sub">${esc(r.group)}: ${esc(r.text)}</div>`).join('')}</details>`;
    return `<tr>
      <td><a href="admin.html?survey=${encodeURIComponent(s.id)}"><strong>${esc(s.title || s.id)}</strong></a><div class="sub">${esc(s.id)} · ${(s.items || []).length} ítems · creada ${fmtDate(s.createdAt)}</div></td>
      <td><span class="tag ${s.published ? '' : 'off'}">${s.published ? 'publicada' : 'borrador'}</span></td>
      <td class="num">${s.count ?? '—'}<div class="sub">${s.last ? 'última ' + fmtDate(s.last) : ''}</div></td>
      <td>${admins}${assign}</td>
      <td>${tags}${warn}${detail}</td></tr>`;
  }).join('');
  $('surveys').querySelectorAll('[data-owner]').forEach(b => b.onclick = async () => {
    const id = b.dataset.owner;
    const email = norm(prompt(`Correo de la persona responsable de "${id}":`, surveys.find(x => x.id === id)?.ownerEmail || ''));
    if (!email) return;
    if (!/^\S+@\S+\.\S+$/.test(email)) { alert('Correo no válido.'); return; }
    try { await updateDoc(doc(db, 'surveys', id), { ownerEmail: email }); loadAll(); } catch (e) { console.error(e); alert('No se pudo asignar.'); }
  });
  $('surveysNote').textContent = `${surveys.length} encuestas · ${total} respuestas en total (incluye las ya retiradas, que quedan como registros vacíos).`;
}

/* ── Account permissions ─────────────────────────────── */
let accessRows = [];
async function loadAccess() {
  const snap = await getDocs(collection(db, 'access'));
  accessRows = snap.docs.map(d => ({ email: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
  const head = '<tr><th>Cuenta</th><th>Paradata</th><th>Crea encuestas (excepción)</th><th>Nota</th><th></th></tr>';
  $('access').innerHTML = head + (accessRows.length ? accessRows.map(r => `<tr data-email="${esc(r.email)}">
    <td>${esc(r.email)}</td>
    <td><label class="switch"><input type="checkbox" data-f="paradata" ${r.paradata ? 'checked' : ''}> sí</label></td>
    <td><label class="switch"><input type="checkbox" data-f="exempt" ${r.exempt ? 'checked' : ''}> sí</label></td>
    <td class="sub">${esc(r.note || '')}</td>
    <td><button class="btn secondary" data-act="rm">Quitar</button></td></tr>`).join('') : '<tr><td colspan="5" class="sub">Ninguna cuenta con permisos especiales: todas ven solo respuestas.</td></tr>');
  $('access').querySelectorAll('input[data-f]').forEach(cb => cb.onchange = async () => {
    const email = cb.closest('tr').dataset.email;
    const row = accessRows.find(r => r.email === email);
    row[cb.dataset.f] = cb.checked;
    await saveAccess(email, row);
  });
  $('access').querySelectorAll('[data-act=rm]').forEach(b => b.onclick = async () => {
    const email = b.closest('tr').dataset.email;
    if (!confirm(`¿Quitar los permisos especiales de ${email}?`)) return;
    await deleteDoc(doc(db, 'access', email)); loadAccess();
  });
}
async function saveAccess(email, r) {
  await setDoc(doc(db, 'access', email), {
    paradata: !!r.paradata, exempt: !!r.exempt, note: r.note || '', updatedBy: me.email, updatedAt: serverTimestamp()
  });
}
$('addAccess').onclick = async () => {
  const email = norm($('newEmail').value);
  if (!/^\S+@\S+\.\S+$/.test(email)) { $('accessMsg').textContent = 'Escribe un correo válido.'; return; }
  try {
    await saveAccess(email, { paradata: $('newParadata').checked, exempt: $('newExempt').checked, note: $('newNote').value.trim() });
    $('accessMsg').textContent = 'Guardado.';
    $('newEmail').value = ''; $('newNote').value = ''; $('newParadata').checked = $('newExempt').checked = false;
    loadAccess();
  } catch (e) { console.error(e); $('accessMsg').textContent = 'No se pudo guardar.'; }
};
$('grantBtn').onclick = async () => {
  const email = norm($('grantEmail').value), sid = $('grantSurvey').value;
  if (!/^\S+@\S+\.\S+$/.test(email) || !sid) { $('grantMsg').textContent = 'Elige encuesta y escribe un correo válido.'; return; }
  try {
    await setDoc(doc(db, 'collab', `${sid}__${email}`), { surveyId: sid, email, role: $('grantRole').value, addedBy: me.email, createdAt: serverTimestamp() });
    $('grantMsg').textContent = `${email} ahora tiene acceso a ${sid}.`; $('grantEmail').value = ''; loadAll();
  } catch (e) { console.error(e); $('grantMsg').textContent = 'No se pudo guardar.'; }
};
