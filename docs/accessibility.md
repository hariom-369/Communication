# Accessibility — WCAG 2.2 AA audit

Status: **audited in Phase 14 (2026-10-10).** Target: WCAG 2.2 level AA for the web app.
Automated checks run on every E2E run; what automation cannot judge is listed with how it was
checked. Not a conformance claim: no audit with assistive-technology users or an external
auditor has been done yet (planned before public launch, Phase 16).

## 1. Automated audit (`apps/web/e2e/accessibility.spec.ts`)

Every route below is loaded in the **light and dark themes**, at **1280 px and 320 px** wide:

- signed out: `/login`, `/signup`, `/forgot-password`, `/grievance`, the not-found page;
- signed in: Chats, Communities, Channels, Security, Devices, Privacy, Notifications, Account,
  Plan, Account status, Moderation (as a moderator).

On each it runs:

| Check | Success criteria | How |
|---|---|---|
| axe-core 4.13 with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa` rules | 1.1.1, 1.3.1, 1.4.3 (both themes), 2.4.2, 2.5.8 target size, 3.1.1, 4.1.2 and the rest axe can decide | injected into a CSP-bypassing audit context |
| Reflow: no horizontal scrolling at 320 CSS px | 1.4.10 | `scrollWidth − clientWidth` |
| Focus visible: tab through the first 12 controls, each must draw an outline or ring | 2.4.7 | computed style of the focused element |
| Focus not obscured: the focused control's centre is not covered by anything | 2.4.11 | `elementFromPoint` |
| Text spacing: with the criterion's line, letter, word and paragraph spacing applied, nothing is cut off and nothing scrolls sideways | 1.4.12 | injected style; overflow of clipping boxes |
| Skip link is the first stop and moves focus into the content | 2.4.1 | keyboard |
| Reduced motion: nothing animates when the system asks for less motion | 2.3.3 (AAA, done anyway) | `document.getAnimations()` on four sections |

Per-feature tests add axe checks of states the route sweep does not reach: an open
conversation, dialogs, the call screen, the plan and invoice pages, moderation cases
(`auth`, `chat`, `calls`, `billing`, `moderation` specs). Lighthouse accessibility is 1.00 on the
public pages (performance.md).

A seeded fault (no focus ring on buttons) was caught by the audit on every page.

### Found and fixed in this audit

- **Reflow** (1.4.10): the grievance form, Privacy, Notifications and Plan pages scrolled
  sideways at 320 px (by 213, 147, 1 and 150 px) — grid columns sized to the widest `<select>`
  option. Fields now never widen their column; layout grids use `minmax(0, 1fr)`.
- **Text-field boundaries** (1.4.11): fields and the message composer were outlined with the
  decorative border colour (1.37–1.62:1). They now use a `controlBorder` token (3.2–3.9:1 in both
  themes), covered by the contrast unit test. Found by reading the contrast test's coverage, not
  by axe (which does not check non-text contrast).
- **Text spacing** (1.4.12): at 320 × 640 the chat list's header rows could push the list out
  of its box, which clipped it. The box now scrolls instead.
- **Skip link** (2.4.1): it scrolled to the content but left focus on the link, so the next Tab
  went back to the navigation. The content region now takes focus.

## 2. Criteria automation cannot decide

Each row says what the evidence is. "Code review" means the implementation was read for this
criterion in this audit; "not verified" means nobody has checked it yet.

| Criterion | Evidence | Result |
|---|---|---|
| 1.3.2 meaningful sequence, 2.4.3 focus order | the focus sweep above tabs through each page in DOM order; layouts do not reorder visually (no `order`, no absolute positioning of content) — code review | pass |
| 2.1.2 no keyboard trap, dialog focus | dialogs are native `<dialog>` with `showModal()` (focus moves in, Escape closes, focus returns) — code review; E2E dialogs are driven by keyboard where they ask for text | pass |
| 1.4.4 resize text | reflow at 320 px (equivalent to 400 % zoom of a 1280 px window) passes on every route; 200 % text-only zoom — not verified | partly verified |
| 1.4.1 use of colour | message states, key-change warnings, errors and the plan tier carry text — code review | pass |
| 1.4.11 non-text contrast | the focus ring, the accent and the boundary of text fields are checked against 3:1 on every background by `packages/ui/src/tokens.test.ts`; decorative separators (cards, sections) are not required to meet it | pass after fix (below) |
| 1.4.13 content on hover or focus | `:hover` rules only change colours; nothing appears on hover — code review | pass |
| 2.2.1 timing adjustable | the only limits are security ones (step-up window, one-time codes, sign-in flows), which the criterion exempts; each can be restarted | pass (exception) |
| 2.5.7 dragging movements | no drag interactions exist | pass |
| 3.2.6 consistent help | the only help mechanism is the grievance page, linked from Account status; there is no help element repeated across pages yet | not applicable today; re-check when help is added |
| 3.3.7 redundant entry | sign-up and billing steps keep their state while moving forward — not verified for going back | partly verified |
| 3.3.8 accessible authentication | passkeys; password fields have `autocomplete` (`current-password`, `new-password`) and do not block paste (no paste handlers anywhere); one-time codes have `autocomplete="one-time-code"` — code review | pass |
| 4.1.3 status messages | connection, offline, update-refused and send states use `role="status"`; errors use `role="alert"` — code review | pass |

## 3. Not yet done

- Screen-reader passes with NVDA, JAWS, VoiceOver (macOS, iOS) and TalkBack — Phase 16, with an
  external accessibility audit before launch.
- Captions for calls (1.2.x applies to recorded media only; live captions are a feature request,
  not an AA requirement for real-time communication).
- The admin console has its own axe checks (Phase 12) but was not part of this sweep; it is used
  by staff on desktop browsers.
