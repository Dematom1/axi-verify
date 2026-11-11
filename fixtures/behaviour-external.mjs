import { readFileSync } from "node:fs";
import { argocdApps, argoWorkflows } from "./adapter-replies.mjs";

export function behaviourReply(bin, args) {
  if (!process.env.AXI_BEHAVIOUR_DATA) return;
  const data = JSON.parse(readFileSync(process.env.AXI_BEHAVIOUR_DATA, "utf8"));
  const exact = (argv) => JSON.stringify(args) === JSON.stringify(argv);
  let stdout;
  if (data.adapter === "terraform-local" && ["terraform", "tofu"].includes(bin)) {
    if (exact([`-chdir=${data.module}`, "state", "list"])) stdout = data.identities.join("\n") + (data.identities.length ? "\n" : "");
    if (exact([`-chdir=${data.module}`, "show", "-json"])) stdout = {
      format_version: "1.0", values: { root_module: { resources: data.identities.map((address, i) => ({ address, mode: "managed", type: "terraform_data", name: address.split(".")[1], provider_name: "terraform.io/builtin/terraform", values: { id: i === 0 ? data.text : `local-${i}`, input: "fixture" }, sensitive_values: {} })) } },
    };
  }
  if (data.adapter === "kubernetes" && bin === "kubectl" && exact(["get", "pods", "-n", "default", "-o", "json", "--context=probe", "--request-timeout=15000ms"])) stdout = {
    apiVersion: "v1", kind: "PodList", items: data.identities.map((name, i) => ({
      metadata: { name, namespace: "default", creationTimestamp: "2026-01-01T00:00:00Z" },
      spec: { containers: [{ name: "app", image: "example.invalid/fixture" }] },
      status: { phase: i ? "Pending" : "Running", message: data.text, conditions: [{ type: "Ready", status: i ? "False" : "True" }], containerStatuses: [{ name: "app", ready: !i, restartCount: i, state: i ? { waiting: { reason: "CrashLoopBackOff" } } : { running: {} } }] },
    })),
  };
  if (data.adapter === "argo-workflows" && bin === "argo" && exact(["list", "--output=json", "--loglevel=error"])) stdout = argoWorkflows(data);
  if (data.adapter === "argocd" && bin === "argocd" && exact(["app", "list", "-o", "json"])) stdout = argocdApps(data);
  if (stdout !== undefined) return data.mode === "backend-denied" ? { stdout: "", stderr: "synthetic permission denial", exit: 1 } : { stdout, exit: 0 };
}
