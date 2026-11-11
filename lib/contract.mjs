import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { adapters } from "../fixtures/adapters.mjs";

const keys = (value, allowed, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${label}: unknown field ${key}`);
};
const strings = (value, label, nonempty = false) => {
  assert(Array.isArray(value) && value.every((s) => typeof s === "string" && !s.includes("\0")), `${label} must be argv strings`);
  if (nonempty) assert(value.length, `${label} must not be empty`);
};
const pointer = (value) => assert(typeof value === "string" && /^\/(?:[^~]|~[01])*$/.test(value), `invalid JSON Pointer ${value}`);
const templates = (value) => { assert(Array.isArray(value) && value.length, "next requires complete command templates"); value.forEach((v) => strings(v, "next command", true)); };
export const fixtures = Object.keys(adapters);
export const caseNames = ["home", "list", "empty", "failure", "truncation", "readonly", "ambient"];

export function validateContract(contract, name) {
  keys(contract, ["schema", "package", "fixture", "commands", "cases", "graph", "unsupported"], "manifest");
  assert.equal(contract.schema, 1, "unsupported .axi/verify.json schema");
  assert.equal(contract.package, name, "contract package differs from installed package");
  assert(fixtures.includes(contract.fixture), `unknown fixture ${contract.fixture}`);
  assert.equal(adapters[contract.fixture]?.package, name, "fixture does not belong to this package");
  strings(contract.graph, "graph", true);
  for (const path of contract.graph) assert(!isAbsolute(path) && !path.split(/[\\/]/).includes(".."), "graph must stay inside installed package");
  assert(Array.isArray(contract.commands) && contract.commands.length, "commands must declare route data");
  const routes = new Set();
  for (const command of contract.commands) {
    keys(command, ["route", "flags", "operands", "probe", "defaults", "examples"], "command");
    strings(command.route, "route", true);
    assert(command.route.every((part) => /^[a-z][a-z0-9-]*$/.test(part)), "invalid command route");
    const route = command.route.join(" ");
    assert(!routes.has(route), `duplicate route ${route}`); routes.add(route);
    keys(command.flags, Object.keys(command.flags ?? {}), "flags");
    for (const [flag, type] of Object.entries(command.flags)) assert(/^--?[a-zA-Z][a-zA-Z0-9-]*$/.test(flag) && ["boolean", "value"].includes(type), `invalid flag declaration ${flag}`);
    assert.equal(command.flags["--help"], "boolean", "every route must declare --help");
    keys(command.operands, ["min", "max"], "operands");
    assert(Number.isSafeInteger(command.operands.min) && command.operands.min >= 0, "invalid operand min");
    assert(command.operands.max === null || Number.isSafeInteger(command.operands.max) && command.operands.max >= command.operands.min, "invalid operand max");
    strings(command.probe, "probe", true);
    assert(command.route.every((part, i) => command.probe[i] === part), "probe must invoke its route");
    keys(command.defaults, Object.keys(command.defaults ?? {}), "defaults");
    assert(Object.values(command.defaults).every((v) => ["string", "number", "boolean"].includes(typeof v)), "defaults must be scalar values");
    assert(Array.isArray(command.examples) && command.examples.length >= 2 && command.examples.length <= 3, "help needs 2–3 examples");
    for (const example of command.examples) { strings(example, "example", true); assert(example[0] === name && command.route.every((part, i) => example[i + 1] === part), "example must be a complete command for its route"); }
  }
  keys(contract.cases, caseNames, "cases");
  assert(Array.isArray(contract.unsupported), "unsupported must be explicit");
  for (const item of contract.unsupported) {
    keys(item, ["check", "status", "reason"], "unsupported");
    assert(typeof item.check === "string" && ["not-applicable", "unconfigured"].includes(item.status) && typeof item.reason === "string" && item.reason.trim(), "unsupported needs check, status, reason");
  }
  const c = contract.cases;
  for (const name of caseNames) {
    if (Object.hasOwn(c, name)) assert(c[name], `case ${name} must contain data; omit it and declare unsupported instead`);
    else assert(contract.unsupported.some((u) => u.check === name), `missing case ${name}: declare unconfigured, never silently skip`);
  }
  if (c.home) { keys(c.home, ["argv", "markers"], "home"); strings(c.home.argv, "home argv"); strings(c.home.markers, "home markers", true); }
  if (c.list) {
    assert(Array.isArray(c.list) && c.list.length, "list cases must not be empty");
    for (const item of c.list) {
      keys(item, ["argv", "collection", "fields", "total", "expanded", "next", "aggregates"], "list");
      strings(item.argv, "list argv", true); pointer(item.collection); pointer(item.total); strings(item.fields, "list fields", true); templates(item.next);
      if (Object.hasOwn(item, "expanded")) { keys(item.expanded, ["argv", "fields"], "expanded"); strings(item.expanded.argv, "expanded argv", true); strings(item.expanded.fields, "expanded fields", true); }
      if (Object.hasOwn(item, "aggregates")) { keys(item.aggregates, Object.keys(item.aggregates ?? {}), "aggregates"); for (const [path, key] of Object.entries(item.aggregates)) { pointer(path); assert(typeof key === "string", "aggregate expected key must be a fixture value"); } }
    }
  }
  if (c.empty) { keys(c.empty, ["list", "argv"], "empty"); assert(Number.isSafeInteger(c.empty.list) && c.list?.[c.empty.list], "empty references missing list"); if (Object.hasOwn(c.empty, "argv")) strings(c.empty.argv, "empty argv", true); }
  for (const name of ["failure", "truncation"]) if (c[name]) {
    assert(Array.isArray(c[name]) && c[name].length, `${name} cases must not be empty`);
    for (const item of c[name]) {
      keys(item, name === "failure" ? ["argv", "fault", "code", "next"] : ["argv", "kind", "value", "size", "cap", "full", "next"], name);
      strings(item.argv, `${name} argv`, true); templates(item.next);
      if (name === "failure") assert(["missing-file", "unreadable-file", "backend-denied"].includes(item.fault) && typeof item.code === "string" && item.code, "invalid failure fault/code");
      else { assert(["text", "rows"].includes(item.kind), "invalid truncation kind"); pointer(item.value); pointer(item.size); assert(Number.isSafeInteger(item.cap) && item.cap > 0, "invalid cap"); strings(item.full, "full argv", true); }
    }
  }
  if (["terraform-local", "axi-verify", "contract-fixture"].includes(contract.fixture)) {
    for (const fault of ["missing-file", "unreadable-file"]) assert(c.failure?.some((item) => item.fault === fault), `file-consuming fixture requires an explicit ${fault} case`);
  }
  if (c.readonly) { assert(Array.isArray(c.readonly) && c.readonly.length, "readonly must list commands"); c.readonly.forEach((a) => strings(a, "readonly argv")); }
  if (c.ambient) { keys(c.ambient, ["bin", "argv", "scope", "capture"], "ambient"); assert(typeof c.ambient.bin === "string" && ["directory", "project-root"].includes(c.ambient.scope), "invalid ambient declaration"); strings(c.ambient.argv, "ambient argv"); if (Object.hasOwn(c.ambient, "capture")) strings(c.ambient.capture, "ambient capture", true); }
  return contract;
}

export async function readContract(packageRoot, profile, manifest) {
  const file = join(packageRoot, ".axi", "verify.json");
  let text, source = "installed:.axi/verify.json", present = true;
  try { await fs.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
  if (present) {
    let path;
    try { path = await fs.realpath(file); } catch (error) { throw new Error(`invalid or dangling archive contract: ${error.message}`); }
    assert(path.startsWith(await fs.realpath(packageRoot) + "/"), "contract symlink escapes package");
    assert((await fs.stat(path)).size <= 1024 * 1024, "contract exceeds 1 MiB");
    text = await fs.readFile(path, "utf8");
  } else {
    const legacy = profile.contract?.legacy?.[manifest.version];
    assert(legacy, `unconfigured contract for ${manifest.name}@${manifest.version}: pack .axi/verify.json or declare a pinned legacy manifest`);
    text = await fs.readFile(new URL(legacy, import.meta.url), "utf8"); source = `legacy:${manifest.name}@${manifest.version}`;
  }
  assert(Buffer.byteLength(text) <= 1024 * 1024, "contract exceeds 1 MiB");
  const contract = validateContract(JSON.parse(text), manifest.name);
  for (const graph of contract.graph) {
    const path = await fs.realpath(resolve(packageRoot, graph));
    assert(path.startsWith(await fs.realpath(packageRoot) + "/"), "graph symlink escapes package");
  }
  return { ...contract, source };
}
