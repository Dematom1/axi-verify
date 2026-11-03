import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encode } from '@toon-format/toon';
import { checked, cleanup, json, prerequisite, scratch } from '../lib/lab.mjs';
import { verifyPacked } from '../lib/packed.mjs';

// Fixed evidence baselines, not floating latest dependencies. Update deliberately after releases.
const published = {
  'argocd-axi': '0.1.13', 'argo-workflows-axi': '0.1.14', 'datadog-axi': '0.1.11',
  'terraform-axi': '0.1.0', 'search-console-axi': '0.1.0',
};
if (!process.argv[2] || process.argv.length > 4) throw new Error('Usage: node scripts/prove-published.mjs <evidence-dir> [unpublished-k8s-archive]');
prerequisite();
const evidence = resolve(process.argv[2]), root = await scratch(), results = [];
const env = { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), CI: '1' };
await fs.writeFile(env.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
await fs.writeFile(env.npm_config_globalconfig, '');
try {
  for (const [name, version] of Object.entries(published)) {
    const spec = `${name}@${version}`;
    const directory = join(root, name); await fs.mkdir(directory);
    const registry = JSON.parse((await checked('npm', ['view', spec, 'version', 'dist', 'gitHead', '--json'], { env })).stdout);
    await json(join(evidence, name, 'registry.json'), { spec, retrievedAt: new Date().toISOString(), ...registry, provenanceNote: 'Attestation URL recorded, not independently cryptographically verified by this runner' });
    const packed = JSON.parse((await checked('npm', ['pack', spec, '--json', '--ignore-scripts', '--pack-destination', directory], { env, cwd: directory, timeout: 180_000 })).stdout);
    assert.equal(packed.length, 1);
    const archive = join(directory, packed[0].filename);
    const bytes = await fs.readFile(archive);
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), registry.dist.integrity, 'downloaded archive integrity differs from registry metadata');
    await fs.mkdir(join(evidence, name), { recursive: true });
    await fs.copyFile(archive, join(evidence, name, packed[0].filename));
    try {
      const result = await verifyPacked({ tarball: archive, expectedGitHead: registry.gitHead, evidenceDir: join(evidence, name) });
      results.push({ name, version, artifact: 'published', passed: result.passed, rows: result.rows.length, failures: result.rows.filter(row => !row.passed).map(row => ({ id: row.id, error: row.error })) });
    } catch (error) { results.push({ name, version, artifact: 'published', passed: false, prerequisiteError: error.message }); }
  }
  if (process.argv[3]) {
    const result = await verifyPacked({ tarball: resolve(process.argv[3]), evidenceDir: join(evidence, 'k8s-axi') });
    results.push({ name: result.package, version: result.version, artifact: 'UNPUBLISHED local pack; registry proof pending', passed: result.passed, rows: result.rows.length, failures: result.rows.filter(row => !row.passed).map(row => ({ id: row.id, error: row.error })) });
  } else results.push({ name: 'k8s-axi', artifact: 'unpublished; local archive not supplied', passed: false, prerequisiteError: 'Published-artifact proof pending; npm registry E404 at initial baseline' });
  await json(join(evidence, 'catalog-summary.json'), results);
  process.stdout.write(encode({ tools: results.map(({ name, version, artifact, passed, rows }) => ({ name, version: version ?? 'unpublished', artifact, passed, rows: rows ?? 0 })), evidence }) + '\n');
  if (results.some(row => !row.passed)) process.exitCode = 1;
} finally { await cleanup(root); }
