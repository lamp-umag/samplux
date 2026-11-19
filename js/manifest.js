// ─────────────────────────────────────────────────────────────
// samplux — "what does this survey collect?" (pure; used by the builder and super.html)
// ─────────────────────────────────────────────────────────────
// Derived from the survey definition, so the description can never drift from what the
// runner really does. It is the seed of the per-study transparency sheet (docs/DATA-POLICY.md).

const PERSONAL_TYPES = { email: 'correo electrónico', phone: 'teléfono', url: 'enlaces / redes sociales', file: 'nombres de archivos' };

export function collectionManifest(survey) {
  const items = (survey && survey.items) || [];
  const st = (survey && survey.settings) || {};
  const answerable = items.filter(it => it && it.type !== 'info' && !/^task_/.test(it.type || ''));
  const tasks = items.filter(it => it && /^task_/.test(it.type || ''));
  const audio = items.filter(it => it && it.type === 'text' && (it.response === 'audio' || it.response === 'either'));
  const personal = [...new Set(items.filter(it => it && PERSONAL_TYPES[it.type]).map(it => PERSONAL_TYPES[it.type]))];
  const consent = st.consent && st.consent.enabled ? st.consent : null;
  const pcfg = st.paradata || {};
  const collect = st.collect || {};
  const geo = collect.geolocation === 'precise' || collect.geolocation === 'coarse' ? collect.geolocation : 'off';

  const rows = [];
  rows.push({ group: 'Respuestas', text: `${answerable.length} preguntas${personal.length ? `, entre ellas datos que pueden identificar: ${personal.join(', ')}` : ''}.` });
  if (audio.length) rows.push({ group: 'Respuestas', text: `Grabaciones de voz en ${audio.length} pregunta(s) (dato personal; la voz identifica).`, flag: 'personal' });
  if (tasks.length) rows.push({ group: 'Respuestas', text: `${tasks.length} tarea(s) cognitiva(s): tiempos de reacción y aciertos.` });
  rows.push({ group: 'Paradata', text: 'Tiempo total y por pregunta, retrocesos y cambios de respuesta, cambios de pestaña.' });
  if (collect.deviceInfo !== false) rows.push({ group: 'Paradata', text: 'Dispositivo y navegador: modelo/sistema, pantalla, idioma, zona horaria, conexión, enlace de origen.' });
  if (pcfg.events !== false) rows.push({ group: 'Paradata', text: `Registro de interacción: ${pcfg.misses === false ? '' : 'toques fuera de los botones (posición), '}entrada a cada pregunta, rotación/cambio de tamaño. No registra lo que se escribe.` });
  if (geo !== 'off') rows.push({ group: 'Opcional', text: `Ubicación ${geo === 'precise' ? 'precisa (GPS)' : 'aproximada (~1 km)'}, solo si la persona lo permite en su navegador.`, flag: 'sensitive' });
  rows.push({ group: 'Consentimiento', text: consent ? `Registro de consentimiento y código de retiro (${consent.level}).` : 'Sin registro de consentimiento ni código de retiro.' });

  const warnings = [];
  if (!consent && (personal.length || audio.length)) warnings.push('Recoge datos personales sin registro de consentimiento: activa "Consentimiento y retiro".');
  if (geo !== 'off' && !consent) warnings.push('La ubicación requiere consentimiento registrado: activa "Consentimiento y retiro".');
  if (geo === 'precise' && consent && consent.level !== 'sensitive') warnings.push('La ubicación precisa es un dato sensible: usa el nivel "Datos sensibles".');
  if (consent && !consent.itemId) warnings.push('Falta indicar el ítem de consentimiento: sin él no se guarda el texto que aceptó la persona.');
  return { rows, warnings, level: consent ? consent.level : null };
}
