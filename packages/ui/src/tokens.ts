/**
 * Tessera design tokens — the single source of truth for the visual identity.
 *
 * Identity: "tesserae" are the small tiles of a mosaic. The palette pairs a warm terracotta
 * accent with a deep lagoon secondary on warm neutral "paper"/"slate" surfaces, deliberately
 * distinct from the green/blue/blurple palettes of existing messengers. Shapes use modest,
 * tile-like radii. Every foreground/background pairing used by components is verified against
 * WCAG 2.2 AA in tokens.test.ts, in both themes.
 */

export const colorRoles = [
  'bg',
  'surface',
  'surfaceRaised',
  'border',
  /** Boundary of text fields and other controls identified by their outline (WCAG 1.4.11). */
  'controlBorder',
  'text',
  'textMuted',
  'accent',
  'accentHover',
  'onAccent',
  'accentSubtle',
  'onAccentSubtle',
  'secondary',
  'onSecondary',
  'danger',
  'onDanger',
  'success',
  'warning',
  'focusRing',
  'bubbleOutgoing',
  'onBubbleOutgoing',
  'bubbleIncoming',
  'onBubbleIncoming',
  'skeleton',
] as const;

export type ColorRole = (typeof colorRoles)[number];
export type Theme = 'light' | 'dark';
export type Palette = Readonly<Record<ColorRole, string>>;

export const palettes: Readonly<Record<Theme, Palette>> = {
  light: {
    bg: '#fbf8f4',
    surface: '#ffffff',
    surfaceRaised: '#f3eee7',
    border: '#ddd5ca',
    controlBorder: '#8c8478',
    text: '#1b1a22',
    textMuted: '#5c5866',
    accent: '#a93d19',
    accentHover: '#8f3214',
    onAccent: '#ffffff',
    accentSubtle: '#f8e4da',
    onAccentSubtle: '#5e1f0a',
    secondary: '#0b5f5b',
    onSecondary: '#ffffff',
    danger: '#b42318',
    onDanger: '#ffffff',
    success: '#1c6b3a',
    warning: '#8a5a00',
    focusRing: '#1d5fd1',
    bubbleOutgoing: '#f8e4da',
    onBubbleOutgoing: '#2a140b',
    bubbleIncoming: '#ffffff',
    onBubbleIncoming: '#1b1a22',
    skeleton: '#ebe4da',
  },
  dark: {
    bg: '#121118',
    surface: '#1a1921',
    surfaceRaised: '#24222c',
    border: '#3a3744',
    controlBorder: '#757082',
    text: '#f3f0ea',
    textMuted: '#aaa4b4',
    accent: '#f08a5d',
    accentHover: '#f5a37e',
    onAccent: '#1b0f0a',
    accentSubtle: '#3b2219',
    onAccentSubtle: '#fbd2bf',
    secondary: '#3cc7bd',
    onSecondary: '#06201e',
    danger: '#f97066',
    onDanger: '#240805',
    success: '#5fd08a',
    warning: '#f4c257',
    focusRing: '#7cb7ff',
    bubbleOutgoing: '#3b2219',
    onBubbleOutgoing: '#fbe6dc',
    bubbleIncoming: '#24222c',
    onBubbleIncoming: '#f3f0ea',
    skeleton: '#2a2832',
  },
};

/** Spacing scale in rem (4px base). */
export const space = {
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.5rem',
  6: '2rem',
  7: '3rem',
} as const;

/** Tile-inspired radii: small tiles, cards, and the fully-rounded pill. */
export const radius = { sm: '6px', md: '10px', lg: '16px', pill: '999px' } as const;

/**
 * System font stacks: no third-party font requests from the app origin (strict CSP,
 * docs/security.md §3). A self-hosted brand face can be added later.
 */
export const font = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Devanagari', sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Roboto Mono', monospace",
} as const;

/** Type scale (rem) with line heights tuned for reading chat text. */
export const text = {
  xs: { size: '0.75rem', lineHeight: '1rem' },
  sm: { size: '0.875rem', lineHeight: '1.25rem' },
  md: { size: '1rem', lineHeight: '1.5rem' },
  lg: { size: '1.25rem', lineHeight: '1.75rem' },
  xl: { size: '1.5rem', lineHeight: '2rem' },
} as const;

/** Motion durations. All collapse to 0 under `prefers-reduced-motion: reduce`. */
export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** Layout breakpoints (min-width) for the mobile stack → tablet → desktop 4-pane layouts. */
export const breakpoints = { tablet: '48rem', desktop: '64rem', wide: '90rem' } as const;
