import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  deniedProbe,
  fixtureDir,
  lock,
  observe,
  prerequisite,
  processResult,
  sandbox,
  scratch,
  snapshot,
  json,
} from "../lib/lab.mjs";
import { hookModel, verifyPacked } from "../lib/packed.mjs";
import {
  noUnexpectedIO,
  normalUnchanged,
  structuredFailure,
} from "../lib/observations.mjs";
import { profiles, profileFor } from "../lib/profiles.mjs";
const cli = fileURLToPath(new URL("../bin/axi-verify.mjs", import.meta.url));

test("seven explicit profiles; unknown names fail closed", () => {
  assert.equal(Object.keys(profiles).length, 7);
  assert.throws(() => profileFor("unreviewed-tool"), /Unsupported package/);
});
test("real permission denial and ineffective-lock rejection", async () => {
  prerequisite();
  const root = await scratch();
  try {
    await assert.rejects(deniedProbe(root), /ineffective write lock/);
    await fs.rm(join(root, ".axi-permission-probe"));
    await fs.mkdir(join(root, "nested"));
    await fs.writeFile(join(root, "nested", "file"), "retained");
    await lock(root);
    assert(["EACCES", "EPERM"].includes(await deniedProbe(root)));
    await assert.rejects(
      fs.writeFile(join(root, "nested", "file"), "bad"),
      (error) => ["EACCES", "EPERM"].includes(error.code),
    );
  } finally {
    await cleanup(root);
  }
});
test("root precondition fails before artifact work", async () => {
  const module = fileURLToPath(new URL("../lib/lab.mjs", import.meta.url));
  const result = await processResult(process.execPath, [
    "--input-type=module",
    "-e",
    `process.getuid = () => 0; const { prerequisite } = await import(${JSON.stringify(module)}); prerequisite();`,
  ]);
  assert.notEqual(result.exit, 0);
  assert.match(result.stderr, /root cannot prove/);
});
for (const custom of [false, true])
  test(`hook model is green on explicit/idempotent setup, red on normal-command installation (custom=${custom})`, async () => {
    const root = await scratch();
    const profile = { ...profiles["argocd-axi"], normal: [["probe"]] };
    const bin = join(fixtureDir, "hook-tool.mjs");
    try {
      const good = await sandbox(root, custom);
      const invoke = (bin, args, lab) => observe(bin, args, lab);
      const observed = await hookModel({
        bin,
        name: "argocd-axi",
        profile,
        lab: good,
        invoke,
      });
      assert.equal(observed.removed.counts["claude:SessionStart"], 0);
      const bad = await sandbox(root, custom);
      bad.env.AXI_BAD_NORMAL = "1";
      await assert.rejects(
        hookModel({ bin, name: "argocd-axi", profile, lab: bad, invoke }),
        /normal command changed disposable/,
      );
    } finally {
      await cleanup(root);
    }
  });
test("snapshot records unreadable files without opening them", async () => {
  const root = await scratch(),
    file = join(root, "secret");
  try {
    await fs.writeFile(file, "credential");
    await fs.chmod(file, 0);
    assert.equal((await snapshot(root)).secret.type, "file");
  } finally {
    await fs.chmod(file, 0o600);
    await cleanup(root);
  }
});
test("same-content normal-command writes are rejected", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    const file = join(lab.home, ".claude", "settings.json");
    await fs.writeFile(file, "{}");
    const result = await observe(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, '{}')`],
      lab,
    );
    assert.equal(
      result.before.home[".claude/settings.json"].size,
      result.after.home[".claude/settings.json"].size,
    );
    assert.notEqual(
      result.before.home[".claude/settings.json"].mtimeNs,
      result.after.home[".claude/settings.json"].mtimeNs,
    );
    assert.throws(() => normalUnchanged(result, lab), /normal command changed/);
  } finally {
    await cleanup(root);
  }
});
test("absolute shell writes to each observed root fail normal-command checks", async () => {
  const root = await scratch();
  try {
    for (const target of [
      ["home/.claude", "settings.json"],
      ["home/selected-claude", "settings.json"],
      ["cwd/.claude", "settings.json"],
      ["", "unexpected.txt"],
    ]) {
      const lab = await sandbox(root, true);
      const file = join(lab.base, ...target);
      const result = await observe(
        "/bin/sh",
        ["-c", 'printf side-effect > "$TARGET"'],
        lab,
        { env: { ...lab.env, TARGET: file } },
      );
      assert.equal(result.exit, 0, result.stderr);
      await noUnexpectedIO(lab);
      assert.throws(
        () => normalUnchanged(result, lab),
        /normal command changed disposable/,
      );
    }
  } finally {
    await cleanup(root);
  }
});
test("fixture shims handle expected commands and missing commands stay unavailable", async () => {
  const root = await scratch();
  try {
    const lab = await sandbox(root);
    const result = await processResult(
      process.execPath,
      [
        "-e",
        `const cp=require('child_process'); const fixture=cp.spawnSync('argocd', ['app', 'list', '-o', 'json'], {encoding:'utf8'}); const missing=cp.spawnSync('not-a-fixture', []); console.log(JSON.stringify({fixture,missing:missing.error?.code}));`,
      ],
      { env: lab.env },
    );
    assert.equal(result.exit, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.fixture.status, 0);
    assert.equal(observed.missing, "ENOENT");
    const calls = (await fs.readFile(lab.env.AXI_FIXTURE_LOG, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      calls.some(
        (call) =>
          call.bin === "argocd" &&
          call.args.join(" ") === "app list -o json" &&
          call.allowed,
      ),
    );
  } finally {
    await cleanup(root);
  }
});
test("network fixture permits only its explicit loopback endpoint and records rejected calls", async () => {
  const root = await scratch(),
    lab = await sandbox(root);
  const server = createServer((request, response) => response.end("fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  lab.env.AXI_HTTP_PORT = String(server.address().port);
  try {
    const allowed = await processResult(
      process.execPath,
      [
        "-e",
        `fetch('http://127.0.0.1:${server.address().port}').then(r => r.text()).then(console.log)`,
      ],
      { env: lab.env },
    );
    assert.equal(allowed.exit, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), "fixture");
    const denied = await processResult(
      process.execPath,
      [
        "-e",
        `require('net').connect({ host: 'external.example.invalid', port: 443 })`,
      ],
      { env: lab.env },
    );
    assert.notEqual(denied.exit, 0);
    assert.match(denied.stderr, /refused external/);
    const log = (await fs.readFile(lab.env.AXI_NETWORK_LOG, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(log.some((record) => record.allowed));
    assert(log.some((record) => record.allowed === false));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await cleanup(root);
  }
});
test("error prefix is not a parsed code; UNKNOWN and exit-zero errors fail", () => {
  for (const result of [
    { exit: 1, decoded: { error: "SETUP_FAILED: bad", help: ["repair"] } },
    { exit: 1, decoded: { code: "UNKNOWN", help: ["repair"] } },
    { exit: 0, decoded: { errors: ["EACCES"], help: ["repair"] } },
  ])
    assert.throws(() =>
      structuredFailure({ stdout: "", stderr: "", ...result }, [
        "SETUP_FAILED",
      ]),
    );
});
test("CLI rejects unknown, duplicate and incomplete flags before packing", async () => {
  for (const args of [
    ["nope"],
    ["static", "--tarball", "/tmp/x"],
    ["packed", "--bogus"],
    ["packed", "--tarball"],
    ["packed", "--expected-git-head", "a".repeat(40)],
    ["packed", "--tarball", "/tmp/a", "--tarball", "/tmp/b"],
  ]) {
    const result = await processResult(process.execPath, [cli, ...args]);
    assert.equal(result.exit, 2, JSON.stringify(args));
    assert.equal(result.decoded.code, "VALIDATION_ERROR");
  }
});
test("local packing runs a noisy prepack and selects its exact archive without parsing lifecycle stdout", async () => {
  const source = await scratch(),
    evidence = await scratch();
  try {
    await json(join(source, "package.json"), {
      name: "search-console-axi",
      version: "0.1.0",
      type: "module",
      files: ["bin.mjs", "built.txt"],
      bin: { "search-console-axi": "bin.mjs" },
      scripts: {
        prepack: `node -e 'console.log("noisy build");require("fs").writeFileSync("built.txt","prepack executed")'`,
      },
    });
    await fs.writeFile(
      join(source, "bin.mjs"),
      '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--version" ? "0.1.0" : "tool: search-console-axi fixture");\n',
    );
    await fs.chmod(join(source, "bin.mjs"), 0o755);
    const result = await verifyPacked({ source, evidenceDir: evidence });
    assert.equal(result.package, "search-console-axi");
    assert.match(
      result.rows.find(
        (row) => row.id === "search-console-axi-help-setup-false",
      ).error,
      /help must document route setup/,
    );
    assert.equal(
      await fs.readFile(join(source, "built.txt"), "utf8"),
      "prepack executed",
    );
    const identity = JSON.parse(
      await fs.readFile(join(evidence, "identity.json"), "utf8"),
    );
    assert.equal(identity.installedManifest.version, "0.1.0");
    assert.equal(identity.archiveGitHead, null);
    const pack = JSON.parse(
      await fs.readFile(join(evidence, "pack.json"), "utf8"),
    );
    assert(
      JSON.parse(pack.stdout)[0].files.some(
        (file) => file.path === "built.txt",
      ),
      "build output must be in the installed archive",
    );
  } finally {
    await cleanup(source);
    await cleanup(evidence);
  }
});
test("missing and wrong archive gitHead fail before install; evidence survives cleanup", async () => {
  const root = await scratch(),
    evidence = await scratch();
  try {
    const source = join(root, "package");
    await fs.mkdir(source);
    for (const gitHead of [undefined, "b".repeat(40)]) {
      await json(join(source, "package.json"), {
        name: "argocd-axi",
        version: "0.1.0",
        gitHead,
        bin: { "argocd-axi": "bin.mjs" },
      });
      const archive = join(root, "bad.tgz");
      assert.equal(
        (await processResult("tar", ["-czf", archive, "-C", root, "package"]))
          .exit,
        0,
      );
      await assert.rejects(
        verifyPacked({
          tarball: archive,
          expectedGitHead: "a".repeat(40),
          evidenceDir: evidence,
        }),
        /archive gitHead differs/,
      );
      assert.match(
        await fs.readFile(join(evidence, "fatal.json"), "utf8"),
        /archive gitHead differs/,
      );
    }
  } finally {
    await cleanup(root);
    await cleanup(evidence);
  }
});
