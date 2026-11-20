import test from 'node:test';
import assert from 'node:assert/strict';
import { diffItems, describeRisks, mergeRetired, withRetiredItems, logEntry } from '../js/revisions.js';

const A = { id: 'a', type: 'single_choice', prompt: 'Uno', options: [{ code: 1, label: 'x' }, { code: 2, label: 'y' }] };
const B = { id: 'b', type: 'text', prompt: 'Dos' };
const C = { id: 'c', type: 'number', prompt: 'Tres' };

test('editing wording is safe and recorded', () => {
  const d = diffItems([A, B], [{ ...A, prompt: 'Uno (nuevo)' }, B]);
  assert.equal(d.risky.length, 0);
  assert.deepEqual(d.edited.map(e => e.id), ['a']);
  assert.equal(d.edited[0].promptFrom, 'Uno');
  assert.equal(describeRisks(d), '');
});

test('deleting keeps the item as retired; re-adding removes it from retired', () => {
  const d = diffItems([A, B, C], [A, C]);
  assert.deepEqual(d.removed.map(i => i.id), ['b']);
  assert.match(describeRisks(d), /se conservan/);
  const retired = mergeRetired([], d, [A, C], 3);
  assert.equal(retired[0].id, 'b'); assert.equal(retired[0].retiredInRev, 3);
  assert.deepEqual(mergeRetired(retired, diffItems([A, C], [A, B, C]), [A, B, C], 4), []);
});

test('adding and reordering are detected without risk', () => {
  const add = diffItems([A], [A, B]); assert.deepEqual(add.added, ['b']); assert.equal(add.risky.length, 0);
  const mv = diffItems([A, B, C], [C, A, B]); assert.equal(mv.moved, true); assert.equal(mv.changed, true);
});

test('changing type or option codes is flagged as risky', () => {
  assert.equal(diffItems([A], [{ ...A, type: 'multi_choice' }]).risky[0].why, 'cambió el tipo de pregunta');
  assert.match(diffItems([A], [{ ...A, options: [{ code: 1, label: 'x' }, { code: 5, label: 'y' }] }]).risky[0].why, /códigos/);
  assert.equal(diffItems([A], [{ ...A, options: [{ code: 1, label: 'X!' }, { code: 2, label: 'Y!' }] }]).risky.length, 0);   // relabel only
});

test('a renamed id looks like remove+add and says so', () => {
  const d = diffItems([A], [{ ...A, id: 'a2' }]);
  assert.match(describeRisks(d), /renombrar/);
});

test('exports keep retired items that still have answers', () => {
  const def = { items: [A], retiredItems: [{ ...B, retiredInRev: 2 }, { ...C, retiredInRev: 2 }] };
  const out = withRetiredItems(def, [{ data: { answers: { a: 1, b: 'hola' } } }]);
  assert.deepEqual(out.items.map(i => i.id), ['a', 'b']);
  assert.equal(out.items[1]._retired, true);
  assert.match(out.items[1].prompt, /eliminada en v2/);
  assert.equal(withRetiredItems({ items: [A] }, []).items.length, 1);
  assert.equal(logEntry(2, d0(), 'x').rev, 2);
});
function d0() { return diffItems([A], [A, B]); }
