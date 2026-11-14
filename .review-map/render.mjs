#!/usr/bin/env node
// Turns a review-map analysis (JSON) into a GitHub pull request comment (Markdown).
// CLI:    node render.mjs <analysis.json> > comment.md
// Module: import { render } from './render.mjs'
//
// Everything in the output is plain GitHub-flavoured Markdown: a Mermaid diagram for the pipeline map,
// <details> blocks for traces and unit cards, and alert blocks for what needs a human.
// Values in the trace tables are copied from the probe result files by this script, and the cause and
// effect tags are computed here, so the reviewing agent cannot word them.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = '<!-- review-map:v1 -->';

const EVIDENCE = {
  observed: '✅ observed in a run',
  static: '🔎 read in the code',
  stated: '⚠️ stated by the author, not checked',
  none: '⚠️ no evidence',
};
const VERDICT = {
  verified: '✅ Holds',
  partly: '🟡 Partly holds',
  'not-verified': '⚠️ Not verified',
  contradicted: '❌ Does not hold',
  'code-only': '🔎 Holds in the code, not run',
};
const STATUS = {
  changed: 'changed by this PR',
  affected: 'code untouched, behaviour changes',
  same: 'unchanged',
};
const SEVERITY = { CAUTION: '🛑', WARNING: '⚠️', IMPORTANT: '❗', NOTE: 'ℹ️' };
const SEVERITY_ORDER = ['CAUTION', 'WARNING', 'IMPORTANT', 'NOTE'];
const REASON = { intent: '`intent`', 'trade-off': '`trade-off`', unreproduced: '`unreproduced`', 'out-of-reach': '`out-of-reach`' };
const REQ_VERDICT = { met: '✅ met', partly: '🟡 partly', 'not-met': '❌ not met', 'not-shown': '⚠️ not shown' };
const REPRO = {
  reproduced: 'So the bug was reproduced. A "fixed" verdict also needs the symptom gone after the PR.',
  unreproduced: 'So the bug was **not** reproduced, and the script will not let the review say the PR fixes it.',
  'no-repro': 'So the script will not let the review say the PR fixes it.',
  'not-run': 'So the script will not let the review say the PR fixes it.',
  'bad-symptom': 'The prediction could not be checked, so the script will not let the review say the PR fixes it.',
};
// Only people a human named (REVIEW_MAP_OWNERS, or the PR's reviewers and assignees) get an @-mention.
const ownerText = (o) => (o?.login ? `@${o.login}${o.source === 'PR reviewers' ? ' <sub>(from the PR reviewers)</sub>' : ''}` : 'unassigned <sub>(set the repository variable `REVIEW_MAP_OWNERS`)</sub>');
const TAG = { cause: '🟧 **cause**', effect: '🟦 effect', same: 'same' };

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const mm = (s) => String(s).replace(/"/g, '#quot;');
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A resolved evidence pointer, as quoted by the script, with a link to the trace it comes from.
// GitHub prefixes every name attribute in a comment with "user-content-"; linking to the prefixed name
// lets the browser jump there by itself, without relying on GitHub's script to map the short form.
const quote = (r) => `${r.resolved?.quote ?? ''}${r.resolved?.anchor ? ` [↗](#user-content-${r.resolved.anchor})` : ''}`;
const quotes = (refs) => (refs ?? []).filter((r) => r.resolved?.ok).map(quote);

export async function render(a, { analysisDir = '.' } = {}) {
  const out = [];
  const p = (...lines) => out.push(...lines);
  const replayFor = (id) => (a.integrity?.replay ? a.integrity.replay.replace('{id}', id) : null);

  p(MARKER);
  p(`## Review map · \`${a.pr.branch}\``);
  p('');

  // ---- the top: what it found, what it refused to decide, what it did not check ---------------
  const shorts = (refs) => (refs ?? []).filter((r) => r.resolved?.ok).map((r) => r.resolved.short ?? r.resolved.quote);
  const found = [...(a.found ?? [])].sort((x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity));
  const decisions = a.decisions ?? [];
  const notChecked = a.notChecked ?? [];

  p(`### What it found (${found.length})`);
  p('');
  if (!found.length) p('_Nothing the evidence backs._');
  found.forEach((f, i) => {
    const ev = shorts(f.refs);
    const tag = f.computed ? ' <sub>🤖 computed by the script</sub>' : ev.length ? ` <sub>${ev.join(' · ')}</sub>` : '';
    p(`${i + 1}. ${SEVERITY[f.severity]} ${f.statement}${tag}`);
  });
  p('');
  const withQuotes = found.map((f, i) => ({ i, qs: quotes(f.refs) })).filter((x) => x.qs.length);
  if (withQuotes.length) {
    p('<details>');
    p('<summary>What the runs show for each finding, copied by a script</summary>');
    p('');
    for (const { i, qs } of withQuotes) {
      p(`${i + 1}. ${found[i].statement}`);
      for (const q of qs) p(`   - ${q}`);
    }
    p('');
    p('</details>');
    p('');
  }

  p(`### What it refused to decide (${decisions.length})`);
  p('');
  if (!decisions.length) p('_Nothing: every question in this review is answered by the evidence._');
  decisions.forEach((d, i) => {
    p(`${i + 1}. **${d.question}** ${REASON[d.reason] ?? code(d.reason)}${d.computed ? ' <sub>🤖 opened by rule</sub>' : ''}`);
    p(`   - **Why:** ${d.detail}`);
    const qs = quotes(d.refs);
    if (qs.length) p(`     <br><sub>${qs.join(' · ')}</sub>`);
    p(`   - **Would settle it:** ${d.wouldSettleIt}`);
    if (d.options?.length) p(`   - **Options:** ${d.options.map((o, k) => `(${String.fromCharCode(97 + k)}) ${o}`).join(' · ')}`);
    p(`   - **Owner:** ${ownerText(d.owner)}`);
  });
  if (decisions.length) {
    p('');
    p('<sub>Reasons are from a fixed list. `intent`: the requirement does not say. `trade-off`: a policy call with no technically right answer. `unreproduced`: the reported symptom never appeared on the code before the change. `out-of-reach`: the tools here cannot exercise it.</sub>');
  }
  p('');

  p(`### What it did not check (${notChecked.length})`);
  p('');
  if (!notChecked.length) p('_Nothing listed._');
  notChecked.forEach((n, i) => {
    p(`${i + 1}. **${n.item}**: ${n.reason}.${n.computed ? ' <sub>🤖 computed by the script</sub>' : ''}`);
    p(`   - **Risk if wrong:** ${n.riskIfWrong}. **How to check:** ${n.howToCheck}.`);
  });
  p('');

  // ---- confidence: computed by the script ---------------------------------------------------
  if (a.confidence?.length) {
    p('> [!CAUTION]');
    p('> **Reduced confidence in this run.** Read the lists above with these in mind:');
    for (const c of a.confidence) p(`> - ${c}`);
    p('');
  }

  // ---- summary ------------------------------------------------------------------------------
  p('### In short');
  p('');
  if (typeof a.summary === 'string') p(a.summary);
  else if (a.summary?.length) {
    p(a.summary.map((s) => s.sentence).join(' '));
    p('');
    p('<details>');
    p('<summary>Evidence behind these sentences, copied from the runs by a script</summary>');
    p('');
    for (const s of a.summary) {
      p(`- ${s.sentence}`);
      for (const q of quotes(s.refs)) p(`  - ${q}`);
    }
    p('');
    p('</details>');
  } else p('_No summary sentence could be backed by the recorded evidence; see "Not backed by the evidence" below._');
  p('');

  const changed = a.nodes.filter((n) => n.status === 'changed').length;
  const affected = a.nodes.filter((n) => n.status === 'affected').length;
  const verdicts = a.claims.reduce((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});
  const open = (verdicts['not-verified'] ?? 0) + (verdicts.contradicted ?? 0) + (verdicts.partly ?? 0);
  p(
    [
      `**${count(changed, 'unit', 'units')} changed**`,
      `**${count(affected, 'unit', 'units')} behave differently downstream**`,
      `**${a.claims.length} author claims checked:** ${verdicts.verified ?? 0} hold${verdicts['code-only'] ? `, ${verdicts['code-only']} hold in the code only` : ''}, ${open} need you`,
      a.unverified ? `**${count(a.unverified.length, 'reviewer statement', 'reviewer statements')} not backed by the evidence**` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  p('');

  // ---- the issue, requirement by requirement ---------------------------------------------------
  if (a.requirements?.length) {
    p(`### The ${a.pr.issueRef ? `issue (${code(a.pr.issueRef)})` : 'request'}, requirement by requirement`);
    p('');
    const r = a.reproduction;
    if (r && r.status !== 'no-symptom') {
      const predicted = r.symptom?.contains?.length ? `${r.symptom.contains.map(code).join(' or ')} at ${r.node ?? code(r.symptom.handoff)}` : 'nothing';
      const afterText = (x) => (!x.seen ? '' : x.seenAfter === false ? `, gone after (${code(x.afterValue)})` : x.seenAfter ? `, **still there after** (${code(x.afterValue)})` : ', not run after');
      const seen = (r.rows ?? []).map((x) => `${code(x.id)}: ${!x.ran ? 'did not run' : x.seen ? `**seen** before (${code(x.value)})${afterText(x)}` : `not seen (${code(x.value)})`}`).join('; ');
      p(`**Reproducing the reported bug.** ${a.plannedBeforeRuns ? 'Before anything ran, the plan predicted' : 'The reviewer stated'} the bug would show as ${predicted} on the code before the PR. ${seen ? `Recorded: ${seen}.` : 'No scenario reproduces the issue.'} ${REPRO[r.status] ?? ''}`);
      p('');
    }
    p('| | Requirement | Covered by (hand-offs that differ before → after) | Verdict |');
    p('|---|---|---|---|');
    for (const q of a.requirements) {
      const cov = q.covers.length
        ? q.covers.map((c) => `[${code(c.id)}](#user-content-trace-${c.id}): ${!c.ran ? 'did not run' : c.differs.length ? c.differs.join(' ') : 'no difference'}`).join('<br>')
        : '_no scenario_';
      const ev = shorts(q.refs);
      const verdict = `${REQ_VERDICT[q.verdict]}<br><sub>${cell(q.note)}${ev.length ? `<br>${ev.join(' · ')}` : ''}${q.rule ? `<br>by rule: ${q.rule}` : ''}</sub>`;
      p(`| ${q.id}${q.primary ? ' ★' : ''} | ${cell(q.statement)} | ${cov} | ${verdict} |`);
    }
    p('');
    p(`<sub>★ the requirement that says the reported bug is gone. ${a.plannedBeforeRuns ? 'Requirements and the expected symptom were written in the plan step, before anything ran.' : 'Requirements and the expected symptom were written by hand after the runs, so they are not a prediction.'}</sub>`);
    p('');
  }

  // ---- pipeline map -----------------------------------------------------------------------
  p('### The change as a pipeline');
  p('');
  p('```mermaid');
  p('flowchart LR');
  for (const n of a.nodes) p(`  ${n.id}["<b>${mm(n.label)}</b><br/>${mm(n.sub)}"]:::${n.status}`);
  for (const e of a.edges) p(`  ${e.from} ${e.changed ? '-.->' : '-->'}${e.label ? `|"${mm(e.label)}"|` : ''} ${e.to}`);
  p('  classDef changed fill:#FAEEDA,stroke:#BA7517,stroke-width:2px,color:#412402');
  p('  classDef affected fill:#E1F5EE,stroke:#0F6E56,color:#04342C');
  p('  classDef same fill:#F1EFE8,stroke:#888780,color:#2C2C2A');
  p('```');
  p('');
  p('🟧 changed by this PR · 🟩 code untouched, behaviour changes · ⬜ unchanged · dashed arrow = the data on that hand-off is different after this PR');
  p('');

  // ---- traces: one real input followed through every hand-off -----------------------------
  if (a.traces?.cases?.length) {
    const dir = resolve(analysisDir, a.traces.evidence);
    const load = (when) => {
      const f = resolve(dir, `probe-${when}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    };
    const before = load('before');
    const after = load('after');
    const adapterUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'adapters', a.traces.adapter ?? 'messagepack', 'handoffs.mjs'));
    const { handoffs } = await import(adapterUrl.href);
    const HANDOFFS = handoffs({ code });

    p('### Follow one real input through the pipeline');
    p('');
    p('Each case below is a real input, run on the code before and after this PR. Its diagram follows the input through the pipeline: every box shows what crossed that hand-off before and after the change. 🟧 marks where a difference starts (nothing upstream of it differs), 🟦 marks what follows from it, dashed arrows lead into boxes that differ. The values are copied from the runs and the tags are computed by a script; the full values are in the table under each diagram.');
    p('');
    a.traces.cases.forEach((c, i) => {
      const b = before.find((s) => s.id === c.id);
      const f = after.find((s) => s.id === c.id);
      const shown = f ?? b;
      if (!shown) return;
      p(`<a name="trace-${c.id}"></a>`);
      p('');
      p(`<details${i === 0 ? ' open' : ''}>`);
      p(`<summary><b>${c.title}</b></summary>`);
      p('');
      // Cause and effect follow the pipeline graph: a hand-off that differs is a cause when nothing
      // upstream of it differs, and an effect when something upstream does. Parallel branches can
      // therefore each have their own cause.
      const rows = HANDOFFS.map((h) => ({ h, x: h.cell(b), y: h.cell(f) }));
      const differs = Object.fromEntries(rows.map((r) => [r.h.id, r.x.key !== r.y.key]));
      const parentsOf = Object.fromEntries(HANDOFFS.map((h) => [h.id, h.parents ?? []]));
      const upstreamDiffers = (id) => (parentsOf[id] ?? []).some((pid) => differs[pid] || upstreamDiffers(pid));
      const tagOf = (r) => c.tags?.[r.h.id] ?? (!differs[r.h.id] ? 'same' : upstreamDiffers(r.h.id) ? 'effect' : 'cause');

      // The trace as a diagram: the real input enters on the left, each node shows what crossed that
      // hand-off before and after the change.
      const mt = (s) => {
        const t = String(s ?? '');
        return (t.length > 70 ? t.slice(0, 68) + '…' : t).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
      };
      const NODE_TAG = { cause: '🟧 cause', effect: '🟦 effect', same: 'same' };
      p('```mermaid');
      p('flowchart LR');
      const input = shown.runtime?.valuesIn;
      p(`  n_input["<b>Input</b><br/>${mt(input ? `object: ${input}` : c.title)}"]:::input`);
      for (const r of rows) {
        const tag = tagOf(r);
        const bx = r.h.brief(b);
        const by = r.h.brief(f);
        const body = differs[r.h.id] ? `before: ${mt(bx)}<br/>after: ${mt(by)}` : mt(by);
        p(`  n_${r.h.id}["<b>${mt(r.h.node ?? r.h.label)}</b><br/>${NODE_TAG[tag]}<br/>${body}"]:::${tag}`);
      }
      for (const r of rows) for (const pid of r.h.parents ?? []) p(`  n_${pid} ${differs[r.h.id] ? '-.->' : '-->'} n_${r.h.id}`);
      p('  classDef input fill:#EEEDFE,stroke:#534AB7,color:#26215C');
      p('  classDef cause fill:#FAEEDA,stroke:#BA7517,stroke-width:2px,color:#412402');
      p('  classDef effect fill:#E6F1FB,stroke:#185FA5,color:#0C447C');
      p('  classDef same fill:#F1EFE8,stroke:#888780,color:#5F5E5A');
      p('```');
      p('');
      p('<details>');
      p('<summary>The input as C#</summary>');
      p('');
      p('```csharp');
      const cut = (src) => src.split('\n[MessagePack.GeneratedMessagePackResolver]')[0].trim();
      if (shown.referencedSource) p('// ---- referenced assembly, compiled separately', cut(shown.referencedSource), '');
      p('// ---- your project', cut(shown.projectSource));
      p('```');
      p('');
      p('</details>');
      p('');
      p('<details>');
      p('<summary>Full values at each hand-off</summary>');
      p('');
      p('| Hand-off | Before this PR | After this PR |');
      p('|---|---|---|');
      for (const r of rows) {
        const where = c.where?.[r.h.id] ? `<br><sub>${c.where[r.h.id]}</sub>` : '';
        p(`| ${r.h.label}<br>${TAG[tagOf(r)]}${where} | ${cell(r.x.show)} | ${cell(r.y.show)} |`);
      }
      p('');
      if (replayFor(c.id)) {
        p(`Scenario \`${c.id}\`. Re-run it yourself and compare with this table:`);
        p('');
        p('```bash');
        p(replayFor(c.id));
        p('```');
        p('');
      }
      p('</details>');
      p('');
      p(c.story);
      p('');
      p('</details>');
      p('');
    });
  }

  // ---- tests ------------------------------------------------------------------------------
  if (a.tests) {
    const t = a.tests;
    p('### Tests, before and after');
    p('');
    const side = (s) => (s?.built ? `${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''}` : `did not build${s?.reason ? ` (${s.reason})` : ''}`);
    p(`| | Before this PR | After this PR |`);
    p('|---|---|---|');
    p(`| ${code(t.project)} | ${side(t.before)}${t.before?.mode ? `<br><sub>${t.before.mode}</sub>` : ''} | ${side(t.after)} |`);
    p('');
    if (t.changes?.length) {
      p('<details>');
      p(`<summary>${count(t.changes.length, 'test changed outcome', 'tests changed outcome')}</summary>`);
      p('');
      p('| Test | Before | After |');
      p('|---|---|---|');
      for (const ch of t.changes.slice(0, 60)) p(`| ${code(ch.name)} | ${ch.before ?? 'did not exist'} | ${ch.after ?? 'did not exist'} |`);
      if (t.changes.length > 60) p(`| … ${t.changes.length - 60} more | | |`);
      p('');
      p('</details>');
      p('');
    }
    if (t.newTests?.length) {
      const VERDICT_T = {
        discriminates: '✅ fails before, passes after: shows the change works',
        'passes-both': '⚠️ passes on the old code too: does not show the change works',
        'fails-after': '❌ fails on this PR',
        'not-run-before': '❔ could not run on the old code (the tests were reverted)',
        'missing-before': '❔ did not run on the old code',
      };
      const weak = t.newTests.filter((x) => x.verdict !== 'discriminates').length;
      p(`<details${weak ? ' open' : ''}>`);
      p(`<summary>${count(t.newTests.length, 'new test', 'new tests')} in this PR, run against the old code: ${t.newTests.length - weak} show the change works</summary>`);
      p('');
      p('| New test | Before | After | What it shows |');
      p('|---|---|---|---|');
      for (const x of t.newTests.slice(0, 60)) p(`| ${code(x.name.split('.').slice(-2).join('.'))} | ${x.before ?? 'did not exist'} | ${x.after} | ${VERDICT_T[x.verdict]} |`);
      p('');
      p('</details>');
      p('');
    }
    if (t.coverage?.measured) {
      const c = t.coverage;
      p(`**Changed lines that ran:** ${c.reached} of ${c.executable} executable changed lines were reached (${c.byProbe} by a scenario, ${c.byTests} by a test)${c.removedLines ? `; ${c.removedLines} removed lines are checked only by the before side` : ''}. Measured with code coverage on the after side.`);
      p('');
    }
  }

  // ---- unit cards -------------------------------------------------------------------------
  p('### Units, input to output');
  p('');
  a.units.forEach((u, i) => {
    p(`<details${i === 0 ? ' open' : ''}>`);
    p(`<summary><b>${u.name}</b> — ${STATUS[u.status]}</summary>`);
    p('');
    p('| | |');
    p('|---|---|');
    if (u.where) p(`| Where | ${cell(u.where)} |`);
    p(`| Receives | ${cell(u.receives)} |`);
    p(`| Emits | ${cell(u.emits)} |`);
    p(`| What changed | ${cell(u.change)} |`);
    p('');
    if (u.examples?.length) {
      if (u.examples[0].refs) {
        p('| What it shows | Evidence, copied from the runs by the script |');
        p('|---|---|');
        for (const x of u.examples) p(`| ${cell(x.note)} | ${cell(quotes(x.refs).join('\n'))} |`);
      } else {
        p('| Input | Before | After | Evidence |');
        p('|---|---|---|---|');
        for (const x of u.examples) p(`| ${cell(x.input)} | ${cell(x.before)} | ${cell(x.after)} | ${EVIDENCE[x.evidence]}${x.ref ? `<br>${cell(x.ref)}` : ''} |`);
      }
      p('');
    }
    p('</details>');
    p('');
  });

  // ---- claims -----------------------------------------------------------------------------
  p("### The author's claims, checked");
  p('');
  p('| Claim | Made in | Verdict | Why |');
  p('|---|---|---|---|');
  for (const c of a.claims) {
    const qs = quotes(c.refs);
    p(`| ${cell(c.claim)} | ${cell(c.source)} | ${VERDICT[c.verdict]} | ${cell(c.evidence)}${qs.length ? `<br><sub>${cell(qs.join('\n'))}</sub>` : ''} |`);
  }
  p('');

  // ---- items the gate removed ---------------------------------------------------------------
  if (a.unverified?.length) {
    p('### Not backed by the evidence');
    p('');
    p("The reviewing agent wrote these, but the evidence it pointed to does not exist or does not show what it said, so they were moved out of the sections above. Treat them as unchecked opinions.");
    p('');
    for (const u of a.unverified) {
      p(`- **${u.section}:** ${u.text.replace(/\n+/g, ' ')}`);
      p(`  <br><sub>Why it was moved: ${u.reasons.join('; ')}${u.quotes?.length ? `. What the runs actually show: ${u.quotes.join('; ')}` : ''}</sub>`);
    }
    p('');
  }

  // ---- method -----------------------------------------------------------------------------
  p('<details>');
  p('<summary>How this was checked</summary>');
  p('');
  p('**Run for real**');
  for (const m of a.method.observed) p(`- ${m}`);
  const s = a.sensitivity;
  if (s?.ran) {
    const blind = (s.rows ?? []).filter((r) => !r.handoffs.length).map((r) => code(r.id));
    p(
      `- Can the probe see a break? With a known break applied to the after code (${s.description}), the probe showed a difference in ${s.detected} of ${s.scenarios} scenarios${s.where?.length ? `, at ${s.where.join(', ')}` : ''}. ` +
        (!s.detected
          ? 'So "no difference" in this review is weak evidence.'
          : blind.length
            ? `It did not show in ${blind.join(', ')}, so for those inputs "no difference" says less.`
            : 'So a "no difference" in any scenario here would have shown a break of this kind.'),
    );
  }
  p('');
  p('What was not covered is listed at the top, under "What it did not check".');
  if (a.method.downgraded?.length) {
    p('');
    p('**Reviewer verdicts the script downgraded**');
    for (const m of a.method.downgraded) p(`- ${m}`);
  }
  p('');
  p('</details>');
  p('');
  p(`<sub>Review map for \`${a.pr.head}\` against \`${a.pr.base}\`. ${a.pr.generatedBy ?? 'Generated by a reviewing agent that did not write this change.'}</sub>`);
  if (a.integrity?.files?.length) {
    p('');
    p(`<sub>Evidence${a.integrity.artifact ? ` ([download](${a.integrity.artifact}), kept 90 days)` : ''}, SHA-256: ${a.integrity.files.map((f) => `${f.name} \`${f.sha256.slice(0, 16)}\``).join(' · ')}</sub>`);
  }

  let md = out.join('\n') + '\n';
  // Never hyperlink upstream issues: a link from a public comment adds an entry to their timeline.
  for (const repo of a.pr.noLinkRepos ?? []) {
    const r = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    md = md.replace(new RegExp(`\\[([^\\]]*)\\]\\(https://github\\.com/${r}/(?:issues|pull)/(\\d+)[^)]*\\)`, 'g'), '$1 (`' + repo.split('/')[0] + '#$2`)');
    md = md.replace(new RegExp(`https://github\\.com/${r}/(?:issues|pull)/(\\d+)\\S*`, 'g'), '`' + repo.split('/')[0] + '#$1`');
  }
  return md;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const a = JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(await render(a, { analysisDir: dirname(resolve(file)) }));
}
