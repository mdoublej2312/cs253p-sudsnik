import { fileURLToPath } from "node:url";
import { ORBIT_MS, type Ctx, type ServiceDeps } from "@sudsnik/contracts";
import type { NodeStatusResponse, Window } from "@sudsnik/contracts/mocks/ephemeris";
import { createCache } from "@sudsnik/infra-cache";
import { createBreaker, type Breaker } from "@sudsnik/infra-resilience";
import { ok, type Result } from "@sudsnik/kernel";
import { buildApp } from "../../app.js";
import { rankerWithFallback, roundRobinRanker, statusRanker, type NodeRanker } from "../../holds.js";
import type { Store } from "../../store.js";
import type { Strategy } from "../../strategy.js";
import { canonWindow, firstWindowFrom, type WindowSource } from "../../windows.js";
import { exactlyOnceTrust } from "./trust.js";


export const variant = "cached";
export const handlersDir = fileURLToPath(new URL("../../handlers/", import.meta.url));
export const alertsDir = fileURLToPath(new URL("../../../alerts/", import.meta.url));   
/** The provider's real /status TTL. Its README says 60 s; it is 300 s (#812). Shorter only pays for repeats. */
export const STATUS_TTL_MS = 300_000;
/** A habitat's windows come from the canon schedule and do not change within an orbit (#872). */
export const WINDOWS_TTL_MS = ORBIT_MS;
/** Third consecutive refusal opens it; the quota resets at the orbit boundary, so it stays open for an orbit. */
export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = ORBIT_MS;


export function cachedStrategy(deps: ServiceDeps, store: Store): Strategy {
  const ephemeris = deps.clients.ephemeris;
  const log = deps.telemetry.logger;
  const cacheOpts = { clock: deps.clock, meter: deps.meter, service: deps.service };
  const windowCache = createCache<Window[]>({ ...cacheOpts, max: 64, ttlMs: WINDOWS_TTL_MS });
  const statusCache = createCache<NodeStatusResponse>({ ...cacheOpts, max: 16, ttlMs: STATUS_TTL_MS });
  /** Never expires: what we already know, for when we cannot ask. */
  const lastStatus = new Map<string, NodeStatusResponse>();

  const breakers = new Map<string, Breaker>();
  const breakerFor = (tenantId: string): Breaker => {
    let b = breakers.get(tenantId);
    if (!b) {
      b = createBreaker({
        name: "ephemeris",
        failureThreshold: BREAKER_THRESHOLD,
        openMs: BREAKER_OPEN_MS,
        clock: deps.clock,
        // The release train reads `breaker_state` records with `to: "open"` for the breaker_opens_on_429 invariant.
        onStateChange: (from, to) => log.info("breaker_state", { breaker: "ephemeris", tenantId, from, to }),
      });
      breakers.set(tenantId, b);
    }
    return b;
  };

  /** Cache, then ephemeris through the tenant's breaker; the caller picks the fallback. */
  async function status(nodeId: string, ctx: Ctx): Promise<Result<NodeStatusResponse>> {
    const hit = statusCache.get(nodeId);
    if (hit) return ok(hit);
    const r = await breakerFor(ctx.tenantId).exec(() => ephemeris.status(nodeId, ctx));
    if (r.ok) {
      statusCache.set(nodeId, r.value);
      lastStatus.set(nodeId, r.value);
    }
    return r;
  }

  const windows: WindowSource = {
    async next(habitatId, nowMs, ctx) {
      let list = windowCache.get(habitatId);
      if (!list) {
        const r = await breakerFor(ctx.tenantId).exec(() => ephemeris.windows(habitatId, ctx));
        if (!r.ok) return ok(canonWindow(habitatId, nowMs));
        list = r.value.windows;
        windowCache.set(habitatId, list);
      }
      return ok(firstWindowFrom(list, nowMs) ?? canonWindow(habitatId, nowMs));
    },
  };

  const byStatus = statusRanker(status);
  const roundRobin = roundRobinRanker(store);
  const nodes: NodeRanker = {
    rank: (ctx) => rankerWithFallback(byStatus, roundRobin, () => breakerFor(ctx.tenantId).state() === "open").rank(ctx),
  };

  return {
    windows,
    nodes,
    async inContact(nodeId, ctx) {
      const r = await status(nodeId, ctx);
      if (r.ok) return ok(r.value.inContact);
      // A dark node is rare (#872): unknown counts as in contact.
      return ok(lastStatus.get(nodeId)?.inContact ?? true);
    },
    ingest: exactlyOnceTrust,
  };
}

export function createApp(deps: ServiceDeps) {
  return buildApp(deps, variant, cachedStrategy, alertsDir);
}