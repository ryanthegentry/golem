# Golem — Design System

Reference this file before generating any frontend code. These are binding design decisions, not suggestions.

## Brand Identity

Golem is a self-custodial Bitcoin wallet guardian. The brand communicates: **protection, solidity, ancient reliability, quiet competence.** Not: speculation, trading, crypto-bro culture, sci-fi, or hype.

The metaphor is the Golem of Prague — a clay automaton inscribed with purpose (the shem) that autonomously protects. The ₿ symbol IS the shem — the inscription that activates the guardian.

**Brand personality:** A dependable night watchman, not a flashy trader. Think private bank, not exchange.

## Logo

Primary logo: Image 2 from the Ideogram generation set (clay golem, glowing ₿ shem on forehead, single Bitcoin held at chest, warm amber glow, compact proportions). File: `assets/brand/golem-logo.png`

**Logo usage rules:**
- Dark backgrounds only (never on white/light)
- Minimum clear space: 1x the height of the "G" in GOLEM
- At small sizes (< 48px), use icon-only mark (golem silhouette) without wordmark
- Wordmark: "GOLEM" in all caps, strong weighted sans-serif, generous letter-spacing

## Color System

```css
:root {
  /* Primary — Bitcoin amber, used sparingly for emphasis and CTAs */
  --color-primary: #F7931A;
  --color-primary-light: #FFB347;
  --color-primary-dark: #CC7A15;

  /* Neutrals — The dominant palette. Dark, warm, grounded. */
  --color-bg-primary: #0D0D0D;
  --color-bg-secondary: #1A1A1A;
  --color-bg-elevated: #242424;
  --color-bg-surface: #2E2E2E;

  /* Text */
  --color-text-primary: #E8E4DF;     /* Warm off-white, not pure white */
  --color-text-secondary: #9B9590;    /* Warm gray */
  --color-text-muted: #6B6560;

  /* Accent — Clay/terracotta from the golem itself */
  --color-clay: #A0785A;
  --color-clay-light: #C4A882;
  --color-clay-dark: #7A5C42;

  /* Semantic */
  --color-success: #4CAF50;
  --color-warning: #F7931A;           /* Reuses primary — intentional */
  --color-danger: #D32F2F;
  --color-info: #5C8A9B;

  /* Borders and dividers */
  --color-border: #333333;
  --color-border-subtle: #2A2A2A;
}
```

**Rules:**
- Bitcoin amber (#F7931A) is for Bitcoin-related elements, CTAs, and the shem glow ONLY. Do not use it as a general accent.
- The UI is predominantly dark and warm-neutral. Amber appears as highlights against darkness.
- Never use pure white (#FFFFFF) for text or backgrounds. Use warm off-whites.
- Never use pure black (#000000) for backgrounds. Use near-blacks with slight warmth.

## Typography

```css
/* Display / Headings */
font-family: 'Cabinet Grotesk', 'DM Sans', sans-serif;
/* Weight: 700-800 for headings, generous letter-spacing (0.02-0.05em) */

/* Body / UI */
font-family: 'DM Sans', 'IBM Plex Sans', sans-serif;
/* Weight: 400 for body, 500 for labels, 600 for emphasis */

/* Monospace (amounts, addresses, technical data) */
font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
/* Weight: 400-500 */
```

**Rules:**
- NEVER use Inter, Roboto, Arial, or system-ui as primary fonts.
- Bitcoin amounts always in monospace.
- Addresses always in monospace, truncated with ellipsis in the middle (e.g., `tb1p...x4f2`).
- Users never see the word "VTXO." Use "position," "balance," or "funds."

## Component Aesthetic

**Cards and surfaces:** Subtle elevation via background color steps (bg-secondary → bg-elevated → bg-surface). No heavy drop shadows. Borders are 1px, subtle, warm gray. Rounded corners: 8-12px.

**Buttons:**
- Primary: Filled with --color-primary, dark text. Used sparingly — one primary CTA per view.
- Secondary: Outlined with --color-border, text in --color-text-primary.
- Destructive: Outlined with --color-danger.

**Status indicators:**
- Agent online: Small green dot, subtle pulse animation (CSS only, no JS).
- Agent refreshing: Amber dot.
- Agent offline/error: Red dot.
- VTXO health: Never use the word "VTXO." Show as "Protection status" — a simple bar or icon.

**Animations:** Minimal. Subtle fade-ins on view transitions. No bouncing, no sliding panels, no parallax. The product communicates quiet competence, not playfulness. One exception: the shem glow on the logo can pulse subtly on agent activity.

## Layout Principles

- **Mobile-first.** The wallet UI will be used primarily on phones.
- **Single-column primary layout.** No complex dashboards for the PoC.
- **Balance is the hero.** The BTC balance should be the largest, most prominent element on the main screen.
- **Agent status is secondary but always visible.** Small indicator showing "Golem is watching" or equivalent.
- **Transactions list below balance.** Simple, chronological, with clear send/receive distinction.

## What This UI is NOT

- Not a trading dashboard (no charts, no candlesticks, no order books)
- Not a crypto exchange (no token listings, no swap widgets front-and-center)
- Not a developer tool (no raw JSON, no hex dumps, no log viewers in the main UI)
- Not a generic AI product (no chatbot interface, no "AI" branding, no purple gradients)

## Reference Products (Aesthetic, Not Feature)

- **Cash App:** Clean balance display, simple send/receive. Aspire to this simplicity.
- **Mercury Bank:** Dark theme, professional, understated fintech.
- **Linear:** Dark UI done right — warm, subtle, not oppressive.
- **Phantom Wallet:** Crypto wallet with actual design taste. Good mobile reference.

## File Structure

```
assets/
  brand/
    golem-logo.png          # Primary logo (dark bg)
    golem-icon.png           # Icon-only mark for small sizes
    golem-wordmark.png       # Text-only wordmark
  fonts/                     # Self-hosted font files if needed
```
