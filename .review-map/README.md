# review-map

An AI reviewer for AI-written pull requests, built so a human can trust what it says.

It runs the change instead of only reading it. A reviewing agent (Claude) reads the diff and the issue and picks real inputs; those inputs and the repository's own tests run on the code before and after the change; the agent then explains the evidence. The result is one pull request comment.

## The rule: the agent points, the script quotes

The agent never writes evidence values. Every summary sentence, "Start here" item, unit example and claim carries pointers (`refs`) to the evidence:

| Pointer | Resolved against | Quoted by the script |
|---|---|---|
| `run`: scenario, hand-off, side, expects | `probe-before.json`, `probe-after.json` | the hand-off's value before and after, linked to its trace row |
| `test`: name, expects | per-test outcomes of both sides | outcome before → after |
| `code`: path, lines | the reviewed commit | a link and the first line |

`lib/verify.mjs` resolves every pointer. When a pointer doesn't exist, or resolves to something other than its `expects` (for example, cited as a difference when the hand-off is identical), the item moves to **Not backed by the evidence**, together with what the runs actually show. A claim backed only by code reading is shown as "holds in the code, not run".

The script also computes these, with no agent involved (`lib/checks.mjs`, `lib/evidence.mjs`):

- **New tests that don't discriminate:** the PR's new tests run against the old code; any that pass there too are flagged.
- **Changed lines that ran:** code coverage on the after side, intersected with the diff ("18 of 18 changed lines reached; not reached: …").
- **Can the probe see a break?** A fixed, known-bad mutation from the adapter is applied to the after code. The method section reports which scenarios and hand-offs light up.
- **Reduced confidence:** an SDK that doesn't satisfy the `global.json` pin, a before side that had to revert the tests too, a side that didn't run, or a missing check. Shown at the top.
- **Fingerprints:** SHA-256 of each evidence file and a link to the workflow artifact, in the footer.

## Steps

| Step | Does | Holds |
|---|---|---|
| `plan` | Agent reads diff and issue, writes scenarios | API key; PR code not run |
| `evidence` | Runs scenarios and tests before and after, with coverage and the known-break run | Nothing secret; this is the only step that runs PR code |
| `analyze` | Agent explains the evidence with pointers; the gate resolves them; script builds the comment | API key; PR code not run |
| `post` | Creates or updates one comment | GitHub token |
| `replay` | Re-runs one scenario before and after and compares it with the recording | Nothing secret |

In GitHub Actions the first four are three jobs (`workflows/review-map.yml`). The reviewer is checked out from the base branch, so a pull request cannot change its own reviewer.

## Re-check a finding yourself

Every trace and finding in the comment prints a command like:

```bash
node .review-map/review.mjs replay --run <workflow run id> --scenario <id> --repo <checkout of the reviewed commit>
```

It downloads the run's recorded inputs and evidence (`gh run download`), prints their SHA-256 so you can compare them with the comment footer, re-runs that one input on the reviewed commit and on its source reverted, and says, for each hand-off, whether it matches the recording. Run `npm ci --prefix .review-map` once first.

## Adapters

Everything specific to one codebase lives in `adapters/<name>/`:

- a plain description of the pipeline for the agent;
- the probe that records each hand-off;
- how each hand-off is shown;
- the known-break mutation.

`adapters/messagepack` covers the MessagePack-CSharp source generator.

## Local run

```bash
npm ci
ANTHROPIC_API_KEY=... node review.mjs all --repo <checkout at PR head> --pr <n> --slug owner/repo --out out/pr-<n>
```

Add `--rollforward-sdk` when the pinned .NET SDK isn't installed locally. The comment will then show reduced confidence.

`analyze --agent-output <file>` reuses a recorded agent response instead of calling the API. `npm test` runs the gate against a fixture with planted mistakes; it needs `out/local-2234` from a local evidence run of PR 2.

A hand-written analysis (`analyses/2283.source.json`) goes through the same gate and checks:

```bash
node lib/verify.mjs analyses/2283.source.json --repo <checkout>
node render.mjs analyses/2283.json
```
