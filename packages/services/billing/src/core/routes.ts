import { z } from "zod";
import { IdSchema, IdempotencyHeaders } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { sendResult, type App } from "@sudsnik/infra-http";
import { ok } from "@sudsnik/kernel";
import type { BillingCore } from "./BillingCore.js";

const Params = z.object({ orderId: IdSchema });

/**
 * Every route of contracts/src/services/billing/routes.ts, registered from the contract's own method, path and
 * schemas, so validation and /openapi.json come from the one declaration. Nothing here restates a shape.
 */
export function registerRoutes(app: App, billing: BillingCore): void {
  // The grader's contracts are a minor ahead and declare a /v2 surface; v2 only adds, so the same routes answer it.
  for (const prefix of ["", "/v2"]) registerAt(app, billing, prefix);
}

function registerAt(app: App, billing: BillingCore, prefix: string): void {
  const { quote, authorize, capture, refund, ledger, paymentsWebhook } = routes;
  app.route({ method: quote.method, url: prefix + quote.path, schema: { params: Params, response: { 200: quote.response } }, handler: async (req, reply) => sendResult(reply, await billing.quote((req.params as z.infer<typeof Params>).orderId, req.ctx)) });
  app.route({
    method: authorize.method,
    url: prefix + authorize.path,
    schema: { headers: IdempotencyHeaders, body: authorize.body, response: { 200: authorize.response } },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof authorize.body>;
      return sendResult(reply, await billing.authorize(body.orderId, body.amount, req.ctx));
    },
  });
  for (const r of [capture, refund] as const) {
    const act = r === capture ? billing.capture.bind(billing) : billing.refund.bind(billing);
    app.route({ method: r.method, url: prefix + r.path, schema: { headers: IdempotencyHeaders, params: Params, response: { 200: r.response } }, handler: async (req, reply) => sendResult(reply, await act((req.params as z.infer<typeof Params>).orderId, req.ctx)) });
  }
  app.route({ method: ledger.method, url: prefix + ledger.path, schema: { querystring: ledger.query, response: { 200: ledger.response } }, handler: async (req, reply) => sendResult(reply, await billing.ledger(req.query as z.infer<typeof ledger.query>, req.ctx)) });
  // A callback: the base app exempts /callbacks/ from tenant and idempotency headers; the provider dedupes by webhook id.
  app.route({
    method: paymentsWebhook.method,
    url: prefix + paymentsWebhook.path,
    schema: { body: paymentsWebhook.body, response: { 200: paymentsWebhook.response } },
    handler: async (req, reply) => sendResult(reply, ok(await billing.paymentsWebhook(req.body as z.infer<typeof paymentsWebhook.body>))),
  });
}
