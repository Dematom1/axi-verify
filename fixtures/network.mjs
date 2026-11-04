// Observe/reject external I/O only; CLI handlers, renderers and filesystem calls remain real.
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { appendFileSync, readFileSync } from "node:fs";
import timers from "node:timers";
import timersPromises from "node:timers/promises";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
if (process.env.AXI_KEYRING_STATE)
  register(new URL("./keyring-loader.mjs", import.meta.url));
if (process.env.AXI_INVENTORY_SDK)
  register(new URL("./inventory-loader.mjs", import.meta.url));
const record = (row) =>
  appendFileSync(process.env.AXI_NETWORK_LOG, JSON.stringify(row) + "\n");
const fetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (process.env.AXI_REGISTRY_PACKAGE && String(url) === `https://registry.npmjs.org/${process.env.AXI_REGISTRY_PACKAGE}/latest`) {
    record({ kind: "registry-fixture", url: String(url), allowed: true });
    if (process.env.AXI_REGISTRY_FORCE_FALLBACK === "1") throw new Error("fixture registry transport failure");
    return new Response(JSON.stringify({ version: process.env.AXI_REGISTRY_VERSION }), { headers: { "content-type": "application/json" } });
  }
  return fetch(url, options);
};
if (process.env.AXI_WAIT_TRACE === "1") {
  const fired = (delay) => {
    if (Number(delay) > 0 && JSON.parse(readFileSync(process.env.AXI_RETRY_SCENARIO, "utf8")).state === "done")
      appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin: "timer", args: [String(delay)], allowed: true, waitDelay: true }) + "\n");
  };
  const timeout = timers.setTimeout, sleep = timersPromises.setTimeout;
  const tracedSleep = async (...args) => { const value = await sleep(...args); fired(args[0]); return value; };
  const tracedTimeout = (callback, delay, ...args) => typeof callback !== "function" ? timeout(callback, delay, ...args) : timeout(function (...values) { fired(delay); return callback.apply(this, values); }, delay, ...args);
  tracedTimeout[Symbol.for("nodejs.util.promisify.custom")] = tracedSleep;
  timers.setTimeout = globalThis.setTimeout = tracedTimeout;
  timersPromises.setTimeout = tracedSleep;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === "object" ? options.host : args[1];
  const port = typeof options === "object" ? options.port : options;
  const allowed =
    host === "127.0.0.1" && String(port) === process.env.AXI_HTTP_PORT;
  record({ kind: "socket", host, port, allowed });
  if (!allowed)
    throw new Error("AXI fixture refused external network connection");
  return connect.apply(this, args);
};
const refuse = (kind) =>
  function () {
    record({ kind, allowed: false });
    throw new Error("AXI fixture refused external network connection");
  };
dgram.Socket.prototype.send = refuse("udp");
for (const api of [
  dns,
  dnsPromises,
  dns.Resolver.prototype,
  dnsPromises.Resolver.prototype,
]) {
  for (const key of Object.getOwnPropertyNames(api)) {
    if (
      key === "lookup" ||
      key === "lookupService" ||
      key === "reverse" ||
      key.startsWith("resolve")
    ) {
      api[key] = refuse(`dns:${key}`);
    }
  }
}
syncBuiltinESMExports();
if (process.env.AXI_GOOGLE_ROOT) {
  const require = createRequire(process.env.AXI_GOOGLE_ROOT + "/package.json");
  const { JWT, UserRefreshClient } = require("google-auth-library");
  for (const Client of [JWT, UserRefreshClient])
    Client.prototype.request = async function (options) {
      const inspect = options.url === "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect" && options.method === "POST" &&
        options.data?.inspectionUrl === "https://healthy.example.invalid/page" && options.data?.siteUrl === "https://healthy.example.invalid/";
      const allowed = inspect ||
        options.url ===
          "https://searchconsole.googleapis.com/webmasters/v3/sites" &&
        (!options.method || options.method === "GET");
      record({
        kind: "google-request",
        url: options.url,
        method: options.method ?? "GET",
        allowed,
      });
      if (!allowed) throw new Error("Unexpected Google fixture request");
      return {
        data: inspect ? { inspectionResult: { inspectionResultLink: "https://healthy.example.invalid/inspection", indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", googleCanonical: "https://healthy.example.invalid/page", userCanonical: "https://healthy.example.invalid/page" } } } : {
          siteEntry: [
            {
              siteUrl: "https://healthy.example.invalid/",
              permissionLevel: "siteOwner",
            },
            {
              siteUrl: "https://problem.example.invalid/",
              permissionLevel: "siteRestrictedUser",
            },
          ],
        },
      };
    };
}
