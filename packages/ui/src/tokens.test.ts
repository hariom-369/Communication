import { describe, expect, it } from 'vitest';

import { contrastRatio } from './contrast.js';
import { tokensCss } from './css.js';
import { colorRoles, palettes, type ColorRole, type Theme } from './tokens.js';

/** WCAG 2.2: 4.5:1 for normal text (1.4.3), 3:1 for UI components and focus indicators (1.4.11). */
const TEXT = 4.5;
const NON_TEXT = 3;

const textPairs: readonly [ColorRole, ColorRole][] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surfaceRaised'],
  ['textMuted', 'bg'],
  ['textMuted', 'surface'],
  ['textMuted', 'surfaceRaised'],
  ['onAccent', 'accent'],
  ['onAccent', 'accentHover'],
  ['onAccentSubtle', 'accentSubtle'],
  ['onSecondary', 'secondary'],
  ['onDanger', 'danger'],
  ['accent', 'bg'], // ghost buttons / links
  ['accent', 'surface'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['success', 'bg'],
  ['warning', 'bg'],
  ['onBubbleOutgoing', 'bubbleOutgoing'],
  ['onBubbleIncoming', 'bubbleIncoming'],
];

const nonTextPairs: readonly [ColorRole, ColorRole][] = [
  ['focusRing', 'bg'],
  ['focusRing', 'surface'],
  ['focusRing', 'surfaceRaised'],
  ['accent', 'bg'],
  ['controlBorder', 'bg'],
  ['controlBorder', 'surface'],
  ['controlBorder', 'surfaceRaised'],
];

describe.each<Theme>(['light', 'dark'])('%s palette', (theme) => {
  const palette = palettes[theme];

  it('defines every colour role as #rrggbb', () => {
    for (const role of colorRoles) expect(palette[role]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(textPairs)('%s on %s meets 4.5:1', (fg, bg) => {
    expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(nonTextPairs)('%s against %s meets 3:1', (fg, bg) => {
    expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

describe('contrastRatio', () => {
  it('matches known reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

describe('tokensCss', () => {
  const css = tokensCss();

  it('follows the OS theme unless the user chose one explicitly', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain(`--t-color-bg: ${palettes.dark.bg};`);
    expect(css).toContain(`--t-color-bg: ${palettes.light.bg};`);
  });

  it('disables motion for users who prefer reduced motion', () => {
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('--t-motion-base: 0ms;');
  });
});
