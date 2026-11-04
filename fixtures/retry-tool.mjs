#!/usr/bin/env node
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const command = process.argv[2];
const state = join(process.env.HOME, "settings");
const native = (verb) => execFileSync("argocd", ["fixture", verb], { encoding: "utf8" }).trim();
const output = (text) => process.stdout.write(text + "\n");
if (command === "read") {
  output(`state: ${native("get")}`);
  if (process.env.AXI_RETRY_BROKEN === "output") output(`timestamp: ${process.pid}`);
  if (process.env.AXI_RETRY_BROKEN === "elapsed") output(`timer: "condition met after ${process.pid}s"`);
  if (process.env.AXI_RETRY_BROKEN === "elapsed-state") output(`timer: "condition ${process.pid} after ${process.pid}s"`);
  if (process.env.AXI_RETRY_BROKEN === "read-native") native("set");
  if (process.env.AXI_RETRY_BROKEN === "read") fs.writeFileSync(state, "bad");
} else if (command === "write" && process.env.AXI_RETRY_BROKEN === "grant") {
  if (!fs.existsSync(state)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { output("error: terminal required\ncode: REFUSED"); process.exit(1); }
    const buffer = Buffer.alloc(32), count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!/^y\s*$/i.test(buffer.subarray(0, count).toString())) process.exit(1);
    fs.writeFileSync(state, "granted");
  }
  output("status: already-done\nstate: granted");
} else if (command === "write") {
  if (native("get") === "done" && process.env.AXI_RETRY_BROKEN !== "write")
    output(process.env.AXI_RETRY_BROKEN === "nested-help" ? "state: done\nother:\n  help: already-done" : "status: already-done\nstate: done");
  else {
    try {
      native("set");
      if (process.env.AXI_RETRY_BROKEN === "first-double") native("set");
      output("status: done\nstate: done");
    }
    catch { output("error: fixture native failure\ncode: UPSTREAM_ERROR"); process.exitCode = 1; }
  }
} else if (command === "event") {
  const current = native("get");
  if (current !== "done" || process.env.AXI_RETRY_BROKEN !== "event-skip") native("set");
  output("status: submitted\nstate: done");
} else if (command === "wait") {
  let result = native("get");
  while (result !== "done") {
    if (process.env.AXI_RETRY_BROKEN === "wait") { output("error: transient"); process.exit(1); }
    result = native("get");
  }
  if (process.env.AXI_RETRY_BROKEN === "wait-repoll") native("get");
  if (process.env.AXI_RETRY_BROKEN === "wait-delay") await new Promise((resolve) => setTimeout(resolve, 1));
  output("state: done");
} else if (command === "setup") {
  if (!fs.existsSync(state) || process.env.AXI_RETRY_BROKEN === "setup") fs.writeFileSync(state, "configured");
  output("state: configured");
} else if (command === "uninstall") {
  fs.rmSync(state, { force: true }); output("state: absent");
} else { output("error: refused\ncode: REFUSED"); process.exitCode = 1; }
