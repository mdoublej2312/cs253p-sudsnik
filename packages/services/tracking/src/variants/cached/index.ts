import { SHUTTLES, type ServiceDeps } from "@sudsnik/contracts";
import { createCache } from "@sudsnik/infra-cache";
import { err, mapResult, ok, sudsnikError } from "@sudsnik/kernel";
import { buildApp, cached, fresh, ingest, podLocation } from "../../app.js";
import type { StoredPosition } from "../../store.js";


export const createApp = (deps: ServiceDeps) =>
  buildApp(deps, "cached", (parts) => {
    const cache = createCache<StoredPosition>({ max: SHUTTLES.length * 2, ttlMs: parts.ttlMs, clock: deps.clock, meter: deps.meter, service: deps.service });
    const remember = (p: StoredPosition) => cache.set(p.shuttleId, p);

    return {
      position: async (shuttleId, ctx) => mapResult(await deps.clients.ephemeris.position(shuttleId, ctx), fresh),
      async positionCached(shuttleId) {
        const hit = cache.get(shuttleId);
        if (hit) return ok(cached(hit));
        const stored = parts.store.position(shuttleId);
        if (!stored) return err(sudsnikError("NOT_FOUND", `no reported position for ${shuttleId}`));
        remember(stored);
        return ok(cached(stored));
      },
      positions: async () => ok(parts.store.positions().map(cached)),
      podLocation: podLocation(parts),
      relay: (body, ctx) => ingest(parts, body, ctx, remember),
    };
  });