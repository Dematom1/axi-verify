import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { decode, encode } from "@toon-format/toon";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const publishedHash = "6b123e987640bb539143b300dcde120e9a5bff1aa1c92ae47c0cedbefdd78ee9";

export async function recordTerraformEvidence(review, destination, identity = { home: homedir(), username: userInfo().username, hostname: hostname() }) {
  const previous = JSON.parse(await fs.readFile(new URL("../tests/terraform-0.1.3/provenance.json", import.meta.url), "utf8"));
  const results = JSON.parse(await fs.readFile(join(review, "results.json"), "utf8"));
  const normalize = (value) => JSON.parse(JSON.stringify(value, (_, item) => {
    if (typeof item !== "string") return item;
    let text = item.replace(/\/(?:Users|home)\/.*?\/fixtures\//g, "/fixtures/");
    if (identity.home) text = text.replaceAll(identity.home, "/fixtures/home");
    text = text.replace(/\/(?:Users|home)\/[^\s"'`,\\\]]+/g, "/fixtures/home");
    for (const [original, placeholder] of [[identity.username, "<user>"], [identity.hostname, "<host>"]]) if (original) text = text.replaceAll(original, placeholder);
    return text;
  }));
  const files = [];
  await fs.mkdir(destination, { recursive: true });
  for (const { file } of previous.files) {
    assert.equal(file, basename(file), "recorded file must stay inside evidence directory");
    if (file.endsWith(".tgz")) {
      const bytes = await fs.readFile(join(review, file));
      assert.equal(sha256(bytes), publishedHash, "published tarball must remain byte-identical");
      await fs.writeFile(join(destination, file), bytes);
      files.push({ file, sha256: publishedHash });
    } else {
      const source = await fs.readFile(join(review, "runs", file));
      const result = results.find((row) => row.label + ".stdout" === file);
      assert(result, `missing recorded invocation for ${file}`);
      assert.equal(source.toString(), result.stdout, `recorded output disagrees with results.json: ${file}`);
      const bytes = Buffer.from(encode(normalize(decode(source.toString()))) + "\n");
      await fs.writeFile(join(destination, file), bytes);
      files.push({ file, sha256: sha256(bytes), sourceSha256: sha256(source), argv: normalize(result.args), exit: result.exit });
    }
  }
  const provenance = {
    package: previous.package, version: previous.version, gitHead: previous.gitHead,
    source: previous.source,
    normalization: "Recorded TOON and argv have personal home prefixes, local username, and machine name replaced with stable placeholders before hashing. sourceSha256 identifies original captured stdout; the published tarball is unchanged.",
    files,
  };
  await fs.writeFile(join(destination, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  return provenance;
}
