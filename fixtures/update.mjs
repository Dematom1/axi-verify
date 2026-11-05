import { readFileSync, writeFileSync, existsSync, realpathSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

export function updateFixture(bin, args) {
  const root = process.env.AXI_UPDATE_GLOBAL_ROOT, name = process.env.AXI_REGISTRY_PACKAGE;
  if (bin !== "npm" || !root || !name) return;
  const vectors = [["install", "-g", `${name}@latest`], ["install", "-g", "--prefix", dirname(dirname(root)), `${name}@latest`]];
  if (!vectors.some((vector) => JSON.stringify(vector) === JSON.stringify(args))) return;
  const directory = realpathSync(join(root, name));
  if (!directory.startsWith(realpathSync(process.env.HOME) + "/")) throw new Error("fixture installer target is not disposable");
  const file = join(directory, "package.json"), version = join(directory, "dist", "src", "version.js");
  for (const target of [file, version])
    if (existsSync(target) && !realpathSync(target).startsWith(directory + "/")) throw new Error("fixture installer file escaped the disposable package");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.name !== name) throw new Error("fixture installer package mismatch");
  appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin, args, allowed: true, mutation: true }) + "\n");
  let native;
  if (process.env.AXI_UPDATE_FAIL_FIRST === "1") {
    native = JSON.parse(readFileSync(process.env.AXI_RETRY_SCENARIO, "utf8"));
    if (native.state === "initial") {
      native.state = "retryable";
      writeFileSync(process.env.AXI_RETRY_SCENARIO, JSON.stringify(native));
      process.stderr.write("fixture installer transport failure (no commit)\n");
      process.exit(1);
    }
  }
  const old = manifest.version, next = process.env.AXI_REGISTRY_VERSION;
  manifest.version = next;
  writeFileSync(file, JSON.stringify(manifest));
  if (existsSync(version)) writeFileSync(version, readFileSync(version, "utf8").replaceAll(JSON.stringify(old), JSON.stringify(next)).replaceAll(`'${old}'`, `'${next}'`));
  if (native) {
    native.state = "done";
    writeFileSync(process.env.AXI_RETRY_SCENARIO, JSON.stringify(native));
  }
  process.stdout.write("fixture version installed\n");
  process.exit(0);
}
