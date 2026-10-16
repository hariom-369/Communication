# Runbook — known-CSAM hash match

The server matches public media (channels, communities' public content) and reported content
against known-abuse hash lists (docs/moderation.md); end-to-end encrypted content is never
scanned. A match logs `moderation.csam_match`, opens a case restricted to the legal role, and
takes the content down.

1. **Do not view the content** outside the legal workflow; evidence is legal-only by design.
2. The legal role confirms the match in the moderation console and preserves the evidence
   (legal hold) — preservation periods per the applicable orders.
3. Report to the authorities as required (POCSO Act, IT Act — the reporting channel and form are
   pending legal sign-off, L-12) within the required time.
4. Suspend the account (enforcement ladder: severe category → immediate suspension), revoke its
   sessions, and keep the case record.
5. Staff wellbeing: rotate who handles these cases; access is logged.
