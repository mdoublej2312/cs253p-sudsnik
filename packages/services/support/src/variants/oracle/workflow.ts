import { ORBIT_MS, type ServiceDeps } from "@sudsnik/contracts";
import type { SupportEnv, TriageWorkflow } from "@sudsnik/contracts/services/support";
import { err, ok, sudsnikError } from "@sudsnik/kernel";
import type { Store } from "../../store.js";
import { givesOrders } from "../../workflow/guard.js";
import { classifyByKeywords } from "../../workflow/keywords.js";
import { triagePrompt } from "../../workflow/prompt.js";
import { parseTriage, type TriageFields } from "../../workflow/validate.js";

const MAX_TOKENS = 64;


export function createOracleWorkflow(deps: ServiceDeps, store: Store, env: SupportEnv): TriageWorkflow {
  const budget = env.SUDSNIK_SUPPORT_TOKEN_BUDGET_PER_ORBIT;
  const orbitNow = () => Math.floor(deps.clock.now() / ORBIT_MS);

  return {
    async classify(input, ctx) {
      const guarded = givesOrders(input.note);
      let tokens = 0;
      let fields: TriageFields | undefined;

      for (const strict of [false, true]) {
        const orbit = orbitNow();
        if (store.tokensInOrbit(orbit) >= budget) break; 
        const res = await deps.clients.oracle.complete(triagePrompt(input.note, strict), MAX_TOKENS, ctx);
        
        if (!res.ok) return err(sudsnikError("UNAVAILABLE", `oracle: ${res.error.message}`));
        const used = res.value.promptTokens + res.value.completionTokens;
        store.addTokens(orbit, used);
        tokens += used;
        const parsed = parseTriage(res.value.completion);
        if (parsed.ok) {
          fields = parsed.value;
          break;
        }
      }

      let result = fields ?? classifyByKeywords(input.note); 
      if (guarded && result.action === "clean") {
        const fallback = classifyByKeywords(input.note);
        result = fallback.action === "clean" ? { ...fallback, action: "inspect" } : fallback;
      }
      return ok({ ...result, tokens, guarded });
    },
  };
}