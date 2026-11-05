// Synthetic native store. No OS credential APIs are imported by this fixture.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
export class AsyncEntry {
  constructor(service, account) { this.key = `${service}:${account}`; }
  store() { return JSON.parse(readFileSync(process.env.AXI_KEYRING_STATE, "utf8")); }
  record(operation, mutation, nativeExit = 0) {
    appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin: "keyring", args: [operation, this.key], allowed: true, mutation, nativeExit }) + "\n");
  }
  async getPassword() {
    if (process.env.AXI_KEYRING_GET_ERROR === "1") {
      this.record("get", false, 1);
      throw new Error("fixture keychain access denied");
    }
    this.record("get", false); return this.store()[this.key] ?? null;
  }
  async setPassword(value) {
    this.record("set", true); const store = this.store(); store[this.key] = value;
    writeFileSync(process.env.AXI_KEYRING_STATE, JSON.stringify(store));
  }
  async deletePassword() {
    this.record("delete", true); const store = this.store(), existed = Object.hasOwn(store, this.key); delete store[this.key];
    writeFileSync(process.env.AXI_KEYRING_STATE, JSON.stringify(store)); return existed;
  }
}
