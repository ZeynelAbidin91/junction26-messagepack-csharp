// Runs the code under review and records what it does: the probe scenarios and the repo's own tests,
// once on the change ("after") and once with the change's source files reverted ("before").
// This is the only step that executes code from the pull request; it is given no secrets.

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

function dotnetTest(repo, adapter, { filter, env = {}, trx, log }) {
  const args = ['test', adapter.testProject, '-v', 'q', '--filter', filter];
  if (trx) args.push('--logger', `trx;LogFileName=${trx.name}`, '--results-directory', trx.dir);
  const r = sh('dotnet', args, { cwd: repo, env: { ...process.env, ...env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  const buildFailed = /Build FAILED|error CS\d+|error MSB\d+/.test(r.stdout) && !/Passed!|Failed!/.test(r.stdout);
  return { status: r.status, buildFailed };
}

function runSide(repo, adapter, scenariosFile, outDir, label) {
  const probeOut = resolve(outDir, `probe-${label}.json`);
  rmSync(probeOut, { force: true });
  const probe = dotnetTest(repo, adapter, {
    filter: adapter.probeFilter,
    env: { REVIEW_MAP_SCENARIOS: resolve(scenariosFile), REVIEW_MAP_PROBE_OUT: probeOut },
    log: resolve(outDir, `probe-${label}.log`),
  });
  const trxDir = resolve(outDir, `trx-${label}`);
  rmSync(trxDir, { recursive: true, force: true });
  const tests = dotnetTest(repo, adapter, {
    filter: `${adapter.probeFilter.replace('~', '!~')}`,
    trx: { dir: trxDir, name: 'tests.trx' },
    log: resolve(outDir, `tests-${label}.log`),
  });
  const trx = existsSync(trxDir) ? readdirSync(trxDir).find((f) => f.endsWith('.trx')) : null;
  return {
    probe: existsSync(probeOut) ? 'ok' : probe.buildFailed ? 'build failed' : 'no output',
    tests: (trx && parseTrx(join(trxDir, trx))) || { built: false, reason: tests.buildFailed ? 'build failed' : `dotnet test exited ${tests.status}` },
  };
}

/**
 * Runs the probe and the tests on both sides and writes probe-after.json, probe-before.json and tests.json
 * into outDir. Leaves the repository exactly as it found it.
 */
export function collectEvidence({ repo, adapter, mergeBase, head, scenariosFile, outDir, rollForwardSdk = false }) {
  mkdirSync(outDir, { recursive: true });
  const files = changedFiles(repo, mergeBase, head);
  const src = files.filter((f) => adapter.isSource(f.path));
  const tests = files.filter((f) => adapter.isTest(f.path));
  const touched = new Set();

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
    if (rollForwardSdk) {
      const gj = join(repo, 'global.json');
      writeFileSync(gj, readFileSync(gj, 'utf8').replace('"rollForward": "patch"', '"rollForward": "latestMajor"'));
    }
    copyFileSync(adapter.probeSource, join(repo, adapter.probeTarget));

    const after = runSide(repo, adapter, scenariosFile, outDir, 'after');

    // Before: revert only the source files, so the PR's new tests run against the old code.
    // If that does not build (the tests use something the PR added), revert the tests as well.
    revert(src);
    let before = runSide(repo, adapter, scenariosFile, outDir, 'before');
    let mode = 'source files reverted, the PR\'s tests kept';
    if (before.probe === 'build failed' || !before.tests.built) {
      revert(tests);
      before = runSide(repo, adapter, scenariosFile, outDir, 'before');
      mode = 'source and test files reverted (the PR\'s tests do not compile against the old code)';
    }

    const names = new Set([...Object.keys(after.tests.results ?? {}), ...Object.keys(before.tests.results ?? {})]);
    const changes = [...names]
      .map((name) => ({ name, before: before.tests.results?.[name] ?? null, after: after.tests.results?.[name] ?? null }))
      .filter((c) => c.before !== c.after)
      .sort((x, y) => (x.after === 'Passed') - (y.after === 'Passed') || x.name.localeCompare(y.name));
    const strip = (t) => (t.built ? { built: true, total: t.total, passed: t.passed, failed: t.failed, skipped: t.skipped } : t);
    const summary = {
      project: adapter.testProject,
      after: strip(after.tests),
      before: { ...strip(before.tests), mode },
      changes,
      probe: { after: after.probe, before: before.probe },
      changedFiles: files,
    };
    writeFileSync(resolve(outDir, 'tests.json'), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    restore();
  }
}
