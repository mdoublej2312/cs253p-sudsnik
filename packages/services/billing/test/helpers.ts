import { IDEMPOTENCY_HEADER, TENANT_HEADER, type Ctx } from "@sudsnik/contracts";
import type { PaymentResponse } from "@sudsnik/contracts/mocks/payments";
import type { FakeDeps } from "@sudsnik/contracts/testing";
import { ok, type Result } from "@sudsnik/kernel";

/** A payments provider that says yes, and counts what it was asked. */
export function fakePayments(deps: FakeDeps) {
  const calls: Array<{ op: string; key?: string }> = [];
  const reply = (op: string, state: PaymentResponse["state"], ref: string, amount = 0) => async (_ctx: Ctx): Promise<Result<PaymentResponse>> => {
    calls.push({ op, ...(_ctx.idempotencyKey ? { key: _ctx.idempotencyKey } : {}) });
    return ok({ paymentRef: ref, state, amount, currency: "USD" });
  };
  deps.clients.payments = {
    authorize: (req, ctx) => reply("authorize", "authorized", `pay-${req.orderId}`, req.amount)(ctx),
    capture: (ref, amount, ctx) => reply("capture", "captured", ref, amount ?? 0)(ctx),
    refund: (ref, amount, ctx) => reply("refund", "refunded", ref, amount ?? 0)(ctx),
  };
  return calls;
}

export const headers = (key: string) => ({ [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: key });
export const settle = () => new Promise((r) => setTimeout(r, 150));
