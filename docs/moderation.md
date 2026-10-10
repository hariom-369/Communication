# Abuse prevention and moderation

Status: IMPLEMENTED (Phase 11, pending review S-10) · Decisions: ADR-021, 022, 049 · Legal: L-04, L-05, L-12, L-13

## 0. As built (Phase 11)

- **Blocks** (§2) are enforced by the server on new direct chats, messages in both directions,
  one-to-one calls, group adds (skipped as "not allowed", without saying why), presence and
  typing. Blocking is private; the blocked person is not told. *Not built:* the message-requests
  inbox for unknown senders (tracked before public beta); per-person mute (conversations can be
  muted, Phase 10).
- **Reporting** (§3) works as designed, with **message franking implemented** (ADR-049): every
  message is franked, so a report is *content verified* when the server's tag and the sender's
  commitment both check out, and *unverified* otherwise. The sheet lets the reporter pick
  messages, up to 10 earlier ones, and whether to include decrypted files, then seals the bundle
  with HPKE to the moderation key (`GET /moderation/key`). Reports of people, channels, posts,
  comments and communities capture what the reporter can see on the server. Reporting can also
  block. Reporters see their reports' status (received / action taken / no violation).
- **Automated controls** (§4): per-route GCRA limits (reports 30/h per person, grievances 5/h per
  address or IPv6 /64); new accounts (7 days): 20 new chats and 5 groups a day, 2 channels a week,
  10 invite links a day; behaviour signal: 3 distinct reporters or 5 blockers within 24 h →
  24 h new-chat restriction plus a case; harmful-link blocklist (refused in public posts and
  comments; on devices, warnings after a k-anonymous prefix lookup); known child abuse material by
  exact SHA-256 (in reports; public channel media are not uploaded as files in this release).
  *Not built:* lookalike-domain and IDN homograph detection, public-upload malware scanning (no
  public uploads yet), risk scores and CAPTCHA-style challenges, perceptual hashing (L-12),
  reporting to authorities (L-12, legal process).
- **Enforcement** (§5) and **moderator workflow** (§6): as described, with bans and legal
  referrals waiting for a second reviewer (with re-authentication); deadlines per §6 recorded on
  each case and swept every minute (`MODERATION_SWEEP_INTERVAL_MS`); queue by priority and
  deadline with countdowns; case view with reports, sealed evidence (opened explicitly, every view
  recorded on the case and audited; images blurred until revealed; matches of known abuse
  material only for the legal role), earlier decisions about the person, timeline and notes.
  The console is in the app for staff (`/moderation`) until the admin console (Phase 12); staff
  roles come from the operator command `pnpm --filter @tessera/api staff grant <user> <role>
  --days <1-90> --by <operator>`.
- **Appeals** (§7): in the account status page (reachable while suspended), within 30 days, decided
  by someone who did not take or approve the decision; outcome by email and in the app; the
  Grievance Appellate Committee is named in grievance emails.
- **Grievances and orders:** a public grievance-officer form (`/grievance`, no account needed)
  with emailed reference, acknowledgement and resolution deadlines and outcome; court and
  government orders recorded by the legal role (3 h, legal hold).
- **Evidence** (§8): HPKE-sealed bundles or server-sealed snapshots with SHA-256 at ingestion; 1
  year after closure unless on legal hold.
- **Transparency** (§9): monthly figures (reports, grievances, orders, cases opened and resolved,
  missed deadlines, actions by kind, appeals and outcomes, automated actions) for senior staff.

## 1. Principles

- Respect E2EE: **no client-side scanning, no server decryption, no silent reporting**.
  Private content reaches Tessera only when a participant explicitly reports it.
- Use metadata and behaviour signals (which Tessera legitimately has) for spam/abuse
  detection in private surfaces; full content moderation in public surfaces.
- Due process: notice, reasons, appeal, human review for severe actions.
- Every moderator action is audited and reversible where possible.

## 2. User tools

Block (server-enforced: blocked user cannot message, call, add you, see presence/photo);
mute; report (user, message, group, channel, community, post, comment); leave and report
group; message requests inbox for unknown senders (media blurred, links inert until accepted).

## 3. Reporting E2EE content (explicit, user-authorised)

```
Reporter selects message(s) → "Report to Tessera" sheet explains exactly what will be sent:
  - the selected messages (+ optionally up to 10 preceding messages, reporter chooses)
  - sender identities, timestamps, conversation ID
  - decrypted media for selected media messages
→ client re-encrypts the bundle to the moderation service public key (HPKE) and uploads
→ server stores as evidence blob (KMS-encrypted at rest), creates report + case
```

**Verifiability (ADR-021, S-10):** Without franking, a reporter could fabricate content.
Planned: message franking — sender includes a commitment (HMAC with random franking key
inside ciphertext); server records the commitment + a server tag at delivery; reporter
reveals franking key + plaintext; moderation service verifies. Until adopted, reports from
E2EE surfaces are marked **unverified** and severe actions need corroboration (multiple
independent reporters or behaviour signals).

## 4. Automated abuse controls

| Control | Signals / mechanism | Surface |
|---|---|---|
| Flood protection | per-device/account/IP token buckets; burst + sustained | all |
| New-account limits | graduated trust: first 7 days limited first-contacts, group creation, invites, channel creation | all |
| Spam detection | first-contact fan-out rate, block/report rate from recipients, message-request ignore rate, account clustering (signup IP/ASN, device fingerprint coarse), invite-link abuse | private (metadata only) |
| Malicious links | Server-side reputation checks only for **public** content; for E2EE, client checks URLs against a locally downloaded hashed blocklist (prefix-hash lookup, no URL sent in clear) | client + public |
| Phishing | lookalike-domain detection in public content; warnings on links with IDN homographs (client) | both |
| Malware | scanning of public uploads; client warnings for risky file types in E2EE | both |
| CSAM | hash matching on public media and on reported content; NCMEC-equivalent / Indian authority reporting per POCSO/IT Act (L-12) | public + reports |
| Suspicious accounts | risk score (signup, login, behaviour); step-up verification; shadow limits **not** used (transparency) | all |

## 5. Enforcement ladder

`warn → feature restriction (e.g. no new chats 24 h) → temporary suspension (1/7/30 days)
→ permanent ban`; content removal for public surfaces; channel/community actions (remove
from discovery, suspend). Severe categories (CSAM, credible threats, terrorism) → immediate
suspension + legal escalation. Users receive notice with reason code and appeal link
(except where legally prohibited).

## 6. Moderator workflow

- Queues by category and priority; SLA timers encode legal deadlines
  (IT Rules 2026: **3 h** for court/government orders, **2 h** for non-consensual intimate
  imagery and deepfake reports, grievance acknowledgement **24 h**, resolution **7 days** —
  to be confirmed by counsel, L-05).
- Case view: reports, evidence (viewed in a sandboxed viewer; sensitive media blurred by
  default with click-to-reveal, logged), account history, prior actions, behaviour signals.
  **No access to any conversation beyond what was reported.**
- Actions require reason codes; permanent bans and legal referrals require second reviewer.
- Moderator wellbeing: blur-by-default, grayscale option, exposure limits per shift.

## 7. Appeals

In-app appeal within 30 days; reviewed by a different moderator; outcome with reasons;
IT Rules escalation path (Grievance Appellate Committee) disclosed.

## 8. Evidence management

Evidence blobs encrypted with a moderation KMS key; access logged; retention 1 year after
case closure unless legal hold; chain-of-custody record (hashes at ingestion) for law
enforcement disclosures processed by legal team only.

## 9. Transparency

Monthly compliance report (required for SSMIs under IT Rules) generated from case data:
complaints received, actions taken, proactive removals (public surfaces).

## 10. Tests (Phase 11 exit)

Rate-limit bypass attempts (IP rotation, multiple devices, IPv6 /64 rotation); block
enforcement across all paths (message, call, group add, presence); report bundle
integrity; moderator can't access unreported content (authorization tests); SLA timer
accuracy; appeal flow; audit completeness.

| Required test | Where |
|---|---|
| Rate-limit bypass | `moderation.integration.test.ts` › abuse controls (per-person report limit across a second session and address), grievances (per address, and across addresses in one IPv6 /64); `rate-limit.test.ts` (/64 grouping) |
| Block enforcement on every path | `moderation.integration.test.ts` › blocks (new chats both ways, messages both ways, calls, group adds both ways, presence); `gateway.integration.test.ts` › typing; E2E `moderation.spec.ts` |
| Report bundle integrity | integration: franked messages verified; altered plaintext, forged tag → unverified; bundle for another conversation, reporter, message set or garbage → refused; sealed bytes hashed, no plaintext in storage, events or logs; unit: `franking.test.ts` (API and web), `report-bundle.test.ts`, HPKE binding |
| No access to unreported content | integration: staff routes closed to everyone else; evidence only through its own case (E2EE and server snapshots); no conversation access; the unreported message never appears; CSAM-matched evidence legal-only |
| SLA timer accuracy | integration › service-level deadlines (each category's deadlines to the millisecond; sweep just before / after each deadline; breach once; queue order); `moderation.test.ts` (rules table) |
| Appeal flow | integration (while suspended; once; not someone else's; not the decision-maker; overturn reverses; window); E2E (report → evidence → suspension → appeal → overturn by a colleague) |
| Audit completeness | integration › every staff decision present in the hash-chained audit log, chain verified |
| Mutation checks | 22 of 22 seeded faults caught (block paths, second reviewer, approver role, appeal independence, evidence scoping, CSAM legal-only, suspension gate, breach once, commitment/tag checks, proven-sender rule, distinct reporters, new-account limit, legal hold, session revocation, harmful links, legal-order role, bundle binding) plus the gateway typing filter |
