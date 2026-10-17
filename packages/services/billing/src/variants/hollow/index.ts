import type { ErrorBody, ServiceDeps } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { baseApp } from "../../app.js";

export const variant = "hollow";

/**
 * Billing, absent (ADR-0008). Every route in the contract answers 501 with a retryable UNAVAILABLE body, so orders
 * records `authorize:pending` and leaves the money owed rather than failed. /health, /ready, /cost and /version
 * stay up from the base app. It consumes and publishes nothing: no handlers are registered.
 */
export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const body: ErrorBody = { code: "UNAVAILABLE", message: `${deps.service} is hollow`, retryable: true };
  for (const prefix of ["", "/v2"]) {
    for (const r of Object.values(routes)) app.route({ method: r.method, url: prefix + r.path, handler: async (_req, reply) => reply.code(501).send(body) });
  }
  app.sudsnik.setReady(true);
  return app;
}
