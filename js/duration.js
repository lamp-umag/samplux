// Item type `duration`: years, months and days on one card. The answer is a single ISO 8601
// string (P2Y3M10D), one export column; in R, lubridate::period() reads it. Pure: tested under node.
export const DURATION_PARTS = [
  { key: 'Y', label: 'Años', one: 'año', many: 'años' },
  { key: 'M', label: 'Meses', one: 'mes', many: 'meses' },
  { key: 'D', label: 'Días', one: 'día', many: 'días' }
];

export function parseDuration(value) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(String(value ?? ''));
  return { Y: m?.[1] != null ? Number(m[1]) : null, M: m?.[2] != null ? Number(m[2]) : null, D: m?.[3] != null ? Number(m[3]) : null };
}

/** '' when every part is empty. A typed 0 is kept: it is an answer. */
export function formatDuration(values) {
  const body = DURATION_PARTS.filter(p => Number.isFinite(values?.[p.key])).map(p => `${values[p.key]}${p.key}`).join('');
  return body ? `P${body}` : '';
}

export function describeDuration(value) {
  const v = parseDuration(value);
  return DURATION_PARTS.filter(p => v[p.key] != null).map(p => `${v[p.key]} ${v[p.key] === 1 ? p.one : p.many}`).join(', ') || String(value ?? '');
}
