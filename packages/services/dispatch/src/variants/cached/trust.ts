import { ok, type Result } from "@sudsnik/kernel";
import type { RelayCallback } from "@sudsnik/contracts/mocks/relay";
import { stepIndex, type IngestTrust, type PodCallback, type StepRange } from "../../ingest.js";
import type { Store } from "../../store.js";
import { checksumVerifies } from "../../checksum.js";


export function exactlyOnceTrust(store: Store): IngestTrust {
  return {
        verify: (body: RelayCallback) => checksumVerifies(body as unknown as Record<string, unknown>),


    fresh: (entry, nowMs) => store.recordCallback(entry, nowMs),

    range(body: PodCallback, progress: number): Result<StepRange> {
      const target = stepIndex(body.kind);

      if (target <= progress) return ok(undefined);

      return ok({ from: progress + 1, to: target });
    },
  };
}