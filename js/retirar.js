// samplux — retirar.html: withdraw consent with the code from the receipt, or ask for help without it.
import { db } from './firebaseClient.js';
import {
  collection, addDoc, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { normalizeSecret, formatSecret, listReceipts, forgetReceipt, cryptoAvailable, CONSENT_LEVELS } from './consent.js';
import { findConsent, withdrawWithCode } from './consentStore.js';

const view = document.getElementById('view');

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
const show = (...nodes) => { view.replaceChildren(...nodes); window.scrollTo(0, 0); };
const fmtDate = v => {
  const d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
  return d && !isNaN(d) ? d.toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' }) : '—';
};

function codeFromHash() {
  const m = /(?:^|[#&])c=([^&]+)/.exec(location.hash);
  return m ? normalizeSecret(decodeURIComponent(m[1])) : null;
}

/* ── Home ─────────────────────────────────────────────── */
function home(message) {
  const input = h('input', { type: 'text', class: 'w-code', placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '24', 'aria-label': 'Código de retiro' });
  const msg = h('p', { class: 'w-msg' }, message || '');
  const go = () => {
    const secret = normalizeSecret(input.value);
    if (!secret) { msg.textContent = 'Ese código no tiene el formato correcto: son 16 letras y números.'; return; }
    lookup(secret);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

  const nodes = [
    h('h1', { class: 'w-title' }, 'Retirar mi consentimiento'),
    h('p', { class: 'w-lead' }, 'Puedes retirar tu consentimiento cuando quieras y sin dar explicaciones. Al hacerlo, tus respuestas se eliminan de inmediato.')
  ];

  const receipts = listReceipts();
  if (receipts.length) {
    nodes.push(h('div', { class: 'w-card' },
      h('h2', {}, 'Participaciones desde este dispositivo'),
      receipts.slice().reverse().map(r => h('div', { class: 'w-row' },
        h('div', {}, h('div', { style: 'font-weight:600;font-size:14px' }, r.surveyTitle || r.surveyId), h('div', { class: 'tiny' }, fmtDate(r.at))),
        h('button', { class: 'btn secondary', onclick: () => lookup(r.secret) }, 'Ver')
      ))
    ));
  }

  nodes.push(h('div', { class: 'w-card' },
    h('h2', {}, 'Tengo mi código'),
    h('p', {}, 'Es el código de 16 caracteres del comprobante que recibiste al terminar la encuesta.'),
    input, msg,
    h('div', { class: 'controls', style: 'margin:0;padding:0' }, h('button', { class: 'btn primary', onclick: go }, 'Continuar'))
  ));
  nodes.push(h('div', { class: 'w-card' },
    h('h2', {}, 'No tengo mi código'),
    h('p', {}, 'Podemos buscar tus respuestas si dejaste un correo en la encuesta. Te escribiremos a ese correo para confirmar que eres tú.'),
    h('div', { class: 'controls', style: 'margin:0;padding:0' }, h('button', { class: 'btn secondary', onclick: requestForm }, 'Pedir el retiro'))
  ));
  show(...nodes);
}

/* ── Code → consent record ─────────────────────────────── */
async function lookup(secret) {
  show(h('p', { class: 'w-lead' }, 'Buscando…'));
  if (!cryptoAvailable()) return home('Este navegador no permite verificar el código. Abre esta página con https o desde otro navegador.');
  let found;
  try {
    found = await findConsent(db, secret);
  } catch (e) {
    console.error(e);
    return home('No pudimos conectarnos. Revisa tu conexión e inténtalo otra vez.');
  }
  if (!found) return home(`No encontramos ninguna participación con el código ${formatSecret(secret)}. Revisa que esté bien escrito.`);
  record(secret, found);
}

function record(secret, found) {
  const d = found.data;
  const withdrawn = d.status === 'withdrawn';
  const msg = h('p', { class: 'w-msg' });
  const btn = h('button', { class: 'btn primary' }, 'Retirar mi consentimiento y borrar mis respuestas');
  btn.onclick = async () => {
    btn.disabled = true; msg.textContent = '';
    try {
      const result = await withdrawWithCode(db, found);
      forgetReceipt(secret);
      done(d, result);
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      msg.textContent = 'No se pudo completar. Revisa tu conexión y vuelve a tocar el botón: no pasa nada si lo repites.';
    }
  };

  const nodes = [
    h('h1', { class: 'w-title' }, withdrawn ? 'Este consentimiento ya fue retirado' : 'Tu participación'),
    h('dl', { class: 'w-facts' },
      h('dt', {}, 'Encuesta'), h('dd', {}, d.surveyTitle || d.surveyId),
      h('dt', {}, 'Consentimiento'), h('dd', {}, fmtDate(d.grantedAt || d.clientGrantedAt)),
      h('dt', {}, 'Tipo de datos'), h('dd', {}, CONSENT_LEVELS[d.level] || '—'),
      withdrawn ? [h('dt', {}, 'Retirado'), h('dd', {}, fmtDate(d.withdrawnAt))] : null
    )
  ];
  if (d.text) nodes.push(h('details', { class: 'w-text' }, h('summary', {}, 'Lo que aceptaste'), h('pre', {}, d.text)));

  if (withdrawn) {
    nodes.push(h('p', { class: 'w-lead' }, 'Tus respuestas ya no están en nuestros registros.'));
    // Finishes an erasure that an earlier visit may have left half-done.
    withdrawWithCode(db, found).catch(() => {});
  } else {
    nodes.push(
      h('p', { class: 'w-lead' }, 'Si retiras tu consentimiento borraremos tus respuestas, las grabaciones de voz y los datos técnicos de tu dispositivo. No se puede deshacer. Los resultados agregados que ya se hayan calculado o publicado no cambian.'),
      msg,
      h('div', { class: 'controls', style: 'flex-direction:column' }, btn, h('button', { class: 'btn secondary', onclick: () => home() }, 'Volver sin retirar'))
    );
  }
  if (d.contact) nodes.push(h('p', { class: 'tiny', style: 'margin-top:20px' }, `Contacto: ${d.contact}`));
  show(...nodes);
}

function done(d, result) {
  history.replaceState(null, '', location.pathname);   // the code is spent: drop it from the address bar
  show(
    h('h1', { class: 'w-title' }, 'Consentimiento retirado'),
    h('p', { class: 'w-lead' }, result === 'absent'
      ? `Retiraste tu consentimiento para «${d.surveyTitle || d.surveyId}». No había respuestas guardadas a tu nombre.`
      : `Retiraste tu consentimiento para «${d.surveyTitle || d.surveyId}» y tus respuestas fueron eliminadas.`),
    h('p', { class: 'tiny' }, 'Solo conservamos un registro mínimo —sin respuestas— de que el consentimiento existió y fue retirado, y cuándo.'),
    h('div', { class: 'controls' }, h('a', { class: 'btn secondary', href: '.', style: 'text-align:center;text-decoration:none' }, 'Volver al inicio'))
  );
}

/* ── No code: manual request ───────────────────────────── */
async function requestForm() {
  const survey = h('select', { 'aria-label': 'Encuesta' }, h('option', { value: '' }, 'No la recuerdo / no aparece'));
  const email = h('input', { type: 'email', placeholder: 'correo@ejemplo.com', maxlength: '200', autocomplete: 'email' });
  const when = h('input', { type: 'text', placeholder: 'Por ejemplo: el martes pasado en la tarde', maxlength: '200' });
  const details = h('textarea', { placeholder: 'Nombre o tema de la encuesta (si no aparece arriba) y cualquier dato que nos ayude a ubicar tus respuestas', maxlength: '2000' });
  const msg = h('p', { class: 'w-msg' });
  const send = h('button', { class: 'btn primary' }, 'Enviar solicitud');
  send.onclick = async () => {
    const mail = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(mail)) { msg.textContent = 'Escribe un correo válido para poder responderte.'; return; }
    send.disabled = true; msg.textContent = '';
    try {
      await addDoc(collection(db, 'withdrawal_requests'), {
        surveyId: survey.value,
        surveyTitle: survey.value ? survey.selectedOptions[0].textContent : '',
        email: mail, when: when.value.trim(), details: details.value.trim(),
        status: 'pending', createdAt: serverTimestamp()
      });
      show(
        h('h1', { class: 'w-title' }, 'Solicitud recibida'),
        h('p', { class: 'w-lead' }, `Te escribiremos a ${mail}. Si ese correo está en alguna respuesta, te pediremos confirmar desde ahí y luego la borraremos. Si no podemos reconocer tus respuestas, también te lo diremos.`),
        h('div', { class: 'controls' }, h('a', { class: 'btn secondary', href: '.', style: 'text-align:center;text-decoration:none' }, 'Volver al inicio'))
      );
    } catch (e) {
      console.error(e);
      send.disabled = false;
      msg.textContent = 'No se pudo enviar. Revisa tu conexión e inténtalo otra vez.';
    }
  };
  show(
    h('h1', { class: 'w-title' }, 'Pedir el retiro sin código'),
    h('p', { class: 'w-lead' }, 'No registramos nombres, así que sin el código solo podemos reconocer tus respuestas por el correo que hayas dejado en la encuesta.'),
    h('div', { class: 'w-card' },
      h('label', {}, 'Encuesta'), survey,
      h('label', {}, 'Correo que escribiste en la encuesta'), email,
      h('label', {}, '¿Cuándo respondiste?'), when,
      h('label', {}, 'Detalles'), details,
      msg,
      h('div', { class: 'controls', style: 'margin:0;padding:0' }, h('button', { class: 'btn secondary', onclick: () => home() }, '← Atrás'), send)
    )
  );
  try {
    const options = new Map(listReceipts().map(r => [r.surveyId, r.surveyTitle || r.surveyId]));
    const snap = await getDocs(query(collection(db, 'surveys'), where('published', '==', true), where('listed', '==', true)));
    snap.docs.forEach(s => options.set(s.id, s.data().title || s.id));
    options.forEach((title, id) => { if (id) survey.append(h('option', { value: id }, title)); });
  } catch (e) { console.warn('No se pudo cargar la lista de encuestas', e); }
}

const initial = codeFromHash();
if (initial) lookup(initial); else home();
window.addEventListener('hashchange', () => { const c = codeFromHash(); if (c) lookup(c); });
