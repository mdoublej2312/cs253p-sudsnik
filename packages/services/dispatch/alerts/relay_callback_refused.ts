import type { AlertRule } from "@sudsnik/contracts";


let prev = 0;

const rule: AlertRule = {
  name: "relay_callback_refused",
  every: 10 * 60_000,
  evaluate(m) {
    const now = m.counters["dispatch.callback_rejected"] ?? 0;
    const fired = now > prev;
    prev = now;
    return fired;
  },
};
export default rule;