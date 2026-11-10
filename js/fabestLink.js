// fabestLink.js — one-time pairing of the fabest desktop app with this admin page.
//
// `fabest samplux connect` opens admin.html?fabest=<port>&code=<code>. After the normal Google
// login this module asks for confirmation ("Conectar fabest en este computador") and, on yes,
// POSTs { code, refreshToken, apiKey, projectId, email, siteUrl } to
// http://127.0.0.1:<port>/pair — a listener fabest runs on this same computer for a few minutes.
// fabest then reads Firestore over REST as this user, under the same security rules.
//
// Without the two URL parameters this module does nothing. It never writes to Firestore.

import { app } from './firebaseClient.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';

const params = new URL(location.href).searchParams;
const port = params.get('fabest');
const code = params.get('code');

// Only a plausible local port and a hex code: anything else is ignored.
const valid = /^\d{4,5}$/.test(port || '') && Number(port) >= 1024 && Number(port) <= 65535 && /^[0-9a-f]{16,64}$/.test(code || '');

function dropParams() {
  const url = new URL(location.href);
  url.searchParams.delete('fabest');
  url.searchParams.delete('code');
  history.replaceState({}, '', url);
}

function card() {
  const box = document.createElement('div');
  box.id = 'fabestLink';
  box.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;max-width:520px;width:calc(100% - 32px);' +
    'background:#fff;color:#000;border:2px solid #000;border-radius:12px;padding:16px 18px;font:15px/1.45 Inter,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.18)';
  document.body.appendChild(box);
  return box;
}

function ask(user) {
  const box = card();
  box.innerHTML = `
    <div style="font-weight:700;font-size:17px;margin-bottom:6px">Conectar fabest en este computador</div>
    <div>fabest (el programa de análisis) podrá leer, como <b></b>, las encuestas y respuestas que tú ves en este panel.
    No podrá modificar nada. Confirma solo si acabas de ejecutar <code>fabest samplux connect</code> en este mismo computador.</div>
    <div class="fl-msg small" style="margin-top:8px;color:#444"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-outline btn-sm fl-no">Cancelar</button>
      <button class="btn btn-primary btn-sm fl-yes">Conectar</button>
    </div>`;
  box.querySelector('b').textContent = user.email || '(sin correo)';
  const msg = box.querySelector('.fl-msg');
  box.querySelector('.fl-no').addEventListener('click', () => { dropParams(); box.remove(); });
  box.querySelector('.fl-yes').addEventListener('click', async () => {
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    msg.textContent = 'Conectando…';
    let payload = null;
    try {
      const body = {
        code,
        refreshToken: user.refreshToken,
        apiKey: app.options.apiKey,
        projectId: app.options.projectId,
        email: user.email || '',
        siteUrl: new URL('.', location.href).href
      };
      const send = (extra) => fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...extra
      });
      // A public page talking to a program on this same computer. Browsers differ in what they
      // want here, so: the plain request first, then with Chrome's explicit "this is loopback" hint.
      let res;
      try { res = await send({}); }
      catch (first) {
        try { res = await send({ targetAddressSpace: 'loopback' }); }
        catch { payload = JSON.stringify(body); throw first; }
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      dropParams();
      msg.innerHTML = '<b>Listo:</b> fabest quedó conectado. Puedes cerrar este aviso y volver a la terminal.';
      const close = box.querySelector('.fl-yes');
      close.textContent = 'Cerrar'; close.disabled = false;
      close.replaceWith(close.cloneNode(true));
      box.querySelector('.fl-yes').addEventListener('click', () => box.remove());
      box.querySelector('.fl-no').remove();
    } catch (e) {
      box.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (!payload) {
        msg.textContent = 'No se pudo conectar con fabest (' + (e?.message || e) + '). ¿Sigue esperando la conexión en fabest?';
        return;
      }
      // The browser did not let this page's script reach fabest (some block it, some ask for a
      // "local network" permission). Plan B always works: send the same data as an ordinary form
      // to fabest's local address, in a new tab. Nothing leaves this computer.
      msg.textContent = 'El navegador no dejó que esta página hablara directamente con fabest. Pulsa «Conectar en una pestaña nueva»: se abrirá una pestaña local que confirma la conexión.';
      const yes = box.querySelector('.fl-yes');
      const alt = yes.cloneNode(true);
      alt.textContent = 'Conectar en una pestaña nueva';
      yes.replaceWith(alt);
      alt.addEventListener('click', () => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `http://127.0.0.1:${port}/pair`;
        form.target = '_blank';
        form.rel = 'noopener';
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = 'payload'; input.value = payload;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
        dropParams();
        msg.innerHTML = 'Se abrió una pestaña nueva. Si dice <b>«Listo»</b>, fabest quedó conectado y puedes cerrar este aviso.';
      });
    }
  });
}

if (valid) {
  let asked = false;
  onAuthStateChanged(getAuth(app), (user) => {
    if (user && !asked) { asked = true; ask(user); }
  });
}
