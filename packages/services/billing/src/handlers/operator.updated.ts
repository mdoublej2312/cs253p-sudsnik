import type { Envelope, Handler, ServiceDeps } from "@sudsnik/contracts";
import { ok, type Result } from "@sudsnik/kernel";
import { coreFor } from "../core/BillingCore.js";

/** Hands the envelope to the billing core bound to these deps; with none bound (hollow) there is nothing to do. */
const handler: Handler = {
  topic: "operator.updated",
  async handle(envelope: Envelope, deps: ServiceDeps): Promise<Result<void>> {
    const core = coreFor(deps);
    return core ? core.applyEvent(envelope) : ok(undefined);
  },
};

export default handler;
