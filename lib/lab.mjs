import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@toon-format/toon";
import { fileURLToPath } from "node:url";

export const fixtureDir = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);
export const json = async (file, value) => {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
};
export function prerequisite() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("PREREQUISITE: non-root Linux or macOS required");
  if (process.getuid() === 0)
    throw new Error("PREREQUISITE: root cannot prove permission denials");
}
export async function processResult(command, args, options = {}) {
  const { timeout = 20_000, input = "", ...spawnOptions } = options;
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0,
      failure;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      failure = "timeout";
      kill();
    }, timeout);
    for (const channel of ["stdout", "stderr"])
      child[channel].on("data", (data) => {
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024) {
          failure = "output limit";
          kill();
        } else chunks[channel].push(data);
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (exit, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.stdout).toString();
      let decoded, decodeError;
      try {
        decoded = decode(stdout);
      } catch (error) {
        decodeError = error.message;
      }
      resolveResult({
        command,
        argv: args,
        exit,
        signal,
        failure,
        stdout,
        stderr: Buffer.concat(chunks.stderr).toString(),
        decoded,
        decodeError,
      });
    });
  });
}
export async function checked(command, args, options) {
  const result = await processResult(command, args, options);
  if (result.exit !== 0 || result.failure)
    throw new Error(
      `${command} failed: ${result.failure || result.stderr || result.stdout}`,
    );
  return result;
}
export async function snapshot(root, excluded = new Set()) {
  const out = {};
  async function walk(path) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name),
        key = relative(root, file);
      if (excluded.has(key)) continue;
      const stat = await fs.lstat(file, { bigint: true });
      const metadata = {
        mode: String(stat.mode),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
      };
      if (entry.isSymbolicLink()) out[key] = { ...metadata, type: "symlink" };
      else if (entry.isDirectory()) {
        out[key] = { ...metadata, type: "directory" };
        await walk(file);
      } else out[key] = { ...metadata, type: "file" };
    }
  }
  await walk(root);
  return out;
}
export async function lock(path, mode = 0o555) {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) {
    if (mode === 0o700) return;
    throw new Error(`Refusing permission change through symlink ${path}`);
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(path))
      await lock(join(path, name), mode === 0o700 ? 0o700 : 0o555);
    await fs.chmod(path, mode);
  } else await fs.chmod(path, mode === 0o700 ? 0o600 : 0o444);
}
export async function deniedProbe(path, read = false) {
  try {
    if (read) await fs.readFile(path);
    else
      await fs.writeFile(join(path, ".axi-permission-probe"), "must fail", {
        flag: "wx",
      });
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) return error.code;
    throw error;
  }
  throw new Error(
    `PREREQUISITE: ineffective ${read ? "read" : "write"} lock at ${path}`,
  );
}
export async function sandbox(root, customClaude = false) {
  const base = await fs.mkdtemp(join(root, "row-"));
  const home = join(base, "home"),
    cwd = join(base, "cwd"),
    bin = join(base, "bin");
  for (const dir of [
    home,
    cwd,
    bin,
    join(base, "tmp"),
    ...[".claude", ".codex", ".config", "selected-claude"].map((d) =>
      join(home, d),
    ),
    ...[".claude", ".codex", ".opencode"].map((d) => join(cwd, d)),
  ])
    await fs.mkdir(dir, { recursive: true });
  await fs.symlink(process.execPath, join(bin, "node"));
  for (const name of ["argocd", "argo", "kubectl", "terraform", "tofu", "npm", "pnpm", "yarn", "bun", "tflint"])
    await fs.symlink(join(fixtureDir, "external.mjs"), join(bin, name));
  for (const name of [
    "node",
    "argocd",
    "argo",
    "kubectl",
    "terraform",
    "tofu",
    "npm", "pnpm", "yarn", "bun", "tflint",
  ]) {
    const expected =
      name === "node" ? process.execPath : join(fixtureDir, "external.mjs");
    if ((await fs.realpath(join(bin, name))) !== (await fs.realpath(expected)))
      throw new Error(`Fixture shim missing: ${name}`);
  }
  const env = {
    PATH: `${bin}:/bin:/usr/bin`,
    HOME: home,
    TMPDIR: join(base, "tmp"),
    TMP: join(base, "tmp"),
    TEMP: join(base, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, customClaude ? "selected-claude" : ".claude"),
    CLOUDSDK_CONFIG: join(home, "gcloud"),
    KUBECONFIG: join(home, "kubeconfig"),
    CI: "1",
    NO_COLOR: "1",
    GCE_METADATA_HOST: "127.0.0.1:9",
    GOOGLE_APPLICATION_CREDENTIALS: join(home, "missing-credentials.json"),
    DD_API_KEY: "synthetic-api-key",
    DD_APP_KEY: "synthetic-app-key",
    AXI_FIXTURE_LOG: join(base, "requests.jsonl"),
    AXI_NETWORK_LOG: join(base, "network.jsonl"),
    npm_config_cache: join(base, "npm-cache"),
    npm_config_userconfig: join(base, "npmrc"),
    npm_config_globalconfig: join(base, "global-npmrc"),
    NODE_OPTIONS: `--import=${JSON.stringify(join(fixtureDir, "network.mjs"))}`,
  };
  await fs.writeFile(
    env.npm_config_userconfig,
    "registry=https://registry.npmjs.org/\n",
  );
  await fs.writeFile(env.npm_config_globalconfig, "");
  const key = join(base, "service-account.json");
  await json(key, {
    type: "service_account",
    client_email: "probe@example.invalid",
    private_key: "not-a-real-key",
  });
  await fs.writeFile(
    env.KUBECONFIG,
    "apiVersion: v1\nkind: Config\ncurrent-context: probe\ncontexts:\n- name: probe\n  context:\n    cluster: probe\n    namespace: default\nclusters:\n- name: probe\n  cluster:\n    server: https://probe.invalid\n",
  );
  return { base, home, cwd, bin, env, key };
}
export async function observe(bin, args, lab, options = {}) {
  const excluded = new Set(["requests.jsonl", "network.jsonl"]);
  const before = {
    home: await snapshot(lab.home),
    cwd: await snapshot(lab.cwd),
    scratch: await snapshot(lab.base, excluded),
  };
  const result = await processResult(bin, args, {
    env: lab.env,
    cwd: lab.cwd,
    ...options,
  });
  return {
    ...result,
    environment: options.env ?? lab.env,
    before,
    after: {
      home: await snapshot(lab.home),
      cwd: await snapshot(lab.cwd),
      scratch: await snapshot(lab.base, excluded),
    },
  };
}
export async function cleanup(root) {
  await lock(root, 0o700);
  await fs.rm(root, { recursive: true, force: true });
}
export async function scratch() {
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), "axi-verify-")));
}
export async function installedBins(prefix, manifest) {
  const bins =
    typeof manifest.bin === "string"
      ? { [manifest.name]: manifest.bin }
      : manifest.bin;
  if (!bins || !Object.hasOwn(bins, manifest.name))
    throw new Error("Archive must declare its named primary bin");
  const result = {};
  for (const [name, target] of Object.entries(bins)) {
    const link = join(prefix, "node_modules", ".bin", name);
    const actual = await fs.realpath(link);
    const expected = resolve(prefix, "node_modules", manifest.name, target);
    if (
      actual !== expected ||
      !expected.startsWith(resolve(prefix, "node_modules", manifest.name) + "/")
    )
      throw new Error(`Invalid installed bin ${name}`);
    await fs.access(link, constants.X_OK);
    result[name] = link;
  }
  return result;
}
