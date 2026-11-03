import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { parse as toml } from 'smol-toml';
import { json } from './lab.mjs';

export const foreignCommand = 'other-tool context # axi-verifier-preserve';
export function destinations(lab, project = false) {
  return {
    claude: join(project ? join(lab.cwd, '.claude') : lab.env.CLAUDE_CONFIG_DIR, 'settings.json'),
    codex: join(project ? join(lab.cwd, '.codex') : lab.env.CODEX_HOME, 'hooks.json'),
    feature: join(lab.env.CODEX_HOME, 'config.toml'),
    opencode: project ? join(lab.cwd, '.opencode', 'plugins') : join(lab.env.XDG_CONFIG_HOME, 'opencode', 'plugins'),
  };
}
export async function seedForeign(lab, project = false) {
  const paths = destinations(lab, project);
  for (const file of new Set([paths.claude, paths.codex, join(lab.home, '.claude', 'settings.json')])) {
    await json(file, { unrelated: 'must survive', hooks: Object.fromEntries(['SessionStart', 'SessionEnd'].map(event => [event, [{ hooks: [{ type: 'command', command: foreignCommand }] }]])) });
  }
  await fs.mkdir(paths.opencode, { recursive: true });
  await fs.writeFile(join(paths.opencode, 'other-tool.js'), '// axi-verifier-preserve\n');
  await fs.writeFile(paths.feature, '[features]\nother_feature = true\n');
}
async function optional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function managedState(lab, name, project = false) {
  const paths = destinations(lab, project), counts = {}, commands = [];
  for (const target of ['claude', 'codex']) {
    const content = await optional(paths[target]);
    const value = content === undefined ? {} : JSON.parse(content);
    for (const event of ['SessionStart', 'SessionEnd']) {
      const groups = value.hooks?.[event] ?? [];
      assert(Array.isArray(groups), `${target} ${event}: invalid persisted groups`);
      const entries = groups.flatMap(group => group.hooks ?? []).filter(hook => typeof hook.command === 'string' && hook.command.includes(name));
      counts[`${target}:${event}`] = entries.length;
      commands.push(...entries.map(hook => ({ target, event, command: hook.command })));
    }
  }
  const config = await optional(paths.feature);
  const features = config === undefined ? {} : toml(config).features ?? {};
  const plugins = [];
  try { for (const file of await fs.readdir(paths.opencode)) {
    const text = await fs.readFile(join(paths.opencode, file), 'utf8');
    if (text.includes(name)) plugins.push({ file, content: text });
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  counts.opencode = plugins.length;
  return { paths, counts, commands, codexFeature: features.hooks === true, plugins };
}
export function assertInstalled(state, profile) {
  for (const key of profile.hooks) assert.equal(state.counts[key], 1, `${key}: expected exactly one managed hook`);
  if (profile.hooks.length) assert.equal(state.codexFeature, true, 'Codex features.hooks must be true');
}
export function assertRemoved(state) {
  for (const [key, count] of Object.entries(state.counts)) assert.equal(count, 0, `${key}: managed entries remain after removal`);
}
export async function assertForeign(lab, project = false) {
  const paths = destinations(lab, project);
  for (const target of ['claude', 'codex']) {
    const settings = JSON.parse(await fs.readFile(paths[target], 'utf8'));
    assert.equal(settings.unrelated, 'must survive', `${target}: unrelated setting lost`);
    for (const event of ['SessionStart', 'SessionEnd']) assert(settings.hooks[event].some(g => g.hooks?.some(h => h.command === foreignCommand)), `${target}: other tool's ${event} removed`);
  }
  assert.equal(await fs.readFile(join(paths.opencode, 'other-tool.js'), 'utf8'), '// axi-verifier-preserve\n');
  assert.equal(toml(await fs.readFile(paths.feature, 'utf8')).features.other_feature, true);
}
export function structuredFailure(result, codes, exit = 1) {
  assert.equal(result.exit, exit, `expected exit ${exit}, got ${result.exit}: ${result.stdout}`);
  assert(!result.decodeError && result.decoded && typeof result.decoded === 'object', `malformed structured error: ${result.decodeError}`);
  const code = result.decoded.code ?? result.decoded.error?.code;
  assert(codes.includes(code), `expected parsed code ${codes.join('|')}, got ${code ?? 'absent'}`);
  assert(result.decoded.help || result.decoded.error?.help, 'structured error needs an actionable help hint');
  assert(!/\n\s+at \S+.*:\d+:\d+/.test(result.stdout + result.stderr), 'raw stack trace leaked');
}
export function successful(result) {
  assert(!result.failure, result.failure);
  assert.equal(result.exit, 0, `expected success: ${result.stdout}\n${result.stderr}`);
}
export function normalUnchanged(result) {
  for (const root of ['home', 'cwd', 'scratch']) {
    assert.deepEqual(result.after[root], result.before[root], `normal command changed disposable ${root} files`);
  }
}
export function assertReported(value, state) {
  const mapped = { sessionEnd: 'claude:SessionEnd', session_end: 'claude:SessionEnd', claude_session_end: 'claude:SessionEnd', claude: 'claude:SessionStart', codex: 'codex:SessionStart', opencode: 'opencode' };
  function walk(object) {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(mapped, key)) {
        const reported = typeof item === 'object' && item !== null ? item.installed : item;
        const expected = state.counts[mapped[key]] > 0;
        if (typeof reported === 'boolean') assert.equal(reported, expected, `reported ${key} disagrees with persisted state`);
        else if (typeof reported === 'string') {
          const installed = ['installed', 'already installed', 'still installed'].includes(reported);
          const absent = ['absent', 'removed', 'not installed', 'not installed (no-op)'].includes(reported);
          if (installed || absent) assert.equal(installed, expected, `reported ${key}=${reported} disagrees with persisted state`);
        }
      }
      walk(item);
    }
  }
  walk(value);
}
export async function noUnexpectedIO(lab) {
  const records = {};
  for (const [kind, file] of [['subprocess', lab.env.AXI_FIXTURE_LOG], ['network', lab.env.AXI_NETWORK_LOG]]) {
    const content = await optional(file);
    records[kind] = content?.trim() ? content.trim().split('\n').map(line => JSON.parse(line)) : [];
    assert(records[kind].every(row => row.allowed), `unexpected ${kind} fixture call: ${JSON.stringify(records[kind].filter(row => !row.allowed))}`);
  }
  return records;
}
