import type { Ctx } from "@sudsnik/contracts";
import { CANCELLABLE_STATES, type Order } from "@sudsnik/contracts/services/orders";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { COMPENSATION, ORIGIN, OrdersService, notFound } from "../../core/OrdersService.js";

/** Cancel on the customer's word (system-spec §9.3, ADR-0002): state, cancel step and order.cancelled commit together; the refund runs after. */
export class CancelSagaOrdersService extends OrdersService {
  async cancel(orderId: string, reason: string, ctx: Ctx): Promise<Result<Order>> {
    const decided = this.inTransaction((): Result<{ order: Order; refund: boolean }> => {
      const order = this.find(ctx.tenantId, orderId);
      if (!order) return err(notFound(orderId));
      if (!CANCELLABLE_STATES.includes(order.state)) return err(sudsnikError("CONFLICT", `order ${orderId} is ${order.state} and can no longer be cancelled`));
      const compensations = this.cancelInPlace(order, reason, ORIGIN.customer, { correlationId: ctx.correlationId });
      return ok({ order, refund: compensations.includes(COMPENSATION.refund) });
    });
    if (!decided.ok) return decided;
    if (decided.value.refund) await this.refundFor(decided.value.order, ctx.correlationId);
    return ok(decided.value.order);
  }
}