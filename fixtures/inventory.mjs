import { pathToFileURL } from "node:url";
import { advertisedRoutes } from "../lib/command-inventory.mjs";

// Inspect registration and help only. Do not resolve credentials or run data commands.
export async function captureRegistry(options) {
  const commands = Object.keys(options.commands), roots = [...new Set([...commands, "update"])];
  const routes = new Set([...roots, ...(options.home ? [""] : [])]), help = {};
  const write = process.stdout.write;
  const queue = [...commands];
  const name = process.env.AXI_REGISTRY_PACKAGE;
  for (const found of advertisedRoutes(options.topLevelHelp ?? "", "", roots, name))
    if (!routes.has(found)) { routes.add(found); if (options.commands[found.split(" ")[0]]) queue.push(found); }
  if (["argocd-axi", "argo-workflows-axi", "k8s-axi"].includes(name) && process.env.AXI_INVENTORY_SDK) {
    const registry = await import(pathToFileURL(process.env.AXI_INVENTORY_ROOT + "/dist/src/registry.js"));
    const refused = Array.isArray(registry.REFUSALS) ? registry.REFUSALS : Object.keys(registry.REFUSALS);
    for (const route of refused) routes.add(route);
  }
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 512) throw new Error("command inventory exceeds 512 routes");
    const route = queue[index], parts = route.split(" "), name = parts.shift();
    let output = "";
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    try {
      const text = parts.length ? await options.commands[name]([...parts, "--help"]) :
        options.getCommandHelp?.(name) ?? await options.commands[name](["--help"]);
      help[route] = output + (typeof text === "string" ? text : JSON.stringify(text ?? ""));
    } catch { help[route] = output; }
    finally { process.stdout.write = write; }
    for (const found of advertisedRoutes(help[route], route, roots, process.env.AXI_REGISTRY_PACKAGE)) {
      if (!routes.has(found)) { routes.add(found); queue.push(found); }
    }
  }
  write.call(process.stdout, JSON.stringify({ commands, routes: [...routes].sort(), help }) + "\n");
  return true;
}
