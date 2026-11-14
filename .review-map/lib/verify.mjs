// The gate between the reviewing agent and the comment. The agent cites evidence as pointers (a hand-off
// of a scenario that ran, a test, a range of code lines); this module resolves every pointer against the
// recorded files and quotes what it finds. Items whose pointers do not resolve, or resolve to something
// other than what the agent said they would show, are moved out of the main sections into "unverified".
//
// CLI (for hand-written analyses):
//   node lib/verify.mjs <analysis.json> --repo <checkout> [--head <sha>]   rewrites the file in place

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Outcome pattern of one test across the two sides. */
export function testPattern(before, after) {
  if (after !== 'Passed') return 'fails-after';
  if (before === 'Passed') return 'passes-both';
  if (before == null) return 'new-not-run-before';
  return 'fails-before-passes-after';
}

/**
 * Resolves every ref in the analysis. Mutates `a`: each ref gets `resolved: { ok, reason?, quote, anchor? }`,
 * failing items are removed from their section and returned in `unverified`, and claim verdicts that
 * only rest on reading the code become `code-only`.
 */
export function verifyAnalysis(a, { before, after, results, handoffs, readCode, blob, extraSides = {} }) {
  const H = Object.fromEntries(handoffs.map((h) => [h.id, h]));
  const find = (side, id) => side.find((s) => s.id === id);
  const usable = (s) => s && !s.probeError;
  const testNames = [...new Set([...Object.keys(results?.after ?? {}), ...Object.keys(results?.before ?? {})])];

  const resolveRef = (r) => {
    if (r.kind === 'run') {
      const h = H[r.handoff];
      const anchor = `trace-${r.scenario}`;
      if (!h) return { ok: false, reason: `no hand-off called ${code(r.handoff)}` };
      // An extra recorded side, such as a what-if build of the PR with one part removed.
      const extra = extraSides[r.side];
      if (extra) {
        const s = find(extra.runs, r.scenario);
        if (!usable(s)) return { ok: false, reason: `scenario ${code(r.scenario)} has no usable ${extra.label} recording` };
        return { ok: true, anchor, quote: `${code(r.scenario)} ${h.node}, ${extra.label}: ${code(short(h.brief(s)))}` };
      }
      if (!['before', 'after', 'both'].includes(r.side)) return { ok: false, reason: `no recorded side called ${code(r.side)}` };
      const b = find(before, r.scenario);
      const f = find(after, r.scenario);
      const need = r.side === 'both' ? [b, f] : [r.side === 'before' ? b : f];
      if (!b && !f) return { ok: false, reason: `scenario ${code(r.scenario)} did not run` };
      if (!need.every(usable)) return { ok: false, reason: `scenario ${code(r.scenario)} has no usable ${r.side === 'both' ? 'before and after' : r.side} recording` };
      const label = `${code(r.scenario)} ${h.node}`;
      if (r.side !== 'both') {
        const s = r.side === 'before' ? b : f;
        return { ok: true, anchor, quote: `${label}, ${r.side}: ${code(short(h.brief(s)))}` };
      }
      const differs = h.cell(b).key !== h.cell(f).key;
      const quote = differs ? `${label}: before ${code(short(h.brief(b)))} → after ${code(short(h.brief(f)))}` : `${label}: ${code(short(h.brief(f)))} on both sides`;
      if (r.expects === 'differs' && !differs) return { ok: false, anchor, quote, reason: `cited as a difference, but ${h.node} is identical before and after` };
      if (r.expects === 'same' && differs) return { ok: false, anchor, quote, reason: `cited as unchanged, but ${h.node} differs before and after` };
      return { ok: true, anchor, quote };
    }
    if (r.kind === 'test') {
      let matches = testNames.filter((n) => n === r.test);
      if (!matches.length) matches = testNames.filter((n) => n.endsWith('.' + r.test) || n.split('(')[0].endsWith('.' + r.test) || n.split('(')[0] === r.test);
      if (!matches.length) return { ok: false, reason: `no test called ${code(r.test)} ran` };
      const patterns = [...new Set(matches.map((n) => testPattern(results.before?.[n], results.after?.[n])))];
      const n = matches[0];
      const name = matches.length > 1 ? `${code(short(r.test, 70))} (${matches.length} cases)` : code(short(n.split('.').slice(-2).join('.'), 80));
      const quote = `test ${name}: before ${results.before?.[n] ?? 'did not exist'} → after ${results.after?.[n] ?? 'did not exist'}${patterns.length > 1 ? ' (cases differ)' : ''}`;
      if (r.expects !== 'any' && !(patterns.length === 1 && patterns[0] === r.expects)) {
        return { ok: false, quote, reason: `cited as ${r.expects}, but the recorded outcome is ${patterns.join(' / ')}` };
      }
      return { ok: true, quote };
    }
    if (r.kind === 'code') {
      const text = readCode?.(r.path);
      if (text == null) return { ok: false, reason: `${code(r.path)} does not exist in the reviewed commit` };
      const lines = text.split('\n');
      const start = Math.round(r.startLine);
      const end = Math.max(start, Math.round(r.endLine));
      if (start < 1 || end > lines.length) return { ok: false, reason: `${code(r.path)} has ${lines.length} lines, not ${start}–${end}` };
      const first = lines.slice(start - 1, end).find((l) => l.trim()) ?? '';
      const where = `${r.path.split('/').pop()} ${start === end ? `line ${start}` : `lines ${start}–${end}`}`;
      return { ok: true, quote: `${blob ? `[${where}](${blob}/${r.path}#L${start}${end > start ? `-L${end}` : ''})` : where}: ${code(short(first.trim(), 100))}` };
    }
    return { ok: false, reason: 'unknown evidence kind' };
  };

  const unverified = [];
  const check = (item, section, text, { allowEmpty = false } = {}) => {
    const refs = item.refs ?? [];
    for (const r of refs) r.resolved = resolveRef(r);
    const failing = refs.filter((r) => !r.resolved.ok);
    if ((!refs.length && !allowEmpty) || failing.length) {
      unverified.push({
        section,
        text,
        reasons: refs.length ? failing.map((r) => r.resolved.reason) : ['cites no evidence'],
        quotes: refs.filter((r) => r.resolved.quote).map((r) => r.resolved.quote),
      });
      return false;
    }
    return true;
  };

  a.summary = (a.summary ?? []).filter((s) => check(s, 'Summary', s.sentence));
  a.attention = (a.attention ?? []).filter((x) => check(x, 'Start here', `**${x.title}** ${x.detail}`));
  for (const u of a.units ?? []) u.examples = (u.examples ?? []).filter((x) => check(x, `Unit ${u.name}`, x.note));
  const downgraded = [];
  a.claims = (a.claims ?? []).filter((c) => {
    // An honest "not verified" without evidence stays in the claims table.
    const ok = check(c, 'Claims', `"${c.claim}" (${c.verdict})`, { allowEmpty: c.verdict === 'not-verified' });
    if (ok && c.verdict !== 'not-verified' && !c.refs.some((r) => r.kind !== 'code')) {
      downgraded.push(`"${short(c.claim, 120)}": marked ${c.verdict}, but its evidence is only code reading, so it is shown as "holds in the code, not run"`);
      c.verdict = 'code-only';
    }
    return ok;
  });
  return { unverified, downgraded };
}

// ---- CLI ---------------------------------------------------------------------------------------
// Finishes a hand-written analysis the same way `review.mjs analyze` finishes the agent's: resolves the
// refs, and adds the script's own confidence notes, computed items, sensitivity and fingerprints.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const file = resolve(process.argv[2]);
  const target = resolve(opt('out') ?? file.replace(/\.source\.json$/, '.json'));
  const src = JSON.parse(readFileSync(file, 'utf8'));
  const dir = resolve(dirname(file), src.traces.evidence);
  const load = (f) => (existsSync(resolve(dir, f)) ? JSON.parse(readFileSync(resolve(dir, f), 'utf8')) : []);
  const repo = resolve(opt('repo'));
  const readCode = (p) => {
    const r = spawnSync('git', ['show', `${src.pr.headFull}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const { handoffs } = await import(pathToFileURL(resolve(here, '..', 'adapters', src.traces.adapter, 'handoffs.mjs')).href);
  const { computedAttention, confidence, fingerprints, sensitivity } = await import(pathToFileURL(resolve(here, 'checks.mjs')).href);
  const H = handoffs({ code });
  const tests = load('tests.json');
  const before = load('probe-before.json');
  const after = load('probe-after.json');
  const extraSides = Object.fromEntries((src.traces.variants ?? []).map((v) => [v.side, { label: v.label, runs: load(v.file) }]));
  const a = structuredClone(src);
  const { unverified, downgraded } = verifyAnalysis(a, { before, after, results: tests.results, handoffs: H, readCode, blob: src.pr.blob, extraSides });
  const sens = sensitivity({ tests, after, mutant: load('probe-mutant.json'), handoffs: H });
  const failed = (load('scenarios.json') ?? []).map((s) => s.id).filter((id) => !after.some((s) => s.id === id && !s.probeError));
  const { results, ...testSummary } = tests;
  Object.assign(a, {
    confidence: confidence({ tests, failedScenarios: failed, sensitivity: sens }),
    computed: computedAttention({ tests, blob: src.pr.blob }),
    tests: testSummary,
    unverified,
    sensitivity: sens,
    integrity: {
      files: fingerprints(['scenarios.json', 'probe-before.json', 'probe-after.json', 'probe-mutant.json', 'tests.json', ...(src.traces.variants ?? []).map((v) => v.file)].map((f) => resolve(dir, f))),
      artifact: null,
      replay: src.replay ?? null,
    },
    method: { ...a.method, downgraded },
  });
  writeFileSync(target, JSON.stringify(a, null, 2));
  console.log(`${target}: ${unverified.length} unverified, ${downgraded.length} downgraded, ${a.confidence.length} confidence notes`);
}
