# Third-party notices

Project-authored code is licensed under MIT. Dependencies retain their own
licenses; `package-lock.json` is the exact dependency record and
`npm run licenses:check` validates every installed package path.

The npm runtime tarball does not bundle dependencies. The following packages
are development-only transitive dependencies of ESLint or the MCPB build CLI.
Their published npm tarballs declare an SPDX license but omit a top-level
LICENSE or NOTICE file. They are exact-pinned in the lockfile, are not present
in the runtime package or MCPB, and are accepted only at the listed version,
license, repository, and integrity hash:

| Package                 | License      | Upstream repository                                                                             |
| ----------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `@humanfs/types@0.15.0` | Apache-2.0   | [humanwhocodes/humanfs](https://github.com/humanwhocodes/humanfs)                               |
| `esrecurse@4.3.0`       | BSD-2-Clause | [estools/esrecurse](https://github.com/estools/esrecurse)                                       |
| `flora-colossus@2.0.0`  | MIT          | [MarshallOfSound/flora-colossus](https://github.com/MarshallOfSound/flora-colossus/tree/v2.0.0) |
| `imurmurhash@0.1.4`     | MIT          | [jensyt/imurmurhash-js](https://github.com/jensyt/imurmurhash-js)                               |
| `keyv@4.5.4`            | MIT          | [jaredwray/keyv](https://github.com/jaredwray/keyv)                                             |
| `natural-compare@1.4.0` | MIT          | [litejs/natural-compare-lite](https://github.com/litejs/natural-compare-lite)                   |

Their exact SHA-512 integrity values are enforced in
`scripts/verify-dependency-licenses.mjs`. Any version, license, integrity, role,
or notice-file change fails the gate and requires a new review. A package with a
missing notice file can never use this exception when it is a runtime dependency
or bundled into a release artifact.

Complete license texts are available from the linked upstream repositories and
the SPDX identifiers above. The final MCPB must independently preserve the
license and notice files for every dependency it actually bundles.

`minimatch@10.2.5` is another development-only ESLint dependency and is licensed
under the permissive Blue Oak Model License 1.0.0. Its installed package includes
the license file; the official license text and required notice link are
<https://blueoakcouncil.org/license/1.0.0>. It is not bundled in the npm runtime
tarball.

Two development-only MCPB build dependencies offer alternative licenses. This
project selects the permissive alternative shown below. The gate pins the exact
version, declared expression, selected license, repository, and integrity hash;
both installed packages include the selected license text and neither is bundled
in the npm runtime tarball or MCPB.

| Package            | Declared expression       | Selected license |
| ------------------ | ------------------------- | ---------------- |
| `node-forge@1.4.0` | `BSD-3-Clause OR GPL-2.0` | BSD-3-Clause     |
| `type-fest@0.21.3` | `MIT OR CC0-1.0`          | MIT              |
