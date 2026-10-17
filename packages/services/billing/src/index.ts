import { fileURLToPath } from "node:url";
import { bootService } from "@sudsnik/infra-boot";
import { createApp } from "./variants/ledger/index.js";
import { readEnv } from "./env.js";

export const service = "billing" as const;
export const handlersDir = fileURLToPath(new URL("./handlers/", import.meta.url));

export { readEnv };
export * from "./variants/ledger/index.js";
export type { BillingService } from "./port.js";

export function start(): Promise<{ port: number; close(): Promise<void> }> {
  return bootService({ service, readEnv, createApp, handlersDir });
}
