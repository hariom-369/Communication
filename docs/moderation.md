# Abuse prevention and moderation

Status: PROPOSED · Decisions: ADR-021, 022 · Legal: L-04, L-05, L-12, L-13

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
