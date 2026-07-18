# Roadmap

This roadmap communicates direction, not a promise of features or dates. A
proposal enters the release surface only after a versioned specification,
Community Edition evidence, security review, documentation, tests, and
maintainer approval.

## v0.1.0 release gate

- Complete native-English documentation and inventory parity.
- Pass disposable release-candidate lifecycles on n8n Community 2.30.5 and
  2.30.7 using synthetic data and no production credentials.
- Inspect clean npm and MCPB artifacts, SBOMs, checksums, signatures, and
  dependency notices.
- Pass independent Opus and GLM implementation audits with no actionable
  findings.
- Enable repository security controls before the first public release.

## Accepted backlog proposal

Execution annotations remain a coherent two-tool proposal outside v0.1.0:

- `n8n_executions_get_tags`
- `n8n_executions_update_tags`

They will not be added individually. A future proposal must prove that both
operate through supported Community Edition endpoints and define strict IDs,
write policy, bounds, redaction, tests, and migration behavior.

## Areas for future evaluation

- Additional deterministic Introspect rules backed by counterexamples and
  stable evidence.
- More immutable offline node references where provenance and maintenance cost
  are clear.
- Client-specific MCPB installation verification as compatible clients evolve.
- Performance and pagination improvements justified by measured workloads.

Folders, data tables, beta evaluation APIs, paid-only project transfers,
arbitrary workflow execution, browser-cookie access, and runtime package
downloads are not implied by this roadmap.
