import { retryFixtures, localWriteRoutes } from "./retry-profiles.mjs";

const routes = (text) =>
  text.split(",").map((route) => route.trim().split(" "));
const common = {
  install: ["setup", "hooks"],
  uninstall: ["setup", "uninstall"],
  status: ["setup", "status"],
  hooks: ["claude:SessionStart", "codex:SessionStart", "opencode"],
  codes: ["SETUP_FAILED", "CONFIG_ERROR", "CONFIG_INVALID", "FILE_ERROR"],
};
export const profiles = {
  "argocd-axi": {
    ...common,
    hooks: [...common.hooks, "claude:SessionEnd"],
    codes: ["UPSTREAM_ERROR", "CONFIG_INVALID"],
    normal: [[], ["ctx"], ["apps"]],
    help: routes(
      "apps,apps view,apps diff,apps sync,apps wait,apps history,apps rollback,apps refresh,apps manifests,ctx,ctx writable,setup hooks,setup status,setup uninstall,context end",
    ),
    helpFlags: { apps: ["--fields", "--limit"] },
    list: ["apps"],
    collection: "apps",
    fields: ["app", "sync", "health", "why"],
    expanded: ["--fields", "project"],
    config: ["ctx", "writable", "remove", "probe"],
    npx: "REFUSED",
  },
  "argo-workflows-axi": {
    ...common,
    status: null,
    hooks: [...common.hooks, "claude:SessionEnd"],
    codes: ["SETUP_FAILED", "FILE_ERROR"],
    normal: [["ctx"], ["wf", "list"]],
    help: routes(
      "wf,wf list,wf get,wf logs,wf wait,wf lint,wf watch,wf submit,wf retry,wf resubmit,wf resume,wf suspend,wf stop,wf terminate,wf delete,cron,cron list,cron get,cron suspend,cron resume,template,template list,template get,template lint,clustertemplate,clustertemplate list,clustertemplate get,archive,archive list,archive get,triage,ctx,setup hooks,setup uninstall,context,context end,update",
    ),
    helpFlags: { "wf list": ["--fields", "--limit"] },
    list: ["wf", "list"],
    collection: "workflows",
    fields: ["name", "phase", "age", "message"],
    expanded: ["--fields", "uid"],
    unsupported: [["setup", "status"]],
    npx: "install",
  },
  "datadog-axi": {
    ...common,
    hooks: [...common.hooks, "claude:SessionEnd"],
    codes: ["SETUP_FAILED"],
    normal: [["ctx"], ["monitors"]],
    project: true,
    help: routes(
      "auth,auth status,monitors,monitors search,monitors view,ctx,setup hooks,setup status,setup uninstall,context end",
    ),
    helpFlags: { monitors: ["--fields", "--limit"] },
    list: ["monitors"],
    collection: "monitors",
    fields: ["id", "name", "status", "type"],
    expanded: ["--fields", "id,name,status,type,priority"],
    npx: "install",
  },
  "terraform-axi": {
    ...common,
    normal: [[], ["doctor", "--offline"], ["state", "list", "MODULE"]],
    help: routes("plan,drift,doctor,state,setup,update"),
    helpFlags: { state: ["--full"], setup: ["--binary"] },
    list: ["state", "list", "MODULE"],
    collection: "resources",
    fields: ["address", "type"],
    expanded: ["--full"],
    config: ["setup", "--binary", "tofu"],
    npx: "install",
  },
  "search-console-axi": {
    hooks: [],
    install: ["setup", "service-account", "KEY"],
    uninstall: ["setup", "uninstall"],
    status: ["setup", "status"],
    codes: ["CONFIG_ERROR", "AUTH_CONFIG_ERROR"],
    normal: [[], ["setup", "status"]],
    help: routes("setup,inspect"),
    helpFlags: { setup: ["--quota-project"] },
    list: ["setup", "check"],
    collection: "sites",
    fields: ["site_url", "permission"],
    unsupported: [["setup", "hooks"]],
    config: ["setup", "--quota-project", "probe-project"],
  },
  "k8s-axi": {
    ...common,
    hooks: [...common.hooks, "claude:SessionEnd"],
    codes: ["CONFIG_INVALID"],
    normal: [["ctx"], ["pods"]],
    help: routes(
      "pods,pods view,pods logs,nodes,nodes view,namespaces,deployments,deployments view,jobs,pvcs,triage,services,events,secrets,secrets view,ctx,setup hooks,setup status,setup uninstall,context end",
    ),
    helpFlags: { pods: ["--fields", "--limit"] },
    list: ["pods"],
    collection: "pods",
    fields: ["pod", "ready", "status", "restarts"],
    expanded: ["--fields", "pod,ready,status,restarts,age"],
    npx: "REFUSED",
  },
};
profiles["axi-verify"] = {
  normal: [[], ["static"]], help: routes("packed,static"),
  hooks: [], install: null, uninstall: null, status: null,
  lifecycle: { setup: false, uninstall: false },
  classifications: { packed: { kind: "reconcile", reason: "packed repeats verification and writes explicitly requested evidence; it has no user setup or backend mutation. Not exercised recursively." } },
};
const dispatchGroups = { "datadog-axi": ["auth", "logs", "metrics", "setup", "traces"], "terraform-axi": ["state"], "k8s-axi": ["setup"] };
for (const [name, profile] of Object.entries(profiles)) {
  profile.classifications = { ...profile.classifications, ...Object.fromEntries((dispatchGroups[name] ?? []).map((route) =>
    [route, { kind: "group", reason: "Dispatch-only parent; concrete child routes have independent fixtures. Help does not cover writes." }])) };
  profile.localWrites = localWriteRoutes(name);
  profile.idempotency = retryFixtures(name, profile);
}

export function profileFor(name) {
  if (!Object.hasOwn(profiles, name))
    throw new Error(
      `Unsupported package ${name}; supported: ${Object.keys(profiles).join(", ")}`,
    );
  return profiles[name];
}
