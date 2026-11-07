import { bootService } from "@sudsnik/infra-boot";
import { readEnv } from "./env.js";
import { createApp, handlersDir, variant } from "./variants/cached/index.js";

export { readEnv, createApp, handlersDir, variant };
export * from "./variants/cached/index.js";
export type { DispatchService, RelayIngest } from "./port.js";

export const service = "dispatch" as const;

export async function start(): Promise<void> {
  await bootService({ service, readEnv, createApp, handlersDir });
}