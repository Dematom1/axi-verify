// Observe/reject external I/O only; CLI handlers, renderers and filesystem calls remain real.
import net from 'node:net';
import { appendFileSync, realpathSync } from 'node:fs';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const record = (row) => appendFileSync(process.env.AXI_NETWORK_LOG, JSON.stringify(row) + '\n');
const allowedProcess = (api, command, args) => {
  const candidates = typeof command === 'string' ? [command, ...(command.includes('/') ? [] : (process.env.PATH ?? '').split(':').map(path => `${path}/${command}`))] : [];
  const target = candidates.find(path => {
    try { return realpathSync(path); } catch { return false; }
  });
  let realTarget;
  try { realTarget = target && realpathSync(target); } catch {}
  const allowed = realTarget === realpathSync(process.execPath) || realTarget === '/bin/sh' || realTarget === realpathSync(new URL('./external.mjs', import.meta.url));
  const bin = typeof command === 'string' ? command.split('/').pop() : command;
  appendFileSync(process.env.AXI_PROCESS_LOG, JSON.stringify({ api, command, args, allowed }) + '\n');
  if (allowed && ['argocd', 'argo', 'kubectl', 'terraform', 'tofu'].includes(bin)) {
    appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin, args: Array.isArray(args) ? args : [], allowed: true }) + '\n');
  }
  if (!allowed) throw new Error(`AXI fixture refused unexpected subprocess: ${command}`);
};
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  allowedProcess('spawn', command, args);
  return spawn.call(this, command, args, options);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  allowedProcess('spawnSync', command, args);
  return spawnSync.call(this, command, args, options);
};
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function (command, args, ...rest) {
    allowedProcess(name, command, args);
    return original.call(this, command, args, ...rest);
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  const port = typeof options === 'object' ? options.port : options;
  const allowed = host === '127.0.0.1' && String(port) === process.env.AXI_HTTP_PORT;
  record({ kind: 'socket', host, port, allowed });
  if (!allowed) throw new Error('AXI fixture refused external network connection');
  return connect.apply(this, args);
};
syncBuiltinESMExports();
if (process.env.AXI_GOOGLE_ROOT) {
  const require = createRequire(process.env.AXI_GOOGLE_ROOT + '/package.json');
  const { JWT, UserRefreshClient } = require('google-auth-library');
  for (const Client of [JWT, UserRefreshClient]) Client.prototype.request = async function (options) {
    const allowed = options.url === 'https://searchconsole.googleapis.com/webmasters/v3/sites' && (!options.method || options.method === 'GET');
    record({ kind: 'google-request', url: options.url, method: options.method ?? 'GET', allowed });
    if (!allowed) throw new Error('Unexpected Google fixture request');
    return { data: { siteEntry: [
      { siteUrl: 'https://healthy.example.invalid/', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://problem.example.invalid/', permissionLevel: 'siteRestrictedUser' },
    ] } };
  };
}
