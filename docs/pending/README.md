# Parked: waiting on a value-help re-import

`derivation-config-service.cds.txt` is a finished CAP service that **cannot compile yet**. It
projects `ZSRVB_MDMLIGHT_VH.DerAddressDefaults` and its four siblings, and
`srv/external/ZSRVB_MDMLIGHT_VH.cds` is a **compiled copy** — the five `Der*` entities are live in
S/4 and served in `$metadata`, but the local copy has not been re-imported, so the compiler answers
`Artifact "ZSRVB_MDMLIGHT_VH.DerAddressDefaults" has not been found` and takes every CDS-compiling
test down with it.

It was committed to `srv/` on 2026-08-27 before the import had been run, which broke `main` for
everybody. Parked here rather than reverted, because the file itself is right.

**To land it:**

```bash
npm run import:valuehelp -- --url https://<host>:44301/sap/opu/odata/sap
```

`--insecure` if the gateway certificate is self-signed; `S4_USER` / `S4_PASSWORD` in the
environment. The bare form only works in Cloud Foundry — see "The imported models are copies" in
CLAUDE.md.

Then move it back and delete this folder:

```bash
git mv docs/pending/derivation-config-service.cds.txt srv/derivation-config-service.cds
```

`npm test` is the check: `test/value-help-wiring.test.js` asserts registered ↔ projected parity, so
it will have an opinion about five newly imported entities either way.
