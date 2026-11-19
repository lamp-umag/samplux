// Seeds a pilot survey (consent + private items + RT task) into a running Firestore emulator.
//   PORT=8080 node scripts/seed-emulator.mjs
import { readFileSync } from 'node:fs';
const base = 'http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/projects/samplux-lamp/databases/(default)/documents';
const enc = v => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const demo = JSON.parse(readFileSync(new URL('../surveys/samplux_demo.json', import.meta.url), 'utf8'));
const items = demo.items.filter(i => !['task_intro', 'tarea_stroop', 'tarea_gonogo', 'comentarios_voz'].includes(i.id));
// move the RT task to the end and mark one item private
const rt = items.splice(items.findIndex(i => i.id === 'tarea_rt'), 1)[0];
rt.taskConfig = { nPractice: 1, nTest: 2 };
items.find(i => i.id === 'ejercicio').handoff = true;
items.find(i => i.id === 'horas_sueno').handoff = true;
items.find(i => i.id === 'genero').required = true;
items.splice(1, 0, { id: 'consentimiento', type: 'single_choice', required: true, prompt: '¿Aceptas participar voluntariamente?', instruction: 'Contacto: equipo LAMP',
  options: [{ code: 1, label: 'Sí, acepto participar' }, { code: 2, label: 'No' }], exitOnAnswer: [2] });
items.push(rt);
const survey = { ...demo, id: 'piloto', title: 'Piloto consentimiento + encuestador', published: true, items,
  settings: { randomizeItems: false, consent: { enabled: true, level: 'sensitive', itemId: 'consentimiento', contact: 'LAMP · lamp@umag.cl' } } };
delete survey.id;
const res = await fetch(`${base}/surveys/piloto`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: enc(survey).mapValue.fields }) });
console.log('seed', res.status, items.map(i => i.id + ':' + i.type).join(' '));
