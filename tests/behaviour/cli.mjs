#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const mode = readFileSync(join(root, "broken.txt"), "utf8").trim();
const argv = process.argv.slice(2);
if (mode === "version-graph" || !["--version", "-v", "-V"].includes(argv[0])) await import("./lib/graph.mjs");
if (argv.length === 1 && ["--version", "-v", "-V"].includes(argv[0])) {
  console.log("0.1.0");
} else {
  const { encode } = await import("./toon.mjs");
  const out = (v) => console.log(mode === "structured-output" ? "raw progress\nnot structured" : encode(v));
  const name = "axi-verify";
  const data = process.env.AXI_BEHAVIOUR_DATA ? JSON.parse(readFileSync(process.env.AXI_BEHAVIOUR_DATA, "utf8")) : { identities: ["0", "1", "2", "3", "4"], text: "x".repeat(500) + "TAIL", homeMarker: "project-a" };
  const flags = ["--help", "--input", "--full", "--fields", "--limit", "--empty", "--detail", "--context-view", "--capture"];
  const help = () => out({ usage: `${name} ${argv[0] ?? "static"} [--input <path>] [--full]`, flags,
    defaults: mode === "command-help" ? "" : mode === "help-defaults" ? "--full false" : "--full false; --limit 2; --fields id,title,status; --input none; --empty false; --detail false; --context-view false; --capture false",
    examples: mode === "command-help" ? [] : [`${name} ${argv[0] ?? "static"}`, `${name} ${argv[0] ?? "static"} --limit 1`, ...(mode === "help-defaults" ? [`${name} ${argv[0]} --limit 2`] : [])] });
  const error = (message, exit = 2) => {
    out({ error: message, code: exit === 2 ? "VALIDATION_ERROR" : "FILE_ERROR",
      flags: mode === "usage" ? [] : flags,
      help: mode === "next-commands" ? "try again" : [`${name} static --help`] });
    process.exitCode = mode === "operational-error" && exit === 1 ? 0 : exit;
  };
  const route = argv[0];
  if (argv.includes("--help") && !(mode === "help-precedence" && argv.length > 2)) help();
  else if (argv.length === 0) out({ bin: fileURLToPath(import.meta.url), description: "Inspect synthetic records", records: mode === "content-home" ? [] : [mode === "stale-home" ? "project-a" : data.homeMarker ?? "project-a"], help: [`${name} static`] });
  else if (!["static", "packed"].includes(route)) error("unknown command " + route);
  else {
    const options = {};
    let invalid;
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (!flags.includes(flag) || flag === "--help") { invalid = "unknown flag or extra operand " + flag; break; }
      if (["--input", "--fields", "--limit"].includes(flag)) {
        const value = argv[++i];
        if (!value || value.startsWith("--")) { invalid = "missing value " + flag; break; }
        options[flag] = value;
      } else options[flag] = true;
    }
    if (mode === "flag-directory" && argv.includes("--axi-unknown-flag")) out({ directory: "--axi-unknown-flag" });
    else if (invalid) {
      if (mode === "no-prompts") console.log("Enter a value:");
      error(invalid, mode === "usage" ? 1 : 2);
    } else if (options["--input"]) {
      try { readFileSync(options["--input"], "utf8"); out({ status: "read" }); }
      catch { if (mode === "unreadable-input") out({ status: "empty" }); else error("cannot read input", 1); }
    } else if (options["--context-view"] || options["--capture"]) {
      const data = JSON.parse(readFileSync(process.env.AXI_BEHAVIOUR_DATA, "utf8"));
      if (options["--capture"]) {
        if (mode !== "lifecycle-capture") writeFileSync(data.session, "session-a");
        out({ status: "recorded" });
      } else out({ context: mode === "ambient-scope" || process.cwd().startsWith(data.projectA) ? "project-a" : process.cwd().startsWith(data.projectB) ? "project-b" : "none",
        session: process.cwd().startsWith(data.projectA) ? (() => { try { return readFileSync(data.session, "utf8"); } catch { return "none"; } })() : "none" });
    } else {
      if (mode === "readonly") writeFileSync(join(process.env.HOME, "implicit-setup"), "bad");
      const records = Array.from({ length: options["--empty"] ? 0 : data.identities.length }, (_, i) => ({ id: String(i), title: `record-${i}`, status: i ? "open" : "closed" }));
      const full = options["--full"];
      const count = mode === "list-total" ? 2 : records.length;
      const hint = mode === "next-commands" ? [] : [`${name} static --detail`, ...(!full && (records.length > 2 || mode === "no-truncation-hint") ? [`${name} static --full`] : [])];
      if (options["--detail"]) {
        const text = data.text;
        out({ body: full ? mode === "full-output" ? text.slice(0, 500) : text : text.slice(0, 200), size: mode === "text-truncation" ? 200 : text.length, help: !full && (text.length > 200 || mode === "no-truncation-hint") ? [`${name} static --detail --full`] : [] });
      } else out({ total: count, status: mode === "empty-state" ? "ok" : `${records.length} records found`,
        aggregate: { open: mode === "aggregates" ? 0 : records.filter((r) => r.status === "open").length },
        records: (full && mode !== "row-truncation" ? records : records.slice(0, Number(options["--limit"] ?? 2))).map((r) => mode === "minimal-schema" ? { ...r, body: "unrequested detail", unused: "" } : options["--fields"] ? { ...r, age: "1h" } : r),
        help: hint });
    }
  }
}
