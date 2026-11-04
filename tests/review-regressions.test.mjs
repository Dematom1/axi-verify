import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSocket } from "node:dgram";
import {
  cleanup,
  checked,
  fixtureDir,
  json,
  observe,
  processResult,
  sandbox,
  scratch,
} from "../lib/lab.mjs";
import { hookModel } from "../lib/packed.mjs";
import { noUnexpectedIO } from "../lib/observations.mjs";
import { profiles } from "../lib/profiles.mjs";

const cli = fileURLToPath(new URL("../bin/axi-verify.mjs", import.meta.url));
async function driveHooks(flags, options = {}) {
  const root = await scratch();
  try {
    const lab = await sandbox(root, options.custom ?? true);
    Object.assign(lab.env, flags);
    return await hookModel({
      bin: join(fixtureDir, "hook-tool.mjs"),
      name: "argocd-axi",
      profile: {
        ...profiles["argocd-axi"],
        normal: [["probe"]],
        ...options.profile,
      },
      lab,
      invoke: (bin, args, target) => observe(bin, args, target),
    });
  } finally {
    await cleanup(root);
  }
}
test("a hookless action cannot install registrations before returning a usage error", async () => {
  await assert.rejects(
    driveHooks(
      { AXI_REJECT_HOOKS_AFTER_INSTALL: "1" },
      { profile: { hooks: [] } },
    ),
    /managed entries remain after removal|normal command changed disposable/,
  );
});
test("the second uninstall cannot recreate managed integrations", async () => {
  await assert.rejects(
    driveHooks({ AXI_REINSTALL_ON_REPEAT_UNINSTALL: "1" }),
    /managed entries remain after removal/,
  );
});
test("a verified SDK default-directory SessionStart fallback has a documented limitation outcome", async () => {
  await assert.rejects(driveHooks({ AXI_SDK_DEFAULT_CLAUDE: "1" }), (error) => {
    assert.equal(
      error.knownLimitation?.id,
      "axi-sdk-js-claude-config-dir-sessionstart",
    );
    assert.match(
      error.knownLimitation.pointer,
      /README\.md#claude-config-dir-sessionstart$/,
    );
    return true;
  });
});
test("SDK limitation classification cannot hide ordinary-command writes or an absent fallback", async () => {
  await assert.rejects(
    driveHooks({ AXI_SDK_DEFAULT_CLAUDE: "1", AXI_BAD_NORMAL: "1" }),
    (error) => {
      assert.equal(
        error.knownLimitation.id,
        "axi-sdk-js-claude-config-dir-sessionstart",
      );
      assert.equal(error.toolFailure, true);
      assert.match(error.message, /normal command changed disposable/);
      return true;
    },
  );
  await assert.rejects(driveHooks({ AXI_OMIT_CLAUDE_START: "1" }), (error) => {
    assert.equal(error.knownLimitation, undefined);
    assert.match(error.message, /expected exactly one managed hook/);
    return true;
  });
});
test("invalid archive paths and SHA values are CLI usage errors before artifact work", async () => {
  const root = await scratch();
  try {
    for (const args of [
      ["packed", "--tarball", "relative.tgz"],
      [
        "packed",
        "--tarball",
        join(root, "missing.tgz"),
        "--expected-git-head",
        "bad-sha",
      ],
    ]) {
      const result = await processResult(process.execPath, [cli, ...args], {
        cwd: root,
      });
      assert.equal(result.exit, 2, result.stdout);
      assert.equal(result.decoded.code, "VALIDATION_ERROR");
    }
  } finally {
    await cleanup(root);
  }
});
test("argocd list fixtures reject missing, changed, and extra arguments", async () => {
  const root = await scratch();
  try {
    for (const args of [
      ["app", "list"],
      ["app", "list", "-o", "yaml"],
      ["app", "list", "-o", "json", "--unexpected"],
    ]) {
      const lab = await sandbox(root);
      const result = await processResult(join(lab.bin, "argocd"), args, {
        env: lab.env,
        cwd: lab.cwd,
      });
      assert.equal(result.exit, 97, `fixture accepted ${JSON.stringify(args)}`);
      await assert.rejects(noUnexpectedIO(lab), /unexpected subprocess/);
    }
  } finally {
    await cleanup(root);
  }
});
test("Node UDP and DNS probes are refused and logged without contacting a real service", async () => {
  const root = await scratch(),
    udp = createSocket("udp4");
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  try {
    for (const code of [
      `const s=require('dgram').createSocket('udp4');s.unref();s.send('fixture',${udp.address().port},'127.0.0.1')`,
      `require('dns').lookup('localhost',()=>{})`,
      `require('dns/promises').lookup('localhost').then(()=>{})`,
      `const r=new(require('dns/promises').Resolver)({timeout:50,tries:1});r.setServers(['127.0.0.1:${udp.address().port}']);r.resolve4('localhost').catch(()=>{})`,
    ]) {
      const lab = await sandbox(root);
      const result = await processResult(process.execPath, ["-e", code], {
        env: lab.env,
        timeout: 5_000,
      });
      assert.notEqual(result.exit, 0, "unobserved UDP/DNS call passed");
      await assert.rejects(noUnexpectedIO(lab), /unexpected network/);
    }
  } finally {
    udp.close();
    await cleanup(root);
  }
});
test("Datadog fixture rejects a monitor-search path prefix instead of the exact endpoint", async () => {
  const root = await scratch(),
    source = join(root, "source"),
    evidence = join(root, "evidence");
  try {
    await fs.mkdir(source);
    await fs.writeFile(
      join(source, "tool.mjs"),
      '#!/usr/bin/env node\nif(process.argv[2]==="monitors") await fetch(process.env.DATADOG_AXI_API_URL+"/api/v1/monitor/search-wrong"); console.log("fixture");\n',
    );
    await fs.chmod(join(source, "tool.mjs"), 0o755);
    await json(join(source, "package.json"), {
      name: "datadog-axi",
      version: "0.1.0",
      type: "module",
      bin: { "datadog-axi": "./tool.mjs" },
      files: ["tool.mjs"],
    });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_globalconfig: join(root, "global-npmrc"),
    };
    await fs.writeFile(env.npm_config_userconfig, "");
    await fs.writeFile(env.npm_config_globalconfig, "");
    const packs = JSON.parse(
      (
        await checked(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
          { env, cwd: source },
        )
      ).stdout,
    );
    const result = await processResult(
      process.execPath,
      [
        cli,
        "packed",
        "--tarball",
        join(root, packs[0].filename),
        "--evidence-dir",
        evidence,
      ],
      { env, cwd: source, timeout: 180_000 },
    );
    assert.equal(result.exit, 1);
    assert(result.decoded.failures.some((row) => /unexpected fixture HTTP request/.test(row.error)), "unexpected HTTP requests must fail their tool rows");
  } finally {
    await cleanup(root);
  }
});
test("packed output separates known SDK limitations from tool failures and rejects vacuous status/config checks", async () => {
  const root = await scratch(),
    source = join(root, "source"),
    evidence = join(root, "evidence");
  try {
    await fs.mkdir(source);
    const fixture = await fs.readFile(
      join(fixtureDir, "hook-tool.mjs"),
      "utf8",
    );
    const newline = fixture.indexOf("\n") + 1;
    await fs.writeFile(
      join(source, "tool.mjs"),
      fixture.slice(0, newline) +
        'process.env.AXI_SDK_DEFAULT_CLAUDE="1";process.env.AXI_MUTATE_DENIED_CONFIG="1";\n' +
        fixture.slice(newline),
    );
    await fs.chmod(join(source, "tool.mjs"), 0o755);
    await json(join(source, "package.json"), {
      name: "argocd-axi",
      version: "0.1.0",
      type: "module",
      bin: { "argocd-axi": "./tool.mjs" },
      files: ["tool.mjs"],
    });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_globalconfig: join(root, "global-npmrc"),
    };
    await fs.writeFile(env.npm_config_userconfig, "");
    await fs.writeFile(env.npm_config_globalconfig, "");
    const packs = JSON.parse(
      (
        await checked(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
          { env, cwd: source },
        )
      ).stdout,
    );
    const result = await processResult(
      process.execPath,
      [
        cli,
        "packed",
        "--tarball",
        join(root, packs[0].filename),
        "--evidence-dir",
        evidence,
      ],
      { env, cwd: source, timeout: 180_000 },
    );
    const summary = JSON.parse(
      await fs.readFile(join(evidence, "summary.json"), "utf8"),
    );
    const status = summary.rows.find((row) => row.id === "read-only-status");
    assert.equal(status.passed, false, "empty status output was accepted");
    assert.match(status.error, /status must report installation state/);
    const denied = summary.rows.find(
      (row) => row.id === "permissions-writable-remove-probe-config-user",
    );
    assert.equal(
      denied.passed,
      false,
      "changed denied-config bytes were accepted",
    );
    assert.match(denied.error, /denied config write changed persisted file/);
    const limitation = summary.rows.find(
      (row) => row.id === "hook-model-selected-claude",
    );
    assert.equal(limitation.status, "known-limitation");
    assert.equal(
      limitation.passed,
      false,
      "known limitations must not be called passing checks",
    );
    assert.equal(summary.knownLimitations.length, 1);
    assert(!summary.failures.some((row) => row.id === limitation.id));
    assert.equal(result.decoded.known_limitations.length, 1);
    assert(!result.decoded.failures.some((row) => row.id === limitation.id));
    const mixedSource = await fs.readFile(join(source, "tool.mjs"), "utf8");
    await fs.writeFile(
      join(source, "tool.mjs"),
      mixedSource.slice(0, newline) +
        'process.env.AXI_BAD_NORMAL="1";\n' +
        mixedSource.slice(newline),
    );
    await checked(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { env, cwd: source },
    );
    const mixed = await processResult(
      process.execPath,
      [
        cli,
        "packed",
        "--tarball",
        join(root, packs[0].filename),
        "--evidence-dir",
        join(root, "mixed-evidence"),
      ],
      { env, cwd: source, timeout: 180_000 },
    );
    assert.equal(
      mixed.decoded.known_limitations.length,
      1,
      "SDK diagnostic must survive a separate real failure",
    );
    const failed = mixed.decoded.failures.find(
      (row) => row.id === limitation.id,
    );
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /normal command changed disposable/);
  } finally {
    await cleanup(root);
  }
});
