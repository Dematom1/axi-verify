import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { commandWords, nextCommands } from "../lib/behaviours.mjs";
import { readContract, validateContract } from "../lib/contract.mjs";
import { cleanup, scratch } from "../lib/lab.mjs";
const own = JSON.parse(await fs.readFile(new URL("../.axi/verify.json", import.meta.url), "utf8"));
const copy = () => structuredClone(own);

test("manifest requires explicit per-route data and rejects malformed declarations", () => {
  assert.equal(validateContract(copy(), "axi-verify").schema, 1);
  for (const mutate of [
    (c) => { c.schema = 2; }, (c) => { c.typo = true; }, (c) => { c.fixture = "arbitrary-shell"; },
    (c) => { c.commands.push(c.commands[0]); }, (c) => { delete c.commands[0].flags; },
    (c) => { c.commands[0].flags["--tarball"] = "maybe"; }, (c) => { c.commands[0].operands.max = -1; },
    (c) => { delete c.commands[0].defaults; }, (c) => { c.commands[0].examples = []; },
    (c) => { c.cases.typo = {}; }, (c) => { delete c.cases.home; },
    (c) => { c.graph = ["../foreign.js"]; }, (c) => { c.cases.failure[0].fault = "live-cloud"; },
    (c) => { c.cases.failure.pop(); },
    (c) => { c.unsupported[0].reason = ""; },
  ]) { const value = copy(); mutate(value); assert.throws(() => validateContract(value, "axi-verify")); }
});

test("a different package cannot borrow verifier-only inapplicable capabilities", () => {
  const value = copy(); value.package = "terraform-axi";
  for (const command of value.commands) for (const example of command.examples) example[0] = "terraform-axi";
  assert.throws(() => validateContract(value, "terraform-axi"), /fixture.*package/);
});

test("missing data fails rather than silently falling back to another version", async () => {
  const root = await scratch();
  try { await assert.rejects(readContract(root, { contract: { legacy: {} } }, { name: "k8s-axi", version: "0.1.0" }), /unconfigured contract for k8s-axi@0.1.0/); }
  finally { await cleanup(root); }
});

test("a dangling archive manifest is invalid, not permission to use a legacy manifest", async () => {
  const root = await scratch();
  try {
    await fs.mkdir(join(root, ".axi")); await fs.mkdir(join(root, "dist/src"), { recursive: true });
    await fs.writeFile(join(root, "dist/src/cli.js"), "// graph fixture");
    await fs.symlink(join(root, "missing.json"), join(root, ".axi/verify.json"));
    await assert.rejects(readContract(root, { contract: { legacy: { "0.1.3": "./legacy-contracts/terraform-axi-0.1.3.json" } } }, { name: "terraform-axi", version: "0.1.3" }), /invalid|dangling/);
  } finally { await cleanup(root); }
});

test("next commands preserve quoted paths and are never shell programs", () => {
  assert.deepEqual(commandWords("tool view '/a path/file' --full"), ["tool", "view", "/a path/file", "--full"]);
  assert.deepEqual(commandWords(String.raw`tool view '/a path/quo'\''te' --full`), ["tool", "view", "/a path/quo'te", "--full"]);
  assert.deepEqual(commandWords(String.raw`tool view /a\ path/file --full`), ["tool", "view", "/a path/file", "--full"]);
  assert.deepEqual(nextCommands({ help: ["Run `tool view <id> --context probe` to inspect"] }, "tool"), [["tool", "view", "<id>", "--context", "probe"]]);
  assert.deepEqual(nextCommands({ help: ["Add `--full`", "see help"] }, "tool"), []);
  for (const value of ["tool x; rm x", "tool $(whoami)", "tool 'unfinished", "tool x | cat"]) assert.throws(() => commandWords(value));
});
