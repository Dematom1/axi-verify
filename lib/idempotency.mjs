import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checked } from "./lab.mjs";
import { noUnexpectedIO, successful } from "./observations.mjs";
import { commandInventory, nativeOperations } from "./command-inventory.mjs";

// Observation logs and native fixture state are not wrapper-owned state.
export async function ownedState(lab) {
  const files = {};
  async function walk(root, prefix = "") {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = join(root, entry.name), key = join(prefix, entry.name);
      if ([lab.env.AXI_FIXTURE_LOG, lab.env.AXI_NETWORK_LOG, lab.env.AXI_RETRY_SCENARIO, lab.env.AXI_KEYRING_STATE].includes(file)) continue;
      const stat = await fs.lstat(file, { bigint: true });
      if (entry.isDirectory()) {
        files[key] = { mode: String(stat.mode), type: "directory" };
        await walk(file, key);
      }
      else files[key] = {
        mode: String(stat.mode), mtimeNs: String(stat.mtimeNs),
        content: entry.isSymbolicLink() ? await fs.readlink(file) :
          createHash("sha256").update(await fs.readFile(file)).digest("hex"),
      };
    }
  }
  await walk(lab.base);
  return files;
}

function normalized(value, fields) {
  const copy = structuredClone(value);
  for (const field of fields) {
    const path = typeof field === "string" ? field : field.path;
    function remove(node, parts) {
      assert(node && typeof node === "object", `missing time field ${path}`);
      const [key, ...rest] = parts;
      for (const name of key === "*" ? Object.keys(node) : [key]) {
        assert(Object.hasOwn(node, name), `missing time field ${path}`);
        if (rest.length) remove(node[name], rest);
        else {
          assert.equal(typeof node[name], "string", `time field ${path} must be a string`);
          if (typeof field === "string") delete node[name];
          else node[name] = node[name].replace(new RegExp(field.pattern, "g"), field.replacement);
        }
      }
    }
    remove(copy, path.split("."));
  }
  return copy;
}

function sameState(actual, expected, message) {
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]));
  assert.equal(changed.length, 0, `${message}: ${changed.join(", ")}`);
}

const valueAt = (value, path) => path.split(".").reduce((node, key) => node?.[key], value);
const diagnosticKeys = ["help", "suggestions", "usage", "error", "code"];
async function assertReportedState(output, fixture, lab) {
  if (fixture.sdkUpdate) {
    const update = output.update, version = lab.env.AXI_REGISTRY_VERSION;
    assert(typeof update === "string" ? update.endsWith(`(${version})`) : update?.current === version && update?.latest === version,
      "retry reported state must match the current installed version");
    return;
  }
  const native = lab.env.AXI_RETRY_SCENARIO ? JSON.parse(await fs.readFile(lab.env.AXI_RETRY_SCENARIO, "utf8")) : undefined;
  const declared = typeof fixture.reportedState === "function" ? await fixture.reportedState(lab, native) :
    fixture.reportedState ?? { fields: ["state"], value: native?.state };
  const rules = (Array.isArray(declared) ? declared : [declared]).map((rule) => {
    let expected = rule.value;
    if (rule.source) {
      const replies = native?.steps.filter((step) => !step.mutation).map((step) => (step.states?.[native.state ?? "initial"] ?? step).stdout) ?? [];
      expected = replies.map((body) => valueAt(body, rule.source)).find((value) => value !== undefined);
    }
    assert(expected !== undefined, "fixture must declare an expected reported state");
    return { fields: rule.fields, expected };
  });
  const matches = (node) => node && typeof node === "object" && Object.entries(node).some(([key, value]) =>
    !diagnosticKeys.includes(key) && (rules.some((rule) => rule.fields.includes(key) && isDeepStrictEqual(value, rule.expected)) || matches(value)));
  assert(matches(output), `retry reported state must match ${JSON.stringify(rules.map((rule) => rule.expected))}`);
}

export async function checkRetry({ bin, fixture, lab, invoke, writeOperations = [] }) {
  const { kind, timeFields = [] } = fixture;
  assert(["read", "write", "wait", "setup", "uninstall", "reconcile", "event", "refusal", "error"].includes(kind), `unknown retry class ${kind}`);
  const executable = fixture.bin ?? bin;
  const argv = fixture.argv.map((arg) => arg === "SPEC" ? join(lab.cwd, "fixture.yaml") : arg);
  const mutations = (rows) => rows.filter((r) => r.mutation === true);
  const before = await ownedState(lab), initialIO = await noUnexpectedIO(lab), initialCalls = initialIO.subprocess;
  const firstBin = fixture.firstPTY
    ? (await checked("which", ["python3"], { env: { PATH: process.env.PATH } })).stdout.trim()
    : executable;
  const firstArgs = fixture.firstPTY
    ? ["-I", "-S", fileURLToPath(new URL("../fixtures/pty.py", import.meta.url)), executable, ...argv]
    : argv;
  const extras = { input: fixture.input ?? "", timeout: fixture.timeout ?? 20_000 };
  const first = await invoke(firstBin, firstArgs, lab, extras);
  const state = await ownedState(lab), firstIO = await noUnexpectedIO(lab), firstCalls = firstIO.subprocess;
  const firstNativeState = lab.env.AXI_RETRY_SCENARIO ? JSON.parse(await fs.readFile(lab.env.AXI_RETRY_SCENARIO, "utf8")).state : undefined;
  let firstStateError;
  if (first.exit === 0 && !fixture.firstExit) {
    try { await fixture.assertFirstState?.(lab); } catch (error) { firstStateError = error; }
  }
  const second = await invoke(executable, argv, lab, extras);
  const after = await ownedState(lab), secondIO = await noUnexpectedIO(lab), secondCalls = secondIO.subprocess;
  first.ownedBefore = before; first.ownedAfter = state;
  second.ownedBefore = state; second.ownedAfter = after;
  if (firstStateError) throw firstStateError;
  // Ordinary command failures still have a second invocation in the evidence.
  if (kind === "error") {
    assert.notEqual(first.exit, 0, "upstream failure was swallowed");
    assert.equal(second.exit, first.exit, "upstream failure became a successful no-op");
    assert(first.decoded?.code || first.decoded?.error?.code, "failure must remain structured");
    assert(firstCalls.slice(initialCalls.length).some((call) => call.nativeExit === 1), "first call never reached the upstream failure fixture");
    assert(secondCalls.slice(firstCalls.length).some((call) => call.nativeExit === 1), "retry never reached the upstream failure fixture");
  } else if (kind === "refusal") {
    assert.equal(first.exit, fixture.exit ?? 1);
    assert.equal(second.exit, first.exit);
    assert.equal(first.decoded?.code, fixture.code ?? "REFUSED");
    assert.equal(second.decoded?.code, first.decoded?.code);
    assert.equal(secondCalls.length + secondIO.network.length, initialCalls.length + initialIO.network.length, "refusal called a dependency");
  } else {
    if (fixture.firstExit) {
      assert.equal(first.exit, fixture.firstExit, "uncommitted native failure was swallowed");
      assert.equal(firstNativeState, "retryable", "first failure did not reach the uncommitted native fixture");
      assert(first.decoded && typeof first.decoded === "object", "native failure must remain structured");
      sameState(state, before, "failed native write changed wrapper state");
    } else successful(first);
    successful(second);
  }
  if (kind === "write" && !fixture.firstExit && !fixture.noMutation && fixture.native?.steps.some((step) => step.mutation && fixture.native.steps.some((read) => read.states?.done)))
    assert.equal(firstNativeState, "done", "first write did not establish the fixture's desired state");
  if (fixture.expectNativeState)
    assert.equal(JSON.parse(await fs.readFile(lab.env.AXI_RETRY_SCENARIO, "utf8")).state, fixture.expectNativeState, "wait returned before the fixture condition held");
  if (fixture.recheckAfterMutation) {
    const observed = firstCalls.slice(initialCalls.length), index = observed.findLastIndex((call) => call.mutation);
    assert(index >= 0 && observed.slice(index + 1).some((call) => call.poll), "native no-op race must be re-read before success");
  }
  const expectedFirst = fixture.firstMutations ?? (kind === "write" && fixture.native?.steps.filter((step) => step.mutation).length === 1 ? Number(!fixture.noMutation) : undefined);
  if (expectedFirst !== undefined)
    assert.equal(mutations(firstCalls).length - mutations(initialCalls).length, expectedFirst, "first write must perform exactly the expected native transition");
  if (fixture.noMutation)
    assert.equal(mutations(secondCalls).length, mutations(initialCalls).length, "satisfied/partial state submitted a mutation");
  if (["read", "wait", "refusal", "error"].includes(kind)) {
    sameState(state, before, "first read changed wrapper state");
    sameState(after, before, "retry changed wrapper state");
    assert.equal(mutations(secondCalls).length, mutations(initialCalls).length, "read submitted a native mutation");
    assert.equal(second.stderr, first.stderr, "repeat diagnostics changed");
    if (timeFields.length)
      for (const result of [first, second]) assert(!result.decodeError && result.decoded && typeof result.decoded === "object", "time-field exclusions require structured output");
    assert.deepEqual(
      timeFields.length ? normalized(second.decoded, timeFields) : second.stdout,
      timeFields.length ? normalized(first.decoded, timeFields) : first.stdout,
      "repeat output changed (only documented time fields may differ)",
    );
  } else {
    if (!fixture.firstExit) sameState(after, state, "retry rewrote wrapper state (contents, mode or mtime)");
    if (fixture.repeatMutation)
      assert.equal(mutations(secondCalls).length - mutations(firstCalls).length, fixture.repeatMutations ?? 1, "completed/custom event must remain deliberately repeatable");
    if (!["reconcile", "event"].includes(kind)) {
      if (fixture.firstExit) {
        assert.equal(mutations(secondCalls).length - mutations(firstCalls).length, 1, "uncommitted failure must remain retryable");
        assert.equal(JSON.parse(await fs.readFile(lab.env.AXI_RETRY_SCENARIO, "utf8")).state, "done", "retry did not establish the desired state");
      } else assert.equal(mutations(secondCalls).length, mutations(firstCalls).length, "retry submitted an extra native mutation");
      if (kind === "write" && !fixture.firstExit) {
        assert(!second.decodeError && second.decoded && typeof second.decoded === "object", "retry needs structured output");
        assert(!second.decoded.error, "successful retry must not contain a structured error");
        const statusPattern = fixture.sdkUpdate ? /already on the latest version/ : /^(already-done|in-progress)(?:$|[: ])/;
        const reportsStatus = (value) => typeof value === "string"
          ? statusPattern.test(value)
          : value && typeof value === "object" && Object.entries(value).some(([key, child]) => !["help", "suggestions", "usage", "error", "code"].includes(key) && reportsStatus(child));
        assert(reportsStatus(second.decoded), "retry must report already-done or in-progress and current state");
        await assertReportedState(second.decoded, fixture, lab);
      }
    }
  }
  const firstOperations = [...new Set(firstCalls.slice(initialCalls.length).flatMap((call) => nativeOperations(call, writeOperations)))];
  const repeatedOperations = [...new Set(secondCalls.slice(firstCalls.length).flatMap((call) => nativeOperations(call, writeOperations)))];
  if (!fixture.noMutation) for (const id of fixture.operations ?? []) {
    assert(firstOperations.includes(id), `first invocation did not exercise registered operation ${id}`);
    if (kind === "event") assert(repeatedOperations.includes(id), `repeat did not exercise event operation ${id}`);
  }
  if (kind === "wait") {
    const repeated = secondCalls.slice(firstCalls.length);
    const reads = repeated.filter((r) => r.poll).map((r) => JSON.stringify([r.bin, r.args]));
    assert.equal(new Set(reads).size, reads.length, "satisfied wait polled again instead of returning immediately");
    assert(!repeated.some((r) => r.waitDelay), "satisfied wait paid a positive-duration timer");
  }
  return { kind, argv, timeFields, firstState: state, repeatedState: after,
    nativeMutations: [mutations(firstCalls).length, mutations(secondCalls).length],
    observedOperations: [firstOperations, repeatedOperations],
    limit: fixture.limit };
}

export async function idempotencyRows({ profile, bin, bins, row, name }) {
  assert(profile.idempotency, "profile must declare its idempotency fixture inventory");
  await row("idempotency-bin-inventory", async () => {
    const declared = [name, ...profile.idempotency.map((fixture) => fixture.binName).filter(Boolean)];
    assert.deepEqual(Object.keys(bins).sort(), [...new Set(declared)].sort(), "each installed bin needs an explicit retry classification");
    return { bins: declared };
  });
  let writeOperations = [];
  await row("idempotency-command-inventory", async (lab, invoke) => {
    const inventory = await commandInventory({ bin, name, profile, lab, invoke });
    writeOperations = inventory.registry.writes;
    return inventory;
  });
  for (const [index, fixture] of profile.idempotency.entries()) {
    await row(`idempotency-${fixture.kind}-${index}-${(fixture.binName ?? (fixture.argv.slice(0, 3).join("-") || "home")).replace(/[^A-Za-z0-9_-]+/g, "-")}${fixture.case ? `-${fixture.case}` : ""}`,
      async (lab, invoke) => {
        const seeded = fixture.seed ? await fixture.seed(lab, invoke, bin) : undefined;
        if (fixture.kind === "wait") lab.env.AXI_WAIT_TRACE = "1";
        if (fixture.native) {
          lab.env.AXI_RETRY_SCENARIO = join(lab.base, "retry-scenario.json");
          const native = JSON.parse(JSON.stringify(fixture.native), (key, value) => value === "SPEC" ? join(lab.cwd, "fixture.yaml") : value);
          await fs.writeFile(lab.env.AXI_RETRY_SCENARIO, JSON.stringify(native));
        }
        return checkRetry({ bin: fixture.binName ? bins[fixture.binName] : bin, fixture: { ...fixture, ...seeded }, lab, invoke, writeOperations });
      });
  }
}
