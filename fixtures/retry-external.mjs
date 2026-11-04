import { appendFileSync, readFileSync, writeFileSync, lstatSync, renameSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

// Only profile-supplied exact argv vectors can act. Unknown calls fail closed.
export function retryExternal(bin, args) {
  const file = process.env.AXI_RETRY_SCENARIO;
  if (!file) return false;
  const scenario = JSON.parse(readFileSync(file, "utf8"));
  const matches = (expected, actual) => {
    if (typeof expected === "string") return expected === actual;
    if (!expected.manifest || typeof actual !== "string") return false;
    const path = resolve(actual), directory = dirname(path);
    if (!directory.startsWith(join(tmpdir(), "argo-workflows-axi-")) || basename(path) !== "workflow.yaml" || !lstatSync(path).isFile()) return false;
    const value = parse(readFileSync(path, "utf8"));
    return value.kind === "Workflow" && value.metadata?.name === expected.manifest;
  };
  const step = scenario.steps.find((s) => s.bin === bin && s.argv.length === args.length &&
    s.argv.every((value, index) => matches(value, args[index])));
  if (!step) return false;
  const state = scenario.state ?? "initial";
  const reply = step.states?.[state] ?? step;
  appendFileSync(process.env.AXI_FIXTURE_LOG,
    JSON.stringify({ bin, args, allowed: true, mutation: step.mutation === true, poll: step.poll === true, nativeExit: reply.exit ?? 0, state }) + "\n");
  if (reply.next) {
    scenario.state = reply.next;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(scenario));
    renameSync(temporary, file);
  }
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.stdout !== undefined) process.stdout.write(typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout));
  process.exit(reply.exit ?? 0);
}
