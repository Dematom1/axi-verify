import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { checked } from "./lab.mjs";

const rows = (kind, commands) => commands.map((argv) => ({ kind, argv }));
const commands = (text) => text.split(",").map((s) => s.trim().split(" "));
export const application = (phase = "Succeeded") => ({
  metadata: { name: "healthy", namespace: "default" },
  spec: { project: "probe", source: { repoURL: "https://example.invalid/repo", targetRevision: "main" } },
  status: { sync: { status: "Synced", revision: "0123456789abcdef0123456789abcdef01234567" }, health: { status: "Healthy" },
    history: [{ id: 1, revision: "0123456789abcdef0123456789abcdef01234567", deployedAt: "2026-01-01T00:00:00Z" }],
    operationState: { phase }, resources: [] },
});
export const workflow = (phase = "Succeeded") => ({
  metadata: { name: "healthy", namespace: "default", uid: "fixture-uid", creationTimestamp: "2026-01-01T00:00:00Z" },
  spec: {}, status: { phase, message: "fixture", nodes: {} },
});
const getApp = { bin: "argocd", argv: ["app", "get", "healthy", "-o", "json"], stdout: application(), poll: true };
const getWorkflow = { bin: "argo", argv: ["get", "healthy", "--output=json", "--loglevel=error"], stdout: workflow(), poll: true };
const grant = async (lab) => {
  const directory = join(lab.env.XDG_CONFIG_HOME, "argocd-axi");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, "config"), "writable-contexts: [probe]\n");
};
const mutatingApp = (argv, before, after) => ({ steps: [
  { bin: "argocd", argv: ["proj", "windows", "list", "probe", "-o", "json", "--argocd-context", "probe"], stdout: [] },
  { ...getApp, argv: [...getApp.argv, "--argocd-context", "probe"], states: { initial: { stdout: before }, done: { stdout: after } } },
  ...["get", "sync", "update", "override"].map((action) => ({ bin: "argocd", argv: ["account", "can-i", action, "applications", "probe/healthy", "--argocd-context", "probe"], stdout: "yes\n" })),
  { bin: "argocd", argv: [...argv, "--argocd-context", "probe"], mutation: true, stdout: "", next: "done" },
] });
const nativeWrite = (verb, argv, before, after = application()) => ({
  kind: "write", argv: ["apps", verb, "healthy", ...(verb === "rollback" ? ["1"] : []), "--confirm"], seed: grant,
  native: mutatingApp(argv, before, after),
});
const runningApp = application("Running");
runningApp.status.sync.status = "OutOfSync";
const unsyncedApp = application();
unsyncedApp.status.sync = { status: "OutOfSync", revision: "fedcba9876543210fedcba9876543210fedcba98" };
const samePrefixApp = application();
samePrefixApp.status.sync.revision = application().status.sync.revision.slice(0, 7) + "f".repeat(33);
const currentUnsyncedApp = application();
currentUnsyncedApp.status.sync.status = "OutOfSync";
const automatedCurrentApp = application();
automatedCurrentApp.spec.syncPolicy = { automated: { prune: true, selfHeal: true } };
const multiBefore = application(), multiAfter = application();
for (const app of [multiBefore, multiAfter]) {
  app.spec.sources = [app.spec.source, { ...app.spec.source, targetRevision: "other" }];
  delete app.spec.source;
  app.status.sync = { status: "Synced", revisions: [application().status.sync.revision, "2".repeat(40)] };
  app.status.history = [{ id: 1, revisions: [application().status.sync.revision, "3".repeat(40)] }];
}
multiAfter.status.sync.revisions = multiAfter.status.history[0].revisions;
const operationRace = nativeWrite("terminate-op", ["app", "terminate-op", "healthy"], runningApp);
operationRace.case = "operation-ended-during-submit";
operationRace.recheckAfterMutation = true;
operationRace.native.steps.find((step) => step.mutation).states = { initial: { exit: 1, stderr: "no operation is in progress", next: "done" }, done: { stdout: "" } };
const appWrites = [
  operationRace,
  { ...nativeWrite("rollback", ["app", "rollback", "healthy", "1", "--timeout", "120"], samePrefixApp), case: "full-revision" },
  { ...nativeWrite("rollback", ["app", "rollback", "healthy", "1", "--timeout", "120"], currentUnsyncedApp), case: "current-revision-out-of-sync" },
  { ...nativeWrite("rollback", ["app", "rollback", "healthy", "1", "--timeout", "120"], multiBefore, multiAfter), case: "multiple-full-revisions" },
  { ...nativeWrite("rollback", ["app", "rollback", "healthy", "1", "--timeout", "120"], automatedCurrentApp, automatedCurrentApp), case: "already-current-with-auto-sync", noMutation: true },
  nativeWrite("sync", ["app", "sync", "healthy", "--async", "--info", "initiated-by=argocd-axi"], unsyncedApp),
  nativeWrite("terminate-op", ["app", "terminate-op", "healthy"], runningApp),
  nativeWrite("rollback", ["app", "rollback", "healthy", "1", "--timeout", "120"], unsyncedApp),
];
const argoGrant = async (lab) => {
  const directory = join(lab.env.XDG_CONFIG_HOME, "argo-workflows-axi");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, "config.json"), JSON.stringify({ writableTargets: [{ context: "probe", namespace: "default" }] }));
};
const specSeed = (kind) => async (lab) => {
  await fs.writeFile(join(lab.cwd, "fixture.yaml"), `apiVersion: argoproj.io/v1alpha1\nkind: ${kind}\nmetadata:\n  name: healthy\nspec:\n  entrypoint: main\n  templates:\n  - name: main\n    container:\n      image: fixture\n`);
};
const waitTime = { path: "app.wait", pattern: "after \\d+s", replacement: "after <elapsed>s" };
const argocd = [
  ...rows("refusal", commands("auth,setup,ctx writable")).map((fixture) => ({ ...fixture, exit: 2, code: "VALIDATION_ERROR" })),
  { kind: "read", argv: ["appsets", "generate", "SPEC"], seed: specSeed("ApplicationSet"), native: { steps: [
    { bin: "argocd", argv: ["appset", "generate", "SPEC", "-o", "json"], stdout: [] },
  ] } },
  ...rows("read", commands("auth guide,whoami,can-i get applications probe/healthy,apps view healthy,apps resources healthy,apps diff healthy,apps history healthy,apps manifests healthy,apps logs healthy,apps actions healthy,ctx writable list,context,projects,projects view probe,projects windows probe,appsets,appsets view probe,repos,clusters")),
  { kind: "write", argv: ["ctx", "use", "probe"], native: { steps: [
    { bin: "argocd", argv: ["context"], states: {
      initial: { stdout: "CURRENT  NAME   SERVER\n         probe  probe.invalid\n*        other  other.invalid\n" },
      done: { stdout: "CURRENT  NAME   SERVER\n*        probe  probe.invalid\n         other  other.invalid\n" },
    } },
    { bin: "argocd", argv: ["context", "probe"], mutation: true, stdout: "", next: "done" },
  ] } },
  { kind: "write", argv: ["ctx", "writable", "remove", "probe"], seed: grant },
  { kind: "write", argv: ["ctx", "writable", "add", "probe"], seed: grant },
  { kind: "write", argv: ["ctx", "writable", "add", "probe"], firstPTY: true, input: "y\n", case: "new-grant" },
  { kind: "refusal", argv: ["ctx", "writable", "add", "probe"], case: "new-grant-without-terminal" },
  ...appWrites,
  ...[["Deployment", "apps", "restart"], ...["promote", "promote-full", "resume"].map((action) => ["Rollout", "argoproj.io", action]), ["Deployment", "apps", "restart", true], ["Widget", "example.invalid", "custom", true]].flatMap(([kind, group, action, repeatable]) => {
    const resource = { kind, group, name: "healthy", namespace: "default", health: { status: action === "restart" ? "Healthy" : "Degraded" } };
    const before = application(), after = application();
    before.status.resources = [resource];
    after.status.resources = [{ ...resource, health: { status: repeatable ? resource.health.status : "Progressing" } }];
    const native = mutatingApp(["app", "actions", "run", "healthy", action, "--kind", kind, "--resource-name", "healthy", "--group", group, "--namespace", "default", "--info", "initiated-by=argocd-axi"], before, after);
    const listed = { kind, group, name: "healthy", namespace: "default", action, disabled: false };
    native.steps.push(
      { bin: "argocd", argv: ["app", "actions", "list", "healthy", "--kind", kind, "-o", "json", "--argocd-context", "probe"], stdout: [listed],
        ...(!repeatable ? { states: { initial: { stdout: [listed] }, done: { stdout: [{ ...listed, disabled: true }] }, partial: { stdout: [{ ...listed, disabled: true }] } } } : {}),
      },
      { bin: "argocd", argv: ["account", "can-i", `action/${group}/${kind}/${action}`, "applications", "probe/healthy", "--argocd-context", "probe"], stdout: "yes\n" },
    );
    const fixture = { kind: repeatable ? "event" : "write", argv: ["apps", "actions", "run", "healthy", action, "--kind", kind, "--name", "healthy", "--confirm"], seed: grant, native,
      case: repeatable ? "completed-or-custom-event" : undefined, repeatMutation: repeatable, firstMutations: repeatable ? 1 : undefined,
      limit: "State-scoped event: Progressing suppresses built-in retries. Completed restarts, arbitrary custom actions, and concurrent preflight races are not exactly-once delivery." };
    if (kind !== "Rollout") return [fixture];
    const healthy = structuredClone(after);
    healthy.status.resources[0].health.status = "Healthy";
    const satisfied = structuredClone(native);
    satisfied.steps.find((step) => step.states?.initial).states = { initial: { stdout: healthy }, done: { stdout: healthy } };
    const actions = satisfied.steps.find((step) => step.argv.includes("actions") && step.argv.includes("list"));
    actions.states.initial = actions.states.done;
    return [fixture, { ...fixture, case: "healthy-rollout", noMutation: true, native: satisfied }];
  }),
  ...[false, true].map((hard) => ({ kind: "reconcile", argv: ["apps", "refresh", "healthy", "--confirm", ...(hard ? ["--hard"] : [])], seed: grant,
    native: mutatingApp(["app", "get", "healthy", hard ? "--hard-refresh" : "--refresh"], application(), application()),
    limit: "Refresh deliberately repeats native reconciliation; desired Application configuration is unchanged.",
  })),
  { kind: "write", argv: ["apps", "sync", "healthy", "--confirm"], case: "already-satisfied", noMutation: true, seed: grant,
    native: mutatingApp(["app", "sync", "healthy", "--async", "--info", "initiated-by=argocd-axi"], application(), application()) }, 
  ...["on", "off"].map((policy) => ({ kind: "write", argv: ["apps", "auto-sync", "healthy", policy, "--confirm"], seed: grant,
    native: mutatingApp(["app", "set", "healthy", "--sync-policy", policy === "on" ? "automated" : "none", "--info", "initiated-by=argocd-axi"], policy === "on" ? application() : { ...application(), spec: { ...application().spec, syncPolicy: { automated: { prune: true, selfHeal: true } } } }, { ...application(), spec: { ...application().spec, syncPolicy: policy === "on" ? { automated: {} } : {} } }) })), 
  ...[["on", false, true, false], ["off", false, false, true], ["on", true, true, true]].map(([policy, beforeEnabled, afterEnabled, noMutation]) => {
    const before = application(), after = application();
    before.spec.syncPolicy = { automated: { enabled: beforeEnabled, prune: true, selfHeal: true } };
    after.spec.syncPolicy = { automated: { enabled: afterEnabled, prune: true, selfHeal: true } };
    return { kind: "write", argv: ["apps", "auto-sync", "healthy", policy, "--confirm"], seed: grant, noMutation,
      case: `enabled-${beforeEnabled}-to-${afterEnabled}`,
      native: mutatingApp(["app", "set", "healthy", "--sync-policy", policy === "on" ? "automated" : "none", "--info", "initiated-by=argocd-axi"], before, after),
    };
  }),
  { kind: "wait", argv: ["apps", "wait", "healthy", "--timeout", "2"], native: { state: "done", steps: [getApp,
    { bin: "argocd", argv: ["app", "wait", "healthy", "--timeout", "2"], stdout: "", poll: true }] },
    timeFields: [waitTime] },
  { kind: "wait", argv: ["apps", "wait", "healthy", "--timeout", "2"], case: "transient", expectNativeState: "done",
    native: { steps: [
      { ...getApp, states: { initial: { stdout: { ...application("Running"), status: { ...application("Running").status, health: { status: "Degraded" } } }, next: "done" }, done: { stdout: application() } } },
      { bin: "argocd", argv: ["app", "wait", "healthy", "--timeout", "2"], poll: true, states: { initial: { exit: 1, stderr: "application health transitioned to Degraded", next: "done" }, done: { stdout: "" } } },
    ] }, timeFields: [waitTime] },
  ...rows("refusal", commands("login,relogin,logout,configure,account,repocreds,cert,gpg,admin,apps create,apps edit,apps delete,apps delete-resource,apps patch-resource,apps set,apps unset,apps patch,projects role,projects create,projects delete,projects edit,projects set,appsets create,appsets delete,repos add,repos rm,clusters add,clusters rm,clusters set,clusters rotate-auth")),
];
const argoTarget = ["--context=probe", "--namespace=default", "--loglevel=error"];
const argoFlags = ["--context", "probe", "-n", "default", "--apply"];
const sourceHash = createHash("sha256").update("fixture-uid").digest("hex").slice(0, 20);
const keyHash = createHash("sha256").update("fixture-uid:0").digest("hex").slice(0, 20);
const resubmitName = `healthy-rs-${keyHash}`;
const resubmitted = { ...workflow("Running"), metadata: { ...workflow().metadata, name: resubmitName,
  labels: { "axi.argoproj.io/resubmit-source": sourceHash, "axi.argoproj.io/resubmit-key": keyHash } } };
const argo = [
  ...[["wf", "Workflow", ["lint"]], ["template", "WorkflowTemplate", ["template", "lint"]]].map(([noun, kind, native]) => ({
    kind: "read", argv: [noun, "lint", "SPEC"], seed: specSeed(kind), native: { steps: [
      { bin: "argo", argv: [...native, "SPEC", "--output=simple", "--loglevel=error"], stdout: "No linting errors found\n" },
    ] },
  })),
  ...rows("read", [[], ["wf"], ["cron"], ["template"], ["clustertemplate"], ["archive"], ["setup"]]),
  { kind: "write", argv: ["wf", "submit", "--from", "workflowtemplate/probe", "--name", "healthy", ...argoFlags], seed: argoGrant,
    native: { steps: [
      { bin: "argo", argv: ["template", "get", "probe", "--output=json", ...argoTarget], stdout: { metadata: { name: "probe" }, spec: { entrypoint: "main", templates: [{ name: "main", container: { image: "fixture" } }] } } },
      { bin: "argo", argv: ["get", "healthy", "--output=json", ...argoTarget], states: { initial: { exit: 1, stderr: 'Error: workflows.argoproj.io "healthy" not found' }, done: { stdout: workflow("Running") } } },
      { bin: "argo", argv: ["submit", "--from=workflowtemplate/probe", "--name=healthy", "--output=json", ...argoTarget], mutation: true, stdout: workflow("Running"), next: "done" },
    ] } },
  { kind: "write", argv: ["wf", "resubmit", "healthy", ...argoFlags], seed: argoGrant,
    native: { steps: [
      { bin: "argo", argv: ["get", "healthy", "--output=json", ...argoTarget], stdout: workflow("Failed") },
      { bin: "argo", argv: ["get", resubmitName, "--output=json", ...argoTarget], states: { initial: { exit: 1, stderr: `Error: workflows.argoproj.io "${resubmitName}" not found` }, done: { stdout: resubmitted } } },
      { bin: "argo", argv: ["submit", { manifest: resubmitName }, `--name=${resubmitName}`, `--labels=axi.argoproj.io/resubmit-key=${keyHash}`, "--output=json", ...argoTarget], mutation: true, stdout: resubmitted, next: "done" },
    ] } },
  ...["suspend", "resume"].map((verb) => ({ kind: "write", argv: ["cron", verb, "healthy", ...argoFlags], seed: argoGrant,
    native: { steps: [
      { bin: "argo", argv: ["cron", "get", "healthy", "--output=json", ...argoTarget], states: { initial: { stdout: { metadata: { name: "healthy" }, spec: { suspend: verb === "resume" } } }, done: { stdout: { metadata: { name: "healthy" }, spec: { suspend: verb === "suspend" } } } } },
      { bin: "argo", argv: ["cron", verb, "healthy", ...argoTarget], mutation: true, stdout: "", next: "done" },
    ] } })),
  ...rows("refusal", commands("wf delete,wf watch,wf node,wf cp,wf create,auth,server,sync,executor-plugin,convert,completion,api,cron create,cron update,cron delete,cron backfill,template create,template update,template delete,clustertemplate create,clustertemplate update,clustertemplate delete,archive delete,archive retry,archive resubmit")),
  ...rows("read", commands("wf get healthy,wf logs healthy,cron list,cron get healthy,template list,template get healthy,clustertemplate list,clustertemplate get healthy,archive list,archive get healthy,triage,context")),
  { kind: "wait", argv: ["wf", "wait", "healthy", "--timeout", "2s"], native: { state: "done", steps: [getWorkflow] } },
  { kind: "wait", argv: ["wf", "wait", "healthy", "--timeout", "2s"], case: "transient", expectNativeState: "done", native: { steps: [
    { ...getWorkflow, states: { initial: { stdout: workflow("Running"), next: "done" }, done: { stdout: workflow() } } },
  ] } },
  ...["retry", "resume", "suspend", "stop", "terminate"].map((verb) => {
    const before = workflow(verb === "retry" ? "Failed" : "Running"), after = workflow(["stop", "terminate"].includes(verb) ? "Failed" : "Running");
    if (verb === "resume") before.spec.suspend = true;
    if (verb === "suspend") after.spec.suspend = true;
    return { kind: "write", argv: ["wf", verb, "healthy", "--context", "probe", "-n", "default", "--apply"], seed: argoGrant, native: { steps: [
      { ...getWorkflow, argv: ["get", "healthy", "--output=json", "--context=probe", "--namespace=default", "--loglevel=error"], states: { initial: { stdout: before }, done: { stdout: after } } },
      { bin: "argo", argv: [verb, "healthy", "--context=probe", "--namespace=default", "--loglevel=error"], mutation: true, next: "done", stdout: "" },
    ] } };
  }),
];

export function retryFixtures(name, profile) {
  const reads = [...profile.normal, ...(profile.list ? [profile.list] : []), ...(profile.status ? [profile.status] : []),
    ["--help"], ["--version"], ["-v"], ["-V"], ...profile.help.map((r) => [...r, "--help"])];
  const unique = [...new Map(reads.map((a) => [JSON.stringify(a), a])).values()];
  const fixtures = rows("read", unique);
  if (!["axi-verify", "search-console-axi"].includes(name))
    fixtures.push({ kind: "read", argv: [], binName: `${name}-ctx` });
  if (name === "axi-verify") fixtures.push({ kind: "reconcile", argv: ["packed"], acquisition: true,
    limit: "packed repeats verification and writes its explicitly requested evidence directory; it does not change the checked package or user configuration.",
    seed: async (lab) => {
      const packageDirectory = join(lab.base, "toy", "package");
      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "argocd-axi", version: "0.0.0", type: "module", bin: { "argocd-axi": "tool.mjs", "argocd-axi-ctx": "tool.mjs" } }));
      await fs.copyFile(new URL("../fixtures/conforming-tool.mjs", import.meta.url), join(packageDirectory, "tool.mjs"));
      await fs.chmod(join(packageDirectory, "tool.mjs"), 0o755);
      const writes = new Set(argocd.filter((fixture) => fixture.kind === "write").map((fixture) => JSON.stringify(fixture.argv)));
      await fs.writeFile(join(packageDirectory, "refusals.json"), JSON.stringify(argocd.filter((fixture) => fixture.kind === "refusal" && !writes.has(JSON.stringify(fixture.argv))).map(({ argv, exit, code }) => ({ argv, exit, code }))));
      const archive = join(lab.base, "conforming.tgz");
      await checked("tar", ["-czf", archive, "-C", join(lab.base, "toy"), "package"], { env: lab.env });
      return { argv: ["packed", "--tarball", archive, "--evidence-dir", join(lab.evidence, "self-packed")] };
    },
  });
  if (profile.install) {
    fixtures.push({ kind: "setup", argv: profile.install });
    fixtures.push({ kind: "uninstall", argv: profile.uninstall, seed: async (lab, invoke, bin) => {
      const result = await invoke(bin, profile.install);
      if (result.exit !== 0) throw new Error(`uninstall seed failed: ${result.stdout}`);
    } });
  }
  if (name === "argocd-axi") fixtures.push(...argocd);
  if (name === "argo-workflows-axi") fixtures.push(...argo);
  if (name === "terraform-axi") fixtures.push(
    ...rows("read", commands("plan MODULE,drift MODULE,lint MODULE,state resource MODULE terraform_data.healthy,setup")),
    { kind: "write", argv: ["setup", "--binary", "tofu"] },
  );
  if (name === "k8s-axi") fixtures.push(
    ...rows("read", [[], ...commands("context,namespaces,nodes,nodes view healthy,pods view healthy,pods logs healthy,deployments,deployments view healthy,jobs,pvcs,services,events,secrets,secrets view healthy,triage")]),
    ...rows("refusal", commands("apply,create,delete,edit,patch,replace,scale,rollout,label,annotate,taint,cordon,uncordon,drain,exec,attach,port-forward,proxy,cp,debug,run,expose,autoscale,set,certificate,auth,token,login,get,describe,ctx use")),
  );
  if (name === "datadog-axi") {
    fixtures.push(...rows("read", [[], ["home"], ...commands("dashboards list,downtimes list,events list,hosts list,incidents list,metrics tags fixture,notebooks list,services list,slos list,synthetics list")]));
    fixtures.push(...rows("read", commands("auth guide,auth list,auth status,monitors search fixture,monitors view 1,services,services view fixture,dashboards,dashboards view abc-def-ghi,incidents,incidents view fixture,hosts,slos,slos view fixture,downtimes,synthetics,synthetics view abc-def-ghi,synthetics results abc-def-ghi,notebooks,notebooks view 1,api /api/v1/monitor,metrics list,metrics search fixture,metrics view fixture,doctor")));
    fixtures.push(...rows("read", commands("slos status fixture,logs search fixture,logs aggregate fixture --by service,logs view fixture,metrics query avg:fixture{*},traces search service:fixture,traces view 1234567890123456789,events,events search fixture")).map((fixture) => ({ ...fixture, argv: [...fixture.argv, "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-01T01:00:00Z"] })));
    fixtures.push(...rows("refusal", [["api", "POST", "/api/v1/monitor"], ["api", "PUT", "/api/v1/monitor/1"], ["api", "DELETE", "/api/v1/monitor/1"], ["api", "GET", "/api/v1/api_key"]]));
    const login = ["auth", "login", "--org", "probe", "--site", "datadoghq.com", "--api-key-stdin"];
    const input = "synthetic_api_key_1234\nsynthetic_app_key_1234\n";
    fixtures.push({ kind: "write", argv: login, input });
    fixtures.push({ kind: "error", argv: login, input, case: "keyring-permission-error", seed: async (lab) => { lab.env.AXI_KEYRING_GET_ERROR = "1"; } });
    fixtures.push({ kind: "write", argv: ["auth", "logout", "--org", "probe"], seed: async (lab, invoke, bin) => {
      const result = await invoke(bin, login, lab, { input });
      if (result.exit !== 0) throw new Error(`auth seed failed: ${result.stdout}`);
    } });
  }
  if (name === "search-console-axi") fixtures.push(
    ...rows("read", [["setup"], ["inspect", "https://healthy.example.invalid/page", "--site", "https://healthy.example.invalid/"], ["setup", "inspect", "https://healthy.example.invalid/page", "--site", "https://healthy.example.invalid/"]]).map((fixture) => ({ ...fixture, seed: async (lab) => { lab.env.GOOGLE_APPLICATION_CREDENTIALS = lab.key; lab.env.AXI_GOOGLE_ROOT = lab.packageRoot; } })),
    { kind: "write", argv: ["setup", "--quota-project", "probe-project"], seed: async (lab) => { lab.env.GOOGLE_APPLICATION_CREDENTIALS = lab.key; lab.env.AXI_GOOGLE_ROOT = lab.packageRoot; } },
  );
  if (["argocd-axi", "argo-workflows-axi", "datadog-axi", "k8s-axi"].includes(name)) fixtures.push({
    kind: "write", argv: ["context", "end"], seed: async (lab) => {
      const transcript = join(lab.base, "transcript.jsonl");
      await fs.writeFile(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `${name} ${profile.list.join(" ")}` } }] } }) + "\n");
      return { input: JSON.stringify({ session_id: "retry-fixture", cwd: lab.cwd, transcript_path: transcript }) };
    },
  });
  if (name !== "axi-verify") fixtures.push(
    ...rows("read", name === "datadog-axi" ? [["update", "--check"]] : [["update", "--check"], ["update", "--dry-run"]]),
    { kind: "write", argv: ["update"], sdkUpdate: true },
  );
  if (!["axi-verify", "k8s-axi"].includes(name)) fixtures.push({ kind: "read", argv: ["update", "--check"], case: "registry-fallback",
    seed: async (lab) => { lab.env.AXI_REGISTRY_FORCE_FALLBACK = "1"; },
  });
  if (!["axi-verify", "k8s-axi"].includes(name)) {
    const upgrade = { kind: "write", argv: ["update"], case: "upgrade", sdkUpdate: true, firstMutations: 1,
    limit: "Synthetic newer version and fake npm installer; this does not test a published upgrade's compatibility.",
    seed: async (lab) => {
      const root = join(lab.home, ".npm-global", "lib", "node_modules");
      await fs.cp(dirname(lab.packageRoot), root, { recursive: true, verbatimSymlinks: true });
      const bin = join(root, ".bin", name);
      if (!(await fs.realpath(bin)).startsWith(lab.home + "/")) throw new Error("update copy's executable escaped the disposable HOME");
      lab.env.AXI_UPDATE_GLOBAL_ROOT = root;
      lab.env.AXI_REGISTRY_VERSION = "9999.0.0";
      return { bin };
    },
    };
    fixtures.push(upgrade, { ...upgrade, case: "upgrade-after-failure", firstExit: 1, native: { state: "initial", steps: [] },
      seed: async (lab) => { const seeded = await upgrade.seed(lab); lab.env.AXI_UPDATE_FAIL_FIRST = "1"; return seeded; },
    });
  }
  const prepared = fixtures.map((fixture) => {
    if (name === "argo-workflows-axi" && fixture.argv.join(" ") === "wf list") fixture = { ...fixture, timeFields: ["workflows.*.age"] };
    if (name === "datadog-axi" && fixture.argv.join(" ") === "events list") fixture = { ...fixture, argv: [...fixture.argv, "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-01T01:00:00Z"] };
    if (name === "k8s-axi" && fixture.argv[0] === "update") return { kind: "refusal", argv: fixture.argv };
    if (name === "search-console-axi" && fixture.argv.join(" ") === "setup check")
      return { ...fixture, seed: async (lab) => { lab.env.GOOGLE_APPLICATION_CREDENTIALS = lab.key; lab.env.AXI_GOOGLE_ROOT = lab.packageRoot; } };
    if (name === "argocd-axi" && ["apps", "whoami"].includes(fixture.argv[0]) && !fixture.native)
      return { ...fixture, native: { steps: [getApp] } };
    if (name === "argo-workflows-axi" && fixture.argv[0] === "wf" && !fixture.native)
      return { ...fixture, native: { steps: [getWorkflow] } };
    if (name === "argo-workflows-axi" && fixture.argv[0] === "archive" && ["list", "get"].includes(fixture.argv[1]) && !fixture.argv.includes("--help"))
      return { ...fixture, argv: [...fixture.argv, "--argo-server", "fixture.invalid:2746"], native: { steps: [
        { bin: "argo", argv: ["archive", "list", "--output=json", "--argo-server=fixture.invalid:2746", "--loglevel=error"], stdout: [workflow()] },
        { bin: "argo", argv: ["archive", "get", "fixture-uid", "--output=json", "--argo-server=fixture.invalid:2746", "--loglevel=error"], stdout: workflow() },
      ] } };
    return fixture;
  });
  return prepared.flatMap((fixture) => {
    if (fixture.kind !== "write" || !fixture.native?.steps.some((step) => step.mutation)) return [fixture];
    const result = [fixture], variant = { ...fixture, recheckAfterMutation: false };
    if (!fixture.noMutation) result.push({ ...variant, case: "retry-after-native-failure", firstExit: 1,
      native: { ...fixture.native, steps: fixture.native.steps.map((step) => step.mutation ? { ...step, states: {
        initial: { exit: 1, stderr: "fixture transport failure (no commit)", next: "retryable" },
        retryable: { stdout: step.stdout ?? "", next: "done" },
      } } : step.states?.initial ? { ...step, states: { ...step.states, retryable: step.states.initial } } : step) },
    });
    if (fixture.native.steps.some((step) => step.states?.done))
      result.push({ ...variant, case: "response-lost-after-commit", noMutation: true, native: { ...fixture.native, state: "done" } });
    const read = fixture.native.steps.find((step) => step.states?.initial && !step.mutation);
    if (read && fixture.argv[0] === "apps") {
      const partial = structuredClone(read.states.done.stdout);
      partial.status.operationState = { phase: fixture.argv[1] === "terminate-op" ? "Terminating" : "Running", operation: { sync: { revision: partial.status.sync.revision, revisions: partial.status.sync.revisions } } };
      result.push({ ...variant, case: "partial", noMutation: true, native: { ...fixture.native, state: "partial", steps: fixture.native.steps.map((step) => step === read ? { ...step, states: { ...step.states, partial: { stdout: partial } } } : step) } });
    }
    if (read) result.push({ ...variant, kind: "error", case: "upstream-auth-failure", noMutation: true,
      native: { ...fixture.native, steps: fixture.native.steps.map((step) => step === read ? { bin: step.bin, argv: step.argv, stdout: "", stderr: "rpc error: code = Unauthenticated desc = fixture authentication failed", exit: 1 } : step) } });
    return result;
  });
}
