import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { cleanup, scratch } from "../lib/lab.mjs";

const workflow = YAML.parse(await fs.readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8"));
const publishScript = workflow.jobs.publish.steps.find((s) => s.name === "Publish unless this version is already on npm").run;

// Runs the real publish step with a stub npm. `view` controls what `npm view` does:
// published (version printed), absent (exit 0, empty), not-found (E404, exit 1), network (ECONNRESET, exit 1).
async function runPublish(view) {
  const dir = await scratch("release-route");
  try {
    const stubs = join(dir, "bin");
    const log = join(dir, "calls.log");
    await fs.mkdir(stubs);
    await fs.writeFile(join(stubs, "npm"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  --version) echo 11.15.0 ;;
  view)
    case "${view}" in
      published) echo 0.2.0 ;;
      absent) ;;
      not-found) echo "npm error code E404" >&2; exit 1 ;;
      network) echo "npm error code ECONNRESET" >&2; exit 1 ;;
    esac ;;
  stage)
    if [ "$2" = list ]; then echo "[]"; fi ;;
esac
exit 0
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", publishScript], {
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SPEC: "axi-verify@0.2.0", TARBALL: "axi-verify-0.2.0.tgz", GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
      encoding: "utf8",
    });
    const calls = await fs.readFile(log, "utf8").catch(() => "");
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    await cleanup(dir);
  }
}

test("publish stages a version only when npm reports it not found (E404)", async () => {
  const run = await runPublish("not-found");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.calls, /stage publish \.\/axi-verify-0\.2\.0\.tgz/);
});

test("publish stages a version when npm view succeeds with no version printed", async () => {
  const run = await runPublish("absent");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.calls, /stage publish/);
});

test("publish skips staging when the version already exists on npm", async () => {
  const run = await runPublish("published");
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.calls, /stage publish/);
});

test("publish fails without staging when npm view fails for a reason other than not-found", async () => {
  const run = await runPublish("network");
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.calls, /stage publish/);
});
