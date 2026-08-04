import { describe, expect, it } from 'vitest';
import { deriveSurface } from '../../src/lib/viewportContext';

describe('deriveSurface', () => {
  it('drops stale interface state when the workflow facet is active', () => {
    expect(deriveSurface('/apps/app-1', '?facet=workflow&page=surface&mode=live&node=node-1')).toEqual({
      surface: 'app_detail',
      resourceKind: 'app',
      resourceId: 'app-1',
      title: 'App · Workflow',
      facet: 'workflow',
    });
  });

  it('keeps the selected page only while the interface is active', () => {
    expect(deriveSurface('/apps/app-1', '?facet=interface&page=news-dashboard&mode=edit&node=hero')).toEqual({
      surface: 'app_detail',
      resourceKind: 'app',
      resourceId: 'app-1',
      title: 'App · Interface',
      page: 'news-dashboard',
      mode: 'edit',
      selectedNodeId: 'hero',
      facet: 'interface',
    });
  });
});
