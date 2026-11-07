import type { AlertRule } from "@sudsnik/contracts";


let prev = { total: 0, dup: 0 };

const rule: AlertRule = {
  name: "relay_delivery_degraded",
  every: 10 * 60_000, 
  evaluate(m) {
    const total = m.counters["dispatch.callbacks"] ?? 0;
    const dup = m.counters["dispatch.callback_duplicates"] ?? 0;
    const dTotal = total - prev.total;
    const dDup = dup - prev.dup;
    prev = { total, dup };
    return dTotal >= 10 && dDup / dTotal > 0.15;
  },
};
export default rule;