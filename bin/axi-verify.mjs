#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
  process.stdout.write(manifest.version + '\n');
} else {
  const { encode } = await import('@toon-format/toon');
  const output = value => process.stdout.write(encode(value) + '\n');
  const help = 'axi-verify packed [--tarball <absolute.tgz>] [--expected-git-head <40-char-sha>] [--evidence-dir <path>] | static';
  try {
    if (args.length === 0 || args.length === 1 && args[0] === '--help' || args.length === 2 && ['packed', 'static'].includes(args[0]) && args[1] === '--help') {
      output({ bin: fileURLToPath(import.meta.url), description: manifest.description, usage: help, examples: ['axi-verify packed', 'axi-verify static'] });
    } else {
      const [command, ...rest] = args;
      const options = {};
      if (!['packed', 'static'].includes(command)) throw new TypeError(`Unknown command ${command}`);
      const flags = { '--tarball': 'tarball', '--expected-git-head': 'expectedGitHead', '--evidence-dir': 'evidenceDir' };
      while (rest.length) {
        const flag = rest.shift();
        if (command !== 'packed' || !Object.hasOwn(flags, flag)) throw new TypeError(`Unknown flag ${flag}`);
        const value = rest.shift();
        if (!value || value.startsWith('--') || Object.hasOwn(options, flags[flag])) throw new TypeError(`Supply ${flag} exactly once with a value`);
        options[flags[flag]] = value;
      }
      if (options.expectedGitHead && !options.tarball) throw new TypeError('--expected-git-head requires --tarball (never repack a release artifact)');
      const result = command === 'packed' ? await (await import('../lib/packed.mjs')).verifyPacked(options) : await (await import('../lib/static.mjs')).verifyStatic();
      output(command === 'packed' ? { package: result.package, version: result.version, passed: result.passed, rows: result.rows.length, failures: result.rows.filter(row => !row.passed), evidence: result.evidence } : result);
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    output({ error: error.message, code: error instanceof TypeError ? 'VALIDATION_ERROR' : 'VERIFICATION_FAILED', help });
    process.exitCode = error instanceof TypeError ? 2 : 1;
  }
}
