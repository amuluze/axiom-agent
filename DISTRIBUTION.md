# Distribution source and release provenance

This repository is a filtered, buildable distribution snapshot of Axiom's development upstream. Each synchronization creates one squash commit so reviewers can inspect the complete public code diff between releases without exposing unrelated upstream history or private infrastructure.

`SOURCE_SNAPSHOT.json` records the exact upstream commit and version used for the snapshot. A tagged release also includes `release-provenance.json`, which links that upstream commit to the public commit, the updater signing public-key identifier, the CHANGELOG hash, the security-change list, and every published asset hash. `SHA256SUMS.txt` covers the provenance file itself.

Runtime sandbox and authorization fixes are included in the public snapshot that ships them. Their code changes remain visible in the diff between public snapshot commits. Security reports stay private until a fix is released according to `SECURITY.md`.
