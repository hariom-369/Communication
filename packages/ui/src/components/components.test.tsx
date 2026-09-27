import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button.js';
import { Skeleton } from './Skeleton.js';

afterEach(cleanup);

async function expectNoAxeViolations(container: HTMLElement) {
  // Colour contrast is verified on the tokens (jsdom has no layout/styles for axe to measure).
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

describe('Button', () => {
  it('is a non-submitting button by default and invokes onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('blocks activation, stays focusable and announces progress while loading', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading loadingLabel="Sending message">
        Send
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.textContent).toContain('Sending message');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(
      <div>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger" loading>
          Delete
        </Button>
        <Button variant="ghost" disabled>
          Ghost
        </Button>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', async () => {
    const { container } = render(
      <div role="status" aria-busy="true" aria-label="Loading conversations">
        <Skeleton shape="circle" width="2rem" height="2rem" />
        <Skeleton />
      </div>,
    );
    for (const element of container.querySelectorAll('.t-skeleton')) {
      expect(element.getAttribute('aria-hidden')).toBe('true');
    }
    await expectNoAxeViolations(container);
  });
});
