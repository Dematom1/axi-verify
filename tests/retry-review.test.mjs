import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { coverage } from "../lib/command-inventory.mjs";
import { checkRetry } from "../lib/idempotency.mjs";
import { profiles } from "../lib/profiles.mjs";
import { scratch, sandbox, cleanup, observe, checked, json } from "../lib/lab.mjs";
import { verifyPacked } from "../lib/packed.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
async function retry(fixture, outputs, broken) {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    if (fixture.native) {
      lab.env.AXI_RETRY_SCENARIO = join(lab.base, "native.json");
      await json(lab.env.AXI_RETRY_SCENARIO, fixture.native);
    }
    if (broken) lab.env.AXI_RETRY_BROKEN = broken;
    let index = 0;
    return await checkRetry({ bin: process.execPath, fixture: { ...fixture, firstPTY: false }, lab,
      invoke: (bin, args, target, extras) => outputs
        ? observe(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(encode(outputs[index++]) + "\n")})`], target, extras)
        : observe(bin, args, target, extras),
    });
  } finally { await cleanup(root); }
}

test("registered refusals cannot be covered by a successful read fixture", () => {
  const registration = { commands: ["delete"], routes: ["delete"] };
  const registry = { writes: [], refusals: ["delete"] };
  const fixture = { kind: "read", route: "delete", argv: ["delete"] };
  const profile = { idempotency: [fixture] };
  assert.throws(() => coverage(registration, registry, profile), /missing refusal fixture.*delete/);
  fixture.kind = "refusal";
  assert.equal(coverage(registration, registry, profile).refusalEntries, 1);
});

test("time exclusions reject a missing or non-string age instead of erasing schema changes", async () => {
  const fixture = { kind: "read", argv: [], timeFields: ["workflows.*.age"] };
  const first = { workflows: [{ name: "probe", age: "1m" }] };
  for (const second of [{ workflows: [{ name: "probe" }] }, { workflows: [{ name: "probe", age: {} }] }])
    await assert.rejects(retry(fixture, [first, second]), /time field.*age/);
  await retry(fixture, [first, { workflows: [{ name: "probe", age: "2m" }] }]);
  const wait = profiles["argocd-axi"].idempotency.find((f) => f.kind === "wait" && !f.case);
  await retry({ ...wait, argv: [] }, [{ wait: "condition met after 1s", app: { operation: "Succeeded" } },
    { wait: "condition met after 2s", app: { operation: "Succeeded" } }]);
});

test("new writable grant must exist after the first invocation, not just be reported", async () => {
  const fixture = profiles["argocd-axi"].idempotency.find((f) => f.case === "new-grant");
  const output = { status: "already-done", writableContexts: ["probe"] };
  await assert.rejects(retry({ ...fixture, argv: [] }, [output, output]), /grant|ENOENT/);
});

test("refresh reconciliation must submit another native refresh on retry", async () => {
  const native = { steps: [
    { bin: "argocd", argv: ["fixture", "get"], states: { initial: { stdout: "pending" }, done: { stdout: "done" } } },
    { bin: "argocd", argv: ["fixture", "set"], mutation: true, stdout: "done", next: "done" },
  ] };
  for (const refresh of profiles["argocd-axi"].idempotency.filter((f) => f.kind === "reconcile")) {
    const fixture = { ...refresh, native, operations: [], argv: [fileURLToPath(new URL("../fixtures/retry-tool.mjs", import.meta.url)), "event"] };
    await assert.rejects(retry(fixture, undefined, "event-skip"), /deliberately repeatable/);
    assert.deepEqual((await retry(fixture)).nativeMutations, [1, 2]);
  }
});

test("retry state must equal the fixture's current value, including asynchronous native phase", async () => {
  const fixture = { kind: "write", argv: [], noMutation: true, native: { state: "done", steps: [] }, reportedState: { fields: ["state"], value: "done" } };
  for (const state of ["pending", null, {}])
    await assert.rejects(retry(fixture, [{ state: "done" }, { status: "in-progress", state }]), /reported state/);
  await retry(fixture, [{ state: "done" }, { status: "already-done", state: "done" }]);
  const asynchronous = { ...fixture, native: { state: "done", steps: [{ bin: "argo", argv: ["get", "probe"], stdout: { status: { phase: "Running" } } }] }, reportedState: { fields: ["phase"], source: "status.phase" } };
  await retry(asynchronous, [{ phase: "Running" }, { status: "in-progress", phase: "Running" }]);
  await assert.rejects(retry(asynchronous, [{ phase: "Running" }, { status: "in-progress", phase: "Pending" }]), /reported state/);
  const sync = profiles["argocd-axi"].idempotency.find((f) => f.argv[1] === "sync" && f.case === "already-satisfied");
  const current = { status: "already-done", observedRevision: "0123456789abcdef0123456789abcdef01234567" };
  await retry({ ...sync, argv: [] }, [current, current]);
  await assert.rejects(retry({ ...sync, argv: [] }, [current, { ...current, observedRevision: "0123456" }]), /reported state/);
});

async function ownArchive(root) {
  const packed = JSON.parse((await checked("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, timeout: 60_000 })).stdout);
  return join(root, packed[0].filename);
}

test("own packed profile rejects a stable but incorrect executable version", async () => {
  const root = await scratch();
  try {
    const archive = await ownArchive(root), unpack = join(root, "wrong");
    await fs.mkdir(unpack);
    await checked("tar", ["-xzf", archive, "-C", unpack]);
    const entry = join(unpack, "package", "bin", "axi-verify.mjs");
    const source = await fs.readFile(entry, "utf8"), end = source.indexOf("\n") + 1;
    await fs.writeFile(entry, source.slice(0, end) + 'if (["--version","-v","-V"].includes(process.argv[2])) { console.log("0.0.0"); process.exit(0); }\n' + source.slice(end));
    const modified = join(root, "wrong.tgz");
    await checked("tar", ["-czf", modified, "-C", unpack, "package"], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" } });
    const result = await verifyPacked({ tarball: modified, evidenceDir: join(root, "evidence") });
    assert.equal(result.passed, false, "a repeatable wrong version is still wrong");
    assert(result.failures.some((r) => r.error.includes("version must equal installed manifest")), JSON.stringify(result.failures));
  } finally { await cleanup(root); }
});

test("finish includes an unexpected HTTP request outside every row slice and preserves evidence", async () => {
  const root = await scratch();
  try {
    const archive = await ownArchive(root), evidence = join(root, "evidence");
    const code = `
      import http from 'node:http'; import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module'; import {basename} from 'node:path';
      let server, injected = false;
      const create = http.createServer;
      http.createServer = (...args) => (server = create(...args));
      const write = fs.writeFile;
      fs.writeFile = async (path, ...args) => {
        if (!injected && String(path).startsWith(${JSON.stringify(evidence)}) && /^\\d{3}-/.test(basename(String(path)))) {
          injected = true;
          await (await fetch('http://127.0.0.1:' + server.address().port + '/unexpected-between-rows')).text();
        }
        return write(path, ...args);
      };
      syncBuiltinESMExports();
      const {verifyPacked} = await import(${JSON.stringify(new URL("../lib/packed.mjs", import.meta.url).href)});
      const result = await verifyPacked({tarball:${JSON.stringify(archive)},evidenceDir:${JSON.stringify(evidence)}});
      console.log(JSON.stringify({passed:result.passed, unexpectedHttp:result.unexpectedHttp, failures:result.failures}));
    `;
    const child = await checked(process.execPath, ["--input-type=module", "-e", code], { timeout: 180_000 });
    const result = JSON.parse(child.stdout);
    assert.equal(result.failures.length, 0, "the injected request must fall outside all row slices");
    assert.equal(result.passed, false, "unclaimed unexpected HTTP must fail the whole run");
    assert.equal(result.unexpectedHttp.length, 1);
    assert.equal(JSON.parse(await fs.readFile(join(evidence, "summary.json"), "utf8")).passed, false);
    assert(JSON.parse(await fs.readFile(join(evidence, "http-requests.json"), "utf8")).some((r) => !r.allowed));
  } finally { await cleanup(root); }
});
