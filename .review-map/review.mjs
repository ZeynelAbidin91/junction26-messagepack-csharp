#!/usr/bin/env node
// review-map: an AI reviewer for AI-written pull requests, built so a human can trust what it says.
//
//   node review.mjs plan     --repo <checkout> --pr <n> [--slug owner/repo] --out <dir>
//   node review.mjs evidence --repo <checkout> --out <dir> [--rollforward-sdk]
//   node review.mjs analyze  --repo <checkout> --out <dir>
//   node review.mjs post     --out <dir>
//   node review.mjs all      (the four steps in order, for local runs)
//
// plan      The reviewing agent reads the diff and the issue and chooses real inputs to run.      (needs API key)
// evidence  Runs those inputs and the repo's tests on the code before and after the change.         (runs PR code, no secrets)
// analyze   The reviewing agent explains the change from that evidence; a script fills the tables. (needs API key)
// post      Creates or updates one comment on the pull request.                                     (needs GitHub token)
//
// The steps are separate so the GitHub Action can run them in separate jobs: the code under review never
// runs on a machine that holds the API key.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ask } from './lib/claude.mjs';
import { budgetedDiff, linkedIssue, mergeBaseOf, pullRequest } from './lib/context.mjs';
import { collectEvidence } from './lib/evidence.mjs';
import { Analysis, Plan } from './lib/schemas.mjs';
import { MARKER, render } from './render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: '.' },
    pr: { type: 'string' },
    slug: { type: 'string', default: process.env.GITHUB_REPOSITORY },
    out: { type: 'string', default: 'review-map-out' },
    adapter: { type: 'string', default: 'messagepack' },
    'rollforward-sdk': { type: 'boolean', default: false },
  },
});
const step = positionals[0];
const repo = resolve(opt.repo);
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });
const adapter = (await import(new URL(`./adapters/${opt.adapter}/adapter.mjs`, import.meta.url))).default;

const readJson = (f) => JSON.parse(readFileSync(resolve(out, f), 'utf8'));
const writeJson = (f, v) => writeFileSync(resolve(out, f), JSON.stringify(v, null, 2));
const log = (...m) => console.error('[review-map]', ...m);

const ROLE = `You are the reviewing agent in review-map. A different AI agent wrote the pull request you are given, and a human has to decide whether to approve it. You did not write this change, and you do not take its description, comments, docs or tests on trust: they are claims to check.

The human's problem is understanding. They need to see what each unit of the change receives and emits, how the units form a pipeline, and which change causes which effect, shown with real data rather than prose. Everything you produce is checked against real runs by a script, and statements without evidence are labelled as such.`;

function contextBlock(ctx, diff) {
  return [
    `<pipeline>\n${adapter.pipeline}\n</pipeline>`,
    `<pull_request>\nTitle: ${ctx.pr.title}\nBranch: ${ctx.pr.headRef}\n\n${ctx.pr.body}\n</pull_request>`,
    ctx.commitMessage ? `<commit_message>\n${ctx.commitMessage}\n</commit_message>` : '',
    ctx.issue ? `<issue ref="${ctx.issue.ref}">\nTitle: ${ctx.issue.title}\n\n${ctx.issue.body}\n</issue>` : '<issue>No linked issue was found.</issue>',
    `<diff base="${ctx.mergeBase.slice(0, 8)}" head="${ctx.head.slice(0, 8)}">\n${diff}\n</diff>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- plan -----------------------------------------------------------------------------------
async function plan() {
  if (!opt.pr || !opt.slug) throw new Error('plan needs --pr and --slug (or GITHUB_REPOSITORY)');
  const pr = pullRequest(opt.slug, opt.pr);
  const head = pr.headSha;
  const mergeBase = mergeBaseOf(repo, pr.baseSha, head);
  const commitMessage = spawnSync('git', ['log', '--format=%B', `${mergeBase}..${head}`], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const ctx = { slug: opt.slug, pr, head, mergeBase, commitMessage, issue: linkedIssue(pr, adapter), adapter: adapter.name };
  writeJson('context.json', ctx);
  const diff = budgetedDiff(repo, mergeBase, head, adapter);

  const system = `${ROLE}

In this step you choose the inputs. The probe described in <pipeline> will run each one through the real pipeline twice, on the code before and after the change, and record what crosses every hand-off. Choose 3 to 6 scenarios that, together, let a human see the cause and effect of this change:
- the issue's own reproduction, when it gives one;
- inputs that reach each new or changed branch in the diff, especially edge cases the author's tests do not cover;
- an input that tests a behaviour the author claims (in the PR, docs, comments or test names);
- one control input that the change should not affect at all.
Pick inputs that would expose a problem if there is one; a scenario that only confirms the happy path is worth little. Each scenario must compile on its own: follow the scenario format exactly. In "why", say in one sentence what the scenario will show.`;

  const user = `${contextBlock(ctx, diff)}

<example_scenarios note="Scenarios written for a different PR, to show the format. Do not reuse them unless they fit this change.">
${JSON.stringify(adapter.exampleScenarios, null, 2)}
</example_scenarios>

Choose the scenarios for this pull request.`;

  const { value, model } = await ask({ system, user, schema: Plan, label: 'plan' });
  writeJson('plan.json', { ...value, model });
  writeJson('scenarios.json', value.scenarios);
  log(`plan: ${value.scenarios.length} scenarios: ${value.scenarios.map((s) => s.id).join(', ')}`);
}

// ---- evidence -------------------------------------------------------------------------------
function evidence() {
  const ctx = readJson('context.json');
  const summary = collectEvidence({
    repo,
    adapter,
    mergeBase: ctx.mergeBase,
    head: ctx.head,
    scenariosFile: resolve(out, 'scenarios.json'),
    outDir: resolve(out, 'evidence'),
    rollForwardSdk: opt['rollforward-sdk'],
  });
  summary.sdk = spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).stdout.trim();
  summary.runner = process.env.RUNNER_OS ? `GitHub Actions ${process.env.RUNNER_OS}` : process.platform;
  writeJson('evidence/tests.json', summary);
  log(`evidence: probe after=${summary.probe.after} before=${summary.probe.before}; tests after=${summary.after.passed ?? '-'}/${summary.after.total ?? '-'} before=${summary.before.passed ?? '-'}/${summary.before.total ?? '-'}; ${summary.changes.length} changed outcome`);
}

// ---- analyze --------------------------------------------------------------------------------
async function analyze() {
  const ctx = readJson('context.json');
  const plan = readJson('plan.json');
  const tests = readJson('evidence/tests.json');
  const load = (f) => {
    try {
      return readJson(`evidence/${f}`);
    } catch {
      return [];
    }
  };
  const before = load('probe-before.json');
  const after = load('probe-after.json');
  const { digest } = await import(new URL(`./adapters/${adapter.name}/handoffs.mjs`, import.meta.url));
  const probeDigest = plan.scenarios.map((s) => {
    const b = before.find((x) => x.id === s.id);
    const f = after.find((x) => x.id === s.id);
    const sameFiles = b?.generated && f?.generated ? f.generated.map((g) => ({ file: g.hintName, identical: b.generated.some((h) => h.hintName === g.hintName && h.text === g.text) })) : null;
    const changedText = f?.generated?.filter((g) => !b?.generated?.some((h) => h.hintName === g.hintName && h.text === g.text)).map((g) => ({ file: g.hintName, after: g.text.slice(0, 3000) }));
    return { id: s.id, title: s.title, why: s.why, before: digest(b), after: digest(f), generatedFileComparison: sameFiles, generatedTextAfterWhereDifferent: changedText };
  });
  const diff = budgetedDiff(repo, ctx.mergeBase, ctx.head, adapter);
  const blob = `https://github.com/${ctx.slug}/blob/${ctx.head}`;

  const system = `${ROLE}

In this step you explain the change from evidence. You get the diff, the probe results for the scenarios you chose earlier (recorded on the code before and after the change), and the repo's test results on both sides. Produce the review map:

- summary: two or three plain sentences: what the change does, whether it does what the issue asked, and the most important thing the human must know.
- nodes and edges: the pipeline from <pipeline>, only the stages this change touches or affects plus their neighbours (4 to 8 nodes). status "changed" if the PR edits that stage's code, "affected" if its code is untouched but its behaviour differs in the evidence, "same" otherwise. Short ids (letters only). Label the edges that match recorded hand-offs with ① model, ② diagnostics, ③ C# files, ④ bytes; mark an edge changed when the evidence shows different data crossing it.
- attention: what needs the human, most important first. Each item says the input, what happened before, what happens after, and the decision the human has to make. End with one TIP listing what the human can stop worrying about, with evidence. Do not pad: if nothing needs a decision, say so in one item.
- traces: one entry per scenario worth showing, most important first, using the scenario ids. story: one to three sentences of cause and effect, naming the hand-off numbers. where: for the hand-off where the cause lies, point to the code (a Markdown link like [TypeCollector.cs line 239](${blob}/src/...#L239)); use handoff ids from <pipeline>.
- units: the functions or stages that changed and the ones whose behaviour changed, each with what it receives and emits, what changed, and examples (input, before, after). Evidence: "observed" only when the example appears in the probe or test results, and then ref must name the scenario id or the test; "static" when you read it in the code; "stated" when only the author says so; "none" when nothing supports it.
- claims: statements the author made (PR text, commit message, docs, code comments, test names and test comments), each with a verdict and the evidence for it. Include claims that hold.
- limits: what this review did not check.

Write for a busy engineer: short sentences, concrete values, no jargon without a gloss, no praise. Code links go to ${blob}. Never link to issues in ${adapter.issueRepo}; write them as \`${adapter.issueRepo.split('/')[0]}#123\`.`;

  const user = `${contextBlock(ctx, diff)}

<probe_results note="Recorded by running the real pipeline. 'before' is the code with the PR's source files reverted.">
${JSON.stringify(probeDigest, null, 1)}
</probe_results>

<test_results>
${JSON.stringify(tests, null, 1)}
</test_results>

Write the review map.`;

  const { value: a, model, usage } = await ask({ system, user, schema: Analysis, label: 'analyze' });

  // The script, not the agent, decides what counts as observed: an "observed" example must cite a
  // scenario that ran or a test that ran. Anything else is downgraded and listed in the comment.
  const scenarioIds = after.concat(before).filter((s) => !s.probeError).map((s) => s.id);
  const testNames = Object.values(tests.changes ?? []).map((c) => c.name.split('(')[0].split('.').pop());
  const downgraded = [];
  for (const u of a.units) {
    for (const x of u.examples) {
      if (x.evidence !== 'observed') continue;
      const ref = x.ref ?? '';
      const cited = scenarioIds.some((id) => ref.includes(id)) || testNames.some((t) => t && ref.includes(t)) || /\b\d+ (tests|passed)\b/.test(ref);
      if (!cited) {
        x.evidence = 'static';
        downgraded.push(`"${x.input}" on ${u.name}: marked observed, but cites no scenario or test that ran`);
      }
    }
  }

  const ran = after.filter((s) => !s.probeError).map((s) => s.id);
  const failed = plan.scenarios.filter((s) => !ran.includes(s.id)).map((s) => s.id);
  const side = (t) => (t.built ? `${t.passed} passed, ${t.failed} failed` : `did not build (${t.reason})`);
  const analysis = {
    pr: {
      branch: ctx.pr.headRef,
      head: ctx.head.slice(0, 8),
      base: ctx.mergeBase.slice(0, 8),
      noLinkRepos: [adapter.issueRepo],
      generatedBy: `Generated automatically by review-map with \`${model}\`, which did not write this change${process.env.GITHUB_RUN_ID ? ` · [workflow run](${process.env.GITHUB_SERVER_URL}/${ctx.slug}/actions/runs/${process.env.GITHUB_RUN_ID})` : ''}.`,
    },
    summary: a.summary,
    nodes: a.nodes,
    edges: a.edges,
    attention: a.attention,
    traces: {
      evidence: 'evidence',
      adapter: adapter.name,
      cases: a.traces
        .filter((t) => plan.scenarios.some((s) => s.id === t.id))
        .map((t) => ({ id: t.id, title: t.title, story: t.story, where: Object.fromEntries(t.where.map((w) => [w.handoff, w.text])) })),
    },
    tests,
    units: a.units,
    claims: a.claims,
    method: {
      observed: [
        `${plan.scenarios.length} scenarios chosen by the reviewing agent from the diff and the issue, each run through the real generator, analyzer and run-time serializer on both sides${failed.length ? `; ${failed.length} could not run: ${failed.map((f) => `\`${f}\``).join(', ')}` : ''}.`,
        `\`${tests.project}\` on both sides. After: ${side(tests.after)}. Before (${tests.before.mode}): ${side(tests.before)}. ${tests.changes.length} tests changed outcome.`,
        `Built with .NET SDK ${tests.sdk} on ${tests.runner}.`,
        `Reviewing agent: \`${model}\`, two calls (choose inputs, explain evidence). The trace tables and their cause and effect tags are computed by a script from the recorded runs.`,
      ],
      limits: [...a.limits, `Only \`${tests.project}\` was run; other test projects in the solution were not.`],
      downgraded,
    },
    usage,
  };
  writeJson('analysis.json', analysis);
  const md = await render(analysis, { analysisDir: out });
  writeFileSync(resolve(out, 'comment.md'), md);
  log(`analyze: comment.md written (${md.length} chars), ${downgraded.length} statements downgraded`);
}

// ---- post -----------------------------------------------------------------------------------
function post() {
  const ctx = readJson('context.json');
  const gh = (args, input) => spawnSync('gh', args, { encoding: 'utf8', input });
  const me = process.env.REVIEW_MAP_COMMENT_AUTHOR ?? (gh(['api', 'user', '--jq', '.login']).stdout.trim() || 'github-actions[bot]');
  const list = gh(['api', '--paginate', `repos/${ctx.slug}/issues/${ctx.pr.number}/comments`, '--jq', `.[] | select(.user.login == "${me}") | select(.body | startswith("${MARKER}")) | .id`]);
  const existing = list.stdout.trim().split('\n').filter(Boolean).pop();
  const body = JSON.stringify({ body: readFileSync(resolve(out, 'comment.md'), 'utf8') });
  const r = existing
    ? gh(['api', '-X', 'PATCH', `repos/${ctx.slug}/issues/comments/${existing}`, '--input', '-', '--jq', '.html_url'], body)
    : gh(['api', '-X', 'POST', `repos/${ctx.slug}/issues/${ctx.pr.number}/comments`, '--input', '-', '--jq', '.html_url'], body);
  if (r.status !== 0) throw new Error(`posting the comment failed: ${r.stderr}`);
  log(`${existing ? 'updated' : 'posted'}: ${r.stdout.trim()}`);
}

const steps = { plan, evidence, analyze, post };
if (step === 'all') {
  await plan();
  evidence();
  await analyze();
  post();
} else if (steps[step]) {
  await steps[step]();
} else {
  console.error('usage: node review.mjs <plan|evidence|analyze|post|all> [options]  (see the header of this file)');
  process.exit(2);
}
