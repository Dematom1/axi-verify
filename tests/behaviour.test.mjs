import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { cleanup, json, observe, processResult, sandbox, scratch } from "../lib/lab.mjs";
import { verifyPacked } from "../lib/packed.mjs";
import { behaviourRows } from "../lib/behaviours.mjs";
import { noUnexpectedIO } from "../lib/observations.mjs";
import { profiles } from "../lib/profiles.mjs";

const checks = ["structured-output", "minimal-schema", "text-truncation", "row-truncation", "list-total", "aggregates", "empty-state", "operational-error", "usage", "flag-directory", "no-prompts", "readonly", "unreadable-input", "ambient-scope", "lifecycle-capture", "content-home", "next-commands", "help-precedence", "command-help", "version-graph", "full-output", "no-truncation-hint"];
const flags = { "--help": "boolean", "--input": "value", "--full": "boolean", "--fields": "value", "--limit": "value", "--empty": "boolean", "--detail": "boolean", "--context-view": "boolean", "--capture": "boolean" };
const contract = {
  schema: 1, package: "axi-verify", fixture: "contract-fixture", graph: ["lib/graph.mjs"],
  commands: ["static", "packed"].map((route) => ({ route: [route], flags,
    operands: { min: 0, max: 0 }, probe: [route],
    defaults: { "--full": false, "--limit": 2 },
    examples: [["axi-verify", route], ["axi-verify", route, "--limit", "1"]],
  })),
  cases: {
    home: { argv: [], markers: ["project-a"] },
    list: [{ argv: ["static"], collection: "/records", fields: ["id", "title", "status"], total: "/total",
      expanded: { argv: ["static", "--fields", "id,title,status,age"], fields: ["id", "title", "status", "age"] },
      next: [["axi-verify", "static", "--detail"]] }],
    empty: { list: 0, argv: ["static", "--empty"] },
    failure: [{ argv: ["static", "--input", "{plan}"], fault: "missing-file", code: "FILE_ERROR", next: [["axi-verify", "static", "--help"]] },
      { argv: ["static", "--input", "{plan}"], fault: "unreadable-file", code: "FILE_ERROR", next: [["axi-verify", "static", "--help"]] }],
    truncation: [
      { argv: ["static", "--detail"], kind: "text", value: "/body", size: "/size", cap: 200, full: ["static", "--detail", "--full"], next: [["axi-verify", "static", "--detail", "--full"]] },
      { argv: ["static"], kind: "rows", value: "/records", size: "/total", cap: 2, full: ["static", "--full"], next: [["axi-verify", "static", "--full"]] },
    ],
    readonly: [[], ["static"]],
    ambient: { bin: "axi-verify", argv: ["static", "--context-view"], scope: "directory" },
  }, unsupported: [],
};

async function fixture(root, broken = "") {
  const source = join(root, "package");
  await fs.mkdir(join(source, "lib"), { recursive: true });
  await json(join(source, "package.json"), { name: "axi-verify", version: "0.1.0", type: "module", bin: { "axi-verify": "cli.mjs" } });
  await fs.copyFile(new URL("./behaviour/cli.mjs", import.meta.url), join(source, "cli.mjs"));
  await fs.chmod(join(source, "cli.mjs"), 0o755);
  await fs.copyFile(new URL("../node_modules/@toon-format/toon/dist/index.mjs", import.meta.url), join(source, "toon.mjs"));
  await fs.writeFile(join(source, "broken.txt"), broken);
  await fs.writeFile(join(source, "lib/graph.mjs"), "export const loaded = true;\n");
  await fs.writeFile(join(source, "lib/commands.mjs"), 'export const commands = ["packed", "static"];\n');
  await json(join(source, ".axi/verify.json"), contract);
  const archive = join(root, "fixture.tgz");
  assert.equal((await processResult("tar", ["-czf", archive, "-C", root, "package"])).exit, 0);
  return archive;
}

async function runFixture(broken = "") {
  const root = await scratch();
  try {
    const tarball = await fixture(root, broken);
    if (!broken) return await verifyPacked({ tarball, evidenceDir: join(root, "evidence") });
    // One full packed run above proves wiring. Broken controls exercise the same
    // rows on an extracted archive without rerunning unrelated legacy checks.
    assert.equal((await processResult("tar", ["-xzf", tarball, "-C", root])).exit, 0);
    const packageRoot = join(root, "package"), bin = join(packageRoot, "cli.mjs"), rows = [];
    const selected = broken === "stale-home" ? "content-home" : broken === "help-defaults" ? "command-help" : broken;
    const row = async (id, body) => {
      if (id !== "principle-contract" && !id.startsWith(`principle-${selected}`)) return;
      const lab = await sandbox(root); lab.packageRoot = packageRoot; lab.evidence = join(root, "evidence");
      await fs.mkdir(lab.evidence, { recursive: true });
      let error;
      try { await body(lab, (bin, argv, target = lab, extras) => observe(bin, argv, target, extras)); await noUnexpectedIO(lab); }
      catch (failure) { error = failure.message; }
      rows.push({ id, status: error ? "failed" : "passed", error });
    };
    await behaviourRows({ profile: profiles["axi-verify"], bin, bins: { "axi-verify": bin }, row, name: "axi-verify", manifest: { name: "axi-verify", version: "0.1.0" } });
    return { rows };
  } finally { await cleanup(root); }
}
const rowsFor = (summary, check) => summary.rows.filter((row) => row.id === `principle-${check}` || row.id.startsWith(`principle-${check}-`));

test("packed manifest drives every principle check on the minimal fixed fixture", async (t) => {
  const summary = await runFixture();
  assert.equal(summary.passed, true, JSON.stringify(summary.failures));
  assert(summary.principleCoverage.every((p) => p.passed), "fixed fixture must cover all ten principles");
  for (const check of checks) await t.test(check, () => {
    const rows = rowsFor(summary, check);
    assert(rows.length, `packed runner omitted ${check}`);
    assert(rows.every((row) => row.status === "passed"), JSON.stringify(rows));
  });
});

const reasons = {
  "structured-output": /stdout must be a structured TOON object/,
  "minimal-schema": /default list field set differs/,
  "text-truncation": /truncation must state original size/,
  "row-truncation": /full output must return every fixture identity/,
  "list-total": /total must report original collection size/,
  aggregates: /incorrect aggregate \/aggregate\/open/,
  "empty-state": /empty state needs explicit zero context/,
  "operational-error": /expected exit 1, got 0/,
  usage: /expected exit 2, got 1/,
  "flag-directory": /expected exit 2, got 0/,
  "no-prompts": /interactive prompt on required-input failure/,
  readonly: /EACCES[^\n]*implicit-setup/,
  "unreadable-input": /expected exit 1, got 0/,
  "ambient-scope": /ambient context leaks an unrelated directory/,
  "lifecycle-capture": /SessionEnd must persist independently observable capture/,
  "content-home": /home must show live fixture marker project-a/,
  "next-commands": /missing complete next command/,
  "help-precedence": /expected success:[\s\S]*unknown flag or extra operand --axi-unknown-flag/,
  "command-help": /help missing default --full=false/,
  "version-graph": /bare version loaded the command graph/,
  "full-output": /--full must return the exact original text/,
  "no-truncation-hint": /untruncated default output must not suggest a full-output escape hatch/,
};
assert.deepEqual(Object.keys(reasons), checks, "every negative control needs an expected reason");

function expectControlFailure(summary, check, reason = reasons[check]) {
  const rows = rowsFor(summary, check), failed = rows.filter((row) => row.status === "failed");
  assert(rows.length, `packed runner omitted ${check}`);
  assert(failed.length, `${check} accepted its broken fixture`);
  assert(failed.some((row) => reason.test(row.error)), `${check}: unrelated failure: ${JSON.stringify(failed)}`);
}

test("negative controls cannot get credit for an unrelated prerequisite failure", () => {
  assert.throws(() => expectControlFailure({ rows: [{ id: "principle-no-prompts-static", status: "failed", error: "spawn python3 ENOENT" }] }, "no-prompts"), /unrelated failure/);
});

test("content-first home must change when the live fixture changes", async () => {
  const summary = await runFixture("stale-home");
  expectControlFailure(summary, "content-home", /home must change with live fixture state/);
});

test("help examples do not substitute for documented defaults", async () => {
  const summary = await runFixture("help-defaults");
  expectControlFailure(summary, "command-help", /help missing default --limit=2/);
});

for (const check of checks) test(`packed negative control: ${check}`, async () => {
  const summary = await runFixture(check);
  expectControlFailure(summary, check);
});
