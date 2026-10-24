import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@sudsnik/infra-db";
import { err, newId, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import type { HoldStore } from "@sudsnik/contracts/services/washnodes";
import { firmwareRefOf, guardTransition, type StoredHold } from "../../domain/hold.js";
import type { WasherRepo } from "../../ports/washerRepo.js";
import { holds } from "../db/schema.js";

type Row = typeof holds.$inferSelect;

const toHold = (r: Row): StoredHold => ({
  holdId: r.holdId, tenantId: r.tenantId, nodeId: r.nodeId, washerId: r.washerId, orderId: r.orderId,
  state: r.state as StoredHold["state"], acquiredAt: r.acquiredAt, expiresAt: r.expiresAt,
  version: r.version, firmwareRef: r.firmwareRef,
});


export function sqliteHoldStore(db: Db, washers: WasherRepo): HoldStore {
  const read = (holdId: string): StoredHold | undefined => {
    const row = db.orm.select().from(holds).where(eq(holds.holdId, holdId)).get();
    return row ? toHold(row) : undefined;
  };

 
  const transition = (holdId: string, expectedVersion: number, to: "released" | "consumed", nowMs: number, reason: string | null, after: (h: StoredHold) => void): Result<StoredHold> =>
    db.orm.transaction(() => {
      const changed = db.orm
        .update(holds)
        .set({ state: to, version: expectedVersion + 1, endedAt: nowMs, reason, liveWasherId: null }) 
        .where(and(eq(holds.holdId, holdId), eq(holds.version, expectedVersion), eq(holds.state, "held")))
        .run().changes;
      if (changed !== 1) {
        const guarded = guardTransition(read(holdId), holdId, expectedVersion);
        return guarded.ok ? err(sudsnikError("CONFLICT", `hold ${holdId} changed underneath`)) : guarded;
      }
      const next = read(holdId)!;
      after(next);
      return ok(next);
    }, { behavior: "immediate" });

  return {
    acquire: async (input) => {
      const ref = firmwareRefOf(input.firmwareRef, `hold for order ${input.orderId}`);
      if (!ref.ok) return ref;
      const hold: StoredHold = {
        holdId: newId(), tenantId: input.tenantId, nodeId: input.nodeId, washerId: input.washerId,
        orderId: input.orderId, state: "held", acquiredAt: input.nowMs,
        expiresAt: input.nowMs + input.ttlMs, version: 0, firmwareRef: ref.value,
      };
      return db.orm.transaction(() => {

        if (!washers.reserve(input.washerId, hold.holdId)) {
          return err(sudsnikError("QUOTA", `washer ${input.washerId} was taken; no idle washer at node ${input.nodeId}`));
        }
        db.orm.insert(holds).values({ ...hold, liveWasherId: hold.washerId }).run(); 
        return ok(hold);
      }, { behavior: "immediate" });
    },
    release: async (holdId, expectedVersion, reason, nowMs) =>
      transition(holdId, expectedVersion, "released", nowMs, reason, (h) => washers.free(h.washerId, h.holdId)),
    consume: async (holdId, expectedVersion, nowMs) =>
      transition(holdId, expectedVersion, "consumed", nowMs, null, (h) => washers.startWashing(h.washerId)),
    expire: async (nowMs) =>
      ok(db.orm.transaction(() => {
       
        const due = db.orm.select().from(holds).where(and(eq(holds.state, "held"), lte(holds.expiresAt, nowMs))).all();
        const expired: StoredHold[] = [];
        for (const r of due) {
          const changed = db.orm
            .update(holds)
            .set({ state: "expired", version: r.version + 1, endedAt: nowMs, reason: "expired", liveWasherId: null }) 
            .where(and(eq(holds.holdId, r.holdId), eq(holds.version, r.version), eq(holds.state, "held")))
            .run().changes;
          if (changed !== 1) continue;
          washers.free(r.washerId, r.holdId);
          expired.push({ ...toHold(r), state: "expired", version: r.version + 1 });
        }
        return expired;
      }, { behavior: "immediate" })),
    get: async (holdId) => {
      const hold = read(holdId);
      return hold ? ok(hold) : err(sudsnikError("NOT_FOUND", `no hold ${holdId}`));
    },
  };
}