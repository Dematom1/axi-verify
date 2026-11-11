import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { cleanup, sandbox, scratch } from "../lib/lab.mjs";
import { seedBehaviour } from "../fixtures/behaviour.mjs";
import { adapters } from "../fixtures/adapters.mjs";
import { argoWorkflows, argocdApps, datadogMonitorSearch, googleSites } from "../fixtures/adapter-replies.mjs";

const named = Object.entries(adapters).filter(([, adapter]) => adapter.identity);

test("each adapter seeds a collection above every list cap, a single record, and none", async () => {
  for (const [fixture] of named) {
    const root = await scratch();
    try {
      const sizes = {};
      for (const mode of ["normal", "small", "empty"]) {
        const lab = await sandbox(root); lab.packageRoot = root; lab.key = `${root}/key.json`;
        const seeded = await seedBehaviour(lab, { fixture }, mode);
        sizes[mode] = seeded.data.identities.length;
        assert.deepEqual(seeded.expected(["list"]).identities, seeded.data.identities);
      }
      assert.deepEqual(sizes, { normal: 105, small: 1, empty: 0 }, fixture);
    } finally { await cleanup(root); }
  }
});

test("renaming the first record changes live home state to a different identity", async () => {
  for (const [fixture, adapter] of named) {
    const root = await scratch();
    try {
      const lab = await sandbox(root); lab.packageRoot = root; lab.key = `${root}/key.json`;
      const seeded = await seedBehaviour(lab, { fixture }, "normal");
      const before = seeded.data.identities[0], changed = await seeded.changeHome();
      assert.equal(changed.present, adapter.renamed); assert.equal(changed.absent, before);
      assert.equal(JSON.parse(await fs.readFile(lab.env.AXI_BEHAVIOUR_DATA, "utf8")).identities[0], adapter.renamed);
    } finally { await cleanup(root); }
  }
});

test("backend replies carry every seeded record, problems first, from the seeded data", () => {
  const data = { identities: Array.from({ length: 105 }, (_, i) => adapters["argo-workflows"].identity(i)), mode: "normal" };
  const workflows = argoWorkflows(data), phases = workflows.map((w) => w.status.phase);
  assert.equal(workflows.length, 105);
  assert.deepEqual(workflows.map((w) => w.metadata.name), data.identities);
  assert.deepEqual(phases.slice(0, 4), ["Failed", "Failed", "Failed", "Succeeded"]);
  assert.equal(argocdApps({ ...data, identities: data.identities.slice(0, 2) })[0].status.health.status, "Degraded");
  assert.equal(googleSites({ identities: ["https://a.example.invalid/"] }).siteEntry[0].permissionLevel, "siteOwner");
});

test("datadog monitor search pages through the seeded collection with a structured total", () => {
  const data = { identities: Array.from({ length: 105 }, (_, i) => String(1000 + i)), mode: "normal" };
  const page = datadogMonitorSearch(data, new URL("http://x.invalid/api/v1/monitor/search?page=2&per_page=50"));
  assert.equal(page.monitors.length, 5); assert.equal(page.metadata.total_count, 105);
  assert.equal(datadogMonitorSearch(data, new URL("http://x.invalid/api/v1/monitor/search?per_page=50")).monitors.length, 50);
});

test("external fixture subprocess emits documented Argo list records", async () => {
  const root = await scratch();
  try {
    const script = new URL("../fixtures/external.mjs", import.meta.url);
    for (const [fixture, bin, args, firstNames, health] of [
      ["argo-workflows", "argo", ["list", "--output=json", "--loglevel=error"], ["wf-item000", "wf-item001", "wf-item002"], "Failed"],
      ["argocd", "argocd", ["app", "list", "-o", "json"], ["app-item000", "app-item001", "app-item002"], "Degraded"],
    ]) {
      const lab = await sandbox(root); lab.packageRoot = root; lab.key = `${root}/key.json`;
      await seedBehaviour(lab, { fixture }, "normal");
      const executable = `${root}/${bin}`;
      await fs.symlink(script, executable);
      const result = spawnSync(process.execPath, [executable, ...args], { encoding: "utf8", env: { ...process.env, ...lab.env } });
      assert.equal(result.status, 0, result.stderr);
      const records = JSON.parse(result.stdout);
      assert.equal(records.length, 105);
      assert.deepEqual(records.slice(0, 3).map((record) => record.metadata.name), firstNames);
      assert(records.slice(0, 3).every((record) => (record.status.phase ?? record.status.health.status) === health));
      assert.equal(records[3].status.phase ?? records[3].status.health.status, fixture === "argo-workflows" ? "Succeeded" : "Healthy");
    }
  } finally { await cleanup(root); }
});
