// Judgements the script makes on its own from the recorded evidence, with no reviewing agent involved:
// how far the run can be trusted (confidence), whether the probe notices a known break (sensitivity),
// what the human should look at regardless of what the agent says (computed attention items), and
// fingerprints of the evidence files (integrity).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

/** Does the SDK that ran satisfy the global.json pin and its rollForward policy? */
export function sdkSatisfies(actual, pin) {
  if (!pin?.version || !actual) return true;
  const [aM, am, ap] = actual.split(/[.-]/).map(Number);
  const [pM, pm, pp] = pin.version.split(/[.-]/).map(Number);
  const band = (n) => Math.floor(n / 100);
  const atLeast = aM > pM || (aM === pM && (am > pm || (am === pm && ap >= pp)));
  switch (pin.rollForward ?? 'patch') {
    case 'disable':
      return actual === pin.version;
    case 'patch':
    case 'latestPatch':
      return aM === pM && am === pm && band(ap) === band(pp) && ap >= pp;
    case 'feature':
    case 'latestFeature':
      return aM === pM && am === pm && ap >= pp;
    case 'minor':
    case 'latestMinor':
      return aM === pM && atLeast;
    default:
      return atLeast;
  }
}

/** Reasons to trust this run less, shown at the top of the comment. Empty when the run is clean. */
export function confidence({ tests, failedScenarios, sensitivity }) {
  const out = [];
  const pin = tests.pinnedSdk;
  if (pin?.version && !sdkSatisfies(tests.sdk, pin)) {
    out.push(`Built with .NET SDK ${tests.sdk}, but the repo pins ${pin.version} (rollForward ${pin.rollForward ?? 'patch'})${tests.rollForwardSdk ? '; the pin was overridden for this run' : ''}. Compiler and analyzer behaviour can differ between SDKs.`);
  }
  if (tests.before?.modeId === 'tests-reverted') {
    out.push("The PR's tests do not compile against the old code, so the before side ran the old tests. Test outcomes before and after are not the same tests, and the new tests' value cannot be judged.");
  }
  for (const side of ['before', 'after']) if (tests.probe?.[side] !== 'ok') out.push(`The probe did not run on the ${side} side (${tests.probe?.[side] ?? 'not recorded'}), so the traces have no ${side} values.`);
  for (const side of ['before', 'after']) if (tests[side] && !tests[side].built) out.push(`The tests did not run on the ${side} side (${tests[side].reason}).`);
  if (failedScenarios.length) out.push(`${failedScenarios.length} chosen input(s) could not run: ${failedScenarios.map(code).join(', ')}.`);
  if (!tests.coverage?.measured) out.push(`Which changed lines ran is unknown: ${tests.coverage?.reason ?? 'coverage was not recorded'}.`);
  if (!sensitivity?.ran) out.push(`The probe's ability to see a break was not checked: ${sensitivity?.reason ?? 'no mutation run'}.`);
  else if (!sensitivity.detected) out.push(`With a known break (${sensitivity.description}) the probe showed no difference in any scenario, so "no difference" in this review means little.`);
  return out;
}

/** Runs the adapter's fixed mutation result against the after side: which scenarios and hand-offs light up. */
export function sensitivity({ tests, after, mutant, handoffs }) {
  const m = tests.mutation;
  if (!m?.applied) return { ran: false, reason: m?.reason ?? 'no mutation recorded' };
  if (m.probe !== 'ok' || !mutant.length) return { ran: false, description: m.description, reason: `the probe did not run on the mutated code (${m.probe})` };
  const rows = [];
  for (const f of after) {
    const x = mutant.find((s) => s.id === f.id);
    if (!x || f.probeError || x.probeError) continue;
    rows.push({ id: f.id, handoffs: handoffs.filter((h) => h.cell(f).key !== h.cell(x).key).map((h) => h.node) });
  }
  const hit = rows.filter((r) => r.handoffs.length);
  const where = [...new Set(hit.flatMap((r) => r.handoffs))];
  return { ran: true, description: m.description, file: m.file, scenarios: rows.length, detected: hit.length, where, rows };
}

/** Items for "Start here" that the script derives itself; the reviewing agent cannot remove or word them. */
export function computedAttention({ tests, blob }) {
  const items = [];
  const weak = (tests.newTests ?? []).filter((t) => t.verdict === 'passes-both');
  const total = (tests.newTests ?? []).length;
  if (weak.length) {
    items.push({
      level: 'WARNING',
      title: `${weak.length} of ${total} new tests pass on the old code too`,
      detail: `These tests pass with the PR's source changes reverted, so they do not show that the change works: ${weak.map((t) => code(t.name.split('(')[0].split('.').pop())).join(', ')}.`,
    });
  }
  const broken = (tests.newTests ?? []).filter((t) => t.verdict === 'fails-after');
  if (broken.length) items.push({ level: 'CAUTION', title: `${broken.length} new tests fail on this PR`, detail: broken.map((t) => code(t.name)).join(', ') });
  const c = tests.coverage;
  if (c?.measured) {
    const gaps = c.files.flatMap((f) =>
      f.inReport ? f.unreached.map(([a, b]) => `[${f.path.split('/').pop()} ${a === b ? a : `${a}–${b}`}](${blob}/${f.path}#L${a}${b > a ? `-L${b}` : ''})`) : [`${code(f.path)} (not in the coverage report)`],
    );
    if (gaps.length) items.push({ level: 'IMPORTANT', title: `${c.executable - c.reached} of ${c.executable} changed lines never ran`, detail: `No scenario and no test reached: ${gaps.join(', ')}. Nothing in this review shows what those lines do.` });
  }
  return items;
}

export function fingerprints(files) {
  return files.filter((f) => existsSync(f)).map((f) => ({ name: basename(f), sha256: createHash('sha256').update(readFileSync(f)).digest('hex') }));
}
