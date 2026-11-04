import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, scratch, cleanup, observe, json } from "../lib/lab.mjs";
import { checkRetry, idempotencyRows } from "../lib/idempotency.mjs";
import { commandInventory } from "../lib/command-inventory.mjs";

const tool = fileURLToPath(new URL("../fixtures/retry-tool.mjs", import.meta.url));
const scenario = (transient = false) => ({ steps: [
  { bin: "argocd", argv: ["fixture", "get"], poll: true, states: {
    initial: { stdout: "pending", ...(transient ? { next: "done" } : {}) }, done: { stdout: "done" },
  } },
  { bin: "argocd", argv: ["fixture", "set"], mutation: true, stdout: "done", next: "done" },
] });

async function run(kind, broken, transient = false, seedDone = false, timeFields = [], recover = false, firstPTY = false) {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    lab.env.AXI_RETRY_SCENARIO = join(lab.base, "scenario.json");
    lab.env.AXI_RETRY_BROKEN = broken ?? "";
    if (kind === "wait") lab.env.AXI_WAIT_TRACE = "1";
    const native = scenario(transient);
    if (recover) {
      native.steps[0].states.retryable = { stdout: "pending" };
      native.steps[1].states = { initial: { exit: 1, stderr: "fixture failure", next: "retryable" }, retryable: { stdout: "done", next: "done" } };
    }
    await json(lab.env.AXI_RETRY_SCENARIO, { ...native, state: seedDone ? "done" : "initial" });
    const observations = [];
    const result = await checkRetry({ bin: process.execPath, fixture: { kind, argv: [tool, kind === "refusal" && broken === "grant" ? "write" : kind], timeFields, native: broken === "grant" ? undefined : native, noMutation: seedDone, firstExit: recover ? 1 : undefined, firstPTY, input: firstPTY ? "y\n" : "", repeatMutation: kind === "event", firstMutations: kind === "event" ? 1 : undefined }, lab,
      invoke: async (bin, args, target, extras) => {
        const result = await observe(bin, args, target, extras); observations.push(result); return result;
      } });
    assert.equal(observations.length, 2);
    return result;
  } finally { await cleanup(root); }
}

test("read, desired write, setup, uninstall, refusal and re-entrant wait pass", async () => {
  for (const kind of ["read", "write", "setup", "uninstall", "refusal"]) await run(kind);
  await run("wait", undefined, true);
  await run("write", undefined, false, true); // retry after committed mutation / lost wrapper response
  assert.deepEqual((await run("write", undefined, false, false, [], true)).nativeMutations, [1, 2]);
  await run("write", "grant", false, false, [], false, true);
  await run("refusal", "grant");
  assert.deepEqual((await run("event")).nativeMutations, [1, 2]);
});

test("double-act and same-content rewrites are red", async () => {
  for (const kind of ["read", "write", "setup"]) await assert.rejects(run(kind, kind));
  await assert.rejects(run("write", "first-double"), /exactly the expected native transition/);
  await assert.rejects(run("write", "nested-help"), /must report already-done/);
  await assert.rejects(run("wait", "wait", true), /expected success/);
  await assert.rejects(run("wait", "wait-repoll", true), /polled again/);
  await assert.rejects(run("wait", "wait-delay", true), /positive-duration timer/);
  await assert.rejects(run("read", "read-native"), /native mutation/);
  await assert.rejects(run("event", "event-skip"), /deliberately repeatable/);
  await assert.rejects(run("read", "output"), /repeat output changed/);
  await run("read", "output", false, false, ["timestamp"]);
  const timeText = [{ path: "timer", pattern: "after \\d+s", replacement: "after <elapsed>s" }];
  await run("read", "elapsed", false, false, timeText);
  await assert.rejects(run("read", "elapsed-state", false, false, timeText), /repeat output changed/);
});

test("package installer shim rejects an unregistered install", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    const installer = await observe(join(lab.bin, "npm"), ["install", "-g", "never-install-this"], lab);
    assert.equal(installer.exit, 97);
  } finally { await cleanup(root); }
});

test("executable operation registry rejects a missing write, a read mislabeled as a write, and parent-only coverage", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    lab.packageRoot = join(root, "registered-tool");
    const sdk = join(lab.packageRoot, "node_modules", "axi-sdk-js");
    await fs.mkdir(join(lab.packageRoot, "dist", "src"), { recursive: true });
    await fs.mkdir(sdk, { recursive: true });
    await json(join(lab.packageRoot, "package.json"), { type: "module" });
    await json(join(sdk, "package.json"), { type: "module", exports: { ".": { import: "./index.mjs" } } });
    await fs.writeFile(join(sdk, "index.mjs"), 'export const runAxiCli = () => { throw new Error("SDK boundary was not intercepted"); };');
    await fs.writeFile(join(sdk, "cli.js"), 'export const RESERVED_COMMANDS = ["update"];');
    await fs.writeFile(join(lab.packageRoot, "dist", "src", "registry.js"), 'export const OPERATIONS = {"app sync": {tier:"write", argv:["app","sync"]}, "app secret": {tier:"write", argv:["app","secret"]}}; export const REFUSALS = {};');
    const bin = join(lab.packageRoot, "tool.mjs");
    await fs.writeFile(bin, '#!/usr/bin/env node\nimport {runAxiCli} from "axi-sdk-js"; await runAxiCli({commands:{apps:(args)=>args.length===1?"command: apps\\nsubcommands[1]:\\n  - secret <name>: New write\\n":"command: apps secret"},home:()=>""});');
    await fs.chmod(bin, 0o755);
    const profile = { idempotency: ["", "apps", "update"].map((route) => ({ kind: "read", route, argv: route ? [route] : [] })) };
    const options = { bin, name: "argocd-axi", profile, lab, invoke: (bin, args, target, extras) => observe(bin, args, target, extras) };
    await assert.rejects(commandInventory(options), /missing retry fixtures: apps secret/);
    profile.idempotency.push({ kind: "read", route: "apps secret", argv: ["apps", "secret"] });
    await assert.rejects(commandInventory(options), /permitted write operation: app sync/);
    const write = (verb) => ({ kind: "write", route: `apps ${verb}`, argv: ["apps", verb], operations: [`app ${verb}`], native: { steps: [{ bin: "argocd", argv: ["app", verb], mutation: true, operation: `app ${verb}` }] } });
    profile.idempotency.push(write("sync"));
    await assert.rejects(commandInventory(options), /permitted write operation: app secret/);
    profile.idempotency.push({ ...write("secret"), kind: "event" });
    await assert.rejects(commandInventory(options), /needs an event\/reconcile reason/);
    profile.idempotency.at(-1).limit = "Explicitly new delivery on every invocation";
    const result = await commandInventory(options);
    assert.equal(result.coverage.permittedWrites, 2);
    assert.equal(result.coverage.writeFixtures, 1);
    assert.equal(result.coverage.events, 1);
    // Explicit profile rows are the execution plan. Advertised help must not
    // silently add read classifications to that plan.
    const ids = [];
    await idempotencyRows({ ...options, bins: { "argocd-axi": bin }, row: async (id, body) => {
      ids.push(id);
      if (id === "idempotency-bin-inventory" || id === "idempotency-command-inventory")
        return body(lab, options.invoke);
    } });
    assert.equal(ids.length, profile.idempotency.length + 2);
  } finally { await cleanup(root); }
});

test("own executable command registry enforces declared lifecycle absence", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    lab.packageRoot = root;
    await fs.mkdir(join(root, "lib"));
    await fs.writeFile(join(root, "lib", "commands.mjs"), 'export const commands = ["static", "setup"];');
    const profile = { lifecycle: { setup: false, uninstall: false }, idempotency: ["", "static", "setup"].map((route) => ({ kind: "read", route, argv: route ? [route] : [] })) };
    await assert.rejects(commandInventory({ name: "axi-verify", profile, lab }), /setup lifecycle registration changed/);
    profile.lifecycle.setup = true;
    await assert.rejects(commandInventory({ name: "axi-verify", profile, lab }), /missing setup lifecycle fixture/);
    profile.idempotency.at(-1).kind = "setup";
    const result = await commandInventory({ name: "axi-verify", profile, lab });
    assert.deepEqual(result.coverage.lifecycle, { setup: true, uninstall: false });
  } finally { await cleanup(root); }
});
