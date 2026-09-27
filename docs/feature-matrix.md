# Feature matrix

Compares **capability archetypes** — "WhatsApp-style", "Telegram-style", "Signal-style",
"Discord-style" — to Tessera's plan. The competitor columns describe publicly documented,
widely known behaviour at a high level and are used only to scope our requirements; they
are not a claim about any product's current exact feature set. Tessera's implementation,
UX and branding are original.

Legend: ● core to that archetype · ◐ partial / optional / limited · ○ absent or not a focus ·
**Tessera** column shows target phase (P#) and protection level: **E2EE**, **SP** (server-protected: encrypted at rest, server holds keys), **PUB** (public).

## Messaging

| Capability | WhatsApp-style | Telegram-style | Signal-style | Discord-style | Tessera |
|---|---|---|---|---|---|
| 1:1 chat E2EE by default | ● | ◐ (opt-in secret chats only) | ● | ○ | P4 · E2EE |
| Group chat E2EE by default | ● | ○ | ● | ○ | P7 · E2EE (≤1,024) |
| Very large groups (100k+) | ◐ | ● | ○ | ● (servers) | P7/P8 · SP "large rooms" (not E2EE, labelled) |
| Multi-device without phone online | ● | ● (cloud) | ● | ● | P5 · E2EE |
| Server-side full history for new devices | ○ | ● | ○ | ● | ○ for E2EE — history via transfer/backup (ADR-010) |
| Replies, mentions, reactions | ● | ● | ● | ● | P3 |
| Edit / delete for everyone | ● | ● | ● | ● | P3 (E2EE control messages) |
| Disappearing messages | ● | ◐ | ● | ○ | P3 |
| Polls | ● | ● | ● | ● | P7 |
| Threads | ◐ | ● (comments/topics) | ○ | ● | P7 (P2 priority) |
| Scheduled messages | ○ | ● | ○ | ○ | P8 (channels only) |
| Stories/status | ● | ● | ● | ○ | P8+ · E2EE to audience (post-GA) |
| Bots / automation | ◐ (business API) | ● | ○ | ● | Architecture P1; bots in non-E2EE surfaces first (ADR-022) |

## Privacy and security

| Capability | WhatsApp-style | Telegram-style | Signal-style | Discord-style | Tessera |
|---|---|---|---|---|---|
| Safety numbers / QR verification | ● | ◐ (secret chats) | ● | ○ | P4 |
| Key-change warnings | ● | ◐ | ● | ○ | P4 |
| Post-quantum key agreement | ◐ (evolving) | ○ | ● (PQXDH + SPQR) | ○ | P4 target, gated on S-02 (ADR-005) |
| Sealed sender / sender metadata hiding | ○ | ○ | ● | ○ | Post-GA research (S-09) |
| Username without exposing phone | ◐ | ● | ● | ● | P2 |
| E2EE backups | ● (opt-in) | ○ | ● | ○ | P5 |
| Passkeys | ● | ◐ | ○ | ● | P2 |
| Key transparency | ● | ○ | ○ | ○ | Post-GA (S-07) |
| Local-only private search | ● | ○ | ● | ○ | P5 |
| Privacy controls (last seen, photo, read receipts) | ● | ● | ● | ◐ | P2/P3 |

## Communities and channels

| Capability | WhatsApp-style | Telegram-style | Signal-style | Discord-style | Tessera |
|---|---|---|---|---|---|
| Community containing groups | ● | ◐ (folders/topics) | ○ | ● (servers) | P7 |
| Granular roles & permissions | ◐ | ◐ | ○ | ● | P7 |
| Public discovery | ◐ | ● | ○ | ● | P7/P8 · PUB |
| Broadcast channels | ● | ● | ○ | ◐ (announcement channels) | P8 · PUB/SP |
| Channel comments, reactions, analytics | ◐ | ● | ○ | ◐ | P8 |
| Member verification / join screening | ○ | ◐ | ○ | ● | P7 |

## Calls

| Capability | WhatsApp-style | Telegram-style | Signal-style | Discord-style | Tessera |
|---|---|---|---|---|---|
| 1:1 voice/video E2EE | ● | ● | ● | ◐ | P9 |
| Group video | ● | ● | ● | ● | P9 (SFU, SFrame E2EE) |
| Screen share | ● | ● | ● | ● | P9 |
| Persistent voice rooms | ○ | ● (voice chats) | ○ | ● | Post-GA |

## Platform

| Capability | WhatsApp-style | Telegram-style | Signal-style | Discord-style | Tessera |
|---|---|---|---|---|---|
| Web client | ● (linked) | ● | ○ (desktop app) | ● | P3 (primary launch client) |
| Desktop app | ● | ● | ● | ● | Post-GA (Tauri, higher-assurance E2EE — ADR-019) |
| Native mobile | ● | ● | ● | ● | Post-GA; protocol designed for it now |
| Premium subscription | ○ | ● | ○ (donations) | ● | P13 |
| Business accounts | ● | ◐ | ○ | ○ | P13 |
| Admin/moderation tooling | internal | internal | minimal | ● (server mods) | P11/P12 |

## Deliberate divergences

1. **We are not Telegram for private chats.** Private 1:1/group chats are always E2EE; no
   "cloud chat" mode that the server can read.
2. **We are not Signal for public reach.** Channels and large rooms exist, are *not* E2EE,
   and say so in the UI.
3. **Server-side full history for E2EE chats is not offered.** It would require either
   keeping keys on the server or weakening forward secrecy. New devices get history from
   an existing device or an encrypted backup.
