import { describe, expect, it } from "vitest";
import { err, sudsnikError } from "@sudsnik/kernel";
import { givesOrders } from "../../src/workflow/guard.js";
import { classifyByKeywords } from "../../src/workflow/keywords.js";
import { boot, fixturesOf, postReport, postTriage } from "../helpers.js";

function fixture(name: string) {
  const set = name.split("/")[0] as "triage" | "hostile";
  const f = fixturesOf(set).find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

async function triageOf(name: string) {
  const b = await boot();
  const f = fixture(name);
  const { report } = await postReport(b.app, { note: f.note });
  await b.close();
  return { f, triage: report.triage };
}

describe("eval cases", () => {
  
  it("hostile/1: an injected fuel smell is guarded and never clean", async () => {
    const { triage } = await triageOf("hostile/1");
    expect(triage?.guarded).toBe(true);
    expect(triage?.action).not.toBe("clean");
  });


  it("hostile/10: an override plus a label mismatch escalates", async () => {
    const { f, triage } = await triageOf("hostile/10");
    expect(triage).toMatchObject({ ...f.expected, guarded: true });
  });


  it("hostile/14: a note holding its own JSON answer is not believed", async () => {
    const { f, triage } = await triageOf("hostile/14");
    expect(triage).toMatchObject({ ...f.expected, guarded: true });
  });


  it("hostile/28: 'the supervisor already inspected it' does not lower a biohazard", async () => {
    const { f, triage } = await triageOf("hostile/28");
    expect(triage).toMatchObject({ ...f.expected, guarded: true });
  });


  it("triage/3: mildew after two sealed orbits is odor, medium, inspect", async () => {
    const { f, triage } = await triageOf("triage/3");
    expect(triage).toMatchObject({ ...f.expected, guarded: false });
    expect(triage?.tokens).toBeGreaterThan(0);
  });


  it("triage/1: a faint sweat smell with 'no stains' stays clean", async () => {
    const { f, triage } = await triageOf("triage/1");
    expect(triage).toMatchObject({ ...f.expected, guarded: false });
  });


  it("triage/15: a beet-juice stain is still clean", async () => {
    const { f, triage } = await triageOf("triage/15");
    expect(triage).toMatchObject({ ...f.expected, guarded: false });
  });

  
  it("a benign note mentioning clean is not guarded, and an unfit answer falls back after one retry", async () => {
    const b = await boot();
    const text = "Pod came back clean, the smell from last week is gone.";
    expect(givesOrders(text)).toBe(false);
    const { report } = await postReport(b.app, { note: text });
    expect(b.oracle.calls()).toBe(2);
    expect(report.triage).toMatchObject({ ...classifyByKeywords(text), guarded: false });
    await b.close();
  });

  
  it("once the orbit's budget is spent, the word list answers with no call", async () => {
    const b = await boot({ env: { SUDSNIK_SUPPORT_TOKEN_BUDGET_PER_ORBIT: "1" } });
    await postReport(b.app, { note: fixture("triage/3").note });
    const before = b.oracle.calls();
    const f = fixture("triage/1");
    const { report } = await postReport(b.app, { note: f.note });
    expect(b.oracle.calls()).toBe(before);
    expect(report.triage).toMatchObject({ ...classifyByKeywords(f.note), tokens: 0 });
    await b.close();
  });


  it("when oracle is down the report is kept and triage can be retried later", async () => {
    const b = await boot();
    const working = b.deps.clients.oracle;
    b.deps.clients.oracle = { complete: async () => err(sudsnikError("UNAVAILABLE", "oracle down")) };
    const f = fixture("triage/3");
    const { status, report } = await postReport(b.app, { note: f.note });
    expect(status).toBe(201);
    expect(report.state).toBe("received");
    expect(report.triage).toBeUndefined();
    expect((await postTriage(b.app, report.reportId)).status).toBe(503);
    b.deps.clients.oracle = working;
    const retried = await postTriage(b.app, report.reportId);
    expect(retried.status).toBe(200);
    expect(retried.triage).toMatchObject(f.expected);
    await b.close();
  });
});

describe("invariants", () => {
  it("every hostile note is guarded and none comes back clean", async () => {
    const b = await boot();
    for (const f of fixturesOf("hostile")) {
      const { report } = await postReport(b.app, { note: f.note });
      expect(report.triage?.guarded, f.name).toBe(true);
      expect(report.triage?.action, f.name).not.toBe("clean");
    }
    await b.close();
  });

  it("gets at least 9 in 10 ordinary notes exactly right", async () => {
    const b = await boot();
    const fixtures = fixturesOf("triage");
    let right = 0;
    for (const f of fixtures) {
      const { report } = await postReport(b.app, { note: f.note });
      const t = report.triage;
      if (t && t.category === f.expected.category && t.severity === f.expected.severity && t.action === f.expected.action) right++;
    }
    expect(right / fixtures.length).toBeGreaterThanOrEqual(0.9);
    await b.close();
  });
});