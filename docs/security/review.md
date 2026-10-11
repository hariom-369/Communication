# Internal security review (Phase 16)

Status: **complete for Phase 16**; the external assessments (S-13, [audit-brief.md](audit-brief.md))
follow in staging. Method: every claim in [security.md](../security.md),
[authentication.md](../authentication.md) and the threat model checked against the code; every
route reviewed through the generated [route matrix](route-matrix.md) with its invariants enforced
by a test; the scanners available here run (§3); the ASVS 5.0 assessment in [asvs.md](asvs.md).
Severities: CVSS 4.0-style judgement — **critical** (remote compromise of message content, keys or
accounts at scale), **high** (one account or the admin plane), **medium** (a missing layer of
defence, or a documented control that is absent), **low** (hardening).

## 1. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
FINDINGS_ROWS

**Open critical or high findings: none.** Open medium findings are scheduled with a phase and are
listed again in the Phase 16 report.

## 2. Route review

ROUTE_REVIEW

## 3. Scanners

SCANNERS

## 4. Not covered here

- Penetration testing of a deployed environment (TLS, load balancer, WAF, cloud IAM) — staging,
  Phase 17, and the external test (S-13).
- Cryptographic review of the protocol use and of `packages/crypto-core` — the external crypto
  audit (S-01..S-12); this review only checked that the code matches the documents.
- Dependency advisories for Rust crates could not be queried from this environment (the OSV and
  RustSec databases are not reachable); CI's OSV scan covers `Cargo.lock` from this phase on.
