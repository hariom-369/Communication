import {
  breakpoints,
  colorRoles,
  font,
  motion,
  palettes,
  radius,
  space,
  text,
  type Theme,
} from './tokens.js';

const kebab = (value: string): string => value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function colorVariables(theme: Theme): string {
  return colorRoles
    .map((role) => `  --t-color-${kebab(role)}: ${palettes[theme][role]};`)
    .join('\n');
}

function staticVariables(): string {
  const lines = [
    ...Object.entries(space).map(([key, value]) => `  --t-space-${key}: ${value};`),
    ...Object.entries(radius).map(([key, value]) => `  --t-radius-${key}: ${value};`),
    `  --t-font-sans: ${font.sans};`,
    `  --t-font-mono: ${font.mono};`,
    ...Object.entries(text).flatMap(([key, value]) => [
      `  --t-text-${key}: ${value.size};`,
      `  --t-leading-${key}: ${value.lineHeight};`,
    ]),
    `  --t-motion-fast: ${motion.fast};`,
    `  --t-motion-base: ${motion.base};`,
    `  --t-motion-slow: ${motion.slow};`,
    `  --t-motion-easing: ${motion.easing};`,
    ...Object.entries(breakpoints).map(([key, value]) => `  --t-breakpoint-${key}: ${value};`),
  ];
  return lines.join('\n');
}

/**
 * Theme stylesheet. The OS preference selects the theme unless the user picks one explicitly
 * (`<html data-theme="light|dark">`, persisted as a non-sensitive UI preference).
 */
export function tokensCss(): string {
  return `/* Generated from src/tokens.ts — do not edit. */
:root {
  color-scheme: light;
${staticVariables()}
${colorVariables('light')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
${colorVariables('dark')}
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
${colorVariables('dark')}
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --t-motion-fast: 0ms;
    --t-motion-base: 0ms;
    --t-motion-slow: 0ms;
  }
}
`;
}
