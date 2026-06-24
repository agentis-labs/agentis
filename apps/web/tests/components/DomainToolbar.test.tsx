/**
 * DomainToolbar — subdomain nesting (Phase 5 subdomain management UI).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DomainToolbar, nestedDomainOptions } from '../../src/components/shared/DomainToolbar';

const DOMAINS = [
  { id: 'marketing', name: 'Marketing', parentDomainId: null },
  { id: 'seo', name: 'SEO', parentDomainId: 'marketing' },
  { id: 'inbound', name: 'Inbound', parentDomainId: 'marketing' },
  { id: 'eng', name: 'Engineering', parentDomainId: null },
];

describe('nestedDomainOptions', () => {
  it('orders each subdomain after its parent and labels it "Parent › Sub"', () => {
    const out = nestedDomainOptions(DOMAINS);
    expect(out.map((o) => o.label)).toEqual(['Marketing', 'Marketing › SEO', 'Marketing › Inbound', 'Engineering']);
    expect(out.find((o) => o.id === 'seo')?.depth).toBe(1);
    expect(out.find((o) => o.id === 'marketing')?.depth).toBe(0);
  });
});

describe('<DomainToolbar /> nesting', () => {
  it('renders subdomains indented under their parent with an add-subdomain row', () => {
    const onAddSubdomain = vi.fn();
    render(
      <DomainToolbar
        domains={DOMAINS}
        selected="all"
        onSelect={() => {}}
        totalCount={4}
        countForDomain={() => 0}
        onAddSubdomain={onAddSubdomain}
      />,
    );
    // Open the dropdown.
    fireEvent.click(screen.getByText('All domains'));
    // Subdomains appear as their own selectable rows under the parent.
    expect(screen.getByText('SEO')).toBeInTheDocument();
    expect(screen.getByText('Inbound')).toBeInTheDocument();
    // One "Subdomain" add row per top-level domain (Marketing + Engineering).
    const addRows = screen.getAllByText('Subdomain');
    expect(addRows.length).toBe(2);
    fireEvent.click(addRows[0]!);
    expect(onAddSubdomain).toHaveBeenCalledWith('marketing');
  });
});
