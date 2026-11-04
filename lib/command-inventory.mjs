import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { normalUnchanged, successful } from "./observations.mjs";

export function advertisedRoutes(text, parent, roots, name) {
  const routes = new Set();
  const add = (signature, relative = false) => {
    signature = signature.trim().replace(/^- /, "");
    if (signature.startsWith(name + " ")) signature = signature.slice(name.length + 1);
    const route = /^[a-z][a-z-]*(?: [a-z][a-z-]*)*/.exec(signature)?.[0];
    if (!route) return;
    const top = route.split(" ")[0];
    if (!roots.includes(top) && !relative) return;
    const full = roots.includes(top) ? route : `${parent} ${route}`;
    if (roots.includes(full.split(" ")[0])) routes.add(full);
  };
  const usage = (value) => { for (const part of value.split(" | ")) add(part, true); };
  let data;
  try { data = decode(text); } catch { /* Some tools use presentation text rather than TOON help. */ }
  if (data && typeof data === "object") {
    for (const key of ["usage", "command"]) if (typeof data[key] === "string") usage(data[key]);
    for (const key of ["subcommands", "commands", "help"]) if (Array.isArray(data[key]))
      for (const item of data[key]) if (typeof item === "string" && item.includes(":")) {
        const signature = item.split(":")[0];
        if (key === "commands") usage(signature);
        else add(signature, key === "subcommands");
      }
  }
  for (const match of text.matchAll(/^(?:usage|command): (.+)$/gm)) usage(match[1]);
  for (const block of text.matchAll(/^subcommands\[\d+\]:[^\n]*\n((?:[ \t].*(?:\n|$))*)/gm))
    for (const line of block[1].split("\n")) if (line.includes(":")) add(line.split(":")[0], true);
  return [...routes];
}

export async function commandInventory({ bin, name, profile, lab, invoke }) {
  let routes, registration;
  if (name === "axi-verify") {
    const source = await fs.readFile(bin, "utf8");
    const declaration = /const commands = (\[[^\]]+\]);/.exec(source);
    assert(declaration, "axi-verify must expose its command allowlist in the entrypoint");
    routes = ["", ...JSON.parse(declaration[1])];
  } else {
    let sdk;
    const require = createRequire(lab.packageRoot + "/package.json");
    for (const directory of require.resolve.paths("axi-sdk-js")) {
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(join(directory, "axi-sdk-js", "package.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const entry = manifest.exports?.["."]?.import ?? manifest.main;
      assert(typeof entry === "string" && entry.startsWith("./"), "cannot resolve SDK's import entry");
      sdk = join(directory, "axi-sdk-js", entry);
      break;
    }
    const result = await invoke(bin, ["--help"], lab, { env: { ...lab.env,
      AXI_INVENTORY_SDK: sdk ?? "",
      AXI_INVENTORY_ROOT: lab.packageRoot,
      AXI_INVENTORY_CAPTURE: new URL("../fixtures/inventory.mjs", import.meta.url).href,
    } });
    successful(result);
    normalUnchanged(result);
    try { registration = JSON.parse(result.stdout); } catch { throw new Error("cannot inspect command registry: SDK registration was not captured"); }
    assert(Array.isArray(registration.routes), "command registry must include routes");
    routes = registration.routes;
  }
  const fixtures = profile.idempotency.filter((fixture) => !fixture.binName && !fixture.argv.includes("--help"));
  const missing = routes.filter((route) => !fixtures.some((fixture) => {
    if (route === "") return fixture.argv.length === 0;
    const fixtureRoute = routes.filter((candidate) => candidate !== "" &&
      fixture.argv.slice(0, candidate.split(" ").length).join(" ") === candidate)
      .sort((a, b) => b.split(" ").length - a.split(" ").length)[0];
    return fixtureRoute === route;
  }));
  assert.equal(missing.length, 0, `unclassified commands or missing retry fixtures: ${missing.join(", ")}`);
  return { routes, fixtures: fixtures.map(({ kind, argv }) => ({ kind, argv })), registration };
}
