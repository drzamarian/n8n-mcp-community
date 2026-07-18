# Contributing

Thank you for helping make n8n MCP Community safer and more useful. Changes are
welcome when they preserve the Community Edition scope, the exact documented
tool contract, and the project's data-minimization defaults.

## Before you begin

- Read the [security model](docs/security-model.md) and
  [architecture](docs/architecture.md).
- Use synthetic fixtures only. Never submit real credentials, workflows,
  executions, instance URLs, cookies, or identifying data.
- For a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.
- Discuss a new tool or public behavior before implementing it. Tool additions
  change the compatibility, documentation, and release contract.

## Development setup

Node.js 22 and 24 are the supported development lines.

```bash
npm ci
npm run check
```

The complete gate covers formatting, dependency licenses and notices, strict
TypeScript, the full automated test suite, a real stdio inventory check, and the
production build.
Run `npm run sbom > sbom.cdx.json` when reviewing dependency changes.

## Branch and commit conventions

- Create a focused branch from `dev`: `feat/<topic>`, `fix/<topic>`,
  `docs/<topic>`, or `chore/<topic>`.
- Keep changes small and traceable. Avoid unrelated refactors.
- Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:`,
  `test:`, or `chore:`.
- Never commit `.env`, generated packages, build output, logs, or secrets.
- Do not force-push a shared review branch.

## Pull requests

A pull request should explain the problem, the chosen minimal change, security
and compatibility impact, tests performed, and documentation updated. Every
tool change must update both the runtime contract and
[docs/tools.md](docs/tools.md). A registration-only tool is not acceptable.

Reviewers will check:

- Community Edition support through a documented Public API path;
- operation mode and MCP annotations matching actual side effects;
- input validation before upstream requests;
- response allowlisting, redaction, pagination, and size limits;
- zero-request denial for invalid or unauthorized operations;
- Node 22 and 24 behavior;
- documentation and inventory parity;
- package, provenance, and license impact.

All actionable review findings must be resolved or explicitly dispositioned with
evidence before merge. `dev` is the integration branch; releasable changes reach
`main` only through the reviewed release process.

## Style

Write code, tests, comments, commit messages, issues, and documentation in clear
native-quality English. TypeScript is strict, `any` is prohibited, and external
data must be validated at the boundary. Prefer the smallest implementation that
satisfies the actual contract.
