# Compliance-readiness (India-first)

Status: **NEEDS-LEGAL-REVIEW.** This is an engineering readiness checklist, **not legal
advice**. Software features do not by themselves create legal compliance. Every item marked
⚖ requires confirmation by qualified Indian counsel against the current Gazette texts.
Regulatory status below reflects the research pass of 2026-09-27 ([research-sources.md](research-sources.md));
several instruments were recently amended or have deadlines that have moved.

## 1. Applicable regimes (to be confirmed ⚖)

| Regime | Why it likely applies | Key status found |
|---|---|---|
| IT Act 2000 + IT (Intermediary Guidelines & Digital Media Ethics Code) Rules 2021, amended through 2026 | We host/transmit user content → intermediary; "social media intermediary"; becomes **SSMI** at ≥ 50 lakh registered Indian users | 2026 amendment in force from 20 Feb 2026 (SGI labelling; 3 h / 2 h takedowns; 7-day grievance resolution); further draft amendments circulating |
| DPDP Act 2023 + DPDP Rules 2025 | We process digital personal data as a Data Fiduciary | Notified 13 Nov 2025; core duties ~May 2027; may be notified a Significant Data Fiduciary |
| CERT-In Directions (28 Apr 2022) under IT Act s.70B | Service provider/intermediary/body corporate | 6-hour incident reporting; 180-day log retention in India; NTP sync; point of contact |
| Telecommunications Act 2023; Telecom Cyber Security Rules 2024 + Amendment Rules 2025 | If we use mobile numbers to identify users → possibly a TIUE (Mobile Number Validation) | Notified Oct 2025 |
| DoT directions on SIM binding for app-based communication services | If classed as such a service using mobile numbers | SIM binding + ~6-hour web/companion re-auth; compliance date reportedly extended to 31 Dec 2026 |
| Consumer Protection Act 2019; E-Commerce Rules 2020; CCPA dark-patterns guidelines 2023 | Paid subscriptions to consumers | — |
| RBI recurring-payment / e-mandate framework; GST | Subscriptions | — |
| POCSO Act 2012; IT Act s.67/67A/67B; BNS 2023 | CSAM & unlawful content duties | — |
| Copyright Act 1957 (s.52 safe harbour/notice) | User-uploaded media | — |

## 2. Checklist

Legend: ☐ not started · Eng = engineering deliverable · ⚖ legal decision/confirmation required.

### 2.1 Intermediary obligations (IT Rules)
- ☐ ⚖ Determine classification (intermediary / SMI / SSMI trajectory) and applicable obligations.
- ☐ Terms of Service, Privacy Policy, Community Guidelines published; users informed annually of rules (Eng: versioned documents + acceptance records). ⚖ drafting.
- ☐ Grievance Officer appointed; name/contact published; grievance portal (Eng: `grievances` workflow with 24 h acknowledgement, 7-day resolution timers ⚖ confirm timelines).
- ☐ Takedown pipeline for court/government orders within **3 hours** ⚖; NCII / impersonation / deepfake complaints within **2 hours** ⚖ (Eng: on-call legal-ops rota, SLA alerts, [moderation.md](moderation.md)).
- ☐ Synthetic-content (SGI) disclosure prompts and labels on public surfaces; metadata/provenance where required ⚖ (Eng: upload declaration + label rendering).
- ☐ Preservation of removed content and associated records for the prescribed period on removal (180 days in 2021 Rules — ⚖ confirm) (Eng: legal-hold storage).
- ☐ Cooperation with lawful requests: request intake, verification, response workflow, transparency (Eng: legal request tracker).
- ☐ **SSMI readiness** (before 50 lakh users): Chief Compliance Officer, Nodal Contact Person, Resident Grievance Officer (resident in India, employees); monthly compliance reports; voluntary user verification; physical address in India. ⚖
- ☐ ⚖ **Rule 4(2) first-originator traceability** for SSMIs primarily providing messaging: **incompatible with the E2EE design**; subject to pending litigation. Board-level decision required on strategy before approaching the threshold. Architecture will not add traceability hooks without that decision.

### 2.2 DPDP
- ☐ Notice in clear language (English + scheduled languages ⚖ which) itemising data, purposes, rights, grievance, Board complaint route (Eng: notice versioning, consent ledger).
- ☐ Consent capture/withdrawal (Eng: `consents` table; withdrawal UI); legitimate-use basis mapping ⚖.
- ☐ Children: verifiable parental consent, no tracking/behavioural monitoring/targeted ads for children ⚖ → **launch 18+** with age declaration; design VPC flow before admitting minors.
- ☐ Data principal rights: access, correction, erasure, grievance, nomination (Eng: [privacy.md §3](privacy.md)); response timelines ⚖.
- ☐ Reasonable security safeguards (encryption, access control, logging, backups, contracts with processors) — [security.md](security.md).
- ☐ Personal data breach: notify Board and affected principals; detailed report to Board within **72 hours** (Eng: incident runbook + templates; parallel CERT-In 6 h clock).
- ☐ Retention and erasure: erase when purpose served; retain logs for the minimum period prescribed (1 year per Rules ⚖ confirm scope); for large social media intermediaries, erasure after prolonged inactivity with 48-hour prior notice ⚖ (Eng: inactivity job).
- ☐ Processor contracts (AWS, email, SMS, payment, push) with DPDP clauses ⚖.
- ☐ Cross-border transfer: default data residency India; check any restricted-country notifications ⚖; push services (Google/Apple/Mozilla) are outside India — only content-free payloads.
- ☐ Significant Data Fiduciary readiness: DPO based in India, DPIA, periodic audit ⚖.
- ☐ Consent Manager integration (optional) ⚖.

### 2.3 CERT-In
- ☐ Point of contact designated and registered.
- ☐ Incident reporting within **6 hours** of noticing (Eng: detection → on-call → report template; runbook).
- ☐ ICT system logs retained **180 days, within India** (Eng: log pipeline in ap-south-1/2; retention config).
- ☐ Clock synchronisation to NIC/NPL NTP or traceable sources (Eng: chrony config in AMIs/nodes; AWS Time Sync is traceable? ⚖/Eng verify).
- ☐ Respond to CERT-In information requests.

### 2.4 Telecom
- ☐ ⚖ Is Tessera an "app-based communication service" for the SIM-binding directions? Does phone-number use make us a TIUE requiring MNV validation? (Blocking decision L-02/L-03 — affects ADR-030 and web session policy.)
- ☐ Eng: configurable web session max-age (can enforce e.g. 6-hour re-auth via QR from a SIM-bound mobile device if required), phone number optional architecture.

### 2.5 Consumer, payments, tax
- ☐ Transparent pricing, auto-renewal disclosure, easy cancellation, refund policy; no dark patterns ⚖.
- ☐ RBI e-mandate compliant recurring payments (provider-handled; Eng: pre-debit notification support).
- ☐ GST registration, invoicing, record retention ⚖.

### 2.6 Content-specific
- ☐ CSAM: detection on public surfaces + reports, mandatory reporting channel to authorities ⚖ (PhotoDNA/industry hash licensing L-12).
- ☐ Copyright notice-and-takedown process ⚖.
- ☐ Law-enforcement guidelines document (what data exists — see metadata inventory — and process) ⚖.

### 2.7 Global (if launching beyond India) ⚖
GDPR (EU representative, DPIA, SCCs), UK GDPR, US state privacy laws, COPPA, EU DSA — out
of scope until P-02 decides launch geography.

## 3. Engineering controls that support compliance (built regardless)

Data catalogue with purpose + retention per column; consent ledger; export/erasure
sagas; audit log; legal-hold flag; grievance + takedown workflows with SLA timers;
incident runbooks with regulatory clocks; data residency in India; transparency report
generator.
