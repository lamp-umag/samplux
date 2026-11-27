import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, describeDuration } from '../js/duration.js';

test('duration round-trips, keeps zeros, skips empty parts', () => {
  assert.equal(formatDuration({ Y: 2, M: 0, D: null }), 'P2Y0M');
  assert.equal(formatDuration({ Y: null, M: null, D: null }), '');
  assert.deepEqual(parseDuration('P2Y3M10D'), { Y: 2, M: 3, D: 10 });
  assert.deepEqual(parseDuration(undefined), { Y: null, M: null, D: null });
  assert.equal(describeDuration('P1Y3M'), '1 año, 3 meses');
});
