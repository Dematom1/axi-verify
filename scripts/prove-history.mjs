import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { astGrep, config } from '../lib/static.mjs';
import { cleanup, json, processResult, scratch } from '../lib/lab.mjs';

const history = fileURLToPath(new URL('../tests/history/', import.meta.url));
const provenance = JSON.parse(await fs.readFile(join(history, 'provenance.json'), 'utf8'));
function replace(source, old, next) {
  assert.equal(source.split(old).length, 2, 'historical repair must replace exactly one known source region: ' + old);
  return source.replace(old, next);
}
export async function proveHistory(evidenceDir) {
  const evidence = resolve(evidenceDir), root = await scratch(), proof = [];
  try {
    for (const item of provenance) {
      const original = await fs.readFile(join(history, item.file), 'utf8');
      assert.equal(createHash('sha256').update(original).digest('hex'), item.sha256, 'historical fixture hash changed');
      const oldFile = join(root, item.file);
      await fs.writeFile(oldFile, original);
      const red = await processResult(astGrep, ['scan', '--config', config, '--json', oldFile]);
      assert.equal(red.exit, 1, 'old source must fail a completed static scan, not a build/prerequisite error');
      const matches = JSON.parse(red.stdout);
      const counts = Object.fromEntries([...new Set(matches.map(match => match.ruleId))].sort().map(id => [id, matches.filter(match => match.ruleId === id).length]));
      assert.deepEqual(counts, item.expected, 'historical match counts changed');
      let fixed = original;
      if (item.file === 'argo-setup.ts') {
        fixed = replace(fixed, 'throw axiError(`Could not read Claude settings at ${path}`, "UNKNOWN");', 'throw axiError(`Could not read Claude settings at ${path}`, "FILE_ERROR");');
        fixed = replace(fixed, 'const markerCommand = `argo-workflows-axi context end # ${MARKER}`;', 'const markerCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(realpathSync(process.argv[1] ?? ""))} context end # ${MARKER}`;');
        fixed = replace(fixed, 'uninstallSessionStartHooks({ marker: MARKER, scope: "user" });', 'const failures: string[] = [];\n    uninstallSessionStartHooks({ marker: MARKER, scope: "user", onError: e => failures.push(e) });\n    if (failures.length) throw axiError(failures.join("; "), "SETUP_FAILED");');
        fixed = replace(fixed, '  const out: Record<string, unknown> = {', '  if (errors.length) throw axiError(errors.join("; "), "SETUP_FAILED");\n  const out: Record<string, unknown> = {');
        fixed = replace(fixed, 'session_end: "installed",', 'session_end: validateSessionEnd(readSettings(settingsPath)).some(g => Array.isArray(g.hooks) && g.hooks.some(h => h.command === markerCommand)) ? "installed" : "absent",');
      } else if (item.file === 'terraform-cli.ts') {
        fixed = replace(fixed, 'uninstallSessionStartHooks({ marker: name });', 'const failures: string[] = [];\n      uninstallSessionStartHooks({ marker: name, onError: e => failures.push(e) });\n      if (failures.length) throw new CliError(`SETUP_FAILED: ${failures.join("; ")}`);');
        fixed = replace(fixed, 'return output({ hooks: "removed", help: hints });', 'return output({ hooks: sessionStartHookStatus({ marker: name }), help: hints });');
        fixed = replace(fixed, '      return output({\n        hooks: errors.length ? errors', '      if (errors.length) throw new CliError(`SETUP_FAILED: ${errors.join("; ")}`);\n      return output({\n        hooks: errors.length ? errors');
      } else if (item.file === 'argocd-cli.ts') {
        fixed = replace(fixed, '  if (error instanceof AxiError) {', '  if (error instanceof Error && "code" in error && ["EACCES", "EPERM", "EROFS", "ENOENT"].includes(String(error.code))) {\n    return { output: renderError(error.message, "CONFIG_INVALID", ["Check config paths and permissions"]), exitCode: 1 };\n  }\n  if (error instanceof AxiError) {');
      } else {
        fixed = replace(fixed, '  readFileSync,', '  readFileSync,\n  realpathSync,');
        fixed = replace(fixed, 'const command = "argocd-axi context end";', 'const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(realpathSync(process.argv[1]!))} context end`;');
      }
      const fixedFile = join(root, 'fixed-' + item.file);
      await fs.writeFile(fixedFile, fixed);
      const green = await processResult(astGrep, ['scan', '--config', config, '--json', fixedFile]);
      assert.equal(green.exit, 0, green.stdout + green.stderr);
      assert.deepEqual(JSON.parse(green.stdout), []);
      await fs.mkdir(evidence, { recursive: true });
      await fs.copyFile(oldFile, join(evidence, item.file));
      await fs.copyFile(fixedFile, join(evidence, 'fixed-' + item.file));
      proof.push({ ...item, red: matches.map(match => ({ rule: match.ruleId, line: match.range.start.line + 1, column: match.range.start.column + 1, text: match.text })), green: [], fixedSha256: createHash('sha256').update(fixed).digest('hex') });
    }
    await json(join(evidence, 'static-history-proof.json'), proof);
    return proof;
  } finally { await cleanup(root); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: npm run proof:history -- <evidence-directory-outside-worktree>');
  const proof = await proveHistory(process.argv[2]);
  process.stdout.write(`Historical static proof: ${proof.length} exact source files rejected, repaired copies green\n`);
}
