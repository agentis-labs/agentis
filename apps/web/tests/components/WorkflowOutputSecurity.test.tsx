import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunOutputCard } from '../../src/components/workflows/RunOutputCard';
import { WorkflowArtifactGrid } from '../../src/components/workflows/WorkflowArtifactGrid';
import { DeploymentCard, WebsitePreview, safeExternalUrl } from '../../src/components/workflows/OutputViewers';

describe('workflow output security boundaries', () => {
  it('renders generated HTML in passive sandboxed frames', () => {
    const first = render(
      <RunOutputCard
        output={{ nodeId: 'out', nodeTitle: 'HTML', kind: 'return_output', renderAs: 'html', value: '<script>fetch("https://leak.test")</script>' }}
      />,
    );
    expect(screen.getByTitle('HTML output preview')).toHaveAttribute('sandbox', '');
    expect(screen.queryByLabelText('Open in new tab')).not.toBeInTheDocument();
    first.unmount();

    render(
      <WorkflowArtifactGrid
        artifacts={[{ id: 'a1', type: 'html', title: 'page.html', content: '<script>alert(1)</script>' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(screen.getByTitle('Preview of page.html')).toHaveAttribute('sandbox', '');
  });

  it('blocks executable link protocols in output cards', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('https://example.test/report')).toContain('https://example.test/report');
    render(
      <RunOutputCard
        output={{ nodeId: 'out', nodeTitle: 'Link', kind: 'other', value: { url: 'javascript:alert(1)', label: 'click' } }}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('uses passive frames for hosted preview surfaces and rejects unsafe URLs', () => {
    const first = render(<WebsitePreview url="https://example.test/site" />);
    expect(screen.getByTitle('Website preview')).toHaveAttribute('sandbox', '');
    first.unmount();

    const second = render(<DeploymentCard spec={{ url: 'https://example.test/deploy' }} />);
    expect(screen.getByTitle('Deployment preview')).toHaveAttribute('sandbox', '');
    second.unmount();

    render(<WebsitePreview url="javascript:alert(1)" />);
    expect(screen.getByText(/blocked unsafe website url/i)).toBeInTheDocument();
  });
});
