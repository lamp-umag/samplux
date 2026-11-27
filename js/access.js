// ─────────────────────────────────────────────────────────────
// samplux — who may do what (client side; the real gate is firestore.rules, docs/ACCESS.md)
// ─────────────────────────────────────────────────────────────
import { doc, getDoc, getDocs, collection, query, where } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

// KEEP IN SYNC with isAdmin() in firestore.rules.
export const SUPER_ADMINS = new Set(['hermanelgueta@gmail.com', 'herman.elgueta@umag.cl']);
export const STAFF_DOMAIN = 'umag.cl';
export const UMAG_RE = /^[a-z0-9._%+-]+@umag\.cl$/;

export const POLICY_NOTICE =
  'Por ahora solo las cuentas de Google @umag.cl pueden crear y editar encuestas. ' +
  'Si necesitas una excepción para una persona o una encuesta, pídela a la administración (herman.elgueta@umag.cl).';

export const PARADATA_NOTICE =
  'Tu cuenta ve las respuestas, pero no los datos técnicos ni de comportamiento (tiempos, dispositivo, eventos de uso, ubicación). ' +
  'Si tu investigación los necesita, solicita el permiso a la administración.';

export const norm = email => String(email || '').trim().toLowerCase();
export const isUmag = email => UMAG_RE.test(norm(email));

/**
 * What the signed-in user is. `role`: 'super' | 'staff' | 'none'.
 * staff = @umag.cl, or an address a super admin exempted (access/<email>.exempt).
 * paradata = may read paradata/metadata (always for super admins).
 */
export async function resolveAccess(db, user) {
  const email = norm(user && user.email);
  const out = { email, role: 'none', paradata: false, exempt: false, umag: isUmag(email) };
  if (!user || !user.emailVerified || !email) return out;
  if (SUPER_ADMINS.has(email)) return { ...out, role: 'super', paradata: true };
  let rec = null;
  try {
    const snap = await getDoc(doc(db, 'access', email));
    rec = snap.exists() ? snap.data() : null;
  } catch (e) { console.warn('[access] no se pudo leer el registro de acceso', e); }
  out.exempt = !!(rec && rec.exempt === true);
  out.paradata = !!(rec && rec.paradata === true);
  if (out.umag || out.exempt) out.role = 'staff';
  return out;
}

/**
 * Surveys a non-super account can open: the ones it owns, the ones it was added to (collab/),
 * and — legacy — surveys that list it in adminEmails. Sorted by title.
 */
export async function fetchMySurveys(db, email) {
  email = norm(email);
  const byId = new Map();
  const add = d => byId.set(d.id, { id: d.id, ...d.data() });
  (await getDocs(query(collection(db, 'surveys'), where('ownerEmail', '==', email)))).forEach(add);
  const collabs = await getDocs(query(collection(db, 'collab'), where('email', '==', email)));
  for (const c of collabs.docs) {
    const sid = c.data().surveyId;
    if (byId.has(sid)) continue;
    try { const s = await getDoc(doc(db, 'surveys', sid)); if (s.exists()) add(s); } catch (_) { /* survey gone */ }
  }
  (await getDocs(query(collection(db, 'surveys'), where('adminEmails', 'array-contains', email)))).forEach(add);
  return [...byId.values()].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
}
