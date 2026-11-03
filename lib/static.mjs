import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processResult } from './lab.mjs';
const require = createRequire(import.meta.url);
export const astGrep = resolve(dirname(require.resolve('@ast-grep/cli/package.json')), 'ast-grep');
export const config = fileURLToPath(new URL('../sgconfig.yml', import.meta.url));
export async function verifyStatic(source = process.cwd()) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('PREREQUISITE: ast-grep verification supports Linux and macOS only');
  const result = await processResult(astGrep, ['scan', '--config', config, '--json', '--globs', '**/{commands,hooks,config,errors,bin}/**/*.{ts,tsx}', '--globs', '**/{cli,setup,config,errors,output,auth,*hook*}.{ts,tsx}', '--globs', '!**/{node_modules,dist,build,skills,fixtures,test,tests,__tests__,.git}/**', resolve(source)]);
  if (result.failure || ![0, 1].includes(result.exit)) throw new Error(`ast-grep failed: ${result.failure ?? result.stderr}`);
  const findings = JSON.parse(result.stdout).map(match => ({ rule: match.ruleId, file: match.file, line: match.range.start.line + 1, column: match.range.start.column + 1, message: match.message }));
  return { passed: result.exit === 0, findings };
}
