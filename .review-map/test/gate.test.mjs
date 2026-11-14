// Checks the gate and the rules between the reviewing agent and the comment, against recorded runs of
// PR 2 (2234). Run: npm test   (needs out/local-2234 from a local evidence run; see README)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoffs } from '../adapters/messagepack/handoffs.mjs';
import { ownerResolver, reproduction, sdkSatisfies } from '../lib/checks.mjs';
import { finishAnalysis, normalizeFixedLists } from '../lib/finish.mjs';
import { Analysis } from '../lib/schemas.mjs';
import { verifyAnalysis } from '../lib/verify.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ev = `${root}out/local-2234/evidence`;
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const have = existsSync(`${ev}/probe-after.json`);
const skip = !have && 'no local evidence for 2234';
const H = handoffs({ code: (s) => '`' + s + '`' });
const readCode = () => Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
const recorded = () => ({ before: json(`${ev}/probe-before.json`), after: json(`${ev}/probe-after.json`), tests: json(`${ev}/tests.json`) });
const fixture = () => Analysis.parse(json(`${root}test/fixtures/agent-output-2234.json`).value);

test('the gate keeps resolvable items and moves every planted mistake out', { skip }, () => {
  const a = fixture();
  const { before, after, tests } = recorded();
  const { unverified, downgraded } = verifyAnalysis(a, { before, after, results: tests.results, handoffs: H, readCode, blob: 'https://example.invalid/blob/x' });

  const moved = unverified.map((u) => u.text).join('\n');
  for (const planted of ['no evidence at all', 'wrong direction', 'never ran', 'all tests pass', 'private required', 'malformed pointer']) assert.match(moved, new RegExp(planted), planted);
  assert.equal(unverified.length, 6);
  assert.match(unverified.find((u) => /malformed/.test(u.text)).reasons[0], /malformed pointer/);
  assert.ok(!JSON.stringify([a.summary, a.found, a.decisions, a.units, a.claims]).includes('PLANTED'), 'no planted item left in the main sections');

  const wrongWay = unverified.find((u) => /wrong direction/.test(u.text));
  assert.match(wrongWay.reasons[0], /identical before and after/);
  assert.match(wrongWay.quotes[0], /0 files/, 'shows what the run actually recorded');

  const kept = a.found[0].refs[0].resolved;
  assert.equal(kept.ok, true);
  assert.match(kept.quote, /before `0 files` → after `2 files`/);
  assert.equal(kept.anchor, 'trace-generated-dup-string-keys-fields');

  // Severity rule: a finding backed only by code reading cannot be a warning.
  assert.equal(a.found.find((f) => /Code-only warning/.test(f.statement)).severity, 'NOTE');
  // Requirement verdicts without a run or test become "not shown"; they stay in the table.
  assert.equal(a.requirements.find((r) => r.id === 'R1').verdict, 'met');
  assert.equal(a.requirements.find((r) => r.id === 'R2').verdict, 'not-shown');

  assert.equal(a.claims.find((c) => /colliding/.test(c.claim)).verdict, 'code-only');
  assert.equal(a.claims.find((c) => /main symptom/.test(c.claim)).verdict, 'not-verified', 'an honest not-verified without refs stays');
  assert.equal(downgraded.length, 3, downgraded.join('\n'));
});

test('the issue is only "fixed" when its symptom was seen on the before side', { skip }, () => {
  const { before, after, tests } = recorded();
  const scenarios = json(`${root}out/local-2234/scenarios.json`).map((s) => ({
    ...s,
    covers: s.id === 'suppressed-dup-int-keys' ? ['R1'] : s.id === 'generated-dup-string-keys-fields' ? ['R2'] : [],
    reproducesIssue: s.id === 'suppressed-dup-int-keys',
  }));
  const requirements = [
    { id: 'R1', statement: 'A suppressed type with duplicate keys no longer breaks the analyzer.', primary: true },
    { id: 'R2', statement: 'Duplicate keys are reported as MsgPack005.', primary: false },
    { id: 'R3', statement: 'Suppressed types never reach the generator.', primary: false },
  ];
  const planWith = (contains) => ({ requirements, scenarios, symptom: { handoff: 'model', contains, why: 'test' } });

  // The recorded before side of the repro throws ArgumentException, so this prediction is confirmed ...
  assert.equal(reproduction({ plan: planWith(['ArgumentException']), before, handoffs: H }).status, 'reproduced');
  // ... and a prediction of a different symptom is not.
  const plan = planWith(['IndexOutOfRangeException']);
  assert.equal(reproduction({ plan, before, handoffs: H }).status, 'unreproduced');

  const a = fixture();
  a.requirements = [
    { id: 'R1', verdict: 'met', note: 'claimed fixed', refs: ['run:suppressed-dup-int-keys:model:both:differs'] },
    { id: 'R2', verdict: 'met', note: 'reported', refs: ['run:generated-dup-string-keys-fields:diagnostics:both:differs'] },
    { id: 'R3', verdict: 'met', note: 'claimed, but nothing covers it', refs: ['run:suppressed-dup-int-keys:generated:both:same'] },
  ];
  const fin = finishAnalysis(a, {
    plan,
    issueRef: 'MessagePack-CSharp#2234',
    pr: { reviewers: [], assignees: [] },
    tests,
    before,
    after,
    mutant: [],
    extraSides: {},
    handoffs: H,
    readCode,
    blob: 'https://example.invalid/blob/x',
    ownersSetting: 'trade-off=alice,default=bob',
    otherTestProjects: [{ path: 'tests/Other/Other.csproj', name: 'Other', touched: false }],
  });

  // The script opens the "does it fix the issue" decision itself, first, and the agent cannot drop it.
  const rule = fin.verified.decisions[0];
  assert.equal(rule.computed, true);
  assert.equal(rule.reason, 'unreproduced');
  assert.match(rule.question, /MessagePack-CSharp#2234/);
  assert.equal(rule.owner.login, 'bob');
  assert.equal(fin.verified.decisions.find((d) => d.reason === 'trade-off').owner.login, 'alice');

  // The primary requirement cannot be "met"; an uncovered one becomes "not shown" and a not-checked item.
  const row = (id) => fin.requirements.find((r) => r.id === id);
  assert.equal(row('R1').verdict, 'not-shown');
  assert.match(row('R1').rule, /never reproduced/);
  assert.equal(row('R2').verdict, 'met');
  assert.equal(row('R3').verdict, 'not-shown');
  assert.match(row('R3').rule, /no scenario covers it/);
  assert.ok(fin.notChecked.some((n) => n.computed && /^R3:/.test(n.item)));
  assert.ok(fin.notChecked.some((n) => n.computed && /other test projects/.test(n.item)));

  // Script findings come first and are marked computed.
  assert.equal(fin.verified.found[0].computed, true);
  assert.match(fin.verified.found[0].statement, /4 of 8 new tests also pass on the old code/);
});

test('fixed lists are enforced by the script, not the grammar', () => {
  const v = {
    nodes: [{ id: 'A', label: 'A', sub: '', status: 'Changed' }],
    edges: [{ from: 'A', to: 'B', label: '', changed: false }],
    units: [{ name: 'u', status: 'weird', where: '' }],
    found: [{ statement: 's', severity: 'urgent', refs: [] }],
    decisions: [{ question: 'Is it wanted?', reason: 'Intent' }, { question: 'Made-up reason?', reason: 'vibes' }],
    requirements: [{ id: 'R1', verdict: 'done' }],
    claims: [{ claim: 'c', verdict: 'true' }],
  };
  const { notes, unverified } = normalizeFixedLists(v);
  assert.equal(v.nodes[0].status, 'changed');
  assert.equal(v.units[0].status, 'same');
  assert.equal(v.units[0].where, null);
  assert.equal(v.edges[0].label, null);
  assert.equal(v.found[0].severity, 'NOTE');
  assert.equal(v.requirements[0].verdict, 'not-shown');
  assert.equal(v.claims[0].verdict, 'not-verified');
  assert.deepEqual(v.decisions.map((d) => d.reason), ['intent']);
  assert.match(unverified[0].reasons[0], /not on the fixed list/);
  assert.equal(notes.length, 4, 'a case difference ("Changed") is accepted without a note');
});

test('decision owners come only from people a human named', () => {
  assert.deepEqual(ownerResolver({ setting: 'alice, @bob', pr: {} })('intent'), { login: 'alice', source: 'REVIEW_MAP_OWNERS' });
  assert.equal(ownerResolver({ setting: '', pr: { reviewers: ['carol'], assignees: [] } })('intent').login, 'carol');
  assert.deepEqual(ownerResolver({ setting: undefined, pr: { reviewers: [], assignees: [] } })('intent'), { login: null, source: 'unassigned' });
});

test('SDK pin check follows global.json rollForward rules', () => {
  const pin = { version: '8.0.402', rollForward: 'patch' };
  assert.equal(sdkSatisfies('8.0.402', pin), true);
  assert.equal(sdkSatisfies('8.0.415', pin), true);
  assert.equal(sdkSatisfies('8.0.500', pin), false);
  assert.equal(sdkSatisfies('9.0.301', pin), false);
  assert.equal(sdkSatisfies('9.0.301', { ...pin, rollForward: 'latestMajor' }), true);
  assert.equal(sdkSatisfies('8.0.401', pin), false);
});
