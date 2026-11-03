import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proveHistory } from '../scripts/prove-history.mjs';
import { cleanup, scratch } from '../lib/lab.mjs';
test('all four rule families reject exact historical files and accept repaired copies', async () => {
  const evidence = await scratch();
  try {
    const proof = await proveHistory(evidence);
    assert.equal(proof.length, 4);
    assert.equal(new Set(proof.flatMap(item => item.red.map(match => match.rule))).size, 4);
    assert(proof.every(item => item.red.length && item.green.length === 0));
  } finally { await cleanup(evidence); }
});
