import { describe, expect, it } from 'vitest';
import { deriveSurface } from '../../src/lib/viewportContext';

/**
 * The chat's viewport awareness is gated off when the surface is 'unknown'
 * (see ThreadView `awarenessActive`). Apps/app-detail/workflow routes must map
 * to real surfaces so the operator chat actually knows where the user is.
 */
describe('deriveSurface', () => {
  it('maps the Apps index to a real surface', () => {
    expect(deriveSurface('/apps')).toMatchObject({ surface: 'apps', title: 'Apps' });
  });

  it('maps an App detail route to app_detail with the app as the resource', () => {
    expect(deriveSurface('/apps/app-123')).toMatchObject({
      surface: 'app_detail',
      resourceKind: 'app',
      resourceId: 'app-123',
    });
  });

  it('folds the facet into the title so the agent knows which part of the App is open', () => {
    expect(deriveSurface('/apps/app-123', '?facet=workflow')).toMatchObject({
      surface: 'app_detail',
      resourceKind: 'app',
      resourceId: 'app-123',
      title: 'App · Workflow',
    });
  });

  it('maps a workflow detail route', () => {
    expect(deriveSurface('/workflows/wf-1')).toMatchObject({ surface: 'workflow_detail', resourceKind: 'workflow', resourceId: 'wf-1' });
  });

  it('never returns the inert "unknown" surface for app routes', () => {
    for (const route of ['/apps', '/apps/x', '/apps/x?facet=interface', '/workflows', '/workflows/y']) {
      const [path, search] = route.split('?');
      expect(deriveSurface(path ?? '/', search ? `?${search}` : '').surface).not.toBe('unknown');
    }
  });
});
