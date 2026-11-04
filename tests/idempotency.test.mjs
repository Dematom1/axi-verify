import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, scratch, cleanup, observe, json } from "../lib/lab.mjs";
import { checkRetry } from "../lib/idempotency.mjs";
import { profiles } from "../lib/profiles.mjs";
import { advertisedRoutes, commandInventory } from "../lib/command-inventory.mjs";

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

test("keyring and package installers cannot reach host state", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    lab.env.AXI_KEYRING_STATE = join(lab.base, "keyring.json");
    await json(lab.env.AXI_KEYRING_STATE, {});
    const result = await observe(process.execPath, ["--input-type=module", "-e", `
      import { AsyncEntry } from '@napi-rs/keyring';
      const entry = new AsyncEntry('fixture', 'account');
      await entry.setPassword('synthetic');
      console.log(await entry.getPassword());
    `], lab);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.stdout.trim(), "synthetic");
    assert.equal(JSON.parse(await fs.readFile(lab.env.AXI_KEYRING_STATE, "utf8"))["fixture:account"], "synthetic");
    const installer = await observe(join(lab.bin, "npm"), ["install", "-g", "never-install-this"], lab);
    assert.equal(installer.exit, 97);
  } finally { await cleanup(root); }
});

test("registry coverage rejects a newly registered nested command", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root), bin = join(lab.bin, "inventory-fixture");
    lab.packageRoot = root;
    await fs.writeFile(bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({routes:["", "read", "group", "group add", "update"]}));\n');
    await fs.chmod(bin, 0o755);
    const profile = { idempotency: [[], ["read"], ["group"], ["update", "--check"]].map((argv) => ({ kind: "read", argv })) };
    const options = { bin, name: "fixture", profile, lab, invoke: (bin, args, target, extras) => observe(bin, args, target, extras) };
    await assert.rejects(commandInventory(options), /missing retry fixtures: group add/);
    profile.idempotency.push({ kind: "write", argv: ["group", "add"] });
    assert((await commandInventory(options)).routes.includes("group add"));
    assert.deepEqual(advertisedRoutes('command: tool group\nsubcommands[1]:\n  - add <name>: Create a thing\n', "group", ["group"], "tool"), ["group", "group add"]);
  } finally { await cleanup(root); }
});

test("every owned tool declares retry rows; tools with no writes have none", () => {
  assert.equal(Object.keys(profiles).length, 7);
  for (const profile of Object.values(profiles)) assert(profile.idempotency.some((r) => r.kind === "read"));
  assert(!profiles["axi-verify"].idempotency.some((r) => r.kind === "write"));
});
