import * as fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { verifyPacked } from "../lib/packed.mjs";
import { json } from "../lib/lab.mjs";

const [directory, ...archives] = process.argv.slice(2);
if (!directory || !archives.length) throw new Error("Usage: node scripts/prove-idempotency.mjs <evidence-dir> <archive.tgz>...");
const evidence = resolve(directory), results = [];
await fs.mkdir(evidence, { recursive: true });
for (const [index, archive] of archives.entries()) {
  let result;
  try {
    result = await verifyPacked({ tarball: resolve(archive), family: "idempotency", evidenceDir: join(evidence, String(index)) });
  } catch (error) {
    results.push({ archive: resolve(archive), passed: false, prerequisiteError: error.message });
    await json(join(evidence, "idempotency-summary.json"), results);
    continue;
  }
  const report = { package: result.package, version: result.version, passed: result.passed,
    counts: Object.fromEntries(["passed", "failed", "known-limitation"].map((status) =>
      [status, result.rows.filter((r) => r.status === status).length])),
    findings: result.failures, knownLimitations: result.knownLimitations, retryLimits: result.retryLimits, evidence: result.evidence };
  results.push(report);
  await json(join(evidence, "idempotency-summary.json"), results);
  console.log(`${report.package}@${report.version}: ${JSON.stringify(report.counts)}`);
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
