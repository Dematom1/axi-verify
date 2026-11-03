import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as yaml } from 'yaml';
import { profileFor } from './profiles.mjs';
import { checked, cleanup, deniedProbe, installedBins, json, lock, observe, prerequisite, processResult, sandbox, scratch, snapshot } from './lab.mjs';
import { assertForeign, assertInstalled, assertRemoved, assertReported, destinations, managedState, noUnexpectedIO, normalUnchanged, seedForeign, structuredFailure, successful } from './observations.mjs';

export async function hookModel({ bin, name, profile, lab, invoke }) {
  await seedForeign(lab);
  const normalErrors = [];
  for (const command of [['--help'], ['--version'], ...profile.normal]) {
    const args = command.map(a => a === 'MODULE' ? lab.cwd : a);
    const result = await invoke(bin, args, lab);
    try { normalUnchanged(result, lab); } catch (error) { normalErrors.push(`${args.join(' ') || '(home)'}: ${error.message}`); }
  }
  if (!profile.hooks.length) {
    structuredFailure(await invoke(bin, ['setup', 'hooks'], lab), ['VALIDATION_ERROR'], 2);
    assert.equal(normalErrors.length, 0, normalErrors.join('; '));
    return { unsupported: 'hook installation', state: await managedState(lab, name) };
  }
  successful(await invoke(bin, profile.install, lab));
  const installed = await managedState(lab, name);
  assertInstalled(installed, profile);
  for (const command of profile.normal) {
    const args = command.map(a => a === 'MODULE' ? lab.cwd : a);
    try { normalUnchanged(await invoke(bin, args, lab), lab); } catch (error) { normalErrors.push(`after setup ${args.join(' ') || '(home)'}: ${error.message}`); }
  }
  successful(await invoke(bin, profile.install, lab));
  const repeated = await managedState(lab, name);
  assertInstalled(repeated, profile);
  assert.deepEqual(repeated, installed, 'repeated setup changed managed registrations');
  successful(await invoke(bin, profile.uninstall, lab));
  const removed = await managedState(lab, name);
  assertRemoved(removed);
  await assertForeign(lab);
  successful(await invoke(bin, profile.uninstall, lab));
  await assertForeign(lab);
  assert.equal(normalErrors.length, 0, normalErrors.join('; '));
  return { installed, repeated, removed };
}

export async function verifyPacked(options = {}) {
  prerequisite();
  const source = resolve(options.source ?? process.cwd());
  const evidence = resolve(options.evidenceDir ?? join(source, '.axi-evidence', new Date().toISOString().replaceAll(':', '-')));
  const root = await scratch();
  if (evidence.startsWith(root + '/')) throw new Error('Evidence must be outside disposable scratch');
  await fs.mkdir(evidence, { recursive: true });
  const results = [], httpRequests = [];
  const server = createServer((request, response) => {
    const allowed = request.method === 'GET' && request.url.startsWith('/api/v1/monitor/search');
    httpRequests.push({ method: request.method, url: request.url, allowed });
    response.writeHead(allowed ? 200 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify(allowed ? { monitors: [
      { id: 1, name: 'healthy', status: 'OK', type: 'metric alert', priority: 3 },
      { id: 2, name: 'problem', status: 'Alert', type: 'metric alert', priority: 1 },
    ], metadata: { total_count: 2, page: 0, per_page: 50 } } : { error: 'Unexpected fixture request' }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  let identity;
  const npmEnv = { PATH: process.env.PATH, HOME: join(root, 'npm-home'), npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), CI: '1', NO_COLOR: '1' };
  await fs.mkdir(npmEnv.HOME);
  await fs.writeFile(npmEnv.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
  await fs.writeFile(npmEnv.npm_config_globalconfig, '');
  try {
    let archive;
    if (options.tarball) {
      assert(isAbsolute(options.tarball), '--tarball must be an absolute path');
      archive = await fs.realpath(options.tarball);
    } else {
      const packed = await checked('npm', ['pack', '--json', '--foreground-scripts=false', '--pack-destination', root], { cwd: source, env: npmEnv, timeout: 180_000 });
      const selected = JSON.parse(packed.stdout);
      assert.equal(selected.length, 1, 'npm pack must select exactly one fresh archive');
      assert.equal(dirname(selected[0].filename), '.', 'npm pack returned an unsafe filename');
      archive = join(root, selected[0].filename);
      await json(join(evidence, 'pack.json'), packed);
    }
    const manifestResult = await checked('tar', ['-xOzf', archive, 'package/package.json'], { env: npmEnv });
    const manifest = JSON.parse(manifestResult.stdout), name = manifest.name, profile = profileFor(name);
    const sourceHead = await processResult('git', ['-C', source, 'rev-parse', 'HEAD'], { env: npmEnv });
    identity = {
      name, version: manifest.version, sha512: 'sha512-' + createHash('sha512').update(await fs.readFile(archive)).digest('base64'),
      archive, archiveGitHead: manifest.gitHead ?? null, sourceHead: options.tarball ? options.expectedGitHead ?? null : sourceHead.exit === 0 ? sourceHead.stdout.trim() : null,
      artifact: options.expectedGitHead ? 'release-candidate (registry publication not asserted)' : 'pre-release/local or supplied archive (registry publication not asserted)',
      node: process.version, npm: (await checked('npm', ['--version'], { env: npmEnv })).stdout.trim(),
      platform: process.platform, arch: process.arch, uid: process.getuid(), manifest,
    };
    await json(join(evidence, 'identity.json'), identity);
    if (options.expectedGitHead) {
      assert(/^[a-f0-9]{40}$/.test(options.expectedGitHead), '--expected-git-head requires a full source SHA');
      assert.equal(manifest.gitHead, options.expectedGitHead, 'archive gitHead differs from expected source SHA');
    }
    const prefix = join(root, 'installed');
    await checked('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive], { env: npmEnv, timeout: 180_000 });
    const installedManifest = JSON.parse(await fs.readFile(join(prefix, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installedManifest.name, manifest.name);
    assert.equal(installedManifest.version, manifest.version);
    identity.installedManifest = installedManifest;
    await json(join(evidence, 'identity.json'), identity);
    const bins = await installedBins(prefix, manifest), bin = bins[name];
    async function row(id, body, custom = false) {
      const lab = await sandbox(root, custom), commands = [];
      lab.env.DATADOG_AXI_API_URL = `http://127.0.0.1:${server.address().port}`;
      lab.env.AXI_HTTP_PORT = String(server.address().port);
      const invoke = async (executable, args, target = lab, extras) => {
        const result = await observe(executable, args.map(a => a === 'KEY' ? target.key : a === 'MODULE' ? target.cwd : a), target, extras);
        commands.push(result);
        assert(!result.failure, result.failure);
        return result;
      };
      let observations, error, io;
      try { observations = await body(lab, invoke); io = await noUnexpectedIO(lab); }
      catch (failure) { error = failure.message; }
      try { io ??= await noUnexpectedIO(lab); } catch (failure) { error = [error, failure.message].filter(Boolean).join('; '); }
      const result = { id, passed: !error, error, commands, observations, io };
      results.push({ id, passed: result.passed, error });
      await json(join(evidence, `${String(results.length).padStart(3, '0')}-${id}.json`), result);
    }
    for (const custom of [false, true]) await row(`hook-model-${custom ? 'selected-claude' : 'default'}`, async (lab, invoke) => hookModel({ bin, name, profile, lab, invoke }), custom);

    // Each route/alias has a fresh HOME; help must still work when every write is denied.
    for (const denied of [false, true]) {
      for (const [binName, executable] of [[name, bin]]) {
        for (const flag of ['--version', '-v', '-V']) await row(`${binName}-version-${flag.slice(1)}-${denied}`, async (lab, invoke) => {
          if (denied) await deny(lab, 'all');
          const result = await invoke(executable, [flag]); successful(result);
          assert.equal(result.stdout.trim(), manifest.version, 'version must equal installed manifest');
          const io = await noUnexpectedIO(lab);
          assert.equal(io.subprocess.length + io.network.length, 0, 'version must not call external dependencies');
          normalUnchanged(result, lab);
        });
        const routes = binName === name ? [[], ...profile.help] : [[]];
        for (const route of routes) await row(`${binName}-help-${route.join('-') || 'top'}-${denied}`, async (lab, invoke) => {
          if (denied) await deny(lab, 'all');
          const result = await invoke(executable, [...route, '--help']); successful(result);
          assert(result.stdout.includes(name), 'help must identify the tool');
          assert(result.stdout.length > name.length + 10, 'help is empty/incomplete');
          if (route.length) assert(result.stdout.includes(route.join(' ')), `help must document route ${route.join(' ')}`);
          for (const flag of profile.helpFlags?.[route.join(' ')] ?? []) assert(result.stdout.includes(flag), `help must document flag ${flag}`);
          const io = await noUnexpectedIO(lab);
          assert.equal(io.subprocess.length + io.network.length, 0, 'help must not call external dependencies');
          normalUnchanged(result, lab);
          return { requiredRoute: route };
        });
      }
    }
    for (const [binName, executable] of Object.entries(bins).filter(([key]) => key !== name)) await row(`installed-auxiliary-${binName}`, async (lab, invoke) => {
      const result = await invoke(executable, []); successful(result);
      assert(result.stdout.trim(), 'auxiliary bin produced no local context');
    });
    if (profile.status) await row('read-only-status', async (lab, invoke) => {
      successful(await invoke(bin, profile.install));
      const before = await managedState(lab, name);
      const result = await invoke(bin, profile.status); successful(result);
      assertReported(result.decoded, before);
      normalUnchanged(result, lab);
      assert.deepEqual(await managedState(lab, name), before);
      return { state: before };
    });
    for (const command of [[], profile.list, ['setup']]) await row(`invalid-flag-${command.join('-') || 'top'}`, async (lab, invoke) => {
      const result = await invoke(bin, [...command, '--axi-unknown-flag']);
      structuredFailure(result, ['VALIDATION_ERROR'], 2);
      const io = await noUnexpectedIO(lab);
      assert.equal(io.subprocess.length + io.network.length, 0, 'usage validation must precede dependency work');
      normalUnchanged(result, lab);
    });
    for (const command of profile.unsupported ?? []) await row(`unsupported-${command.join('-')}`, async (lab, invoke) => structuredFailure(await invoke(bin, command), ['VALIDATION_ERROR'], 2));

    // Preserve five denial lanes, with real EACCES/EPERM probes and seeded uninstall.
    const actions = [profile.install, profile.uninstall, ...(profile.config ? [profile.config] : [])];
    if (!profile.hooks.length) actions.push(['setup']);
    for (const project of profile.project ? [false, true] : [false]) {
      for (const action of actions) for (const lane of ['writable', 'codex', 'claude', 'config', 'all']) {
        const argv = [...action, ...(project ? ['--project'] : [])];
        await row(`permissions-${action.slice(1).join('-') || 'setup'}-${lane}-${project ? 'project' : 'user'}`, async (lab, invoke) => {
          await seedForeign(lab, project);
          const uninstall = action === profile.uninstall;
          if (uninstall) {
            successful(await invoke(bin, [...profile.install, ...(project ? ['--project'] : [])]));
            if (profile.hooks.length) assertInstalled(await managedState(lab, name, project), profile);
            else assert.equal(JSON.parse(await fs.readFile(join(lab.home, '.config', name, 'config.json'), 'utf8')).serviceAccountPath, lab.key);
          }
          if (name === 'argocd-axi' && action === profile.config) {
            await fs.mkdir(join(lab.home, '.config', name), { recursive: true });
            await fs.writeFile(join(lab.home, '.config', name, 'config'), 'writable-contexts: [probe]\n');
          }
          const before = await snapshot(lab.home), probes = lane === 'writable' ? [] : await deny(lab, lane, project);
          const result = await invoke(bin, argv);
          const relevantDenial = lane !== 'writable' && (profile.hooks.length > 0 && (action === profile.install || uninstall) || ['config', 'all'].includes(lane) && (action === profile.install || uninstall || action === profile.config));
          if (relevantDenial) structuredFailure(result, profile.codes);
          else if (!profile.hooks.length && (action === profile.config || action[1] === undefined)) structuredFailure(result, ['AUTH_CONFIG_ERROR']);
          else successful(result);
          if (profile.hooks.length && [profile.install, profile.uninstall].includes(action)) {
            const state = await managedState(lab, name, project);
            if (lane === 'writable') {
              if (uninstall) assertRemoved(state); else assertInstalled(state, profile);
            }
            assertReported(result.decoded, state);
            await assertForeign(lab, project);
            return { probes, before, state };
          }
          const configFile = join(lab.home, '.config', name, name === 'argocd-axi' ? 'config' : 'config.json');
          if (name === 'terraform-axi' && action === profile.config && !['config', 'all'].includes(lane)) assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).binary, 'tofu');
          if (name === 'argocd-axi' && action === profile.config && !['config', 'all'].includes(lane)) assert(!yaml(await fs.readFile(configFile, 'utf8'))['writable-contexts'].includes('probe'), 'writable-context removal was not persisted');
          if (name === 'search-console-axi' && !['config', 'all'].includes(lane)) {
            if (action === profile.install) assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).serviceAccountPath, lab.key);
            if (action === profile.config) assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).quotaProjectId, 'probe-project');
            if (uninstall) await assert.rejects(fs.access(configFile), { code: 'ENOENT' });
          }
          if (['config', 'all'].includes(lane)) assert.equal((await snapshot(lab.home))['.config/' + name + '/' + (name === 'argocd-axi' ? 'config' : 'config.json')]?.content, before['.config/' + name + '/' + (name === 'argocd-axi' ? 'config' : 'config.json')]?.content, 'denied config write changed persisted file');
          return { probes };
        });
      }
    }
    for (const malformed of [false, true]) await row(`settings-${malformed ? 'malformed' : 'unreadable'}`, async (lab, invoke) => {
      successful(await invoke(bin, profile.install));
      const file = profile.hooks.length ? destinations(lab).claude : join(lab.home, '.config', name, 'config.json');
      const initial = await fs.readFile(file, 'utf8');
      if (malformed) await fs.writeFile(file, '{ invalid json');
      else { await fs.chmod(file, 0o000); await deniedProbe(file, true); }
      const before = malformed ? '{ invalid json' : initial;
      let result;
      try { result = await processResult(bin, profile.status ?? profile.install, { cwd: lab.cwd, env: lab.env }); }
      finally { await fs.chmod(file, 0o600); }
      // Capture after restoring only modes, never erase the unreadable/invalid file before the invocation.
      assert.equal(await fs.readFile(file, 'utf8'), before, 'failed read modified settings');
      await json(join(evidence, `${name}-${malformed ? 'malformed' : 'unreadable'}-raw.json`), result);
      if (name === 'search-console-axi' && malformed && result.exit === 0) {
        assert.equal(result.decoded?.auth?.status, 'invalid', 'malformed config must not be reported as absent or configured');
        assert.match(result.decoded.auth.error, /invalid JSON|invalid format/, 'invalid status must explain the observed config failure');
      } else structuredFailure(result, malformed ? [...profile.codes, 'VALIDATION_ERROR'] : profile.codes, malformed && result.exit === 2 ? 2 : 1);
      return { result, unchangedContents: before };
    });
    if (!profile.hooks.length) for (const kind of ['missing', 'unreadable']) await row(`credential-${kind}`, async (lab, invoke) => {
      const file = kind === 'missing' ? join(lab.base, 'missing.json') : lab.key;
      if (kind === 'unreadable') { await fs.chmod(file, 0o000); await deniedProbe(file, true); }
      try { structuredFailure(await invoke(bin, ['setup', 'service-account', file]), ['AUTH_CONFIG_ERROR']); }
      finally { if (kind === 'unreadable') await fs.chmod(file, 0o600); }
    });
    await row('default-list-schema', async (lab, invoke) => {
      const requestStart = httpRequests.length;
      if (name === 'search-console-axi') {
        lab.env.AXI_GOOGLE_ROOT = join(prefix, 'node_modules', name);
        lab.env.GOOGLE_APPLICATION_CREDENTIALS = lab.key;
      }
      const result = await invoke(bin, profile.list); successful(result);
      const list = result.decoded?.[profile.collection];
      assert(Array.isArray(list) && list.length >= 2, 'default schema needs nonempty healthy and problem fixtures');
      for (const item of list) assert.deepEqual(Object.keys(item), profile.fields, 'default list field set differs');
      assert(JSON.stringify(list).includes('healthy') && JSON.stringify(list).includes('problem'), 'list must contain both synthetic fixture identities');
      assert(profile.fields.length <= 4, 'default list exceeds four columns');
      const io = await noUnexpectedIO(lab);
      if (name === 'search-console-axi') assert.equal(io.network.filter(row => row.kind === 'google-request').length, 1, 'Google external request boundary was not exercised');
      else if (name === 'datadog-axi') assert(httpRequests.length > requestStart, 'Datadog external request boundary was not exercised');
      else {
        const expected = { 'argocd-axi': ['argocd', 'app list'], 'argo-workflows-axi': ['argo', 'list'], 'terraform-axi': ['terraform', 'state list'], 'k8s-axi': ['kubectl', 'get pods'] }[name];
        assert(io.subprocess.some(call => call.bin === expected[0] && call.args.join(' ').includes(expected[1])), 'list subprocess fixture boundary was not exercised');
      }
      if (profile.expanded) {
        const expanded = await invoke(bin, [...profile.list, ...profile.expanded]); successful(expanded);
        const expandedList = expanded.decoded?.[profile.collection];
        assert(Array.isArray(expandedList) && expandedList.length >= 2, 'expanded list missing');
        if (profile.expanded[0] === '--fields') for (const item of expandedList) for (const field of profile.expanded[1].split(',')) assert(Object.hasOwn(item, field), `expanded field ${field} missing`);
        if (name === 'terraform-axi') assert((await noUnexpectedIO(lab)).subprocess.some(call => call.args.join(' ').includes('show -json')), '--full did not exercise state decoding');
      }
      return { fields: profile.fields, fixtures: ['healthy', 'problem'] };
    });
    if (profile.hooks.length) {
      await row('execute-stored-hooks', async (lab, invoke) => {
        successful(await invoke(bin, profile.install));
        const state = await managedState(lab, name); assertInstalled(state, profile);
        const outcomes = [];
        const payload = await hookPayload(lab, `${name} ${profile.list.join(' ')} --context probe`);
        const before = await snapshot(lab.home);
        for (const hook of state.commands) {
          const result = await invoke('/bin/sh', ['-c', hook.command], lab, { input: JSON.stringify(payload) });
          successful(result);
          if (hook.event === 'SessionStart') assert(result.stdout.trim().length > 0, 'SessionStart produced no ambient context');
          else assert(result.stdout.includes('recorded'), 'SessionEnd did not report recording');
          outcomes.push({ ...hook, exit: result.exit, stdout: result.stdout });
        }
        const after = await snapshot(lab.home);
        if (profile.hooks.includes('claude:SessionEnd')) {
          const changedSessionFiles = Object.entries(after).filter(([path, value]) => /session/i.test(path) && (value.type !== before[path]?.type || value.size !== before[path]?.size || value.mtimeNs !== before[path]?.mtimeNs));
          assert(changedSessionFiles.length > 0, 'SessionEnd did not persist independently observable session effects');
        }
        return { outcomes, after };
      });
      await row('relocation-repair', async (lab, invoke) => {
        await seedForeign(lab);
        successful(await invoke(bin, profile.install));
        const original = await managedState(lab, name);
        const settings = JSON.parse(await fs.readFile(destinations(lab).claude, 'utf8'));
        settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: `${name}-ctx` }] });
        if (profile.hooks.includes('claude:SessionEnd')) settings.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: `${name} context end${name === 'argo-workflows-axi' ? ' # ' + name : ''}` }] });
        await json(destinations(lab).claude, settings);
        const relocated = join(root, "relocated path with space ' quote-" + name);
        await fs.cp(prefix, relocated, { recursive: true, dereference: false, verbatimSymlinks: true });
        const nextBin = join(relocated, 'node_modules', '.bin', name);
        successful(await invoke(nextBin, profile.install));
        const next = await managedState(lab, name); assertInstalled(next, profile);
        const payload = await hookPayload(lab, `${name} ${profile.list.join(' ')} --context probe`);
        for (const hook of next.commands) {
          assert(!hook.command.includes(prefix), 'repair retained old install path');
          successful(await invoke('/bin/sh', ['-c', hook.command], lab, { input: JSON.stringify(payload) }));
        }
        await assertForeign(lab);
        return { original, repaired: next };
      });
      await row('npx-local-archive', async (lab) => {
        const npm = await checked('which', ['npm'], { env: { PATH: process.env.PATH } });
        const execArgs = ['exec', '--yes', '--ignore-scripts', '--cache', join(lab.base, 'npm-cache'), '--userconfig', npmEnv.npm_config_userconfig, '--package', archive];
        // Warm dependency bytes without running the tool; the actual setup runs offline with the fixture-only PATH.
        await checked(npm.stdout.trim(), [...execArgs, '--', 'node', '--version'], { cwd: lab.cwd, env: { ...npmEnv, HOME: lab.home }, timeout: 180_000 });
        const args = [...execArgs, '--offline', '--', name, ...profile.install];
        const result = await processResult(npm.stdout.trim(), args, { cwd: lab.cwd, env: { ...lab.env, npm_config_audit: 'false', npm_config_fund: 'false' }, timeout: 180_000 });
        await json(join(evidence, 'npx-raw.json'), result);
        if (profile.npx === 'REFUSED') { structuredFailure(result, ['REFUSED']); assertRemoved(await managedState(lab, name)); }
        else {
          successful(result); const state = await managedState(lab, name); assertInstalled(state, profile);
          const payload = await hookPayload(lab, `${name} ${profile.list.join(' ')} --context probe`);
          for (const hook of state.commands) successful(await processResult('/bin/sh', ['-c', hook.command], { cwd: lab.cwd, env: lab.env, input: JSON.stringify(payload) }));
        }
        return { result, state: await managedState(lab, name) };
      });
    }
    assert(httpRequests.every(request => request.allowed), 'unexpected Datadog HTTP request');
    await json(join(evidence, 'http-requests.json'), httpRequests);
    const summary = { package: name, version: manifest.version, passed: results.every(row => row.passed), rows: results, evidence };
    await json(join(evidence, 'summary.json'), summary);
    return summary;
  } catch (error) {
    await json(join(evidence, 'fatal.json'), { error: error.message, identity, rows: results });
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await cleanup(root);
  }
}
async function hookPayload(lab, command) {
  const transcript = join(lab.base, 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }) + '\n');
  return { session_id: 'axi-verifier-probe', cwd: lab.cwd, transcript_path: transcript };
}
async function deny(lab, lane, project = false) {
  const targets = lane === 'all' ? ['codex', 'claude', 'config'] : [lane];
  const paths = targets.flatMap(target => {
    const user = join(lab.home, '.' + target);
    if (!project) return [user];
    return [user, join(lab.cwd, target === 'config' ? '.opencode' : '.' + target)];
  });
  const probes = [];
  for (const path of paths) { await lock(path); probes.push({ path, code: await deniedProbe(path) }); }
  if (lane === 'all') for (const path of [lab.home, lab.cwd]) { await fs.chmod(path, 0o555); probes.push({ path, code: await deniedProbe(path) }); }
  return probes;
}
