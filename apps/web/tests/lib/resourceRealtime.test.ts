import { describe, expect, it } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core/events';
import { resourceDomainsForEvent } from '../../src/lib/resourceRealtime';

describe('resourceDomainsForEvent', () => {
  it('maps canonical mutations to every affected resource', () => {
    expect(resourceDomainsForEvent(REALTIME_EVENTS.WORKFLOW_UPDATED)).toEqual(['workflows']);
    expect(resourceDomainsForEvent(REALTIME_EVENTS.INTERFACE_PUBLISHED)).toEqual(['apps', 'interfaces']);
    expect(resourceDomainsForEvent(REALTIME_EVENTS.DATA_CHANGED)).toEqual(['apps', 'appData']);
    expect(resourceDomainsForEvent(REALTIME_EVENTS.RUN_FAILED)).toEqual(['runs', 'history']);
    expect(resourceDomainsForEvent(REALTIME_EVENTS.APPROVAL_REQUESTED)).toEqual(['approvals']);
  });
});
