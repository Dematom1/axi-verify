import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { advertisedRoutes, exportedRegistration } from "../lib/command-inventory.mjs";
import { applicable, helpVariants } from "../lib/behaviours.mjs";
import { validateContract } from "../lib/contract.mjs";
import { sessionEndReported } from "../lib/observations.mjs";
import { kubernetesReply } from "../fixtures/kubernetes.mjs";
import { datadogReply } from "../fixtures/datadog.mjs";
import { profiles } from "../lib/profiles.mjs";

// Pinned from terraform-axi 0.1.5, the version the sweep found these false
// positives against. See tests/terraform-0.1.5/provenance.json.
const pinned = (file) => fs.readFile(new URL(`./terraform-0.1.5/${file}`, import.meta.url), "utf8");
const roots = ["plan", "drift", "lint", "doctor", "state", "setup"];

test("nested subcommands in the top-level help text are registered routes", async () => {
  const routes = advertisedRoutes(await pinned("top-help.stdout"), "", roots, "terraform-axi");
  for (const route of ["setup hooks", "setup status", "setup uninstall"]) assert(routes.includes(route), `missing ${route}: ${routes}`);
  assert(!routes.includes("summary plan"), "summary lines are not routes");
});

test("a usage line's `a|b|c` alternatives are registered routes", async () => {
  const routes = advertisedRoutes(await pinned("setup-help.stdout"), "setup", roots, "terraform-axi");
  for (const route of ["setup hooks", "setup status", "setup uninstall"]) assert(routes.includes(route), `missing ${route}: ${routes}`);
});

const command = (route, probe, flags = {}) => ({ route, flags: { "--help": "boolean", ...flags }, operands: { min: 0, max: null }, probe, defaults: {}, examples: [] });

test("a parent route is not compared against help for the child route its probe invokes", () => {
  const state = command(["state"], ["state", "list", "{module}"], { "--full": "boolean" });
  const list = command(["state", "list"], ["state", "list", "{module}"]);
  const parentOnly = helpVariants(state, [state, list]).map((args) => args.join(" "));
  assert(parentOnly.length, "parent keeps its own help variants");
  assert(parentOnly.every((args) => !args.startsWith("state list")), `child probe leaked into parent: ${parentOnly}`);
  const childAlone = helpVariants(list, [state, list]).map((args) => args.join(" "));
  assert(childAlone.includes("state list {module} --help"), "the child still checks its own probe");
});

test("a leaf route keeps every help variant", () => {
  const plan = command(["plan"], ["plan", "--plan-json", "{plan}"], { "--plan-json": "value" });
  const variants = helpVariants(plan, [plan]).map((args) => args.join(" "));
  assert(variants.includes("plan --plan-json {plan} --help"));
  assert(variants.includes("plan --plan-json {plan} --axi-unknown-flag --help"));
  assert(variants.includes("plan --plan-json --help"));
});

test("a manifest can declare the lifecycle capture invocation", () => {
  const base = { schema: 1, package: "terraform-axi", fixture: "terraform-local", graph: ["dist/src/cli.js"], commands: [{ ...command(["plan"], ["plan"]), examples: [["terraform-axi", "plan"], ["terraform-axi", "plan", "--help"]] }], unsupported: [] };
  const cases = (ambient) => ({
    home: { argv: [], markers: ["project-a"] }, list: [{ argv: ["plan"], collection: "/changes", fields: ["address"], total: "/n", next: [["terraform-axi", "plan"]] }],
    empty: { list: 0 }, failure: ["missing-file", "unreadable-file"].map((fault) => ({ argv: ["plan"], fault, code: "X", next: [["terraform-axi", "plan"]] })),
    truncation: [{ argv: ["plan"], kind: "rows", value: "/changes", size: "/n", cap: 1, full: ["plan", "--full"], next: [["terraform-axi", "plan", "--full"]] }],
    readonly: [[]], ambient,
  });
  const ambient = { bin: "terraform-axi-ctx", argv: [], scope: "directory", capture: ["--capture"] };
  assert.deepEqual(validateContract({ ...base, cases: cases(ambient) }, "terraform-axi").cases.ambient.capture, ["--capture"]);
  assert.throws(() => validateContract({ ...base, cases: cases({ ...ambient, capture: "--capture" }) }, "terraform-axi"), /capture must be argv strings/);
});

test("SessionEnd output is judged by structure, not by the word `recorded`", () => {
  assert.doesNotThrow(() => sessionEndReported({ stdout: "captured: true\nsession: s1\n", decoded: { captured: true, session: "s1" } }));
  assert.doesNotThrow(() => sessionEndReported({ stdout: "status: recorded\n", decoded: { status: "recorded" } }));
  assert.throws(() => sessionEndReported({ stdout: "", decoded: undefined }), /SessionEnd did not report/);
  assert.throws(() => sessionEndReported({ stdout: "error: boom\n", decoded: { error: "boom" } }), /SessionEnd did not report/);
});

test("kubectl logs fixture serves the --tail=101 request k8s-axi uses to detect truncation", () => {
  const args = (tail) => ["logs", "healthy", "-n", "default", "-c", "app", `--tail=${tail}`, "--limit-bytes=1048576", "--context=probe", "--request-timeout=15000ms"];
  assert.equal(kubernetesReply(args(100)), "fixture log\n");
  assert.equal(kubernetesReply(args(101)), "fixture log\n");
  assert.equal(kubernetesReply(args(102)), undefined);
});

test("ambient context is not applicable to a tool that installs no hooks, and only to such a tool", () => {
  const contract = { cases: {}, fixture: "search-console", unsupported: [{ check: "ambient", status: "not-applicable", reason: "installs no hooks" }] };
  assert.deepEqual(applicable(contract, "ambient", { hooks: [] }), { notApplicable: "installs no hooks" });
  assert.throws(() => applicable(contract, "ambient", { hooks: ["claude:SessionStart"] }), /unconfigured ambient/);
  assert.throws(() => applicable(contract, "list", { hooks: [] }), /unconfigured list/);
});

test("a tool that dispatches its own commands is inventoried from its exported registry", () => {
  const registration = exportedRegistration({ commands: [{ name: "setup", subcommands: { check: "", status: "" } }, { name: "report" }] });
  assert.deepEqual(registration.commands, ["setup", "report"]);
  assert.deepEqual(registration.routes, ["", "report", "setup", "setup check", "setup status"]);
  assert.throws(() => exportedRegistration({}), /exports no command registry/);
});

test("profiles and the datadog stub cover what the packed tools actually use", () => {
  assert(profiles["argocd-axi"].codes.includes("FILE_ERROR"), "argocd-axi reports FILE_ERROR for unreadable hook files");
  for (const path of ["/api/v2/ci/pipelines/events", "/api/v2/ci/tests/events"]) assert.deepEqual(datadogReply("GET", path), { data: [] });
  for (const route of ["ci pipelines", "ci tests", "ci view"]) assert(profiles["datadog-axi"].idempotency.some((f) => f.route === route), `datadog-axi ${route} needs a retry fixture`);
});
