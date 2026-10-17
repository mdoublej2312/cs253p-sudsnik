import {
  CYCLE_UNIT_PRICE_MINOR,
  DEFAULT_CURRENCY,
  EXPECTED_CYCLE_UNITS,
  WASH_PRICE_MINOR,
  makeEnvelope,
  parsePayload,
  serviceUrlVar,
  type Ctx,
  type Envelope,
  type ServiceDeps,
  type Topic,
} from "@sudsnik/contracts";
import type { PaymentsWebhook } from "@sudsnik/contracts/mocks/payments";
import type { BillingService, Charge, LedgerEntry, LedgerFilter, Quote } from "@sudsnik/contracts/services/billing";
import type { Db } from "@sudsnik/infra-db";
import type { Outbox } from "@sudsnik/infra-queue";
import { err, newId, ok, sudsnikError, type Result } from "@sudsnik/kernel";

type Tier = keyof typeof WASH_PRICE_MINOR;
interface ChargeRow {
  charge_id: string;
  tenant_id: string;
  order_id: string;
  amount: number;
  base: number;
  currency: string;
  state: Charge["state"];
  payment_ref: string | null;
  updated_at: number;
}

const toCharge = (r: ChargeRow): Charge => ({
  chargeId: r.charge_id,
  tenantId: r.tenant_id,
  orderId: r.order_id,
  amount: r.amount,
  currency: r.currency,
  state: r.state,
  ...(r.payment_ref ? { paymentRef: r.payment_ref } : {}),
  updatedAt: r.updated_at,
});

/**
 * Billing behind its contract. One charge per order moves authorized -> captured -> refunded (or authorized -> refunded
 * when a cancel voids it, or -> failed when the provider refuses); every move appends to the ledger and, where it is
 * money changing hands, enqueues its event in the same transaction (ADR-0002). A move is only taken from the state it
 * leaves, so a retried call or a redelivered event or webhook finds the move already made and changes nothing.
 */
export class BillingCore implements BillingService {
  private readonly callbackUrl: string;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly db: Db,
    private readonly outbox: Outbox,
  ) {
    this.callbackUrl = `${(deps.env[serviceUrlVar("billing")] ?? "").replace(/\/$/, "")}/callbacks`;
  }

  async quote(orderId: string, ctx: Ctx): Promise<Result<Quote>> {
    const tier = this.tierOf(ctx.tenantId);
    const base = WASH_PRICE_MINOR[tier];
    const amount = base + EXPECTED_CYCLE_UNITS * CYCLE_UNIT_PRICE_MINOR;
    return ok({ orderId, amount, currency: DEFAULT_CURRENCY, breakdown: { base, cycleUnits: EXPECTED_CYCLE_UNITS, tier } });
  }

  async authorize(orderId: string, amount: number, ctx: Ctx): Promise<Result<Charge>> {
    const existing = this.find(ctx.tenantId, orderId);
    if (existing) return existing.state === "failed" ? err(sudsnikError("CONFLICT", `charge for ${orderId} failed`)) : ok(toCharge(existing));
    const key = { ...ctx, idempotencyKey: `authorize-${orderId}` };
    const paid = await this.deps.clients.payments.authorize({ orderId, amount, currency: DEFAULT_CURRENCY, callbackUrl: this.callbackUrl }, key);
    if (!paid.ok && paid.error.retryable) return paid;
    const now = this.deps.clock.now();
    const row: ChargeRow = {
      charge_id: newId(),
      tenant_id: ctx.tenantId,
      order_id: orderId,
      amount,
      base: WASH_PRICE_MINOR[this.tierOf(ctx.tenantId)],
      currency: DEFAULT_CURRENCY,
      state: paid.ok ? "authorized" : "failed",
      payment_ref: paid.ok ? paid.value.paymentRef : null,
      updated_at: now,
    };
    this.db.transaction(() => {
      this.db.write(
        "insert or ignore into charges (charge_id, tenant_id, order_id, amount, base, currency, state, payment_ref, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.charge_id, row.tenant_id, row.order_id, row.amount, row.base, row.currency, row.state, row.payment_ref, row.updated_at,
      );
      if (paid.ok) this.append(row, "authorize", amount, now);
      else this.emit("charge.failed", row, ctx.correlationId, { orderId, reason: paid.error.message });
    });
    await this.outbox.pump();
    const stored = this.find(ctx.tenantId, orderId)!;
    return paid.ok ? ok(toCharge(stored)) : paid;
  }

  async capture(orderId: string, ctx: Ctx): Promise<Result<Charge>> {
    const charge = this.find(ctx.tenantId, orderId);
    if (!charge) return err(sudsnikError("NOT_FOUND", `no charge for ${orderId}`));
    if (charge.state !== "authorized") return charge.state === "captured" ? ok(toCharge(charge)) : err(sudsnikError("CONFLICT", `charge for ${orderId} is ${charge.state}`));
    // Priced on what the washer used, never above what was authorized.
    const units = this.db.readOne<{ cycle_units: number }>("select cycle_units from wash_units where order_id = ?", orderId)?.cycle_units ?? EXPECTED_CYCLE_UNITS;
    const amount = Math.min(charge.amount, charge.base + units * CYCLE_UNIT_PRICE_MINOR);
    const paid = await this.deps.clients.payments.capture(charge.payment_ref!, amount, { ...ctx, idempotencyKey: `capture-${orderId}` });
    if (!paid.ok) return paid;
    this.settleCapture(charge.charge_id, amount, ctx.correlationId);
    await this.outbox.pump();
    return ok(toCharge(this.find(ctx.tenantId, orderId)!));
  }

  async refund(orderId: string, ctx: Ctx): Promise<Result<Charge>> {
    const charge = this.find(ctx.tenantId, orderId);
    if (!charge) return err(sudsnikError("NOT_FOUND", `no charge for ${orderId}`));
    if (charge.state === "refunded") return ok(toCharge(charge));
    if (charge.state === "failed") return err(sudsnikError("CONFLICT", `charge for ${orderId} failed`));
    // Refunded through the provider; one that refuses an authorization never captured (409) has nothing to give back, so it is voided here.
    const paid = await this.deps.clients.payments.refund(charge.payment_ref!, undefined, { ...ctx, idempotencyKey: `refund-${orderId}` });
    if (!paid.ok && !(paid.error.code === "CONFLICT" && charge.state === "authorized")) return paid;
    this.move(charge.charge_id, ["authorized", "captured"], "refunded", (c, now) => {
      this.append(c, "refund", -c.amount, now);
      this.emit("refund.issued", c, ctx.correlationId, { orderId: c.order_id, refundId: newId(), amount: c.amount, currency: c.currency });
    });
    await this.outbox.pump();
    return ok(toCharge(this.find(ctx.tenantId, orderId)!));
  }

  async ledger(filter: LedgerFilter, ctx: Ctx): Promise<Result<LedgerEntry[]>> {
    const rows = this.db.read<{ entry_id: string; tenant_id: string; order_id: string; kind: LedgerEntry["kind"]; amount: number; currency: string; at: number; ref: string | null }>(
      `select * from ledger where tenant_id = ?${filter.orderId ? " and order_id = ?" : ""} order by at, rowid limit ?`,
      ...[ctx.tenantId, ...(filter.orderId ? [filter.orderId] : []), filter.limit],
    );
    return ok(rows.map((r) => ({ entryId: r.entry_id, tenantId: r.tenant_id, orderId: r.order_id, kind: r.kind, amount: r.amount, currency: r.currency, at: r.at, ...(r.ref ? { ref: r.ref } : {}) })));
  }

    /** The provider's word on a payment. A capture we timed out on is settled here when its webhook arrives. */
  async paymentsWebhook(hook: PaymentsWebhook): Promise<{ accepted: boolean; duplicate: boolean }> {
    const charge =
      this.db.readOne<ChargeRow>("select * from charges where payment_ref = ?", hook.paymentRef) ?? this.db.readOne<ChargeRow>("select * from charges where order_id = ?", hook.orderId);
    if (!charge) return { accepted: false, duplicate: false };
    // The dedupe row and the effect it guards commit together: a restart sees both or neither (#888).
    const fresh = this.db.transaction(() => {
      if (this.db.write("insert or ignore into webhooks (id) values (?)", hook.id).changes !== 1) return false;
      if (hook.event === "captured") this.settleCapture(charge.charge_id, Math.min(hook.amount, charge.amount), charge.charge_id);
      if (hook.event === "failed") this.move(charge.charge_id, ["authorized"], "failed", (c) => this.emit("charge.failed", c, c.charge_id, { orderId: c.order_id, reason: "payment failed" }));
      return true;
    });
    if (!fresh) return { accepted: true, duplicate: true };
    await this.outbox.pump();
    return { accepted: true, duplicate: false };
  }

  /** Events consumed: a return is captured; a wash's units and an operator's tier are kept for pricing. */
  async applyEvent(envelope: Envelope): Promise<Result<void>> {
    const topic = envelope.topic as Topic;
    if (topic === "order.returned") {
      const { orderId } = parsePayload("order.returned", envelope.payload);
      const ctx: Ctx = { tenantId: envelope.tenantId, correlationId: envelope.correlationId };
      // An order whose authorization never landed is authorized now, so a return is always billable.
      if (!this.find(envelope.tenantId, orderId)) {
        const q = await this.quote(orderId, ctx);
        const a = q.ok ? await this.authorize(orderId, q.value.amount, ctx) : q;
        if (!a.ok) return a.error.retryable ? a : ok(undefined);
      }
      const c = await this.capture(orderId, ctx);
      return c.ok || !c.error.retryable ? ok(undefined) : err(c.error);
    }
    if (topic === "wash.completed") {
      const p = parsePayload("wash.completed", envelope.payload);
      this.db.lazy(() => this.db.write("insert or replace into wash_units (order_id, cycle_units) values (?, ?)", p.orderId, p.cycleUnits));
    } else if (topic === "operator.updated") {
      const p = parsePayload("operator.updated", envelope.payload);
      this.db.lazy(() => this.db.write("insert or replace into operators (operator_id, pricing_tier) values (?, ?)", p.operatorId, p.pricingTier));
    }
    return ok(undefined);
  }

  private tierOf(tenantId: string): Tier {
    return (this.db.readOne<{ pricing_tier: Tier }>("select pricing_tier from operators where operator_id = ?", tenantId)?.pricing_tier ?? "standard");
  }

  private find(tenantId: string, orderId: string): ChargeRow | undefined {
    return this.db.readOne<ChargeRow>("select * from charges where tenant_id = ? and order_id = ?", tenantId, orderId);
  }

  /** authorized -> captured, once: the second caller (a retry, a duplicate webhook) finds it captured and does nothing. */
  private settleCapture(chargeId: string, amount: number, correlationId: string): void {
    this.move(chargeId, ["authorized"], "captured", (c, now) => {
      this.db.write("update charges set amount = ? where charge_id = ?", amount, chargeId);
      this.append(c, "capture", amount, now);
      this.emit("charge.captured", c, correlationId, { orderId: c.order_id, chargeId: c.charge_id, amount, currency: c.currency });
    });
  }

  /** Moves a charge to `to` only from one of `from`, with `then` in the same transaction; false when it was not in `from`. */
  private move(chargeId: string, from: Charge["state"][], to: Charge["state"], then: (c: ChargeRow, now: number) => void): boolean {
    const now = this.deps.clock.now();
    return this.db.transaction(() => {
      const c = this.db.readOne<ChargeRow>("select * from charges where charge_id = ?", chargeId);
      if (!c || !from.includes(c.state)) return false;
      this.db.write("update charges set state = ?, updated_at = ? where charge_id = ?", to, now, chargeId);
      then(c, now);
      return true;
    });
  }

  private append(c: Pick<ChargeRow, "tenant_id" | "order_id" | "currency" | "payment_ref">, kind: LedgerEntry["kind"], amount: number, at: number): void {
    this.db.write("insert into ledger (entry_id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)", newId(), c.tenant_id, c.order_id, kind, amount, c.currency, at, c.payment_ref);
  }

  private emit(topic: "charge.captured" | "charge.failed" | "refund.issued", c: Pick<ChargeRow, "tenant_id">, correlationId: string, payload: object): void {
    this.outbox.enqueue(makeEnvelope({ topic, tenantId: c.tenant_id, occurredAt: this.deps.clock.now(), correlationId, payload }));
  }
}

// Handlers are found by directory scan and receive only ServiceDeps, so the app binds its core to the deps it was built with.
const cores = new WeakMap<ServiceDeps, BillingCore>();
export const bindCore = (deps: ServiceDeps, core: BillingCore): void => void cores.set(deps, core);
export const coreFor = (deps: ServiceDeps): BillingCore | undefined => cores.get(deps);
