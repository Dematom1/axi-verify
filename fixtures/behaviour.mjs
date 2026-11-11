import * as fs from "node:fs/promises";
import { join } from "node:path";
import { json } from "../lib/lab.mjs";
import { adapters } from "./adapters.mjs";

// Fixture adapters own the expected records. Consumer manifests cannot supply
// expected backend data, arbitrary commands, credentials, or network access.
export async function seedBehaviour(lab, contract, mode = "normal") {
  const projectA = join(lab.cwd, "project-a"), projectB = join(lab.cwd, "project-b");
  for (const path of [projectA, join(projectA, "child"), projectB, join(lab.cwd, "unrelated")]) await fs.mkdir(path, { recursive: true });
  const plan = join(lab.base, "plan.json"), session = join(lab.home, "session-a.txt");
  const terraform = contract.fixture === "terraform-local";
  const adapter = adapters[contract.fixture];
  const total = mode === "empty" ? 0 : mode === "small" ? 1 : terraform ? 105 : adapter.total ?? 5;
  const identity = adapter.identity ?? ((i) => terraform ? `terraform_data.item${String(i).padStart(3, "0")}` : String(i));
  const identities = Array.from({ length: total }, (_, i) => identity(i));
  const text = mode === "small" ? "short fixture" : "x".repeat(500) + "TAIL";
  const data = { adapter: contract.fixture, mode, module: projectA, projectA, projectB, session, text, identities, homeMarker: "project-a" };
  lab.env.AXI_BEHAVIOUR_DATA = join(lab.base, "behaviour.json");
  if (contract.fixture === "search-console") { lab.env.GOOGLE_APPLICATION_CREDENTIALS = lab.key; lab.env.AXI_GOOGLE_ROOT = lab.packageRoot; }
  await json(lab.env.AXI_BEHAVIOUR_DATA, data);
  const planCount = mode === "empty" ? 0 : mode === "small" ? 1 : 30;
  const changes = Array.from({ length: planCount }, (_, i) => ({ address: `terraform_data.item${String(i).padStart(3, "0")}`, mode: "managed", type: "terraform_data", name: `item${String(i).padStart(3, "0")}`, provider_name: "terraform.io/builtin/terraform", change: { actions: ["create"], before: null, after: { input: "fixture" }, after_unknown: {} } }));
  await json(plan, { format_version: "1.2", terraform_version: "1.15.8", planned_values: { root_module: { resources: [] } }, resource_changes: changes });
  if (terraform) {
    await json(join(lab.env.XDG_CONFIG_HOME, "terraform-axi", "config.json"), { binary: "terraform", modules: [projectA, projectB] });
    for (const directory of [projectA, projectB]) await fs.writeFile(join(directory, "main.tf"), 'resource "terraform_data" "fixture" { input = "local-only" }\n');
  }
  return {
    data, tokens: { module: projectA, plan, address: "terraform_data.item000", context: "probe", namespace: "default" },
    expected(argv) {
      const isPlan = terraform && argv[0] === "plan";
      return { identities: isPlan ? changes.map((r) => r.address) : identities, text,
        aggregates: { open: mode === "empty" ? 0 : 4, add: planCount, change: 0, destroy: 0 } };
    },
    async changeHome() {
      if (terraform) {
        await json(join(lab.env.XDG_CONFIG_HOME, "terraform-axi", "config.json"), { binary: "terraform", modules: [projectB] });
        return { present: "project-b", absent: "project-a" };
      }
      if (contract.fixture === "axi-verify") {
        await json(join(lab.cwd, ".axi/verify.json"), {});
        return { present: "configured", absent: "unconfigured" };
      }
      if (adapter.identity) {
        // Live backend state: rename the first record so a content-first home must change with it.
        const absent = data.identities[0]; data.identities[0] = adapter.renamed; await json(lab.env.AXI_BEHAVIOUR_DATA, data);
        return { present: adapter.renamed, absent };
      }
      data.homeMarker = "project-new"; await json(lab.env.AXI_BEHAVIOUR_DATA, data);
      return { present: "project-new", absent: "project-a" };
    },
    capture: contract.fixture === "contract-fixture" ? ["static", "--capture"] : ["context", "end"],
  };
}

export const expand = (argv, fixture) => argv.map((value) => value.replace(/\{([a-z]+)\}/g, (_, key) => {
  if (!Object.hasOwn(fixture.tokens, key)) throw new Error(`unknown fixture token ${key}`);
  return fixture.tokens[key];
}));
