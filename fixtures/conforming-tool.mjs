#!/usr/bin/env node
// A tiny already-satisfied tool used only to exercise axi-verify's packed command.
import * as fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.AXI_INVENTORY_CAPTURE) {
  const { captureRegistry } = await import(process.env.AXI_INVENTORY_CAPTURE);
  const names = ["ctx", "auth", "whoami", "can-i", "apps", "projects", "appsets", "repos", "clusters", "setup", "context", "update"];
  await captureRegistry({ commands: Object.fromEntries(names.map((name) => [name, async () => ""])), home: true });
  process.exit(0);
}
const refusals = JSON.parse(fs.readFileSync(new URL("./refusals.json", import.meta.url), "utf8"));
const refusal = refusals.find((route) => (route.exit !== 2 || route.argv.length === args.length) && route.argv.every((part, index) => args[index] === part));
if (refusal) {
  console.log(`error: refused\ncode: ${refusal.code ?? "REFUSED"}`); process.exit(refusal.exit ?? 1);
}
if (process.env.AXI_RETRY_SCENARIO) {
  const scenario = JSON.parse(fs.readFileSync(process.env.AXI_RETRY_SCENARIO, "utf8"));
  const failure = scenario.steps.find((step) => step.stderr?.includes("Unauthenticated"));
  if (failure) {
    try { execFileSync(failure.bin, failure.argv, { stdio: "pipe" }); } catch {}
    console.log("error: fixture authentication failed\ncode: UPSTREAM_ERROR"); process.exit(1);
  }
  const mutation = scenario.steps.find((step) => step.mutation);
  const poll = scenario.steps.find((step) => step.poll && step.states?.initial?.next);
  if (!mutation && args.includes("wait") && poll)
    for (let count = scenario.state === "done" ? 1 : 2; count > 0; count--)
      execFileSync(poll.bin, poll.argv, { stdio: "pipe" });
  const read = scenario.steps.find((step) => step.states?.initial && step.states?.done);
  const satisfied = read && JSON.stringify(read.states.initial) === JSON.stringify(read.states.done);
  const repeatable = args.includes("refresh") || satisfied && (args.includes("restart") || args.includes("custom"));
  if (mutation && (repeatable || !satisfied && ["initial", "retryable"].includes(scenario.state ?? "initial"))) {
    if (read?.poll) execFileSync(read.bin, read.argv, { stdio: "pipe" });
    try { execFileSync(mutation.bin, mutation.argv, { stdio: "pipe" }); }
    catch (error) {
      const current = JSON.parse(fs.readFileSync(process.env.AXI_RETRY_SCENARIO, "utf8"));
      if (read?.poll && current.state === "done" && /no operation/i.test(error.stderr?.toString() ?? ""))
        execFileSync(read.bin, read.argv, { stdio: "pipe" });
      else { console.log("error: fixture native failure\ncode: UPSTREAM_ERROR"); process.exit(1); }
    }
  }
}
const directory = join(process.env.XDG_CONFIG_HOME, "argocd-axi");
const writeOnce = (file, text) => {
  if (!fs.existsSync(file)) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, text); }
};
if (args.join(" ") === "ctx writable add probe") {
  const file = join(directory, "config");
  if (!fs.existsSync(file)) {
    if (!process.stdin.isTTY) { console.log("error: terminal required\ncode: REFUSED"); process.exit(1); }
    const buffer = Buffer.alloc(32);
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!/^y(?:es)?\s*$/i.test(buffer.subarray(0, count).toString())) process.exit(1);
    writeOnce(file, "writable-contexts: [probe]\n");
  }
}
if (args.join(" ") === "ctx writable remove probe") {
  const file = join(directory, "config");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("[probe]")) fs.writeFileSync(file, "writable-contexts: []\n");
}
if (args.join(" ") === "setup hooks") writeOnce(join(directory, "integration"), "installed\n");
if (args.join(" ") === "setup uninstall") fs.rmSync(join(directory, "integration"), { force: true });
if (args.join(" ") === "context end") writeOnce(join(directory, "session"), "fixture\n");
const manifest = () => JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
if (args[0] === "update" && process.env.AXI_UPDATE_GLOBAL_ROOT && manifest().version !== process.env.AXI_REGISTRY_VERSION) {
  try { execFileSync("npm", ["install", "-g", `${manifest().name}@latest`], { stdio: "pipe" }); }
  catch { console.log("error: fixture installer failed\ncode: UPSTREAM_ERROR"); process.exit(1); }
}
console.log(`status: already-done\nstate: desired\nupdate: already on the latest version (${manifest().version})`);
