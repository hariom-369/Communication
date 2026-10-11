# Runbook — web release signing key

The key signs `release.json` for every web release (ADR-052, docs/e2ee.md §7). Browsers that run
Tessera install a new release only if it is signed by a key the running release listed in
`keys`. Whoever holds a listed key can ship code to every returning browser; losing all listed keys
strands browsers on the last release. Treat it like a code-signing key.

## Keys in use

- **Active key** — signs releases. Lives only in the release pipeline's secret store
  (`RELEASE_SIGNING_KEY`), readable by the release job through OIDC, never by people.
- **Backup key** — never used to sign, kept offline (hardware token or sealed envelope in two
  locations, two custodians). Its public key is listed in **every** release (`RELEASE_NEXT_KEYS`),
  so it can take over if the active key is lost or compromised.

## Generate a key (two people, offline machine)

```
openssl genpkey -algorithm ed25519 -outform DER | base64 -w0 > release-key.pkcs8.b64
# public key (raw 32 bytes, base64) for RELEASE_NEXT_KEYS and for monitors:
base64 -d release-key.pkcs8.b64 | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | base64
```

Record the public key, date and custodians in the key register. Destroy the working copy after
storing it.

## Routine rotation (yearly, or when a custodian leaves)

1. Generate the new key. Release N lists `active, backup, new` (`RELEASE_NEXT_KEYS=backup,new`).
2. Wait until most browsers run release N: at least two weeks (once release telemetry exists,
   Phase 16, the share of browsers on each release replaces the fixed wait).
3. Release N+1 is signed with the new key and lists `new, backup`. The old key is destroyed.

## Active key lost

Sign the next release with the backup key (bring it online for one signing, two people), listing
a newly generated backup. Then rotate as above.

## Active key compromised

1. Treat as a security incident: the regulatory clocks of docs/compliance.md apply if user data
   may be affected (the incident runbook itself is written in Phase 17).
2. Ship a release signed with the **backup** key that lists only the backup and a new key; this
   is what honest browsers move to.
3. The attacker can also sign a release listing only their key. Browsers that install it before
   the honest release are lost to the attacker's code until their site data is cleared — the
   honest release cannot reach them. Detect it: external monitors run
   `apps/web/scripts/verify-release.mjs <origin> --key <backup> --key <new>` continuously and alert
   on any manifest signed by another key. Announce publicly what to do (clear site data, or use
   the desktop app).
4. Revoke pipeline credentials, audit who could read the secret, rotate the backup key.

## Checks after every release

- `verify-release.mjs` against production succeeds with the expected key (CI and external
  monitor).
- `release.json` lists the active and the backup key.
