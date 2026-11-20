import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../js/zip.js';

test('the zip writer produces an archive that unzip reads back intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const blob = makeZip([{ name: 'preferencias.json', data: '{"a":1,"ñ":"ü"}' }, { name: 'notas/leeme.md', data: 'hola\n' }]);
  const file = join(dir, 'x.zip');
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const list = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n');
  assert.deepEqual(list, ['preferencias.json', 'notas/leeme.md']);
  assert.equal(execFileSync('unzip', ['-p', file, 'preferencias.json']).toString(), '{"a":1,"ñ":"ü"}');
  execFileSync('unzip', ['-tq', file]);   // CRCs verify
});
