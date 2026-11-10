const pinned = ["--context=probe", "--request-timeout=15000ms"];
const empty = { apiVersion: "v1", kind: "List", items: [] };
const metadata = { name: "healthy", namespace: "default", uid: "fixture-pod", creationTimestamp: "2026-01-01T00:00:00Z" };
const pod = { apiVersion: "v1", kind: "Pod", metadata, spec: { nodeName: "healthy", containers: [{ name: "app", image: "fixture" }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "app", ready: true, restartCount: 0, state: { running: {} } }] } };
const deployment = { apiVersion: "apps/v1", kind: "Deployment", metadata, spec: { replicas: 1, selector: { matchLabels: { app: "fixture" } }, template: { spec: pod.spec } }, status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1, conditions: [{ type: "Available", status: "True" }] } };
const node = { apiVersion: "v1", kind: "Node", metadata, spec: {}, status: { conditions: [{ type: "Ready", status: "True" }], nodeInfo: { kubeletVersion: "v1.34.0" }, capacity: { cpu: "1", memory: "1Gi" }, allocatable: { cpu: "1", memory: "1Gi" } } };
const template = '{{range .items}}{{"["}}{{printf "%q" .metadata.namespace}},{{printf "%q" .metadata.name}},{{printf "%q" (printf "%v" .type)}},{{printf "%q" .metadata.creationTimestamp}},{{"["}}{{$sep := ""}}{{range $k, $_ := .data}}{{$sep}}{{printf "%q" $k}}{{$sep = ","}}{{end}}{{"]]\\n"}}{{end}}';
export function kubernetesReply(args) {
  const exact = (argv) => JSON.stringify([...argv, ...pinned]) === JSON.stringify(args);
  if (exact(["get", "node", "healthy", "-o", "json"])) return node;
  if (exact(["get", "pod", "healthy", "-n", "default", "-o", "json"])) return pod;
  if (exact(["get", "deployment.apps", "healthy", "-n", "default", "-o", "json"])) return deployment;
  // k8s-axi asks for one line more than its 100-line cap to detect truncation.
  for (const tail of [100, 101]) if (exact(["logs", "healthy", "-n", "default", "-c", "app", `--tail=${tail}`, "--limit-bytes=1048576"])) return "fixture log\n";
  if (["jobs.batch", "pods", "deployments.apps", "persistentvolumeclaims", "services", "endpointslices.discovery.k8s.io"].some((noun) => exact(["get", noun, "-A", "-o", "json"]))) return empty;
  for (const scope of [["-A"], ["-n", "default"]]) {
    for (const selector of ["type=Warning", ...["Pod", "Node", "Deployment"].map((kind) => `involvedObject.kind=${kind},involvedObject.name=healthy`)])
      if (exact(["get", "events", ...scope, `--field-selector=${selector}`, "-o", "json"])) return empty;
  }
  if (exact(["get", "secrets", "-n", "default", "--field-selector=metadata.name=healthy", `--output=go-template=${template}`]))
    return '["default","healthy","Opaque","2026-01-01T00:00:00Z",["token"]]\n';
  return undefined;
}
