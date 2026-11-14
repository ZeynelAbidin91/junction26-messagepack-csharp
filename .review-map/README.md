# review-map

An AI reviewer for AI-written pull requests, built so a human can trust what it says.

It runs the change instead of only reading it. A reviewing agent (Claude) reads the diff and the issue and picks real inputs; those inputs and the repository's own tests run on the code before and after the change; the agent then explains the evidence. The result is one pull request comment with:

- the change drawn as a pipeline, with changed stages and changed hand-offs marked;
- real inputs followed through every hand-off, before and after, with the first difference tagged as the cause and later ones as effects (computed by a script, not worded by the agent);
- each unit's input and output, every example labelled as observed in a run, read in the code, or only stated;
- the author's claims checked one by one;
- what was run, what was not, and any reviewer statement the script downgraded for lack of evidence.

## Steps

| Step | Does | Holds |
|---|---|---|
| `plan` | Agent reads diff and issue, writes scenarios | API key; PR code not run |
| `evidence` | Runs scenarios and tests, before and after | Nothing secret; this is the only step that runs PR code |
| `analyze` | Agent explains the evidence; script builds the comment | API key; PR code not run |
| `post` | Creates or updates one comment | GitHub token |

In GitHub Actions these are three jobs (`workflows/review-map.yml`), and the reviewer is checked out from the base branch, so a pull request cannot change its own reviewer.

## Adapters

Everything specific to one codebase lives in `adapters/<name>/`: a plain description of the pipeline for the agent, the probe that records each hand-off, and how each hand-off is shown. `adapters/messagepack` covers the MessagePack-CSharp source generator.

## Local run

```bash
npm ci
ANTHROPIC_API_KEY=... node review.mjs all --repo <checkout at PR head> --pr <n> --slug owner/repo --out out/pr-<n>
```

Add `--rollforward-sdk` when the pinned .NET SDK is not installed locally.
