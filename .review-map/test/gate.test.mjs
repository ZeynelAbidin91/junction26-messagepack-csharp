// Checks the gate between the reviewing agent and the comment, against recorded runs of PR 2 (2234).
// Run: node --test test/   (needs out/local-2234 from a local evidence run; see README)

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoffs } from '../adapters/messagepack/handoffs.mjs';
import { sdkSatisfies } from '../lib/checks.mjs';
import { verifyAnalysis } from '../lib/verify.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ev = `${root}out/local-2234/evidence`;
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const have = existsSync(`${ev}/probe-after.json`);

test('the gate keeps resolvable items and moves every planted mistake out', { skip: !have && 'no local evidence for 2234' }, () => {
  const a = json(`${root}test/fixtures/agent-output-2234.json`).value;
  const tests = json(`${ev}/tests.json`);
  const readCode = () => Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
  const { unverified, downgraded } = verifyAnalysis(a, {
    before: json(`${ev}/probe-before.json`),
    after: json(`${ev}/probe-after.json`),
    results: tests.results,
    handoffs: handoffs({ code: (s) => '`' + s + '`' }),
    readCode,
    blob: 'https://example.invalid/blob/x',
  });

  const moved = unverified.map((u) => u.text).join('\n');
  for (const planted of ['no evidence at all', 'wrong direction', 'never ran', 'all tests pass', 'private required', 'malformed pointer']) assert.match(moved, new RegExp(planted), planted);
  assert.equal(unverified.length, 6);
  assert.match(unverified.find((u) => /malformed/.test(u.text)).reasons[0], /malformed pointer/);
  assert.ok(!JSON.stringify([a.summary, a.attention, a.units, a.claims]).includes('PLANTED'), 'no planted item left in the main sections');

  const wrongWay = unverified.find((u) => /wrong direction/.test(u.text));
  assert.match(wrongWay.reasons[0], /identical before and after/);
  assert.match(wrongWay.quotes[0], /0 files/, 'shows what the run actually recorded');

  const kept = a.attention[0].refs[0].resolved;
  assert.equal(kept.ok, true);
  assert.match(kept.quote, /before `0 files` → after `2 files`/);
  assert.equal(kept.anchor, 'trace-generated-dup-string-keys-fields');

  assert.equal(a.claims.find((c) => /colliding/.test(c.claim)).verdict, 'code-only');
  assert.equal(downgraded.length, 1);
  assert.equal(a.claims.find((c) => /main symptom/.test(c.claim)).verdict, 'not-verified', 'an honest not-verified without refs stays');
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
