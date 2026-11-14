// Everything that happens after the reviewing agent (or a human) has written an analysis, the same for
// both: the gate resolves its evidence pointers, and the script adds what it decides by rule. Used by
// `review.mjs analyze` and by `lib/verify.mjs` for hand-written analyses.

import {
  computedFound,
  computedNotChecked,
  confidence,
  ownerResolver,
  reproduction,
  requirementTable,
  ruleDecisions,
  sensitivity,
} from './checks.mjs';
import { verifyAnalysis } from './verify.mjs';

/**
 * @param a          the agent's (or a human's) analysis, in the Analysis shape
 * @param plan       { requirements, symptom, scenarios } as chosen before anything ran
 * @returns the verified parts to put into analysis.json
 */
export function finishAnalysis(a, { plan, issueRef, pr, tests, before, after, mutant, extraSides, handoffs, readCode, blob, ownersSetting, otherTestProjects }) {
  const v = structuredClone(a);
  const repro = reproduction({ plan, before, handoffs });

  // Rule-made items go in before the gate, marked computed, so the agent can neither word nor drop them.
  v.found = [...computedFound({ tests }), ...(v.found ?? [])];
  v.decisions = [...ruleDecisions({ repro, issueRef }), ...(v.decisions ?? [])];

  const { results } = tests;
  const { unverified, downgraded } = verifyAnalysis(v, { before, after, results, handoffs, readCode, blob, extraSides });

  const table = requirementTable({ plan, verdicts: v.requirements ?? [], before, after, handoffs, repro });
  downgraded.push(...table.downgraded);

  const ran = after.filter((s) => !s.probeError).map((s) => s.id);
  const failedScenarios = (plan.scenarios ?? []).filter((s) => !ran.includes(s.id)).map((s) => s.id);
  const notChecked = [...computedNotChecked({ tests, blob, requirements: table.rows, failedScenarios, otherTestProjects }), ...(v.notChecked ?? [])];

  const owner = ownerResolver({ setting: ownersSetting, pr });
  for (const d of v.decisions) d.owner = owner(d.reason);

  // Every scenario a kept item cites gets a trace, so each quote can link to its full table.
  const cited = new Set(
    [...v.summary, ...v.found, ...v.decisions, ...table.rows, ...v.claims, ...v.units.flatMap((u) => u.examples)]
      .flatMap((x) => x.refs ?? [])
      .filter((r) => r.kind === 'run' && r.resolved?.ok)
      .map((r) => r.scenario),
  );
  // The agent gives traces as a list; a hand-written analysis as { evidence, adapter, cases }.
  const traceList = Array.isArray(v.traces) ? v.traces : (v.traces?.cases ?? []);
  const traceCases = traceList.filter((t) => (plan.scenarios ?? []).some((s) => s.id === t.id) || before.some((s) => s.id === t.id));
  for (const id of cited) {
    if (traceCases.some((t) => t.id === id)) continue;
    const s = (plan.scenarios ?? []).find((x) => x.id === id);
    if (s) traceCases.push({ id, title: s.title, story: s.why, where: [] });
  }

  const sens = sensitivity({ tests, after, mutant, handoffs });
  return {
    verified: v,
    unverified,
    downgraded,
    repro,
    requirements: table.rows,
    notChecked,
    traceCases,
    failedScenarios,
    sensitivity: sens,
    confidence: confidence({ tests, failedScenarios, sensitivity: sens }),
  };
}
