import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Alert } from './Alert.js';
import { Dialog } from './Dialog.js';
import { TextField } from './TextField.js';

afterEach(cleanup);

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

describe('TextField', () => {
  it('links label, hint and error for assistive technology', async () => {
    const { container } = render(
      <TextField
        label="Username"
        hint="5–32 characters"
        error="This username is taken"
        defaultValue="asha"
      />,
    );
    const input = screen.getByLabelText('Username');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = described.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['5–32 characters', 'This username is taken']);
    await expectNoAxeViolations(container);
  });

  it('is not marked invalid without an error', () => {
    render(<TextField label="Email" />);
    expect(screen.getByLabelText('Email').hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Alert', () => {
  it('uses assertive roles only for problems', () => {
    render(
      <>
        <Alert tone="danger">Failed</Alert>
        <Alert tone="success">Saved</Alert>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Failed');
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });
});

describe('Dialog', () => {
  it('renders an accessible, labelled dialog and reports Escape as close', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open title="Confirm it is you" description="Enter your password" onClose={onClose}>
        <button type="button">Continue</button>
      </Dialog>,
    );
    const dialog = container.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Confirm it is you',
    );
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });
});
