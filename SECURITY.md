# Security policy

## Supported version

Only the latest released version is supported. The current prerelease line is `0.1.x`; no stable release has been declared yet.

## Threat model

Proof Gate treats manifest text, paths, titles, evidence summaries, and pull-request metadata as untrusted data. It must never:

- execute a command supplied by the manifest;
- render arbitrary HTML;
- fetch a manifest URL;
- read a path selected from manifest content;
- send repository data over the network;
- preserve a previous `PASS` after a parser or I/O error;
- use a write-capable GitHub token.

The Action reads only an explicitly configured manifest path and writes only to an explicitly configured report directory, both constrained to `GITHUB_WORKSPACE`.

## Reporting a vulnerability

Do not open a public issue containing exploit details or secrets. Until a dedicated private reporting channel exists, create a minimal public issue requesting a security contact without including the vulnerability payload. A private advisory workflow must be configured before publication.

## Safe workflow use

- Grant `contents: read` unless a future feature demonstrably requires more.
- Avoid `pull_request_target` for untrusted contributions.
- Pin third-party actions to a full-length commit SHA.
- Never interpolate PR titles, bodies, branches, or manifest data directly into shell scripts.
- Auto mode uses argv-only Git calls with validated event SHAs. Fork pull requests remain untrusted data under `pull_request`; bot/unknown authors trigger `PG007`. Workflow-command metacharacters are escaped, and PR text is never executed.
- `.proofgate.json` cannot grant static human approvals. Evidence files are bounded, workspace-relative regular files; missing evidence fails closed.
