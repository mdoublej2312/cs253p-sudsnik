import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEMPOTENCY_HEADER, TENANT_HEADER } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { fakeDeps, type FakeDeps } from "@sudsnik/contracts/testing";
import { createApp } from "../../src/variants/hollow/index.js";
import { handlersDir } from "../../src/index.js";

describe("billing hollow", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let deps: FakeDeps;
  beforeAll(async () => {
    deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
    app = await createApp(deps);
  });
  afterAll(() => app.sudsnik.drain());

  it("is up, ready, and says it is hollow", async () => {
    for (const url of ["/health", "/ready", "/cost", "/version"]) expect((await app.inject(url)).statusCode).toBe(200);
    expect(((await app.inject("/version")).json() as { variant: string }).variant).toBe("hollow");
  });

  it("answers 501 UNAVAILABLE, retryable, on every route and publishes nothing", async () => {
    for (const r of Object.values(routes)) {
      const url = r.path.replace(":orderId", "01M3Z1VS0000000000000000AA");
      const res = await app.inject({ method: r.method, url, headers: { [TENANT_HEADER]: "op1", [IDEMPOTENCY_HEADER]: "k1" }, ...(r.method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(501);
      expect(res.json()).toEqual({ code: "UNAVAILABLE", message: "billing is hollow", retryable: true });
    }
    expect(deps.bus.published.length).toBe(0);
  });
});
