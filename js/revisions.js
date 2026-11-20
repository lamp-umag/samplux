// ─────────────────────────────────────────────────────────────
// samplux — survey revisions (what editing a live survey does to its data)
// ─────────────────────────────────────────────────────────────
// Answers are stored under the item id, so editing a survey never touches collected data:
//   - edit wording (prompt, help…)   → the data stays valid; exports show the CURRENT wording.
//   - delete an item                 → old answers stay in the responses; the item is kept in
//                                       `retiredItems`, so exports keep its column (empty for newer people).
//   - add an item                    → older responses simply have no value for it (empty cell).
//   - reorder                        → each response stores the order it actually saw
//                                       (`presentationOrder`); the new order applies to new respondents.
//   - change an id / option codes / type → breaks the link with earlier data: confirmed before saving.
// Every save that changes content bumps `revision`; each response records `surveyRevision`,
// and `changeLog` says what changed in each revision. Pure functions: tested under node.
// ─────────────────────────────────────────────────────────────

const IGNORED = new Set(['_open']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codesOf = it => (Array.isArray(it.options) ? it.options.map(o => (o && typeof o === 'object' ? (o.code ?? o.value ?? o.label) : o)) : null);

export function diffItems(prevItems = [], nextItems = []) {
  const prev = new Map(prevItems.map(it => [it.id, it]));
  const next = new Map(nextItems.map(it => [it.id, it]));
  const added = nextItems.filter(it => !prev.has(it.id)).map(it => it.id);
  const removed = prevItems.filter(it => !next.has(it.id));
  const edited = [];
  const risky = [];
  for (const it of nextItems) {
    const old = prev.get(it.id);
    if (!old) continue;
    const fields = [...new Set([...Object.keys(old), ...Object.keys(it)])].filter(k => !IGNORED.has(k) && !same(old[k], it[k]));
    if (!fields.length) continue;
    const entry = { id: it.id, fields };
    if (fields.includes('prompt')) { entry.promptFrom = String(old.prompt ?? '').slice(0, 300); entry.promptTo = String(it.prompt ?? '').slice(0, 300); }
    edited.push(entry);
    if (fields.includes('type')) risky.push({ id: it.id, why: 'cambió el tipo de pregunta' });
    if (!same(codesOf(old), codesOf(it)) && codesOf(old) && codesOf(it)) risky.push({ id: it.id, why: 'cambiaron las opciones o sus códigos' });
  }
  const common = prevItems.filter(it => next.has(it.id)).map(it => it.id);
  const commonNext = nextItems.filter(it => prev.has(it.id)).map(it => it.id);
  const moved = !same(common, commonNext);
  return { added, removed, edited, risky, moved, changed: !!(added.length || removed.length || edited.length || moved) };
}

/** Human summary for the confirmation dialog. Empty string when there is nothing to warn about. */
export function describeRisks(diff) {
  const lines = [];
  if (diff.removed.length) lines.push(`• Eliminaste ${diff.removed.length} pregunta(s): ${diff.removed.map(i => i.id).join(', ')}. Sus respuestas anteriores se conservan y se siguen exportando; las personas nuevas quedarán con celdas vacías.`);
  if (diff.risky.length) lines.push(...diff.risky.map(r => `• "${r.id}": ${r.why}. Las respuestas ya recogidas podrían dejar de interpretarse bien.`));
  if (diff.added.length && diff.removed.length) lines.push('• Si solo cambiaste un ID (renombrar), se separan los datos antiguos de los nuevos: lo normal es NO cambiar IDs.');
  return lines.join('\n');
}

export function logEntry(rev, diff, by) {
  return {
    rev, at: new Date().toISOString(), by: by || null,
    added: diff.added, removed: diff.removed.map(i => i.id),
    edited: diff.edited.slice(0, 40), moved: diff.moved
  };
}

/** retiredItems after a save: previous ones + newly removed, minus any that came back. */
export function mergeRetired(retired = [], diff, nextItems, rev) {
  const present = new Set(nextItems.map(i => i.id));
  const byId = new Map(retired.filter(r => !present.has(r.id)).map(r => [r.id, r]));
  for (const it of diff.removed) byId.set(it.id, { ...JSON.parse(JSON.stringify(it)), retiredInRev: rev });
  return [...byId.values()];
}

/** Items of the current definition + retired ones that still have data (flagged `_retired`). */
export function withRetiredItems(def, responses) {
  const retired = Array.isArray(def && def.retiredItems) ? def.retiredItems : [];
  if (!retired.length) return def;
  const have = new Set();
  for (const r of responses || []) for (const k of Object.keys((r.data && r.data.answers) || {})) have.add(k);
  const extra = retired.filter(it => have.has(it.id) && !(def.items || []).some(x => x.id === it.id))
    .map(it => ({ ...it, _retired: true, required: false, prompt: `(eliminada en v${it.retiredInRev ?? '?'}) ${it.prompt ?? ''}`.trim() }));
  return extra.length ? { ...def, items: [...(def.items || []), ...extra] } : def;
}

export function changeLogText(def) {
  const log = Array.isArray(def && def.changeLog) ? def.changeLog : [];
  if (!log.length) return [];
  const L = ['HISTORIAL DE CAMBIOS DE LA ENCUESTA (columna survey_revision de cada respuesta)', '-'.repeat(60)];
  for (const e of log) {
    const parts = [];
    if (e.added?.length) parts.push(`agregó ${e.added.join(', ')}`);
    if (e.removed?.length) parts.push(`eliminó ${e.removed.join(', ')}`);
    for (const ed of e.edited || []) parts.push(`editó ${ed.id} (${ed.fields.join(', ')})${ed.promptFrom != null ? ` «${ed.promptFrom}» → «${ed.promptTo}»` : ''}`);
    if (e.moved) parts.push('cambió el orden');
    L.push(`v${e.rev} · ${String(e.at || '').slice(0, 10)} · ${e.by || ''}: ${parts.join('; ') || 'sin cambios de contenido'}`);
  }
  L.push('');
  return L;
}
