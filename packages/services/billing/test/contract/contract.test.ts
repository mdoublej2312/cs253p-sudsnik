import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractSuite } from "@sudsnik/contracts/testing/contractSuite";
import { routes } from "@sudsnik/contracts/services/billing";
import { createApp, handlersDir } from "../../src/index.js";
import { fakePayments } from "../helpers.js";

const orderId = "01M3Z1VS0000000000000000CT";

// Routes are swept in contract order, so one order is quoted, authorized, captured, refunded, then read from the ledger.
contractSuite(
  { describe, it, expect, beforeAll, afterAll },
  {
    service: "billing",
    routes,
    createApp,
    handlersDir,
    prepare: (deps) => void fakePayments(deps),
    examples: {
      quote: { params: { orderId } },
      authorize: { body: { orderId, amount: 5260 } },
      capture: { params: { orderId } },
      refund: { params: { orderId } },
      ledger: { query: { orderId } },
    },
  },
);
