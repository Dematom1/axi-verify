import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { verifyStatic } from '../lib/static.mjs';
import { cleanup, scratch } from '../lib/lab.mjs';
test('static scans caller production commands, not tests, generated output or unrelated source', async () => {
  const root = await scratch();
  try {
    const invalid = 'function setup() { return { session_end: "installed" }; }';
    for (const path of ['src/commands/setup.ts', 'tests/setup.ts', 'fixtures/setup.ts', 'dist/setup.ts', 'skills/setup.ts', 'node_modules/other/setup.ts', 'src/unrelated.ts']) {
      const file = join(root, path); await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, invalid);
    }
    const result = await verifyStatic(root);
    assert.equal(result.passed, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].rule, 'axi-no-literal-setup-status');
    assert(result.findings[0].file.endsWith('/src/commands/setup.ts'));
    await fs.writeFile(join(root, 'src/commands/setup.ts'), 'function setup() { return observed; }');
    assert.deepEqual(await verifyStatic(root), { passed: true, findings: [] });
  } finally { await cleanup(root); }
});
