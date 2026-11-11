// Backend replies for the argo-workflows, argocd, datadog and search-console
// adapters. Every record derives from the seeded behaviour data, never from a manifest.
// Problems come first, as these tools sort them, so full output keeps fixture order.
const failed = (data, i) => i < 3 && data.mode !== "small";
const created = "2026-01-01T00:00:00Z";

export function argoWorkflows(data) {
  return data.identities.map((name, i) => ({
    metadata: { name, namespace: "default", creationTimestamp: created }, spec: {},
    status: { phase: failed(data, i) ? "Failed" : "Succeeded", message: failed(data, i) ? "synthetic step failure" : "" },
  }));
}

export function argocdApps(data) {
  return data.identities.map((name, i) => ({
    metadata: { name, namespace: "default" }, spec: { project: "probe", source: { repoURL: "https://example.invalid/repo" } },
    status: { sync: { status: failed(data, i) ? "OutOfSync" : "Synced" }, health: { status: failed(data, i) ? "Degraded" : "Healthy", message: failed(data, i) ? "synthetic readiness failure" : "" }, resources: [] },
  }));
}

export function datadogMonitorSearch(data, url) {
  const page = Number(url.searchParams.get("page") ?? 0), perPage = Number(url.searchParams.get("per_page") ?? 30);
  const monitors = data.identities.map((id, i) => ({ id: Number(id), name: i === 0 && data.text ? `monitor-${id}` : `monitor-${id}`, status: failed(data, i) ? "Alert" : "OK", overall_state: failed(data, i) ? "Alert" : "OK", type: "metric alert", priority: 3, query: "avg:fixture{*} > 1", message: "fixture", options: {}, tags: [] }));
  return { monitors: monitors.slice(page * perPage, (page + 1) * perPage), metadata: { total_count: monitors.length, page, per_page: perPage } };
}

export function googleSites(data) {
  return { siteEntry: data.identities.map((siteUrl, i) => ({ siteUrl, permissionLevel: i % 2 ? "siteRestrictedUser" : "siteOwner" })) };
}
