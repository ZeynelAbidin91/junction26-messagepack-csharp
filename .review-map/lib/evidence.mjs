// Runs the code under review and records what it does: the probe scenarios and the repo's own tests,
// once on the change ("after") and once with the change's source files reverted ("before").
// This is the only step that executes code from the pull request; it is given no secrets.
//
// Besides the two sides it records three things a script can judge without the reviewing agent:
//   - which of the PR's new tests pass on the old code too (they do not show the change works),
//   - which changed source lines actually ran on the after side (code coverage),
//   - whether the probe notices a known break (a fixed mutation of the after code, probe only).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, ...args) => {
  const r = sh('git', args, { cwd: repo });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

export function changedFiles(repo, mergeBase, head) {
  return git(repo, 'diff', '--name-status', '--no-renames', `${mergeBase}`, head)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, path] = l.split('\t');
      return { status, path };
    });
}

function parseTrx(file) {
  if (!existsSync(file)) return null;
  const xml = readFileSync(file, 'utf8');
  const results = {};
  for (const m of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const name = /testName="([^"]*)"/.exec(m[0])?.[1];
    const outcome = /outcome="([^"]*)"/.exec(m[0])?.[1];
    if (name) results[name.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')] = outcome;
  }
  const values = Object.values(results);
  return {
    built: true,
    total: values.length,
    passed: values.filter((v) => v === 'Passed').length,
    failed: values.filter((v) => v === 'Failed').length,
    skipped: values.filter((v) => v === 'NotExecuted').length,
    results,
  };
}

const findFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...findFiles(p, suffix));
    else if (e.name.endsWith(suffix)) found.push(p);
  }
  return found;
};

/** Line hits per source file from Cobertura XML files: Map(normalisedPath -> Map(line -> hits)). */
function parseCobertura(files) {
  const byFile = new Map();
  for (const f of files) {
    const xml = readFileSync(f, 'utf8');
    for (const cls of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
      const filename = /filename="([^"]*)"/.exec(cls[1])?.[1];
      if (!filename) continue;
      const key = filename.replace(/\\/g, '/');
      const lines = byFile.get(key) ?? new Map();
      for (const l of cls[2].matchAll(/<line\b([^>]*)\/?>/g)) {
        const n = Number(/number="(\d+)"/.exec(l[1])?.[1]);
        const hits = Number(/hits="(\d+)"/.exec(l[1])?.[1] ?? 0);
        if (n) lines.set(n, Math.max(lines.get(n) ?? 0, hits));
      }
      byFile.set(key, lines);
    }
  }
  return byFile;
}

function dotnetTest(repo, adapter, { filter, env = {}, resultsDir, trxName, coverage, log }) {
  const args = ['test', adapter.testProject, '-v', 'q', '--filter', filter];
  if (resultsDir) args.push('--results-directory', resultsDir);
  if (trxName) args.push('--logger', `trx;LogFileName=${trxName}`);
  if (coverage) args.push('--collect', 'Code Coverage;Format=cobertura');
  const r = sh('dotnet', args, { cwd: repo, env: { ...process.env, ...env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  const buildFailed = /Build FAILED|error CS\d+|error MSB\d+/.test(r.stdout) && !/Passed!|Failed!/.test(r.stdout);
  return { status: r.status, buildFailed };
}

function runProbe(repo, adapter, scenariosFile, outDir, label, { coverage = false } = {}) {
  const probeOut = resolve(outDir, `probe-${label}.json`);
  rmSync(probeOut, { force: true });
  const resultsDir = resolve(outDir, `cov-probe-${label}`);
  rmSync(resultsDir, { recursive: true, force: true });
  const r = dotnetTest(repo, adapter, {
    filter: adapter.probeFilter,
    env: { REVIEW_MAP_SCENARIOS: resolve(scenariosFile), REVIEW_MAP_PROBE_OUT: probeOut },
    resultsDir: coverage ? resultsDir : undefined,
    coverage,
    log: resolve(outDir, `probe-${label}.log`),
  });
  return {
    probe: existsSync(probeOut) ? 'ok' : r.buildFailed ? 'build failed' : 'no output',
    coverageFiles: coverage ? findFiles(resultsDir, '.cobertura.xml') : [],
  };
}

function runTests(repo, adapter, outDir, label, { coverage = false } = {}) {
  const trxDir = resolve(outDir, `trx-${label}`);
  rmSync(trxDir, { recursive: true, force: true });
  const r = dotnetTest(repo, adapter, {
    filter: `${adapter.probeFilter.replace('~', '!~')}`,
    resultsDir: trxDir,
    trxName: 'tests.trx',
    coverage,
    log: resolve(outDir, `tests-${label}.log`),
  });
  const trx = findFiles(trxDir, '.trx')[0];
  return {
    tests: (trx && parseTrx(trx)) || { built: false, reason: r.buildFailed ? 'build failed' : `dotnet test exited ${r.status}` },
    coverageFiles: coverage ? findFiles(trxDir, '.cobertura.xml') : [],
  };
}

/** Lines the PR added or changed in each source file (line numbers on the head side), and lines it removed. */
function changedLines(repo, mergeBase, head, paths) {
  const added = new Map();
  let removed = 0;
  if (!paths.length) return { added, removed };
  const diff = git(repo, 'diff', '-U0', '--no-renames', mergeBase, head, '--', ...paths);
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file) added.set(file, added.get(file) ?? []);
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      removed += h[1] === undefined ? 1 : Number(h[1]);
      const start = Number(h[2]);
      const n = h[3] === undefined ? 1 : Number(h[3]);
      for (let i = 0; i < n; i++) added.get(file).push(start + i);
    }
  }
  return { added, removed };
}

const ranges = (nums) => {
  const out = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
};

/** Changed source lines that the coverage tool counts as executable, and which of them ran. */
function changedLineCoverage({ repo, mergeBase, head, src, probeFiles, testFiles }) {
  const paths = src.filter((f) => f.status !== 'D' && f.path.endsWith('.cs')).map((f) => f.path);
  const { added, removed } = changedLines(repo, mergeBase, head, paths);
  if (!probeFiles.length && !testFiles.length) return { measured: false, reason: 'the coverage collector produced no report', removedLines: removed };
  const probe = parseCobertura(probeFiles);
  const tests = parseCobertura(testFiles);
  const lookup = (map, path) => {
    for (const [k, v] of map) if (k === path || k.endsWith('/' + path)) return v;
    return null;
  };
  const files = [];
  for (const [path, lines] of added) {
    const p = lookup(probe, path);
    const t = lookup(tests, path);
    if (!p && !t) {
      files.push({ path, inReport: false, changed: lines.length, executable: 0, byProbe: 0, byTests: 0, unreached: [] });
      continue;
    }
    const exec = lines.filter((n) => p?.has(n) || t?.has(n));
    const hit = (m, n) => (m?.get(n) ?? 0) > 0;
    const unreached = exec.filter((n) => !hit(p, n) && !hit(t, n));
    files.push({
      path,
      inReport: true,
      changed: lines.length,
      executable: exec.length,
      byProbe: exec.filter((n) => hit(p, n)).length,
      byTests: exec.filter((n) => hit(t, n)).length,
      reached: exec.length - unreached.length,
      unreached: ranges(unreached),
    });
  }
  const sum = (k) => files.reduce((s, f) => s + (f[k] ?? 0), 0);
  return {
    measured: true,
    executable: sum('executable'),
    reached: sum('reached'),
    byProbe: sum('byProbe'),
    byTests: sum('byTests'),
    removedLines: removed,
    files,
  };
}

/** Test methods the PR adds, read from the added lines of its test files. */
function newTestMethods(repo, mergeBase, head, tests) {
  const paths = tests.filter((f) => f.status !== 'D' && f.path.endsWith('.cs')).map((f) => f.path);
  if (!paths.length) return [];
  const diff = git(repo, 'diff', '-U0', '--no-renames', mergeBase, head, '--', ...paths);
  const names = new Set();
  let pendingAttr = false;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      pendingAttr = false;
      continue;
    }
    const t = line.slice(1).trim();
    if (/^\[(Fact|Theory|SkippableFact|CombinatorialData|InlineData|MemberData)\b/.test(t)) pendingAttr = pendingAttr || /^\[(Fact|Theory|SkippableFact)\b/.test(t);
    const m = /^(?:public|internal|private)?\s*(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\(/.exec(t);
    if (m && pendingAttr) {
      names.add(m[1]);
      pendingAttr = false;
    }
  }
  return [...names];
}

/** For each new test: does it show the change works (fails before, passes after)? */
function classifyNewTests(methods, before, after, beforeMode) {
  const methodOf = (name) => name.split('(')[0].split('.').pop();
  const rows = [];
  for (const [name, outcomeAfter] of Object.entries(after.results ?? {})) {
    if (!methods.includes(methodOf(name))) continue;
    const outcomeBefore = before.results?.[name] ?? null;
    let verdict;
    if (outcomeAfter !== 'Passed') verdict = 'fails-after';
    else if (outcomeBefore === null) verdict = beforeMode === 'tests-reverted' ? 'not-run-before' : 'missing-before';
    else if (outcomeBefore === 'Passed') verdict = 'passes-both';
    else verdict = 'discriminates';
    rows.push({ name, before: outcomeBefore, after: outcomeAfter, verdict });
  }
  return rows.sort((x, y) => x.verdict.localeCompare(y.verdict) || x.name.localeCompare(y.name));
}

/**
 * Runs the probe and the tests on both sides and writes probe-after.json, probe-before.json,
 * probe-mutant.json and tests.json into outDir. Leaves the repository exactly as it found it.
 * probeOnly skips the tests, coverage and the mutation (used by `review.mjs replay`).
 */
export function collectEvidence({ repo, adapter, mergeBase, head, scenariosFile, outDir, rollForwardSdk = false, probeOnly = false }) {
  mkdirSync(outDir, { recursive: true });
  const files = changedFiles(repo, mergeBase, head);
  const src = files.filter((f) => adapter.isSource(f.path));
  const tests = files.filter((f) => adapter.isTest(f.path));
  const touched = new Set();
  const gj = join(repo, 'global.json');
  const pinnedSdk = existsSync(gj) ? JSON.parse(readFileSync(gj, 'utf8')).sdk ?? null : null;

  const revert = (list) => {
    for (const f of list) {
      touched.add(f.path);
      if (f.status === 'A') rmSync(join(repo, f.path), { force: true });
      else git(repo, 'checkout', mergeBase, '--', f.path);
    }
  };
  const restore = () => {
    for (const p of touched) {
      const r = sh('git', ['checkout', head, '--', p], { cwd: repo });
      if (r.status !== 0) sh('git', ['rm', '-q', '--cached', '--ignore-unmatch', p], { cwd: repo });
    }
    sh('git', ['reset', '-q'], { cwd: repo });
    sh('git', ['checkout', head, '--', 'global.json'], { cwd: repo });
    rmSync(join(repo, adapter.probeTarget), { force: true });
  };

  try {
    if (rollForwardSdk) writeFileSync(gj, readFileSync(gj, 'utf8').replace('"rollForward": "patch"', '"rollForward": "latestMajor"'));
    // The SDK the builds below actually use: asked inside the repo, where its global.json applies.
    const sdk = sh('dotnet', ['--version'], { cwd: repo }).stdout.trim() || 'unknown';
    copyFileSync(adapter.probeSource, join(repo, adapter.probeTarget));

    if (probeOnly) {
      const after = runProbe(repo, adapter, scenariosFile, outDir, 'after');
      revert(src);
      let before = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      if (before.probe === 'build failed') {
        revert(tests);
        before = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      }
      return { probe: { after: after.probe, before: before.probe }, sdk };
    }

    // After, with code coverage on, so the changed lines that ran can be counted.
    const afterProbe = runProbe(repo, adapter, scenariosFile, outDir, 'after', { coverage: true });
    const afterTests = runTests(repo, adapter, outDir, 'after', { coverage: true });
    const coverage = changedLineCoverage({ repo, mergeBase, head, src, probeFiles: afterProbe.coverageFiles, testFiles: afterTests.coverageFiles });

    // A known break, to show the probe can see one: the adapter's fixed mutation of the after code.
    let mutation = { applied: false, reason: 'the adapter declares no mutation' };
    if (adapter.mutation) {
      const m = adapter.mutation;
      const file = join(repo, m.file);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!text.includes(m.find)) mutation = { applied: false, description: m.description, reason: `the line to mutate was not found in ${m.file}` };
      else {
        touched.add(m.file);
        writeFileSync(file, text.replace(m.find, m.replace));
        const run = runProbe(repo, adapter, scenariosFile, outDir, 'mutant');
        git(repo, 'checkout', head, '--', m.file);
        mutation = { applied: true, description: m.description, file: m.file, probe: run.probe };
      }
    }

    // Before: revert only the source files, so the PR's new tests run against the old code.
    // If that does not build (the tests use something the PR added), revert the tests as well.
    revert(src);
    let beforeProbe = runProbe(repo, adapter, scenariosFile, outDir, 'before');
    let beforeTests = runTests(repo, adapter, outDir, 'before');
    let mode = 'source files reverted, the PR\'s tests kept';
    let modeId = 'tests-kept';
    if (beforeProbe.probe === 'build failed' || !beforeTests.tests.built) {
      revert(tests);
      beforeProbe = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      beforeTests = runTests(repo, adapter, outDir, 'before');
      mode = 'source and test files reverted (the PR\'s tests do not compile against the old code)';
      modeId = 'tests-reverted';
    }
    const after = afterTests.tests;
    const before = beforeTests.tests;

    const names = new Set([...Object.keys(after.results ?? {}), ...Object.keys(before.results ?? {})]);
    const changes = [...names]
      .map((name) => ({ name, before: before.results?.[name] ?? null, after: after.results?.[name] ?? null }))
      .filter((c) => c.before !== c.after)
      .sort((x, y) => (x.after === 'Passed') - (y.after === 'Passed') || x.name.localeCompare(y.name));
    const strip = (t) => (t.built ? { built: true, total: t.total, passed: t.passed, failed: t.failed, skipped: t.skipped } : t);
    const summary = {
      project: adapter.testProject,
      after: strip(after),
      before: { ...strip(before), mode, modeId },
      changes,
      newTests: classifyNewTests(newTestMethods(repo, mergeBase, head, tests), before, after, modeId),
      modifiedTestFiles: tests.filter((f) => f.status === 'M').map((f) => f.path),
      probe: { after: afterProbe.probe, before: beforeProbe.probe },
      coverage,
      mutation,
      sdk,
      pinnedSdk,
      rollForwardSdk,
      changedFiles: files,
      results: { before: before.results ?? {}, after: after.results ?? {} },
    };
    writeFileSync(resolve(outDir, 'tests.json'), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    restore();
  }
}
