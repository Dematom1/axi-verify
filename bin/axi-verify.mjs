#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) {
  process.stdout.write(manifest.version + "\n");
} else {
  const { commands } = await import("../lib/commands.mjs");
  const { encode } = await import("@toon-format/toon");
  const output = (value) => process.stdout.write(encode(value) + "\n");
  const packedFlags = { "--tarball": "tarball", "--expected-git-head": "expectedGitHead", "--evidence-dir": "evidenceDir" };
  const [command, ...rest] = args;
  const validFlags = command === "packed" ? [...Object.keys(packedFlags), "--help"] : ["--help"];
  const reference = (route) => ({
    bin: fileURLToPath(import.meta.url), description: manifest.description,
    usage: route === "static" ? "axi-verify static [--help]" : "axi-verify packed [--tarball <absolute.tgz>] [--expected-git-head <40-char-sha>] [--evidence-dir <path>] [--help]",
    flags: route === "static" ? ["--help"] : [...Object.keys(packedFlags), "--help"],
    defaults: route === "static" ? "none; no defaults apply" : "--tarball: pack current source; --expected-git-head: none; --evidence-dir: .axi-evidence/<timestamp>",
    examples: route === "static" ? ["axi-verify static", "axi-verify static --help"] : ["axi-verify packed", "axi-verify packed --tarball /absolute/tool.tgz --evidence-dir /absolute/evidence"],
  });
  try {
    if (args.includes("--help")) output(commands.includes(command) ? reference(command) : { ...reference("packed"), commands });
    else if (!args.length) {
      let contract = "unconfigured";
      try { await access(join(process.cwd(), ".axi", "verify.json")); contract = "configured"; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      output({ bin: fileURLToPath(import.meta.url), description: manifest.description, directory: process.cwd(), contract, commands,
        help: ["Run `axi-verify static` to scan source", "Run `axi-verify packed` to verify the installed archive contract"] });
    } else {
      const options = {};
      if (!commands.includes(command)) throw new TypeError(`Unknown command ${command}`);
      while (rest.length) {
        const flag = rest.shift();
        if (command !== "packed" || !Object.hasOwn(packedFlags, flag)) throw new TypeError(`Unknown flag or extra operand ${flag}`);
        const value = rest.shift();
        if (!value || value.startsWith("--") || Object.hasOwn(options, packedFlags[flag])) throw new TypeError(`Supply ${flag} exactly once with a value`);
        options[packedFlags[flag]] = value;
      }
      if (options.expectedGitHead && !options.tarball) throw new TypeError("--expected-git-head requires --tarball (never repack a release artifact)");
      const result = command === "packed"
        ? await (await import("../lib/packed.mjs")).verifyPacked(options)
        : await (await import("../lib/static.mjs")).verifyStatic();
      output(command === "packed" ? {
        package: result.package, version: result.version, passed: result.passed, rows: result.rows.length,
        failures: result.failures, unexpected_http: result.unexpectedHttp, known_limitations: result.knownLimitations,
        principle_coverage: result.principleCoverage.map((p) => ({ principle: p.principle, passed: p.passed, checks: p.rows.length, not_applicable: p.notApplicable.length })),
        retry_limits: result.retryLimits, retry_coverage: result.retryCoverage, evidence: result.evidence,
      } : result);
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    output({ error: error.message, code: error instanceof TypeError ? "VALIDATION_ERROR" : "VERIFICATION_FAILED",
      flags: validFlags, help: [error instanceof TypeError ? `Run \`axi-verify ${commands.includes(command) ? command : "packed"} --help\` to correct the invocation` : "Run `axi-verify packed --tarball <readable-archive>` to retry with a readable archive"] });
    process.exitCode = error instanceof TypeError ? 2 : 1;
  }
}
