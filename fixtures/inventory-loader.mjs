import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "axi-sdk-js") return { url: "axi-inventory:sdk", shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url !== "axi-inventory:sdk") return nextLoad(url, context);
  return { format: "module", shortCircuit: true,
    source: `export * from ${JSON.stringify(pathToFileURL(process.env.AXI_INVENTORY_SDK).href)}; export { captureRegistry as runAxiCli } from ${JSON.stringify(new URL("./inventory.mjs", import.meta.url).href)};` };
}
