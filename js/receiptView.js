// samplux — the withdrawal receipt shown after submitting (and in interviewer mode).
import qrcode from './vendor/qrcode.js';
import { formatSecret, withdrawUrl, receiptText, CONSENT_LEVELS } from './consent.js';

export function qrSvg(text, cellSize = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} container
 * @param {{secret:string, surveyTitle:string, contact?:string, level?:string, shared?:boolean}} r
 *   shared: the device belongs to an interviewer — the respondent takes the code away
 *   (photo / scan), so "copy" and "download" make no sense and are left out.
 */
export function renderReceipt(container, r) {
  const url = withdrawUrl(r.secret);
  const box = el('div', 'receipt fade-in');

  box.append(el('div', 'receipt-kicker', 'Tu comprobante'));
  box.append(el('p', 'receipt-lead', r.shared
    ? 'Escanea el código con tu teléfono o tómale una foto. Con él puedes retirar tu consentimiento cuando quieras: tus respuestas se borran de inmediato.'
    : 'Guarda este código. Con él puedes retirar tu consentimiento cuando quieras, sin dar explicaciones: tus respuestas se borran de inmediato.'));

  const row = el('div', 'receipt-row');
  const qr = el('div', 'receipt-qr');
  qr.innerHTML = qrSvg(url);
  qr.setAttribute('role', 'img');
  qr.setAttribute('aria-label', 'Código QR con el enlace de retiro');
  const side = el('div', 'receipt-side');
  side.append(el('div', 'receipt-label', 'Código de retiro'));
  side.append(el('div', 'receipt-code', formatSecret(r.secret)));
  if (r.level && CONSENT_LEVELS[r.level]) side.append(el('div', 'tiny', CONSENT_LEVELS[r.level]));
  row.append(qr, side);
  box.append(row);

  if (!r.shared) {
    const actions = el('div', 'receipt-actions');
    const copy = el('button', 'btn secondary', 'Copiar enlace');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = 'Copiado ✓'; }
      catch { prompt('Copia este enlace:', url); }
    };
    const text = receiptText({ secret: r.secret, surveyTitle: r.surveyTitle, url, contact: r.contact });
    const save = el('a', 'btn secondary', 'Descargar');
    save.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    save.download = 'comprobante-samplux.txt';
    const mail = el('a', 'btn secondary', 'Enviármelo');
    mail.href = `mailto:?subject=${encodeURIComponent('Mi comprobante de participación')}&body=${encodeURIComponent(text)}`;
    actions.append(copy, save, mail);
    box.append(actions);
    const now = el('a', 'receipt-link', 'Retirar mi consentimiento ahora');
    now.href = url;
    box.append(now);
  }
  box.append(el('p', 'tiny', 'No registramos tu nombre: este código es la única forma de reconocer tus respuestas. Si lo pierdes, en la página de retiro hay otra vía.'));
  container.append(box);
  return box;
}
