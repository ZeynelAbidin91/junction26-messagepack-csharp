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
};
const STATUS = {
  changed: 'changed by this PR',
  affected: 'code untouched, behaviour changes',
  same: 'unchanged',
};
const TAG = { cause: '🟧 **cause**', effect: '🟦 effect', same: 'same' };

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const mm = (s) => String(s).replace(/"/g, '#quot;');
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function render(a, { analysisDir = '.' } = {}) {
  const out = [];
  const p = (...lines) => out.push(...lines);

  p(MARKER);
  p(`## Review map · \`${a.pr.branch}\``);
  p('');
  p(a.summary);
  p('');

  const changed = a.nodes.filter((n) => n.status === 'changed').length;
  const affected = a.nodes.filter((n) => n.status === 'affected').length;
  const verdicts = a.claims.reduce((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});
  const open = (verdicts['not-verified'] ?? 0) + (verdicts.contradicted ?? 0) + (verdicts.partly ?? 0);
  p(
    [
      `**${count(changed, 'unit', 'units')} changed**`,
      `**${count(affected, 'unit', 'units')} behave differently downstream**`,
      `**${a.claims.length} author claims checked:** ${verdicts.verified ?? 0} hold, ${open} need you`,
    ].join(' · '),
  );
  p('');

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

  // ---- what needs a human -----------------------------------------------------------------
  if (a.attention?.length) {
    p('### Start here');
    p('');
    for (const item of a.attention) {
      p(`> [!${item.level ?? 'WARNING'}]`);
      p(`> **${item.title}**`);
      p('>');
      for (const line of item.detail.split('\n')) p(`> ${line}`);
      p('');
    }
  }

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
      p('| Input | Before | After | Evidence |');
      p('|---|---|---|---|');
      for (const x of u.examples) {
        p(`| ${cell(x.input)} | ${cell(x.before)} | ${cell(x.after)} | ${EVIDENCE[x.evidence]}${x.ref ? `<br>${cell(x.ref)}` : ''} |`);
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
  for (const c of a.claims) p(`| ${cell(c.claim)} | ${cell(c.source)} | ${VERDICT[c.verdict]} | ${cell(c.evidence)} |`);
  p('');

  // ---- method -----------------------------------------------------------------------------
  p('<details>');
  p('<summary>How this was checked, and what was not</summary>');
  p('');
  p('**Run for real**');
  for (const m of a.method.observed) p(`- ${m}`);
  p('');
  p('**Not covered**');
  for (const m of a.method.limits) p(`- ${m}`);
  if (a.method.downgraded?.length) {
    p('');
    p('**Reviewer statements the script downgraded**');
    for (const m of a.method.downgraded) p(`- ${m}`);
  }
  p('');
  p('</details>');
  p('');
  p(`<sub>Review map for \`${a.pr.head}\` against \`${a.pr.base}\`. ${a.pr.generatedBy ?? 'Generated by a reviewing agent that did not write this change.'}</sub>`);

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
