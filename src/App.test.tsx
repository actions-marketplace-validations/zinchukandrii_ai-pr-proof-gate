import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { safeFixture } from './fixtures';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('AI PR Proof Gate UI', () => {
  it('A1 completes the keyboard-addressable evaluation journey', () => {
    render(<App />);
    const run = screen.getByRole('button', { name: /run proof gate/i });
    run.focus();
    expect(run).toHaveFocus();
    fireEvent.click(run);
    expect(screen.getByTestId('decision')).toHaveTextContent('PASS');
    expect(screen.getByText('PG008')).toBeVisible();
  });

  it('A7 clears a previous PASS after malformed input', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /run proof gate/i }));
    expect(screen.getByTestId('decision')).toHaveTextContent('PASS');
    fireEvent.change(screen.getByLabelText(/pull-request evidence manifest/i), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: /run proof gate/i }));
    expect(screen.queryByTestId('decision')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Malformed JSON');
  });

  it('A9 restores a local draft and Reset removes it', () => {
    const changed = { ...safeFixture, title: 'Restored draft' };
    localStorage.setItem('ai-pr-proof-gate:draft:v1', JSON.stringify(changed));
    render(<App />);
    expect(screen.getByLabelText(/pull-request evidence manifest/i)).toHaveValue(JSON.stringify(changed));
    fireEvent.click(screen.getByRole('button', { name: /reset safe fixture/i }));
    expect(screen.getByLabelText(/pull-request evidence manifest/i)).toHaveValue(JSON.stringify(safeFixture, null, 2));
  });

  it('selects a blocked fixture and exposes the exact rule', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Fixture'), { target: { value: 'outOfScope' } });
    fireEvent.click(screen.getByRole('button', { name: /run proof gate/i }));
    expect(screen.getByTestId('decision')).toHaveTextContent('BLOCKED');
    expect(screen.getByText('PG001')).toBeVisible();
  });
});
