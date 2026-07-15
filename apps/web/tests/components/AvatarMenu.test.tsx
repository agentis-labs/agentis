import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AvatarMenu } from '../../src/components/shared/AvatarMenu';
import { useAgentisStore } from '../../src/store/agentisStore';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAvatarMenu(onLogout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AvatarMenu name="Operator" onLogout={onLogout} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('AvatarMenu', () => {
  it('lets operators click portaled menu options', async () => {
    const user = userEvent.setup();
    useAgentisStore.getState().setSettingsOpen(false, 'profile');
    renderAvatarMenu();

    await user.click(screen.getByRole('button', { name: /open profile menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /settings/i }));

    expect(useAgentisStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'workspace' });
    expect(screen.getByTestId('location')).toHaveTextContent('/');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('keeps theme buttons clickable inside the portaled menu', async () => {
    const user = userEvent.setup();
    renderAvatarMenu();

    await user.click(screen.getByRole('button', { name: /open profile menu/i }));
    await user.click(screen.getByRole('button', { name: /light/i }));

    expect(localStorage.getItem('agentis.theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
