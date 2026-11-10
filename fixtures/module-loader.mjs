import { appendFileSync } from "node:fs";

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  appendFileSync(process.env.AXI_MODULE_LOG, url + "\n");
  return result;
}
