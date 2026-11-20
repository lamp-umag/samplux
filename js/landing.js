// samplux — landing page: ES/EN switch + the embedded "feel" demo. No data leaves the page.
const T = {
  es: {
    title: 'samplux — encuestas que se sienten bien y miden bien',
    nav_surveys: 'Encuestas', nav_try: 'Pruébalo', nav_how: 'Cómo se usa', nav_builder: 'Constructor', nav_login: 'Entrar',
    eyebrow: 'Aplicación de encuestas · LAMP',
    h1: 'Una encuesta que se siente bien en el teléfono y mide bien en el análisis.',
    lead: 'samplux nació en el laboratorio para nuestros propios estudios. Quien responde ve una pregunta por pantalla, sin vueltas. Quien investiga recibe los datos ordenados y listos para analizar.',
    cta_create: 'Crear una encuesta', cta_try: 'Probarla aquí',
    what_k: 'Qué es', what_h: 'Simple para quien responde, completa para quien investiga.',
    c1_h: 'Quien responde', c1_p: 'Una pregunta por pantalla, botones grandes y nada que instalar. Se hizo pensando primero en el celular, que es donde la gente realmente responde.',
    c2_h: 'Quien investiga', c2_p: 'Creas y publicas la encuesta desde el navegador, compartes un enlace y sigues las respuestas en un panel. Descargas todo cuando lo necesites.',
    c3_h: 'Quien aplica en terreno', c3_p: 'Hay un modo para encuestadores, pensado para tablet o computador, que sigue funcionando aunque se corte la conexión.',
    demo_k: 'Pruébalo', demo_h: 'Así se siente responder.',
    n1: 'Un toque por pregunta. Avanza sola, sin botón de siguiente.',
    n2: '¿Cambiaste de opinión? Vuelve con «Atrás» y elige otra opción.',
    n3: 'El orden de las preguntas se sortea para cada persona.',
    seen_h: 'Lo que ve quien investiga', seen_p: 'Nunca quién eres: solo cómo fue responder.',
    demo_full: 'Probar una encuesta completa →',
    how_k: 'Cómo se usa', how_h: 'Tres pasos.',
    s1_h: 'Entra con tu cuenta', s1_p: 'Usa tu cuenta de Google <strong>@umag.cl</strong> en el <a href="builder.html"><u>constructor</u></a>.',
    s2_h: 'Crea y publica', s2_p: 'Arma tu encuesta, pruébala en la vista previa y publícala. Compartes el enlace con quienes van a responder.',
    s3_h: 'Mira los resultados', s3_p: 'En el <a href="admin.html"><u>panel</u></a> ves las respuestas a medida que llegan y las descargas cuando quieras.',
    respond: '¿Vienes a responder una encuesta? Usa el enlace que te enviaron, o revisa las <a href="encuesta.html">encuestas disponibles</a>.',
    acc_k: 'Quién puede usarla', acc_h: 'Abierta a cuentas @umag.cl.',
    acc_p: 'Por ahora crear y editar encuestas está habilitado para cuentas <strong>@umag.cl</strong>. Si eres de otra institución, o piensas hacer una aplicación grande, escríbenos a <a href="mailto:lamp@umag.cl"><u>lamp@umag.cl</u></a>: te damos el visto bueno y revisamos juntos la capacidad del servicio para que todo funcione bien.',
    acc_btn: 'Escribir a LAMP',
    f_credit: 'Creada por el Prof. Herman Elgueta en el Laboratorio Austral de Medición Psicosocial (LAMP), Universidad de Magallanes.',
    f_more_h: 'Más información', f_more_p: 'Detalles, documentación y código en <a href="https://github.com/lamp-umag/samplux">github.com/lamp-umag/samplux</a>.',
    f_contact: 'Contacto',
    // demo content
    mail_subject: 'Quiero usar samplux',
    mail_body: 'Hola, quiero usar samplux.\n\nNombre:\nInstitución / unidad:\nEstudio (de qué se trata):\nPersonas que esperas que respondan:\nFechas aproximadas:\nMi cuenta de Google (@umag.cl u otra):',
    d_topic: 'Bienestar', d_of: 'de', d_back: '← Atrás', d_again: 'Barajar y empezar de nuevo',
    d_done_h: 'Gracias por responder.', d_done_p: 'En una encuesta real, aquí termina tu parte. Esto fue solo una demostración: no se guardó nada.',
    d_scale: ['Nunca', 'A veces', 'Seguido', 'Siempre'],
    d_q: ['Me siento tranquilo/a y en paz.', 'Tengo energía para hacer lo que me importa.', 'Me siento acompañado/a por quienes quiero.'],
    d_time: 'Tiempo', d_backs: 'Volvió atrás', d_changed: 'Cambió de opinión', d_order: 'Orden de las preguntas',
    d_yes: 'sí', d_no: 'no', d_times: n => n === 0 ? 'nunca' : n === 1 ? '1 vez' : `${n} veces`, d_s: 's'
  },
  en: {
    title: 'samplux — surveys that feel good and measure well',
    nav_surveys: 'Surveys', nav_try: 'Try it', nav_how: 'How it works', nav_builder: 'Builder', nav_login: 'Sign in',
    eyebrow: 'Survey application · LAMP',
    h1: 'A survey that feels good on your phone and measures well in the analysis.',
    lead: 'samplux was born in our lab for our own studies. Respondents see one question per screen, nothing in the way. Researchers get tidy data, ready to analyse.',
    cta_create: 'Create a survey', cta_try: 'Try it here',
    what_k: 'What it is', what_h: 'Simple for respondents, complete for researchers.',
    c1_h: 'Respondents', c1_p: 'One question per screen, big buttons and nothing to install. Designed phone-first, because that is where people really answer.',
    c2_h: 'Researchers', c2_p: 'Create and publish a survey in the browser, share a link and follow the responses in a dashboard. Download everything whenever you need it.',
    c3_h: 'Fieldwork', c3_p: 'An interviewer mode, made for tablets and computers, keeps working even when the connection drops.',
    demo_k: 'Try it', demo_h: 'This is what answering feels like.',
    n1: 'One tap per question. It moves on by itself — no “next” button.',
    n2: 'Changed your mind? Go back with “Back” and pick another option.',
    n3: 'The order of the questions is shuffled for every person.',
    seen_h: 'What the researcher sees', seen_p: 'Never who you are: only how answering went.',
    demo_full: 'Try a full survey →',
    how_k: 'How it works', how_h: 'Three steps.',
    s1_h: 'Sign in', s1_p: 'Use your <strong>@umag.cl</strong> Google account in the <a href="builder.html"><u>builder</u></a>.',
    s2_h: 'Create and publish', s2_p: 'Build your survey, test it in the preview and publish it. Share the link with the people who will answer.',
    s3_h: 'Follow the results', s3_p: 'In the <a href="admin.html"><u>dashboard</u></a> you see responses as they arrive and download them whenever you like.',
    respond: 'Here to answer a survey? Use the link you were sent, or browse the <a href="encuesta.html">available surveys</a>.',
    acc_k: 'Who can use it', acc_h: 'Open to @umag.cl accounts.',
    acc_p: 'For now, creating and editing surveys is enabled for <strong>@umag.cl</strong> accounts. If you are from another institution, or plan a large application, write to <a href="mailto:lamp@umag.cl"><u>lamp@umag.cl</u></a>: we give you the go-ahead and check together that the service has the capacity, so everything runs smoothly.',
    acc_btn: 'Write to LAMP',
    f_credit: 'Created by Prof. Herman Elgueta at the Laboratorio Austral de Medición Psicosocial (LAMP), Universidad de Magallanes.',
    f_more_h: 'More information', f_more_p: 'Details, documentation and code at <a href="https://github.com/lamp-umag/samplux">github.com/lamp-umag/samplux</a>.',
    f_contact: 'Contact',
    mail_subject: 'I would like to use samplux',
    mail_body: 'Hello, I would like to use samplux.\n\nName:\nInstitution / unit:\nStudy (what it is about):\nExpected number of respondents:\nApproximate dates:\nMy Google account (@umag.cl or other):',
    d_topic: 'Wellbeing', d_of: 'of', d_back: '← Back', d_again: 'Shuffle and start again',
    d_done_h: 'Thanks for answering.', d_done_p: 'In a real survey, your part ends here. This was only a demo: nothing was saved.',
    d_scale: ['Never', 'Sometimes', 'Often', 'Always'],
    d_q: ['I feel calm and at peace.', 'I have energy for what matters to me.', 'I feel supported by the people I care about.'],
    d_time: 'Time', d_backs: 'Went back', d_changed: 'Changed their mind', d_order: 'Order of the questions',
    d_yes: 'yes', d_no: 'no', d_times: n => n === 0 ? 'never' : n === 1 ? 'once' : `${n} times`, d_s: 's'
  }
};

let lang = 'es';
const $ = s => document.querySelector(s);
const t = k => T[lang][k];

function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(n => { n.innerHTML = t(n.dataset.i18nHtml); });
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  $('#mailBtn').href = `mailto:lamp@umag.cl?subject=${encodeURIComponent(t('mail_subject'))}&body=${encodeURIComponent(t('mail_body'))}`;
  renderDemo();
}
function setLang(l) {
  lang = l === 'en' ? 'en' : 'es';
  try { localStorage.setItem('samplux.lang', lang); } catch { /* private mode */ }
  applyLang();
}

/* ── Demo: three questions, one tap each, in random order ─────────────────── */
const demo = { order: [], i: 0, answers: {}, t0: 0, backs: 0, changed: 0, done: false, notes: new Set() };
function shuffle(a) { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; }
function resetDemo() {
  Object.assign(demo, { order: shuffle([0, 1, 2]), i: 0, answers: {}, t0: Date.now(), backs: 0, changed: 0, done: false, notes: new Set([3]) });
  renderDemo();
}
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function renderDemo() {
  const body = $('#dBody');
  if (!body) return;
  body.replaceChildren();
  body.style.animation = 'none'; void body.offsetWidth; body.style.animation = '';
  $('#dFill').style.width = `${(demo.done ? 3 : demo.i) / 3 * 100}%`;
  if (demo.done) {
    const d = el('div', 'done');
    d.append(el('h3', '', t('d_done_h')), el('p', '', t('d_done_p')));
    const again = el('button', 'pill solid', t('d_again')); again.style.marginTop = '22px'; again.onclick = resetDemo;
    d.append(again); body.append(d);
  } else {
    const q = demo.order[demo.i];
    body.append(el('div', 'meta', `${t('d_topic')} · ${demo.i + 1} ${t('d_of')} 3`), el('p', 'q', t('d_q')[q]));
    const opts = el('div', 'opts');
    t('d_scale').forEach((label, v) => {
      const b = el('button', 'opt' + (demo.answers[q] === v ? ' sel' : ''), label);
      b.onclick = () => {
        if (demo.answers[q] != null && demo.answers[q] !== v) demo.changed += 1;
        demo.answers[q] = v;
        demo.notes.add(1);
        b.classList.add('sel');
        setTimeout(() => { demo.i += 1; if (demo.i >= 3) demo.done = true; renderDemo(); }, 220);
      };
      opts.append(b);
    });
    const nav = el('div', 'nav');
    const back = el('button', '', t('d_back')); back.disabled = demo.i === 0;
    back.onclick = () => { demo.backs += 1; demo.notes.add(2); demo.i -= 1; renderDemo(); };
    nav.append(back);
    body.append(opts, nav);
    if (demo.i === 0) demo.notes.add(3);
  }
  renderNotes();
}

function renderNotes() {
  document.querySelectorAll('.note-card[data-note]').forEach(c => c.classList.toggle('on', demo.notes.has(Number(c.dataset.note))));
  $('#dSeen').classList.toggle('on', demo.done);
  const list = $('#dSeenList');
  const secs = Math.max(1, Math.round((Date.now() - demo.t0) / 1000));
  const letters = demo.order.map(i => String.fromCharCode(65 + i)).join(' → ');
  const rows = demo.done ? [
    [t('d_time'), `${secs} ${t('d_s')}`],
    [t('d_backs'), t('d_times')(demo.backs)],
    [t('d_changed'), demo.changed ? t('d_yes') : t('d_no')],
    [t('d_order'), letters]
  ] : [[t('d_order'), letters]];
  list.replaceChildren(...rows.map(([k, v]) => { const li = document.createElement('li'); li.innerHTML = `${k}: <b></b>`; li.querySelector('b').textContent = v; return li; }));
}

document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
const q = new URLSearchParams(location.search).get('lang');
let saved = null; try { saved = localStorage.getItem('samplux.lang'); } catch { /* ignore */ }
lang = q === 'en' || q === 'es' ? q : (saved === 'en' ? 'en' : 'es');
resetDemo();
applyLang();
