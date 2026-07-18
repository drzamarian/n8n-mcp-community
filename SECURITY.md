# Security policy

Security is part of the product contract. Please report suspected
vulnerabilities privately and give the maintainer reasonable time to investigate
before public disclosure.

## Supported versions

No public version is supported until the first signed release. After release,
the latest maintained minor line will receive security fixes. Older lines may be
asked to upgrade when a safe backport is impractical.

## Report a vulnerability

Use GitHub's **Security → Report a vulnerability** form. This repository will
not be published until GitHub private vulnerability reporting is enabled and
verified. Do not open a public issue with exploit details, credentials, workflow
payloads, or identifying instance data.

If the private form is unavailable, open a public issue containing only the
sentence “Private security contact requested.” Do not include technical details
until a private channel has been established.

Include, when safe:

- the affected version or commit;
- the tool, resource, prompt, or package path involved;
- a minimal reproduction using synthetic data;
- the expected and observed security boundary;
- impact and any known prerequisites;
- whether the issue may already have been exploited.

Never send a real n8n API key, credential value, cookie, workflow payload,
execution payload, or private instance URL. Replace them with unmistakable
placeholders.

## Response process

The maintainer will acknowledge a complete report, reproduce it against a safe
environment, classify impact, prepare a fix and regression test, and coordinate
disclosure. Timelines depend on severity and reproducibility; no fixed response
time is promised before the project has a public support process.

Security fixes must pass the normal Node 22/24 checks, secret and static scans,
package inspection, and independent review before release.

## Security boundaries

The MCP server reduces risk but does not replace n8n access control. The n8n API
key determines upstream permissions; unsafe mode can authorize destructive
requests; explicitly allowing non-loopback HTTP accepts transport risk; and all
n8n content remains untrusted after sanitization. See
[docs/security-model.md](docs/security-model.md) for the complete model.
