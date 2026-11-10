#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, lstatSync, renameSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { kubernetesReply } from "./kubernetes.mjs";
import { updateFixture } from "./update.mjs";
import { behaviourReply } from "./behaviour-external.mjs";
// Exact native fixture vectors only; observation of an operation is independent
// of the wrapper's reported status. Unknown calls fall through to fail closed.
function retryExternal(bin, args) {
  const file = process.env.AXI_RETRY_SCENARIO;
  if (!file) return;
  const scenario = JSON.parse(readFileSync(file, "utf8"));
  const matches = (expected, actual) => {
    if (typeof expected === "string") return expected === actual;
    if (!expected.manifest || typeof actual !== "string") return false;
    const path = resolve(actual), directory = dirname(path);
    if (!directory.startsWith(join(tmpdir(), "argo-workflows-axi-")) || basename(path) !== "workflow.yaml" || !lstatSync(path).isFile()) return false;
    const value = parse(readFileSync(path, "utf8"));
    return value.kind === "Workflow" && value.metadata?.name === expected.manifest;
  };
  const step = scenario.steps.find((s) => s.bin === bin && s.argv.length === args.length && s.argv.every((value, i) => matches(value, args[i])));
  if (!step) return;
  const state = scenario.state ?? "initial", reply = step.states?.[state] ?? step;
  appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin, args, allowed: true, mutation: step.mutation === true, poll: step.poll === true, nativeExit: reply.exit ?? 0, state }) + "\n");
  if (reply.next) {
    scenario.state = reply.next;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(scenario));
    renameSync(temporary, file);
  }
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.stdout !== undefined) process.stdout.write(typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout));
  process.exit(reply.exit ?? 0);
}
const bin = basename(process.argv[1]);
const args = process.argv.slice(2),
  text = args.join(" ");
retryExternal(bin, args);
const behaviour = behaviourReply(bin, args);
if (behaviour) {
  appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin, args, allowed: true, nativeExit: behaviour.exit }) + "\n");
  if (behaviour.stderr) process.stderr.write(behaviour.stderr);
  process.stdout.write(typeof behaviour.stdout === "string" ? behaviour.stdout : JSON.stringify(behaviour.stdout));
  process.exit(behaviour.exit);
}
updateFixture(bin, args);
const exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);
let value;
if (bin === "npm" && exact(["root", "-g"])) value = (process.env.AXI_UPDATE_GLOBAL_ROOT ?? process.env.HOME + "/.npm-global/node_modules") + "\n";
else if (bin === "npm" && [false, true].some((asJson) => exact(["view", process.env.AXI_REGISTRY_PACKAGE, "version", ...(asJson ? ["--json"] : [])]))) value = args.includes("--json") ? JSON.stringify(process.env.AXI_REGISTRY_VERSION) : process.env.AXI_REGISTRY_VERSION + "\n";
else if (bin === "tflint" && exact(["--format=json"])) value = { errors: [], issues: [] };
else if (bin === "argocd") {
  if (exact(["context"]))
    value = "CURRENT  NAME   SERVER\n*        probe  probe.invalid\n";
  else if (text.startsWith("account get-user-info"))
    value = { loggedIn: true, username: "fixture", groups: [] };
  else if (text.startsWith("version"))
    value = { client: { version: "v3.0.0" }, server: { version: "v3.0.0" } };
  else if (exact(["account", "can-i", "get", "applications", "probe/healthy"])) value = "yes\n";
  else if (exact(["app", "manifests", "healthy", "--source", "git"])) value = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: healthy\n";
  else if (exact(["app", "logs", "healthy", "--tail", "100"])) value = "fixture log\n";
  else if (exact(["app", "actions", "list", "healthy", "-o", "json"])) value = [];
  else if (exact(["proj", "list", "-o", "json"])) value = [{ metadata: { name: "probe" }, spec: {} }];
  else if (exact(["proj", "get", "probe", "-o", "json"])) value = { metadata: { name: "probe" }, spec: {} };
  else if (exact(["proj", "windows", "list", "probe", "-o", "json"])) value = [];
  else if (exact(["appset", "list", "-o", "json"])) value = [{ metadata: { name: "probe" }, spec: { generators: [] } }];
  else if (exact(["appset", "get", "probe", "-o", "json"])) value = { metadata: { name: "probe" }, spec: { generators: [] } };
  else if (exact(["repo", "list", "-o", "json"])) value = [{ repo: "https://example.invalid/repo", connectionState: { status: "Successful" } }];
  else if (exact(["cluster", "list", "-o", "json"])) value = [{ name: "probe", server: "https://probe.invalid", connectionState: { status: "Successful" } }];
  else if (
    exact(["app", "list", "-o", "json"])
  )
    value = ["healthy", "problem"].map((name, index) => ({
      metadata: { name, namespace: "default" },
      spec: {
        project: "probe",
        source: { repoURL: "https://example.invalid/repo" },
      },
      status: {
        sync: { status: index ? "OutOfSync" : "Synced" },
        health: {
          status: index ? "Degraded" : "Healthy",
          message: index ? "synthetic readiness failure" : "",
        },
        resources: [],
      },
    }));
} else if (bin === "argo") {
  if (text.startsWith("version")) value = "argo: v3.6.0\n";
  else if (exact(["logs", "healthy", "--tail=100", "--container=main", "--loglevel=error"])) value = "fixture log\n";
  else if (["cron", "template", "cluster-template"].some((noun) => exact([noun, "list", "--output=name", "--loglevel=error"]))) value = "healthy\n";
  else if (["cron", "template", "cluster-template"].some((noun) => exact([noun, "get", "healthy", "--output=json", "--loglevel=error"]))) value = { metadata: { name: "healthy", namespace: "default" }, spec: { schedule: "0 * * * *", workflowSpec: { entrypoint: "main" }, templates: [] }, status: {} };
  else if (exact(["list", "--output=json", "--loglevel=error"]))
    value = ["healthy", "problem"].map((name, index) => ({
      metadata: {
        name,
        namespace: "default",
        creationTimestamp: "2026-01-01T00:00:00Z",
      },
      spec: {},
      status: {
        phase: index ? "Failed" : "Succeeded",
        message: index ? "synthetic step failure" : "",
      },
    }));
} else if (bin === "kubectl") {
  const reply = kubernetesReply(args);
  if (reply !== undefined) value = reply;
  else if (
    text.includes("current-context") ||
    text.startsWith("config get-contexts")
  )
    value = "probe\n";
  else if (text.startsWith("config view") && text.includes("cluster.server"))
    value = "https://probe.invalid\ndefault\n";
  else if (text.startsWith("config view") && text.includes("jsonpath"))
    value = "default\n";
  else if (text.startsWith("config view"))
    value = {
      "current-context": "probe",
      contexts: [
        { name: "probe", context: { namespace: "default", cluster: "probe" } },
      ],
      clusters: [
        { name: "probe", cluster: { server: "https://probe.invalid" } },
      ],
    };
  else if (text.startsWith("version"))
    value = { clientVersion: { gitVersion: "v1.34.0" } };
  else if (["namespaces", "nodes"].some((noun) => exact(["get", noun, "-o", "json", "--context=probe", "--request-timeout=15000ms"]))) value = { apiVersion: "v1", kind: "List", items: [] };
  else if (["deployments.apps", "jobs.batch", "persistentvolumeclaims", "services", "endpointslices.discovery.k8s.io", "events"].some((noun) => exact(["get", noun, "-n", "default", "-o", "json", "--context=probe", "--request-timeout=15000ms"]))) value = { apiVersion: "v1", kind: "List", items: [] };
  else if (exact(["get", "secrets", "-n", "default", '--output=go-template={{range .items}}{{"["}}{{printf "%q" .metadata.namespace}},{{printf "%q" .metadata.name}},{{printf "%q" (printf "%v" .type)}},{{printf "%q" .metadata.creationTimestamp}},{{"["}}{{$sep := ""}}{{range $k, $_ := .data}}{{$sep}}{{printf "%q" $k}}{{$sep = ","}}{{end}}{{"]]\\n"}}{{end}}', "--context=probe", "--request-timeout=15000ms"])) value = "";
  else if (/\bget namespace default\b/.test(text))
    value = "namespace/default\n";
  else if (exact(["get", "pods", "-n", "default", "-o", "json", "--context=probe", "--request-timeout=15000ms"]))
    value = {
      apiVersion: "v1",
      kind: "PodList",
      items: ["healthy", "problem"].map((name, index) => ({
        metadata: {
          name,
          namespace: "default",
          creationTimestamp: "2026-01-01T00:00:00Z",
        },
        spec: {
          containers: [{ name: "app", image: "example.invalid/app:fixture" }],
        },
        status: {
          phase: index ? "Pending" : "Running",
          conditions: [{ type: "Ready", status: index ? "False" : "True" }],
          containerStatuses: [
            {
              name: "app",
              ready: !index,
              restartCount: index ? 3 : 0,
              state: index
                ? { waiting: { reason: "CrashLoopBackOff" } }
                : { running: {} },
            },
          ],
        },
      })),
    };
} else if (["terraform", "tofu"].includes(bin)) {
  if (exact(["version", "-json"])) value = { terraform_version: "1.10.0" };
  else if ([false, true].some((drift) => exact([`-chdir=${process.cwd()}`, "plan", "-json", "-input=false", "-lock=false", "-detailed-exitcode", ...(drift ? ["-refresh-only"] : [])])))
    value = JSON.stringify({ type: "version", terraform: "1.10.0", ui: "1.2" }) + "\n" + JSON.stringify({ type: "change_summary", changes: { add: 0, change: 0, remove: 0, operation: "plan" } }) + "\n";
  else if (exact([`-chdir=${process.cwd()}`, "fmt", "-check", "-no-color"])) value = "";
  else if (exact([`-chdir=${process.cwd()}`, "validate", "-json", "-no-color"])) value = { valid: true, diagnostics: [] };
  else if (exact([`-chdir=${process.cwd()}`, "state", "list"]))
    value = "terraform_data.healthy\nterraform_data.problem\n";
  else if (exact([`-chdir=${process.cwd()}`, "show", "-json"]))
    value = {
      format_version: "1.0",
      values: {
        root_module: {
          resources: ["healthy", "problem"].map((name) => ({
            address: `terraform_data.${name}`,
            mode: "managed",
            type: "terraform_data",
            name,
            values: { input: "fixture" },
            sensitive_values: {},
          })),
        },
      },
    };
}
const allowed = value !== undefined;
appendFileSync(
  process.env.AXI_FIXTURE_LOG,
  JSON.stringify({ bin, args, allowed }) + "\n",
);
if (!allowed) {
  process.stderr.write(
    "Unexpected fixture subprocess: " + bin + " " + text + "\n",
  );
  process.exit(97);
}
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
