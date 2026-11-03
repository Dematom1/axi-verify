// Observe/reject external I/O only; CLI handlers, renderers and filesystem calls remain real.
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const record = (row) => appendFileSync(process.env.AXI_NETWORK_LOG, JSON.stringify(row) + '\n');
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
