## Summary

Describe the user-visible outcome and why this is the smallest complete change.

## Verification

List the exact commands and environments used. Include negative and boundary
tests when behavior or security controls change.

## Security, compatibility, and documentation

- [ ] The pull request targets `dev`, not `main`.
- [ ] I ran `npm run verify:contributor` or explained the exact unavailable gate.
- [ ] If I am a maintainer preparing a release, I also ran the keyed `npm run verify` gate.
- [ ] I added or updated tests for every changed contract.
- [ ] I updated native-English documentation for user-visible changes.
- [ ] I did not add secrets, private hosts, personal data, or production fixtures.
- [ ] I reviewed operation mode, side effects, redaction, and output bounds.
- [ ] I documented compatibility assumptions and n8n version requirements.
- [ ] I have the right to submit this work under the repository's MIT license.
- [ ] I disclosed material AI assistance and reviewed the resulting code myself.

## Release impact

State whether the change affects npm, MCPB, Registry metadata, migration,
upgrade, rollback, or uninstall behavior. Use “None” only after checking each.
