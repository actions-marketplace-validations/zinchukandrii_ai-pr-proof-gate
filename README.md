# AI PR Proof Gate

A deterministic evidence-contract gate for maintainers reviewing human- and AI-generated pull requests.

It does **not** use runtime AI, execute commands from a manifest, call GitHub APIs, merge code, or upload repository data. The same TypeScript evaluator powers the local web console, CLI, and GitHub Action entrypoint.

## Why this exists

Danger automates team-specific review conventions, reviewdog maps linter output to inline comments, and OpenSSF Scorecard evaluates repository security posture. Proof Gate has a narrower job: validate that a pull request carries the declared scope, required check evidence, risky-file review, and human approval needed for an auditable decision.

## Decisions and stable rule IDs

| Rule | Decision | Meaning |
|---|---|---|
| `PG001` | `BLOCKED` | Changed file is outside every declared scope. |
| `PG002` | `BLOCKED` | A required check failed. |
| `PG003` | `REVIEW_REQUIRED` | A required check was skipped. |
| `PG004` | `REVIEW_REQUIRED` | A risky path changed without approved human review. |
| `PG005` | `BLOCKED` | A required check lacks valid evidence. |
| `PG006` | `REVIEW_REQUIRED` | Binary or oversized change. |
| `PG007` | `REVIEW_REQUIRED` | Automation/unknown author lacks human approval. |
| `PG008` | `PASS` | No blocking or review-required condition remains. |

`BLOCKED` takes precedence over `REVIEW_REQUIRED`; parser errors fail closed and never preserve a stale `PASS`.

## Local development

Local development and tests require Node.js 22.22.2+. The bundled GitHub Action entrypoint uses GitHub's Node.js 24 action runtime.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run cli:smoke
npm run build
npm run action:smoke
npm run action:auto-smoke
npm run dev
```

The local console uses bundled synthetic fixtures. It stores only the current draft in browser `localStorage`; **Reset safe fixture** deletes that draft.

## CLI

```bash
npm run cli -- fixtures/safe.json \
  --json-out .tmp/report.json \
  --markdown-out .tmp/report.md
```

Stable exit codes:

- `0` — `PASS`
- `10` — `REVIEW_REQUIRED`
- `20` — `BLOCKED`
- `2` — invalid input or I/O failure

## GitHub Action

Build the committed Node entrypoint before creating a release:

```bash
npm ci
npm run build
npm run action:smoke
```

See [`examples/proofgate.workflow.yml`](examples/proofgate.workflow.yml). The action supports manual manifest mode (the default) and bounded `auto` mode. Auto mode reads `GITHUB_EVENT_PATH`, accepts only `pull_request` events with exact 40-hex base/head SHAs, calculates a local merge-base diff through argv-only Git calls, writes the generated manifest, and sends no repository data over the network.

For a consumer repository, pin the release tag and use auto mode after checking out full history:

```yaml
- name: Evaluate pull request evidence contract
  uses: zinchukandrii/ai-pr-proof-gate@v0.1.0
  with:
    mode: auto
    config: .proofgate.json
    report-dir: .proofgate
```

The complete example also installs dependencies, runs tests, records bounded evidence, and retains the generated receipts.

The released Action is available in [GitHub Marketplace](https://github.com/marketplace/actions/ai-pr-proof-gate).

The example deliberately uses:

- `permissions: contents: read`;
- a full-length commit SHA for `actions/checkout`, `fetch-depth: 0`, and `persist-credentials: false`;
- `pull_request`, not `pull_request_target`;
- no interpolation of pull-request text into shell commands.

The check/job name `ai-pr-proof-gate` is stable so a repository ruleset can require it. `REVIEW_REQUIRED` and `BLOCKED` both fail the Action check; details remain available as escaped workflow annotations, JSON/Markdown receipts, the generated manifest, and the step summary.

## Auto-mode policy and evidence

Copy [`.proofgate.example.json`](.proofgate.example.json) to `.proofgate.json` and configure expected paths. Optional `requiredChecks` entries reference small, workspace-relative JSON files created by earlier workflow steps:

```json
{"status":"pass","kind":"test-report","summary":"Project tests completed successfully."}
```

Missing evidence fails closed. Static approvals are forbidden. Fork pull requests are processed as untrusted data under the read-only `pull_request` workflow; bot or unknown authors still trigger `PG007`.

## Manifest

Start with [`fixtures/safe.json`](fixtures/safe.json). Paths must be workspace-relative, use `/`, and may not be absolute or contain `..`. Input is limited to 200,000 characters. Required check statuses are `pass`, `fail`, or `skipped`, and every required check must reference an existing evidence item.

## Security boundary

- Manifest and PR text are untrusted data, never instructions.
- No `eval`, dynamic code loading, shell execution, network request, token access, automatic comment, approval, or merge.
- The Action restricts manifest, config, evidence, and report paths to `GITHUB_WORKSPACE`, including resolved symlink targets.
- Event SHAs must be exact 40-character hexadecimal values and are passed to Git as argv with `shell: false`.
- PR text is never interpolated into a shell or workflow command; annotation values are escaped.
- The example grants only `contents: read`.
- Report output is deterministic and contains no fabricated timestamps.

See [`SECURITY.md`](SECURITY.md) for disclosure and threat-model details.

## Current limits

- Auto mode requires checkout history containing the base and head commits. The example uses `fetch-depth: 0` for the first deterministic release.
- Glob support is intentionally limited to `*` and `**`.
- SARIF, artifact attestations, policy files, network integrations, and hosted storage are future possibilities—not current features.
- Same-repository and separate consumer-repository live GitHub PR validation are complete. External-maintainer and independently owned fork validation remain pending.

## Research basis

The implementation was hardened against current GitHub guidance for least-privilege workflow permissions, untrusted input, full-length SHA pinning, and required status checks. Comparison sources included Danger JS, reviewdog, and OpenSSF Scorecard. The source matrix is retained outside the project in the local build report; no market-demand claim is made yet.
