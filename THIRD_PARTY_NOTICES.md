# Third-party notices

Project-authored code is licensed under MIT. Dependencies retain their own
licenses; `package-lock.json` is the exact dependency record and
`npm run licenses:check` validates every installed package path.

The npm runtime tarball does not bundle dependencies. The following packages
are development-only transitive dependencies of ESLint.
Their published npm tarballs declare an SPDX license but omit a top-level
LICENSE or NOTICE file. They are exact-pinned in the lockfile, are not present
in the runtime package or MCPB, and are accepted only at the listed version,
license, repository, and integrity hash:

| Package                 | License      | Source or immutable package record                                            |
| ----------------------- | ------------ | ----------------------------------------------------------------------------- |
| `@humanfs/types@0.15.0` | Apache-2.0   | [humanwhocodes/humanfs](https://github.com/humanwhocodes/humanfs)             |
| `esrecurse@4.3.0`       | BSD-2-Clause | [estools/esrecurse](https://github.com/estools/esrecurse)                     |
| `imurmurhash@0.1.4`     | MIT          | [jensyt/imurmurhash-js](https://github.com/jensyt/imurmurhash-js)             |
| `natural-compare@1.4.0` | MIT          | [litejs/natural-compare-lite](https://github.com/litejs/natural-compare-lite) |

Their exact SHA-512 integrity values are enforced in
`scripts/verify-dependency-licenses.mjs`. Any version, license, integrity, role,
or notice-file change fails the gate and requires a new review. A package with a
missing notice file can never use this exception when it is a runtime dependency
or bundled into a release artifact.

Complete license texts are identified by the SPDX expressions above. The linked
source repositories or immutable package records preserve provenance for the
reviewed versions. The final MCPB must independently preserve the license and
notice files for every dependency it actually bundles.

`minimatch@10.2.5` is another development-only ESLint dependency and is licensed
under the permissive Blue Oak Model License 1.0.0. Its installed package includes
the license file; the official license text and required notice link are
<https://blueoakcouncil.org/license/1.0.0>. It is not bundled in the npm runtime
tarball.

The pinned `mcpb/mcpb-manifest-v0.4.schema.json` file comes from the official
`@anthropic-ai/mcpb@2.1.2` source at immutable tag `v2.1.2` in
[modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb/tree/v2.1.2).
Copyright 2025 Anthropic, PBC. It is used under the MIT License reproduced in
`mcpb/OFFICIAL_SCHEMA_LICENSE`. The immutable upstream schema has SHA-256
`068557824c651d6d49b86ad132adeafe62ca788d918b3e1e2b224bf0f91320fd`.
The checked-in JSON is semantically identical but formatted with the repository's
Prettier policy; its SHA-256 is
`dae6c4a11da73fcce9adda27dface6049a90b31765623e0a445e485b321e4d46`.
The schema is a development-time validator and is not included in the npm
runtime tarball or the MCPB artifact.
