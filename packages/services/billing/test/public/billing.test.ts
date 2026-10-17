import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEnvelope, type Envelope } from "@sudsnik/contracts";
import { fakeDeps, type FakeDeps } from "@sudsnik/contracts/testing";
import { err, sudsnikError } from "@sudsnik/kernel";
import { createApp } from "../../src/variants/ledger/index.js";
import { handlersDir } from "../../src/index.js";
import { fakePayments, headers, settle } from "../helpers.js";

const orderId = "01M3Z1VS0000000000000000AA";
const event = (topic: Envelope["topic"], payload: object) => makeEnvelope({ topic, tenantId: "op1", occurredAt: 0, payload });
const returned = () => event("order.returned", { orderId, podId: "hab01-p001", habitatId: "hab01", returnedAt: 0, orbitsElapsed: 4 });

describe("billing", () => {
  let deps: FakeDeps;
  let app: Awaited<ReturnType<typeof createApp>>;
  let calls: ReturnType<typeof fakePayments>;
  const authorize = (key = "k1") => app.inject({ method: "POST", url: "/charges/authorize", headers: headers(key), payload: { orderId, amount: 5260 } });
  beforeEach(async () => {
    deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
    calls = fakePayments(deps);
    app = await createApp(deps);
  });
  afterEach(() => app.sudsnik.drain());

  it("quotes the canon price for the operator's tier", async () => {
    const q = (await app.inject({ url: `/quotes/${orderId}`, headers: { "x-sudsnik-tenant": "op1" } })).json() as { amount: number };
    expect(q.amount).toBe(4900 + 120 * 3);
  });

  it("authorizes once however often it is asked", async () => {
    expect((await authorize("k1")).json()).toMatchObject({ orderId, state: "authorized", amount: 5260 });
    expect((await authorize("k2")).statusCode).toBe(200);
    expect(calls.filter((c) => c.op === "authorize")).toHaveLength(1);
  });

  it("leaves nothing behind when the provider is unavailable, and says to retry", async () => {
    deps.clients.payments.authorize = async () => err(sudsnikError("TIMEOUT", "provider timed out"));
    const res = await authorize();
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ retryable: true });
    expect(((await app.inject({ url: `/ledger?orderId=${orderId}`, headers: { "x-sudsnik-tenant": "op1" } })).json() as unknown[]).length).toBe(0);
  });

  it("captures a returned order once, priced on the units washed, and never twice", async () => {
    await authorize();
    await deps.bus.deliver(event("wash.completed", { orderId, washerId: "A1", completedAt: 0, cycleUnits: 80 }));
    await deps.bus.deliver(returned());
    await deps.bus.deliver(returned());
    const ref = `pay-${orderId}`;
    const hook = { id: "wh1", paymentRef: ref, orderId, event: "captured", amount: 5140, currency: "USD", atMs: 0 };
    expect((await app.inject({ method: "POST", url: "/callbacks/payments", payload: hook })).json()).toEqual({ accepted: true, duplicate: false });
    expect((await app.inject({ method: "POST", url: "/callbacks/payments", payload: hook })).json()).toEqual({ accepted: true, duplicate: true });
    await settle();
    const captured = deps.bus.ofTopic<{ amount: number }>("charge.captured");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.amount).toBe(4900 + 80 * 3);
    const ledger = (await app.inject({ url: `/ledger?orderId=${orderId}`, headers: { "x-sudsnik-tenant": "op1" } })).json() as Array<{ kind: string }>;
    expect(ledger.map((e) => e.kind)).toEqual(["authorize", "capture"]);
  });

  it("authorizes a returned order whose authorization never landed, then captures it", async () => {
    await deps.bus.deliver(returned());
    await settle();
    expect(deps.bus.ofTopic("charge.captured")).toHaveLength(1);
  });

  it("refunds an authorized charge, voiding it when the provider says it was never captured", async () => {
    await authorize();
    deps.clients.payments.refund = async () => err(sudsnikError("CONFLICT", "payment is not captured"));
    const res = await app.inject({ method: "POST", url: `/charges/${orderId}/refund`, headers: headers("r1") });
    expect(res.json()).toMatchObject({ state: "refunded" });
    expect(deps.bus.ofTopic("refund.issued")).toHaveLength(1);
  });

  it("keys the provider call by the order, so a retry under a new key authorizes once, and serves /v2", async () => {
    deps.clients.payments.authorize = async () => err(sudsnikError("TIMEOUT", "provider timed out"));
    expect((await authorize("t1")).statusCode).toBe(504);
    calls = fakePayments(deps);
    await authorize("t2");
    await authorize("t3");
    expect(calls.map((c) => c.key)).toEqual([orderId]);
    expect((await app.inject({ url: `/v2/quotes/${orderId}`, headers: { "x-sudsnik-tenant": "op1" } })).statusCode).toBe(200);
  });

  it("settles a capture from its webhook alone, once however often it arrives", async () => {
    await authorize();
    const hook = { id: "wh9", paymentRef: `pay-${orderId}`, orderId, event: "captured", amount: 5260, currency: "USD", atMs: 0 };
    for (let i = 0; i < 2; i++) await app.inject({ method: "POST", url: "/callbacks/payments", payload: hook });
    const ledger = (await app.inject({ url: `/ledger?orderId=${orderId}`, headers: { "x-sudsnik-tenant": "op1" } })).json() as Array<{ kind: string }>;
    expect(ledger.filter((e) => e.kind === "capture")).toHaveLength(1);
    expect(deps.bus.ofTopic("charge.captured")).toHaveLength(1);
  });

  it("publishes a capture before the handler returns", async () => {
    await authorize();
    await deps.bus.deliver(returned());
    expect(deps.bus.ofTopic("charge.captured")).toHaveLength(1);
  });

  it("refunds captured money through the provider", async () => {
    await authorize();
    await app.inject({ method: "POST", url: `/charges/${orderId}/capture`, headers: headers("c1") });
    const res = await app.inject({ method: "POST", url: `/charges/${orderId}/refund`, headers: headers("r1") });
    expect(res.json()).toMatchObject({ state: "refunded" });
    expect(calls.filter((c) => c.op === "refund")).toHaveLength(1);
  });
});
