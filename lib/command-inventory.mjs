import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { normalUnchanged, successful } from "./observations.mjs";

// Help discovers additional read/help routes only. It never declares operations
// or gives a write fixture credit for exercising a registered operation.
export function advertisedRoutes(text, parent, roots, name) {
  const routes = new Set();
  const add = (signature, relative = false) => {
    signature = signature.trim().replace(/^- /, "");
    if (signature.startsWith(name + " ")) signature = signature.slice(name.length + 1);
    const route = /^[a-z][a-z-]*(?: [a-z][a-z-]*)*/.exec(signature)?.[0];
    if (!route) return;
    const top = route.split(" ")[0];
    if (!roots.includes(top) && !relative) return;
    const full = roots.includes(top) ? route : `${parent} ${route}`;
    if (roots.includes(full.split(" ")[0])) routes.add(full);
  };
  const usage = (value) => {
    for (const part of value.split(" | ")) {
      add(part, true);
      // `setup hooks|status|uninstall` names three sibling routes.
      const alternatives = /^((?:[a-z][a-z-]* )*)([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)/.exec(part.replace(new RegExp(`^${name} `), ""));
      if (alternatives) for (const alternative of alternatives[2].split("|")) add(alternatives[1] + alternative, true);
    }
  };
  let data;
  try { data = decode(text); } catch { /* Presentation help is also supported. */ }
  if (data && typeof data === "object") {
    for (const key of ["usage", "command"]) if (typeof data[key] === "string") usage(data[key]);
    // Some tools put their whole reference in one encoded `help` string.
    if (typeof data.help === "string" && data.help !== text) for (const found of advertisedRoutes(data.help, parent, roots, name)) routes.add(found);
    for (const key of ["subcommands", "commands", "help"]) if (Array.isArray(data[key]))
      for (const item of data[key]) if (typeof item === "string" && item.includes(":")) {
        const signature = item.split(":")[0];
        if (key === "commands") usage(signature);
        else add(signature, key === "subcommands");
      }
  }
  for (const match of text.matchAll(/^(?:usage|command): (.+)$/gm)) usage(match[1]);
  for (const block of text.matchAll(/^subcommands\[\d+\]:[^\n]*\n((?:[ \t].*(?:\n|$))*)/gm))
    for (const line of block[1].split("\n")) if (line.includes(":")) add(line.split(":")[0], true);
  // `<group>[N]:` lists a registered command's own subcommands (terraform-axi `setup[3]:`).
  for (const block of text.matchAll(/^([a-z][a-z-]*)\[\d+\]:[^\n]*\n((?:[ \t].*(?:\n|$))*)/gm))
    if (roots.includes(block[1])) for (const line of block[2].split("\n")) if (line.includes(":")) add(`${block[1]} ${line.split(":")[0].trim()}`);
  return [...routes];
}

// Import the installed package's executable operation tables directly. Never
// accept operation IDs or access tiers from tool stdout or from help text.
export async function backendRegistry(name, packageRoot) {
  const load = (path) => import(pathToFileURL(join(packageRoot, path)).href);
  if (["argocd-axi", "argo-workflows-axi", "datadog-axi", "k8s-axi"].includes(name)) {
    const source = "dist/src/registry.js", registry = await load(source);
    const entries = name === "datadog-axi" ? registry.WRITE_OPERATIONS.map((op) => [op.id, op]) : Object.entries(registry.OPERATIONS ?? {});
    const writes = entries.filter(([, op]) => op.tier === "write" || op.access === "write").map(([id, op]) => ({ id, bin: op.bin ?? "argocd", argv: op.command ?? op.argv }));
    if (name === "k8s-axi") {
      assert.equal(typeof registry.assertSafe, "function");
      assert.throws(() => registry.assertSafe(["apply", "-f", "fixture.yaml"]));
    }
    return { source, writes, refusals: registry.REFUSALS,
      ...(name === "datadog-axi" ? { refusalMatches: (refusal, argv) => argv[0] === "api" && argv.length === 3 &&
        registry.createRegistry([], [refusal]).match(argv[1], argv[2]).kind === "refused" } : {}),
    };
  }
  if (name === "terraform-axi") {
    const source = "dist/src/runner.js", registry = await load(source);
    assert.throws(() => registry.assertAllowed(["apply"]));
    return { source, writes: [], refusals: [], zeroWriteWitness: "apply rejected by executable runner; SDK command map also checked" };
  }
  assert(["search-console-axi", "axi-verify"].includes(name), `missing operation-registry adapter for ${name}`);
  return { source: name === "axi-verify" ? "lib/commands.mjs" : "dist/bin/search-console-axi.js", writes: [], refusals: [], zeroWriteWitness: "executable command registry has no backend-write handler; local mutations classified separately" };
}

// Resolve the backend operation from the call log's actual executable/argv,
// never the route or a fixture-supplied operation label. Two Argo operations
// share `submit`: deterministic resubmit carries its reserved resubmit-key label.
export function nativeOperations(call, operations) {
  return operations.filter((op) => {
    if (call.bin !== op.bin || !op.argv?.every((part, i) => call.args[i] === part)) return false;
    if (op.id === "app refresh") return call.args.some((arg) => ["--refresh", "--hard-refresh"].includes(arg));
    if (["wf.submit", "wf.resubmit"].includes(op.id)) {
      const resubmit = call.args.some((arg) => typeof arg === "string" && arg.startsWith("--labels=axi.argoproj.io/resubmit-key="));
      return op.id === (resubmit ? "wf.resubmit" : "wf.submit");
    }
    return true;
  }).map((op) => op.id);
}

export function coverage(registration, registry, profile) {
  const fixtures = profile.idempotency.filter((f) => !f.binName && !f.argv.includes("--help"));
  const missingRoutes = registration.routes.filter((route) => !fixtures.some((f) => f.route === route) &&
    !(["event", "reconcile", "group"].includes(profile.classifications?.[route]?.kind) && profile.classifications[route].reason));
  assert.equal(missingRoutes.length, 0, `unclassified commands or missing retry fixtures: ${missingRoutes.join(", ")}`);
  const refusalEntries = Array.isArray(registry.refusals)
    ? registry.refusals.map((refusal) => [typeof refusal === "string" ? refusal : `${refusal.method} ${refusal.path}`, refusal])
    : Object.entries(registry.refusals);
  for (const [id, refusal] of refusalEntries) {
    const matches = (fixture) => !Array.isArray(registry.refusals) || typeof refusal === "string"
      ? fixture.route === id : registry.refusalMatches?.(refusal, fixture.argv);
    assert(fixtures.some((fixture) => fixture.kind === "refusal" && matches(fixture)), `missing refusal fixture: ${id}`);
  }
  const records = registry.writes.map((operation) => {
    const cases = fixtures.filter((f) => f.operations?.includes(operation.id) && ["write", "event", "reconcile"].includes(f.kind));
    assert(cases.length, `missing retry fixture for permitted write operation: ${operation.id}`);
    for (const fixture of cases) {
      if (fixture.kind !== "write") assert(fixture.limit, `operation ${operation.id} needs an event/reconcile reason`);
      assert(fixture.native?.steps.some((s) => s.mutation && nativeOperations({ bin: s.bin, args: s.argv }, registry.writes).includes(operation.id)),
        `operation ${operation.id} has no matching native mutation fixture`);
    }
    return { ...operation, classes: [...new Set(cases.map((f) => f.kind))], reasons: [...new Set(cases.map((f) => f.limit).filter(Boolean))] };
  });
  const ids = new Set(registry.writes.map((op) => op.id));
  for (const fixture of fixtures) for (const id of fixture.operations ?? []) assert(ids.has(id), `fixture names an unregistered write operation: ${id}`);
  const localWrites = (profile.localWrites ?? []).map((route) => {
    assert(fixtures.some((f) => f.route === route && ["write", "setup", "uninstall"].includes(f.kind)), `missing local-write fixture: ${route}`);
    return route;
  });
  const lifecycle = { setup: registration.commands.includes("setup"), uninstall: registration.commands.includes("uninstall") };
  for (const [command, expected] of Object.entries(profile.lifecycle ?? {}))
    assert.equal(lifecycle[command], expected, `${command} lifecycle registration changed; declare and fixture it`);
  for (const [command, present] of Object.entries(lifecycle)) if (present)
    assert(fixtures.some((f) => f.kind === command), `missing ${command} lifecycle fixture`);
  return { source: registry.source, permittedWrites: records.length, writeFixtures: records.filter((r) => r.classes.includes("write")).length,
    reconcile: records.filter((r) => r.classes.includes("reconcile")).length, events: records.filter((r) => r.classes.includes("event")).length,
    operations: records, localWrites, refusalEntries: Object.keys(registry.refusals).length,
    refusalFixtures: new Set(fixtures.filter((f) => f.kind === "refusal").map((f) => JSON.stringify(f.argv))).size,
    registeredCommands: registration.commands, lifecycle, zeroWriteWitness: registry.zeroWriteWitness, classifications: profile.classifications ?? {} };
}

// Routes of a tool that dispatches its own commands: its exported `commands` and their `subcommands`.
export function exportedRegistration({ commands }) {
  assert(Array.isArray(commands) && commands.every((c) => typeof c?.name === "string"), "tool exports no command registry");
  const names = commands.map((c) => c.name);
  return { commands: names, routes: ["", ...commands.flatMap((c) => [c.name, ...Object.keys(c.subcommands ?? {}).map((sub) => `${c.name} ${sub}`)])].sort() };
}

export async function commandRegistration({ bin, name, lab, invoke }) {
  let registration;
  if (name === "axi-verify") {
    const { commands } = await import(pathToFileURL(join(lab.packageRoot, "lib/commands.mjs")).href);
    registration = { commands, routes: ["", ...commands] };
  } else {
    let sdk;
    const require = createRequire(lab.packageRoot + "/package.json");
    for (const directory of require.resolve.paths("axi-sdk-js")) {
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(join(directory, "axi-sdk-js", "package.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const entry = manifest.exports?.["."]?.import ?? manifest.main;
      assert(typeof entry === "string" && entry.startsWith("./"), "cannot resolve SDK's import entry");
      sdk = join(directory, "axi-sdk-js", entry);
      break;
    }
    assert(sdk, "cannot resolve executable SDK command registry");
    const result = await invoke(bin, ["--help"], lab, { env: { ...lab.env,
      AXI_INVENTORY_SDK: sdk, AXI_INVENTORY_ROOT: lab.packageRoot,
      AXI_INVENTORY_CAPTURE: new URL("../fixtures/inventory.mjs", import.meta.url).href,
    } });
    successful(result); normalUnchanged(result);
    // A tool with its own dispatcher never reaches the SDK's runAxiCli, so its help is not the capture.
    try { registration = JSON.parse(result.stdout); } catch { registration = undefined; }
    if (registration) {
      assert(Array.isArray(registration.commands) && Array.isArray(registration.routes), "SDK registration was not captured");
      const { RESERVED_COMMANDS } = await import(pathToFileURL(join(dirname(sdk), "cli.js")).href);
      registration.commands = [...new Set([...registration.commands, ...RESERVED_COMMANDS])];
    } else registration = exportedRegistration(await import(pathToFileURL(join(lab.packageRoot, "dist/src/cli.js")).href));
  }
  return registration;
}

export async function commandInventory({ bin, name, profile, lab, invoke }) {
  const registration = await commandRegistration({ bin, name, lab, invoke });
  const registry = await backendRegistry(name, lab.packageRoot);
  const report = coverage(registration, registry, profile);
  return { ...registration, registry, coverage: report };
}
