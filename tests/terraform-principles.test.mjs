import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { behaviourRows, nextCommands } from "../lib/behaviours.mjs";
import { cleanup, observe, processResult, sandbox, scratch } from "../lib/lab.mjs";
import { noUnexpectedIO } from "../lib/observations.mjs";
import { profiles } from "../lib/profiles.mjs";
const evidence = new URL("./terraform-0.1.3/", import.meta.url);
const metadata = JSON.parse(await fs.readFile(new URL("provenance.json", evidence), "utf8"));

test("retained terraform-axi tarball and review outputs retain exact provenance", async () => {
  for (const item of metadata.files) assert.equal(createHash("sha256").update(await fs.readFile(new URL(item.file, evidence))).digest("hex"), item.sha256, item.file);
  assert.equal(metadata.files.find((f) => f.file.endsWith(".tgz")).sha256, "6b123e987640bb539143b300dcde120e9a5bff1aa1c92ae47c0cedbefdd78ee9");
});

const recorded = async (label) => decode(await fs.readFile(new URL(label + ".stdout", evidence), "utf8"));
test("six reviewed principles have recorded counterexamples", async (t) => {
  await t.test("2: plan defaults exceed four columns", async () => assert.equal(Object.keys((await recorded("plan-default")).changes[0]).length, 6));
  await t.test("3: full state list still omits resources", async () => { const value = await recorded("state-list-full"); assert.equal(value.resources.length, 100); assert.equal(value.total, 105); });
  await t.test("6: doctor accepts a flag-shaped directory", () => assert.equal(metadata.files.find((f) => f.file === "doctor-bad-flag-existing-dir.stdout").exit, 0));
  await t.test("7: unrelated cwd receives configured module", async () => assert((await recorded("ambient-context")).terraform_axi.modules.length));
  await t.test("9: state list lacks a complete next command", async () => assert.deepEqual(nextCommands(await recorded("state-list"), "terraform-axi"), []));
  await t.test("10: help with plan input exits 2", () => assert.equal(metadata.files.find((f) => f.file === "plan-help-with-input.stdout").exit, 2));
});

test("packed behaviours reject each of the six failures in the exact published 0.1.3 artifact", async (t) => {
  const root = await scratch(), results = [];
  try {
    const archive = fileURLToPath(new URL("terraform-axi-0.1.3.tgz", evidence));
    assert.equal((await processResult("tar", ["-xzf", archive, "-C", root])).exit, 0);
    const packageRoot = join(root, "package");
    // npm ci supplies this pinned published package's exact runtime dependencies;
    // the executable files below still come from the SHA-256-verified tarball.
    await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
    const manifest = JSON.parse(await fs.readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.gitHead, metadata.gitHead);
    const bins = Object.fromEntries(Object.entries(manifest.bin).map(([name, path]) => [name, join(packageRoot, path)]));
    // npm's bin-link step supplies executable bits omitted by this archive.
    for (const executable of Object.values(bins)) await fs.chmod(executable, 0o755);
    const row = async (id, body, custom, principles) => {
      const lab = await sandbox(root), commands = [];
      lab.packageRoot = packageRoot; lab.evidence = join(root, "evidence");
      await fs.mkdir(lab.evidence, { recursive: true });
      const invoke = async (bin, argv, target = lab, extras) => {
        const result = await observe(bin, argv, target, extras); commands.push(result);
        assert(!result.failure, result.failure); return result;
      };
      let error, observations;
      try { observations = await body(lab, invoke); await noUnexpectedIO(lab); } catch (failure) { error = failure.message; }
      results.push({ id, principles, status: error ? "failed" : "passed", error, observations, commands });
    };
    await behaviourRows({ profile: profiles[manifest.name], bin: bins[manifest.name], bins, row, name: manifest.name, manifest });
    const expectFailure = async (principle, id, reason) => t.test(`principle ${principle}: ${id}`, () => {
      const result = results.find((r) => r.id === "principle-" + id);
      assert(result, `missing published-artifact check ${id}`);
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.match(result.error, reason, "must fail on the reviewed behaviour, not a prerequisite");
      assert(result.commands.length, "historical proof must execute the packed CLI");
    });
    assert.equal(results.find((r) => r.id === "principle-contract").status, "passed");
    await expectFailure(2, "minimal-schema-1", /default list field set differs/);
    await expectFailure(3, "text-truncation-0", /original size/);
    await expectFailure(3, "row-truncation-1", /missing complete next command/);
    await expectFailure(3, "full-output-1", /every fixture identity/);
    await expectFailure(6, "flag-directory-doctor", /expected exit 2, got 0/);
    await expectFailure(6, "usage-doctor-explain", /expected exit 2, got 1/);
    await expectFailure(7, "ambient-scope", /unrelated directory/);
    await expectFailure(9, "next-commands-list-0", /missing complete next command/);
    await expectFailure(10, "help-precedence-plan", /expected success/);
    await expectFailure(10, "command-help-plan", /help missing flag|help missing default|examples/);
    await expectFailure(10, "version-graph", /loaded the command graph/);
  } finally { await cleanup(root); }
});
