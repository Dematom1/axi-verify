import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encode } from '@toon-format/toon';
import { checked, cleanup, json, scratch } from '../lib/lab.mjs';
import { verifyPacked } from '../lib/packed.mjs';

if (![3, 4, 5].includes(process.argv.length)) throw new Error('Usage: node scripts/prove-regressions.mjs <evidence-directory> [historical-terraform-archive] [historical-argo-archive]');
const evidence = resolve(process.argv[2]), root = await scratch();
const env = { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), CI: '1' };
await fs.writeFile(env.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
await fs.writeFile(env.npm_config_globalconfig, '');
const proofs = [];
async function fetchArchive(spec) {
  const metadata = JSON.parse((await checked('npm', ['view', spec, 'version', 'dist', 'gitHead', '--json'], { env })).stdout);
  const directory = join(root, spec); await fs.mkdir(directory);
  const packed = JSON.parse((await checked('npm', ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', directory], { env, cwd: directory, timeout: 180_000 })).stdout);
  assert.equal(packed.length, 1);
  const archive = join(directory, packed[0].filename), bytes = await fs.readFile(archive);
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata.dist.integrity);
  await json(join(evidence, spec, 'registry.json'), { spec, ...metadata });
  await fs.copyFile(archive, join(evidence, spec, packed[0].filename));
  return { archive, metadata };
}
function row(summary, id) {
  const result = summary.rows.find(row => row.id === id);
  assert(result, `missing required row ${id}`);
  return result;
}
try {
  const bad = await fetchArchive('argocd-axi@0.1.8');
  const good = await fetchArchive('argocd-axi@0.1.13');
  const red = await verifyPacked({ tarball: bad.archive, evidenceDir: join(evidence, 'argocd-axi@0.1.8') });
  const green = await verifyPacked({ tarball: good.archive, evidenceDir: join(evidence, 'argocd-axi@0.1.13') });
  for (const [id, reason] of [
    ['default-list-schema', 'default list field set differs'],
    ['permissions-uninstall-claude-user', 'got UNKNOWN'],
    ['permissions-writable-remove-probe-config-user', 'got UNKNOWN'],
    ['settings-unreadable', 'expected exit 1, got 0'],
    ['execute-stored-hooks', 'expected success'],
  ]) {
    assert.equal(row(red, id).passed, false, `historical ${id} must be red`);
    assert(row(red, id).error.includes(reason), `${id}: unintended red reason: ${row(red, id).error}`);
    assert(!/unexpected (subprocess|network) fixture call|timeout|PREREQUISITE/.test(row(red, id).error), 'unrelated failure is not regression proof');
    assert.equal(row(green, id).passed, true, `${id}: fixed successor is not green: ${row(green, id).error}`);
    proofs.push({ id, bad: 'argocd-axi@0.1.8', source: '23ed411594a4bbd4df00b381add760034ca72367', fixed: 'argocd-axi@0.1.13', red: row(red, id).error, green: true });
  }
  const argo = await fetchArchive('argo-workflows-axi@0.1.14');
  const baseline = await verifyPacked({ tarball: argo.archive, evidenceDir: join(evidence, 'argo-baseline') });
  async function recordedCommand(directory, id) {
    const file = (await fs.readdir(directory)).find(file => file.endsWith('-' + id + '.json'));
    assert(file, `missing command evidence for ${id}`);
    const record = JSON.parse(await fs.readFile(join(directory, file), 'utf8'));
    assert(!/unexpected (subprocess|network) fixture call|timeout|PREREQUISITE/.test(record.error ?? ''), 'unrelated failure is not regression proof');
    return record.commands.at(-1);
  }
  if (process.argv[4]) {
    const archive = resolve(process.argv[4]);
    const manifest = JSON.parse((await checked('tar', ['-xOzf', archive, 'package/package.json'])).stdout);
    assert.equal(manifest.gitHead, '28217eba3686b18acd222b52d8f148c76796d61d', 'historical Argo pack must identify the exact pre-fix source');
    await verifyPacked({ tarball: archive, evidenceDir: join(evidence, 'argo-before') });
    const installId = 'permissions-hooks-codex-user';
    const oldInstall = await recordedCommand(join(evidence, 'argo-before'), installId);
    const newInstall = await recordedCommand(join(evidence, 'argo-baseline'), installId);
    assert.equal(oldInstall.exit, 0, 'historical collected installation errors must reproduce exit zero');
    assert.equal(newInstall.exit, 1); assert.equal(newInstall.decoded.code, 'SETUP_FAILED');
    proofs.push({ id: 'argo-denied-install-exit-and-code', source: manifest.gitHead, bad: 'historical unpublished local pack, version 0.1.12', fixed: 'argo-workflows-axi@0.1.14', red: 'denied Codex install exited zero', green: true, scope: 'exit and typed code only; complete current row remains red for missing repair help' });
  }
  if (process.argv[3]) {
    await verifyPacked({ tarball: resolve(process.argv[3]), evidenceDir: join(evidence, 'terraform-before') });
    const terra = await fetchArchive('terraform-axi@0.1.0');
    await verifyPacked({ tarball: terra.archive, evidenceDir: join(evidence, 'terraform-current') });
    for (const id of ['permissions-hooks-all-user', 'permissions-uninstall-all-user']) {
      const before = await recordedCommand(join(evidence, 'terraform-before'), id);
      const after = await recordedCommand(join(evidence, 'terraform-current'), id);
      assert.equal(before.exit, 0); assert.equal(after.exit, 1);
      const originalHooks = Object.entries(before.after.home).filter(([path, value]) => /hooks.json|settings.json|plugins/.test(path) && value.content?.includes('terraform-axi'));
      if (id.includes('uninstall')) assert(originalHooks.length > 0, 'historical removal must leave managed files');
      else assert.equal(originalHooks.length, 0, 'all-denied install must leave no managed files');
      proofs.push({ id: 'terraform-' + id, source: 'e069c3a269cd1850ae2d155bb3993410946955e2', bad: 'historical unpublished local pack', fixed: 'terraform-axi@0.1.0', red: 'failed mutation exited zero', green: true, scope: 'exit and file preservation only; complete current row remains red for missing parsed code' });
    }
  }
  for (const mutation of ['version', 'invalid-flag']) {
    const directory = join(root, mutation); await fs.mkdir(directory);
    await checked('tar', ['-xzf', argo.archive, '-C', directory]);
    const packageDir = join(directory, 'package'), file = join(packageDir, 'package.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    if (mutation === 'version') {
      const originalVersion = manifest.version;
      manifest.version = '0.1.999999'; await json(file, manifest);
      const leaf = join(packageDir, 'dist', 'src', 'version.js');
      const source = await fs.readFile(leaf, 'utf8');
      assert(source.includes('export const VERSION = readPackageVersion();'));
      await fs.writeFile(leaf, source.replace('export const VERSION = readPackageVersion();', `export const VERSION = ${JSON.stringify(originalVersion)};`));
    }
    else {
      const entry = join(packageDir, manifest.bin[manifest.name]);
      const source = await fs.readFile(entry, 'utf8'), end = source.indexOf('\n') + 1;
      await fs.writeFile(entry, source.slice(0, end) + 'if (process.argv.includes("--axi-unknown-flag")) { process.stdout.write("error: ignored invalid flag\\n"); process.exit(0); }\n' + source.slice(end));
    }
    const packed = JSON.parse((await checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: packageDir, env })).stdout);
    const mutatedArchive = join(directory, packed[0].filename);
    await fs.mkdir(join(evidence, 'controlled-' + mutation), { recursive: true });
    await fs.copyFile(mutatedArchive, join(evidence, 'controlled-' + mutation, packed[0].filename));
    const result = await verifyPacked({ tarball: mutatedArchive, evidenceDir: join(evidence, 'controlled-' + mutation) });
    const id = mutation === 'version' ? 'argo-workflows-axi-version--version-false' : 'invalid-flag-top';
    assert.equal(row(baseline, id).passed, true, 'unmodified archive must pass the selected assertion');
    assert.equal(row(result, id).passed, false);
    assert.match(row(result, id).error, mutation === 'version' ? /version must equal installed manifest/ : /expected exit 2, got 0/);
    proofs.push({ id, bad: 'controlled faulty copy of argo-workflows-axi@0.1.14', mutation, historicalDefectClaim: false, red: row(result, id).error, green: true });
  }
  await json(join(evidence, 'runtime-red-green.json'), proofs);
  process.stdout.write(encode({ proofs: proofs.map(({ id, green }) => ({ id, green })), evidence }) + '\n');
} finally { await cleanup(root); }
