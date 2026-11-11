// Fixture adapters own the expected backend records. A manifest names an adapter;
// it can never supply data, commands, credentials or network exceptions.
// `total` is the normal-mode collection size: above every list cap so truncation is observable.
export const adapters = {
  "terraform-local": { package: "terraform-axi" },
  kubernetes: { package: "k8s-axi" },
  "axi-verify": { package: "axi-verify" },
  "contract-fixture": { package: "axi-verify" },
  "argo-workflows": { package: "argo-workflows-axi", total: 105, identity: (i) => `wf-item${String(i).padStart(3, "0")}` , renamed: `wf-moved000` },
  argocd: { package: "argocd-axi", total: 105, identity: (i) => `app-item${String(i).padStart(3, "0")}` , renamed: `app-moved000` },
  datadog: { package: "datadog-axi", total: 105, identity: (i) => String(1000 + i) , renamed: "9000" },
  "search-console": { package: "search-console-axi", total: 105, identity: (i) => `https://item${String(i).padStart(3, "0")}.example.invalid/` , renamed: `https://moved000.example.invalid/` },
};
