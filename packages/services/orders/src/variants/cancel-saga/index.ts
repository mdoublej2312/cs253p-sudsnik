import type { ServiceDeps } from "@sudsnik/contracts";
import { composeApp } from "../../core/composeApp.js";
import { CancelSagaOrdersService } from "./CancelSagaOrdersService.js";

export const variant = "cancel-saga";

export function createApp(deps: ServiceDeps) {
  return composeApp(deps, { variant, service: (parts) => new CancelSagaOrdersService(parts.repo, parts.outbox, parts.deps) });
}