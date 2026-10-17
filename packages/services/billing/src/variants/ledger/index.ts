import type { ServiceDeps } from "@sudsnik/contracts";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { baseApp } from "../../app.js";
import { BillingCore, bindCore } from "../../core/BillingCore.js";
import { registerRoutes } from "../../core/routes.js";
import { openBillingDb } from "../../db.js";

export const variant = "ledger";

/** Billing as the contract describes it: charges, an append-only ledger, and events through the outbox. */
export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const db = openBillingDb(deps);
  const outbox = createOutbox(db, deps.bus);
  const core = new BillingCore(deps, db, outbox);
  bindCore(deps, core);
  registerRoutes(app, core);
  // Stops run in reverse: handlers stop, the outbox pumps its last rows, then the db closes.
  app.sudsnik.registerStop(() => db.close());
  app.sudsnik.registerStop(() => outbox.stop());
  for (const h of await registerHandlers(deps)) app.sudsnik.registerStop(h.stop);
  outbox.start();
  app.sudsnik.setReady(true);
  return app;
}
