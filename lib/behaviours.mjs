import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checked, deniedProbe, lock, snapshot } from "./lab.mjs";
import { noUnexpectedIO, normalUnchanged, structuredFailure, successful } from "./observations.mjs";
import { commandRegistration } from "./command-inventory.mjs";
import { readContract } from "./contract.mjs";
import { expand, seedBehaviour } from "../fixtures/behaviour.mjs";

export function at(value, pointer) {
  return pointer.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~")).reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, value);
}
function structured(result) {
  assert(!result.failure, result.failure);
  assert(!result.decodeError && result.decoded && typeof result.decoded === "object" && !Array.isArray(result.decoded), "stdout must be a structured TOON object");
  assert(!/\n\s+at \S+.*:\d+:\d+/.test(result.stdout + result.stderr), "raw stack trace leaked");
}
function failure(result, codes, exit) {
  structured(result); structuredFailure(result, codes, exit);
  assert(strings(result.decoded.error ?? result.decoded.message).some((s) => s.trim()), "structured error must explain what went wrong");
}
function missingValue(command, flag) {
  const argv = [];
  for (let i = 0; i < command.probe.length; i++) {
    if (command.probe[i] === flag) { i++; continue; }
    argv.push(command.probe[i]);
  }
  return [...argv, flag];
}
// Invocations that must print `command`'s own reference. A probe that runs a
// declared child route is that child's invocation, so the child's row owns it.
export function helpVariants(command, commands) {
  const under = (argv, route) => route.every((part, i) => argv[i] === part);
  const children = commands.filter((c) => c.route.length > command.route.length && under(c.route, command.route));
  const missing = Object.entries(command.flags).filter(([, type]) => type === "value").map(([flag]) => [...missingValue(command, flag), "--help"]);
  return [[...command.route, "--help", ...command.probe.slice(command.route.length)], [...command.probe, "--help"], [...command.probe, "--axi-unknown-flag", "--help"], ...missing]
    .filter((argv) => !children.some((child) => under(argv, child.route)));
}
function flagOperand(command) {
  const argv = [...command.probe];
  for (let i = command.route.length; i < argv.length; i++) {
    if (command.flags[argv[i]] === "value") { i++; continue; }
    if (command.flags[argv[i]] === "boolean") continue;
    argv[i] = "--axi-unknown-flag"; return argv;
  }
  return [...argv, "--axi-unknown-flag"];
}
function noPrompt(result) {
  assert(!result.failure, `noninteractive command ${result.failure}`);
  assert(!/(?:enter|type|provide) (?:a |the |your )?(?:value|password|token|input)|\[y\/n\]|press (?:enter|return)|are you sure/i.test(result.stdout + result.stderr), "interactive prompt on required-input failure");
}
function strings(value) {
  if (typeof value === "string") return [value];
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}
function hints(output) {
  return strings([output?.help, output?.next, output?.suggestions, output?.error?.help]);
}
// Parse words, not programs. No expansion, substitution, redirects, or shell
// execution; advertised full commands must also equal the fixture-local argv.
export function commandWords(text) {
  assert(!/[\n\r]/.test(text), "hint contains shell syntax");
  const words = [];
  let word = "", quote = "", active = false;
  const flush = () => { if (active) words.push(word); word = ""; active = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = ""; else word += ch; continue; }
    if (ch === "\\") {
      assert(i + 1 < text.length, "unfinished command escape");
      if (quote === '"' && !'"\\$`'.includes(text[i + 1])) word += ch;
      else word += text[++i];
      active = true; continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else { assert(!"$`".includes(ch), "hint contains shell substitution"); word += ch; }
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    active = true;
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "<") {
      const placeholder = /^<[^>\s]+>/.exec(text.slice(i));
      assert(placeholder, "hint contains shell redirect"); word += placeholder[0]; i += placeholder[0].length - 1; continue;
    }
    assert(!";|&$`>".includes(ch), "hint contains shell syntax");
    word += ch;
  }
  assert(!quote, "unbalanced command quoting"); flush();
  return words;
}
export function nextCommands(output, name) {
  return hints(output).flatMap((hint) => {
    const quoted = [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const candidates = quoted.length ? quoted : [hint.replace(/^(?:Run|Example:)\s+/, "")];
    return candidates.filter((s) => s.startsWith(name + " ")).map(commandWords);
  });
}
function next(result, templates, fixture, name) {
  const commands = nextCommands(result.decoded, name), expected = templates.map((t) => expand(t, fixture));
  assert(expected.some((argv) => commands.some((actual) => JSON.stringify(actual) === JSON.stringify(argv))), `missing complete next command: ${expected.map((v) => v.join(" ")).join(" | ")}`);
  return commands;
}
function fullValue(result, item, fixture, contract) {
  const expected = fixture.expected(item.argv), complete = at(result.decoded, item.value);
  if (item.kind === "text") assert.equal(complete, expected.text, "--full must return the exact original text");
  else {
    assert(Array.isArray(complete), "full collection missing");
    const id = contract.cases.list?.find((c) => c.collection === item.value)?.fields[0];
    assert(id, "truncation collection needs a list identity field");
    assert.deepEqual(complete.map((r) => String(r[id])), expected.identities, "full output must return every fixture identity");
  }
}
async function unchangedRead(bin, argv, lab, invoke) {
  const result = await invoke(bin, argv, lab);
  successful(result); structured(result); normalUnchanged(result);
  assert(!result.decoded.error, "success contains an error");
  return result;
}
async function noDependency(lab, before) {
  const after = await noUnexpectedIO(lab);
  assert.equal(after.subprocess.length + after.network.length, before.subprocess.length + before.network.length, "usage/help/version must precede dependency work");
}
const absentForVerifier = new Set(["list", "empty", "truncation", "ambient"]);
function applicable(contract, kind) {
  if (Object.hasOwn(contract.cases, kind)) return;
  const absent = contract.unsupported.find((u) => u.check === kind);
  assert(absent?.status === "not-applicable" && contract.fixture === "axi-verify" && absentForVerifier.has(kind), `unconfigured ${kind}: ${absent?.reason ?? "missing command data"}`);
  return { notApplicable: absent.reason };
}
function preservesInput(original, full, command) {
  let cursor = 0;
  const carried = [];
  for (let i = 0; i < original.length; i++) {
    if (["--full", "--limit"].includes(original[i])) { if (command?.flags[original[i]] === "value") i++; continue; }
    carried.push(original[i]);
  }
  for (const part of carried) { cursor = full.indexOf(part, cursor); assert(cursor >= 0, `full command drops input selector ${part}`); cursor++; }
}

export async function behaviourRows({ profile, bin, bins, row, name, manifest }) {
  let contract;
  const run = (id, principles, body) => row(`principle-${id}`, async (lab, invoke) => {
    const result = await body(lab, invoke);
    return { principles, ...result };
  }, false, principles);
  await run("contract", [1,2,3,4,5,6,7,8,9,10], async (lab) => {
    contract = await readContract(lab.packageRoot, profile, manifest);
    return { source: contract.source, fixture: contract.fixture, commands: contract.commands.map((c) => c.route.join(" ")), unsupported: contract.unsupported };
  });
  if (!contract) return;
  const seed = (lab, mode) => seedBehaviour(lab, contract, mode);
  const firstList = contract.cases.list?.[0];
  const dataRead = contract.cases.home?.argv ?? firstList?.argv;
  await run("coverage", [6,10], async (lab, invoke) => {
    const registration = await commandRegistration({ bin, name, lab, invoke });
    const declared = new Set(contract.commands.map((c) => c.route.join(" ")));
    for (const route of registration.routes.filter(Boolean)) assert(declared.has(route), `unconfigured command ${route}`);
    for (const route of declared) assert(registration.routes.includes(route), `manifest route not registered: ${route}`);
    assert(!contract.unsupported.some((u) => u.status === "unconfigured"), "manifest explicitly declares unconfigured checks");
    return { coverage: { routes: [...declared] } };
  });
  await run("structured-output", [1,6], async (lab, invoke) => {
    assert(dataRead, "unconfigured data command"); const fixture = await seed(lab);
    await unchangedRead(bin, expand(dataRead, fixture), lab, invoke);
  });
  for (const [index, item] of (contract.cases.list ?? []).entries()) {
    await run(`minimal-schema-${index}`, [2], async (lab, invoke) => {
      const fixture = await seed(lab), result = await unchangedRead(bin, expand(item.argv, fixture), lab, invoke), list = at(result.decoded, item.collection);
      assert(Array.isArray(list) && list.length >= 2, "minimal schema requires nonempty mixed records");
      assert(item.fields.length <= 4, "default list exceeds four fields");
      for (const record of list) assert.deepEqual(Object.keys(record), item.fields, "default list field set differs");
      const expected = fixture.expected(item.argv).identities;
      assert(list.every((r) => expected.includes(String(r[item.fields[0]]))), "list identities disagree with fixture");
      if (item.expanded) {
        const expanded = await unchangedRead(bin, expand(item.expanded.argv, fixture), lab, invoke), values = at(expanded.decoded, item.collection);
        assert(Array.isArray(values) && values.length, "expanded list missing");
        for (const record of values) for (const field of item.expanded.fields) assert(Object.hasOwn(record, field), `expanded field missing: ${field}`);
      }
    });
    await run(`list-total-${index}`, [4], async (lab, invoke) => {
      const fixture = await seed(lab), result = await unchangedRead(bin, expand(item.argv, fixture), lab, invoke);
      assert.equal(at(result.decoded, item.total), fixture.expected(item.argv).identities.length, "total must report original collection size");
    });
    await run(`aggregates-${index}`, [4], async (lab, invoke) => {
      const fixture = await seed(lab), expected = fixture.expected(item.argv).aggregates;
      const declarations = item.aggregates ?? (contract.fixture === "contract-fixture" ? { "/aggregate/open": "open" } : undefined);
      assert(declarations, "unconfigured derived summaries: declare aggregate paths or an explicit absence");
      if (!Object.keys(declarations).length) return { notApplicable: "Manifest explicitly declares no relevant derived summary for this list; original totals are checked separately." };
      const result = await unchangedRead(bin, expand(item.argv, fixture), lab, invoke);
      for (const [path, key] of Object.entries(declarations)) { assert(Object.hasOwn(expected, key), `unknown aggregate fixture key ${key}`); assert.equal(at(result.decoded, path), expected[key], `incorrect aggregate ${path}`); }
    });
    await run(`next-commands-list-${index}`, [9], async (lab, invoke) => {
      const fixture = await seed(lab), result = await unchangedRead(bin, expand(item.argv, fixture), lab, invoke); next(result, item.next, fixture, name);
    });
  }
  if (!contract.cases.list) for (const id of ["minimal-schema", "list-total", "aggregates", "next-commands-list"]) await run(id, [2,4,9], async () => applicable(contract, "list"));
  for (const [index, item] of (contract.cases.truncation ?? []).entries()) {
    await run(`full-output-${index}`, [3], async (lab, invoke) => {
      const fixture = await seed(lab), result = await unchangedRead(bin, expand(item.full, fixture), lab, invoke);
      fullValue(result, item, fixture, contract);
    });
    await run(`no-truncation-hint-${index}`, [3,9], async (lab, invoke) => {
      const fixture = await seed(lab, "small"), result = await unchangedRead(bin, expand(item.argv, fixture), lab, invoke);
      fullValue(result, item, fixture, contract);
      assert(!nextCommands(result.decoded, name).some((argv) => JSON.stringify(argv) === JSON.stringify([name, ...expand(item.full, fixture)])), "untruncated default output must not suggest a full-output escape hatch");
    });
    await run(`${item.kind === "text" ? "text" : "row"}-truncation-${index}`, [3,9], async (lab, invoke) => {
      const fixture = await seed(lab), argv = expand(item.argv, fixture), full = expand(item.full, fixture);
      const command = contract.commands.find((c) => c.route.every((part, i) => argv[i] === part));
      preservesInput(argv, full, command);
      const limited = await unchangedRead(bin, argv, lab, invoke), value = at(limited.decoded, item.value), expected = fixture.expected(item.argv);
      const original = item.kind === "text" ? expected.text : expected.identities;
      assert(original.length > item.cap, "fixture must exceed truncation cap");
      assert.equal(at(limited.decoded, item.size), original.length, "truncation must state original size");
      assert(value?.length > 0 && value.length < original.length, "truncation needs a nonempty preview");
      const commands = next(limited, item.next, fixture, name);
      const advertised = commands.find((argv) => JSON.stringify(argv) === JSON.stringify([name, ...full]));
      assert(advertised, "truncation hint must preserve the complete full-output invocation");
      const result = await unchangedRead(bin, advertised.slice(1), lab, invoke);
      fullValue(result, item, fixture, contract);
      if (item.kind === "text") assert(original.startsWith(value.replace(/(?:…|\.\.\.).*$/s, "")), "preview must be a prefix of the original text");
      assert(!nextCommands(result.decoded, name).some((argv) => JSON.stringify(argv) === JSON.stringify(advertised)), "untruncated output must not suggest its own full-output escape hatch");
    });
  }
  if (!contract.cases.truncation) for (const id of ["text-truncation", "row-truncation", "full-output", "no-truncation-hint"]) await run(id, [3,9], async () => applicable(contract, "truncation"));
  await run("empty-state", [4,5], async (lab, invoke) => {
    const absent = applicable(contract, "empty"); if (absent) return absent;
    const fixture = await seed(lab, "empty"), item = contract.cases.list[contract.cases.empty.list];
    const result = await unchangedRead(bin, expand(contract.cases.empty.argv ?? item.argv, fixture), lab, invoke);
    assert.equal(at(result.decoded, item.total), 0, "empty list must report zero total");
    const list = at(result.decoded, item.collection); assert(Array.isArray(list) && list.length === 0 || list === "none", "empty list has records");
    assert(/(?:0\s+\S+.*(?:found|available)|empty|no (?:records|resources|items|pods|changes)|none)/i.test(result.stdout), "empty state needs explicit zero context");
  });
  for (const [index, item] of (contract.cases.failure ?? []).entries()) {
    for (const id of ["operational-error", "unreadable-input", "next-commands-error"]) {
      if (id === "unreadable-input" && item.fault !== "unreadable-file") continue;
      await run(`${id}-${index}`, [6,9], async (lab, invoke) => {
        const fixture = await seed(lab, item.fault), file = fixture.tokens.plan;
        if (item.fault === "missing-file") await fs.rm(file);
        if (item.fault === "unreadable-file") { await fs.chmod(file, 0); await deniedProbe(file, true); }
        try {
          const result = await invoke(bin, expand(item.argv, fixture), lab);
          failure(result, [item.code], 1); noPrompt(result); normalUnchanged(result);
          next(result, item.next, fixture, name);
        } finally { if (item.fault === "unreadable-file") await fs.chmod(file, 0o600); }
      });
    }
  }
  if (!contract.cases.failure) for (const id of ["operational-error", "unreadable-input", "next-commands-error"]) await run(id, [6,9], async () => applicable(contract, "failure"));
  for (const command of contract.commands) {
    const route = command.route.join("-");
    const variants = [["unknown", [...command.probe, "--axi-unknown-flag"]]];
    if (command.operands.min > 0) variants.push(["missing-operand", command.route]);
    if (command.operands.max !== null) variants.push(["operand", [...command.probe, ...Array(command.operands.max + 1).fill("axi-extra-operand")]]);
    for (const [flag, type] of Object.entries(command.flags)) if (type === "value") variants.push([flag.slice(2), missingValue(command, flag)]);
    for (const [variant, argv] of variants) await run(`usage-${route}-${variant}`, [6], async (lab, invoke) => {
      const fixture = await seed(lab), before = await noUnexpectedIO(lab), result = await invoke(bin, expand(argv, fixture), lab);
      failure(result, ["VALIDATION_ERROR", "USAGE_ERROR"], 2); noPrompt(result); normalUnchanged(result);
      if (variant === "unknown") { assert(result.stdout.includes("--axi-unknown-flag"), "unknown flag must be named"); for (const flag of Object.keys(command.flags)) assert(result.stdout.includes(flag), `unknown flag response must inline valid flag ${flag}`); }
      await noDependency(lab, before);
    });
    await run(`flag-directory-${route}`, [6], async (lab, invoke) => {
      const fixture = await seed(lab); await fs.mkdir(join(lab.cwd, "--axi-unknown-flag"));
      const before = await noUnexpectedIO(lab), result = await invoke(bin, expand(flagOperand(command), fixture), lab);
      failure(result, ["VALIDATION_ERROR", "USAGE_ERROR"], 2); normalUnchanged(result); await noDependency(lab, before);
    });
    await run(`no-prompts-${route}`, [6], async (lab, invoke) => {
      const fixture = await seed(lab);
      const missing = Object.entries(command.flags).find(([, type]) => type === "value");
      const argv = expand(missing ? missingValue(command, missing[0]) : [...command.probe, "--axi-unknown-flag"], fixture);
      const before = await noUnexpectedIO(lab);
      for (const terminal of [false, true]) {
        const python = terminal && (await checked("which", ["python3"], { env: { PATH: process.env.PATH } })).stdout.trim();
        const result = terminal ? await invoke(python, ["-I", "-S", new URL("../fixtures/pty.py", import.meta.url).pathname, bin, ...argv], lab) : await invoke(bin, argv, lab);
        noPrompt(result); failure(result, ["VALIDATION_ERROR", "USAGE_ERROR"], 2); normalUnchanged(result);
      }
      await noDependency(lab, before);
    });
    await run(`help-precedence-${route}`, [6,10], async (lab, invoke) => {
      const fixture = await seed(lab), before = await noUnexpectedIO(lab);
      const standalone = await unchangedRead(bin, [...command.route, "--help"], lab, invoke);
      for (const args of helpVariants(command, contract.commands)) {
        const result = await unchangedRead(bin, expand(args, fixture), lab, invoke); assert.equal(result.stdout, standalone.stdout, "--help with input must print the command reference without running it");
      }
      await noDependency(lab, before);
    });
    await run(`command-help-${route}`, [10], async (lab, invoke) => {
      const result = await unchangedRead(bin, [...command.route, "--help"], lab, invoke);
      for (const flag of Object.keys(command.flags)) assert(result.stdout.includes(flag), `help missing flag ${flag}`);
      const defaults = result.decoded.defaults !== undefined ? [JSON.stringify(result.decoded.defaults)] : strings(result.decoded.help).filter((line) => /default/i.test(line));
      for (const [key, value] of Object.entries(command.defaults)) assert(defaults.some((line) => line.includes(key) && line.includes(String(value))), `help missing default ${key}=${value}`);
      if (!Object.keys(command.defaults).length) assert(/no defaults|defaults?:\s*(?:none|\{\})/i.test(result.stdout), "help must state that no defaults apply");
      const examples = nextCommands({ help: result.decoded.examples ?? result.decoded.help }, name).filter((argv) => command.route.every((part, i) => argv[i + 1] === part));
      const distinct = new Set(examples.map((argv) => JSON.stringify(argv)));
      assert(distinct.size >= 2 && distinct.size <= 3, "per-command help needs 2–3 complete distinct examples");
      for (const example of command.examples) assert(distinct.has(JSON.stringify(example)), `help missing example ${example.join(" ")}`);
    });
  }
  await run("readonly", [6,7], async (lab, invoke) => {
    const absent = applicable(contract, "readonly"); if (absent) return absent;
    const fixture = await seed(lab); await lock(lab.home); await deniedProbe(lab.home); await deniedProbe(lab.env.XDG_CONFIG_HOME);
    for (const argv of contract.cases.readonly) await unchangedRead(bin, expand(argv, fixture), lab, invoke);
  });
  await run("content-home", [8,10], async (lab, invoke) => {
    const absent = applicable(contract, "home"); if (absent) return absent;
    const fixture = await seed(lab), result = await unchangedRead(bin, expand(contract.cases.home.argv, fixture), lab, invoke);
    assert(typeof result.decoded.bin === "string" && (result.decoded.bin.startsWith("/") || result.decoded.bin.startsWith("~/")), "home must identify executable path");
    assert(typeof result.decoded.description === "string" && result.decoded.description.length, "home must describe the tool");
    for (const marker of contract.cases.home.markers) assert(result.stdout.includes(marker), `home must show live fixture marker ${marker}`);
    assert(nextCommands(result.decoded, name).length, "home must suggest a complete next command");
    const changed = await fixture.changeHome(), updated = await unchangedRead(bin, expand(contract.cases.home.argv, fixture), lab, invoke);
    assert(updated.stdout.includes(changed.present) && !updated.stdout.includes(changed.absent), "home must change with live fixture state, not print a static manual");
  });
  for (const id of ["ambient-scope", "lifecycle-capture"]) await run(id, [7], async (lab, invoke) => {
    const absent = applicable(contract, "ambient"); if (absent) return absent;
    const fixture = await seed(lab), ambient = contract.cases.ambient, executable = bins[ambient.bin];
    assert(executable, `ambient bin missing: ${ambient.bin}`);
    const readAt = async (cwd) => unchangedRead(executable, expand(ambient.argv, fixture), { ...lab, cwd }, invoke);
    const { projectA, projectB } = fixture.data;
    if (id === "ambient-scope") {
      for (const [cwd, visible, hidden] of [[projectA, "project-a", "project-b"], [join(projectA, "child"), "project-a", "project-b"], [projectB, "project-b", "project-a"], [join(lab.cwd, "unrelated"), null, "project-a"]]) {
        const result = await readAt(cwd);
        if (visible) assert(result.stdout.includes(visible), `ambient context missing current project ${visible}`);
        assert(!result.stdout.includes(hidden) && (visible || !result.stdout.includes("project-b")), "ambient context leaks an unrelated directory");
      }
    } else {
      const transcript = join(lab.base, "transcript.jsonl"); await fs.writeFile(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `${name} ${profile.list?.join(" ") ?? "static"}` } }] } }) + "\n");
      const before = await snapshot(lab.home), contextA = (await readAt(projectA)).stdout, contextB = (await readAt(projectB)).stdout;
      const captured = await invoke(ambient.capture ? executable : bin, ambient.capture ?? fixture.capture, { ...lab, cwd: projectA }, { input: JSON.stringify({ session_id: "session-a", cwd: projectA, transcript_path: transcript }) });
      successful(captured); structured(captured);
      assert.notDeepEqual(await snapshot(lab.home), before, "SessionEnd must persist independently observable capture");
      // Tools surface a capture in their own words (a session id, `last_session`), so compare context before and after.
      assert.notEqual((await readAt(projectA)).stdout, contextA, "captured session must appear in its project context");
      assert.equal((await readAt(projectB)).stdout, contextB, "captured session leaked to another project");
    }
  });
  await run("version-graph", [10], async (lab, invoke) => {
    const fixture = await seed(lab), log = join(lab.evidence, `${basename(lab.base)}-modules.jsonl`);
    lab.env.AXI_MODULE_LOG = log;
    const roots = await Promise.all(contract.graph.map(async (p) => pathToFileURL(await fs.realpath(join(lab.packageRoot, p))).href));
    for (const flag of ["--version", "-v", "-V"]) {
      await fs.writeFile(log, ""); const before = await noUnexpectedIO(lab), result = await invoke(bin, [flag], lab);
      successful(result); assert.equal(result.stdout, manifest.version + "\n", "version must be bare installed version"); normalUnchanged(result); await noDependency(lab, before);
      const loads = (await fs.readFile(log, "utf8")).trim().split("\n"); assert(!roots.some((root) => loads.includes(root)), "bare version loaded the command graph");
    }
    await fs.writeFile(log, ""); await unchangedRead(bin, expand(dataRead, fixture), lab, invoke);
    const loads = (await fs.readFile(log, "utf8")).trim().split("\n");
    for (const root of roots) assert(loads.includes(root), `module observer did not witness command graph ${root}`);
  });
  return contract;
}
