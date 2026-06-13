/**
 * @agentis/core errors — code → http status mapping + payload shape.
 *
 * AgentisError is the wire-shape contract between API and dashboard. A
 * regression in `httpStatus` or `toJSON()` ripples into every error UI.
 */

import { describe, it, expect } from 'vitest';
import { AgentisError, type AgentisErrorCode } from '@agentis/core';

const CODE_TO_STATUS: Array<[AgentisErrorCode, number]> = [
  ['AUTH_INVALID_CREDENTIALS', 401],
  ['AUTH_TOKEN_EXPIRED', 401],
  ['AUTH_TOKEN_INVALID', 401],
  ['AUTH_FORBIDDEN', 403],
  ['CROSS_WORKSPACE_ACCESS', 403],
  ['EXTENSION_REGISTRY_PERMISSION_NOT_ACKNOWLEDGED', 403],
  ['RESOURCE_NOT_FOUND', 404],
  ['WORKFLOW_RUN_NOT_FOUND', 404],
  ['EXTENSION_NOT_FOUND', 404],
  ['RESOURCE_CONFLICT', 409],
  ['WORKFLOW_RUN_INVALID_STATE', 409],
  ['VALIDATION_FAILED', 422],
  ['WORKFLOW_GRAPH_INVALID', 422],
  ['WEBHOOK_SIGNATURE_INVALID', 422],
  ['WEBHOOK_REPLAY_DETECTED', 422],
  ['WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 422],
  ['EXTENSION_REGISTRY_HASH_MISMATCH', 422],
  ['EXTENSION_REGISTRY_SCAN_BLOCKED', 422],
  ['EXTENSION_NETWORK_VIOLATION', 422],
  ['EXTENSION_SSRF_BLOCKED', 422],
  ['TRIGGER_INVALID_CONFIG', 422],
  ['TRIGGER_NOT_ACTIVE', 422],
  ['REPLAY_TARGET_INVALID', 422],
  ['OPERATION_RATE_LIMITED', 429],
  ['OPERATION_CANCELED', 499],
  ['ADAPTER_UNAVAILABLE', 503],
  ['EXTENSION_REGISTRY_UNAVAILABLE', 503],
  ['EXTENSION_DOCKER_UNAVAILABLE', 503],
  ['EXTENSION_RUNTIME_UNAVAILABLE', 503],
  ['ADAPTER_TIMEOUT', 504],
  ['EXTENSION_TIMEOUT', 504],
  ['ADAPTER_REJECTED', 500],
  ['INTERNAL_ERROR', 500],
];

describe('AgentisError', () => {
  it.each(CODE_TO_STATUS)('maps %s to HTTP %i', (code, status) => {
    const err = new AgentisError(code, 'demo');
    expect(err.httpStatus).toBe(status);
  });

  it('honors an explicit httpStatus override', () => {
    const err = new AgentisError('VALIDATION_FAILED', 'demo', { httpStatus: 418 });
    expect(err.httpStatus).toBe(418);
  });

  it('toJSON includes code + message but omits empty optionals', () => {
    const err = new AgentisError('RESOURCE_NOT_FOUND', 'gone');
    expect(err.toJSON()).toEqual({ code: 'RESOURCE_NOT_FOUND', message: 'gone' });
  });

  it('toJSON includes remediation + details when present', () => {
    const err = new AgentisError('AUTH_TOKEN_INVALID', 'bad', {
      remediation: 'Re-login',
      details: { hint: 'try again' },
    });
    expect(err.toJSON()).toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
      message: 'bad',
      remediation: 'Re-login',
      details: { hint: 'try again' },
    });
  });

  it('inherits from Error so `instanceof Error` works', () => {
    const err = new AgentisError('INTERNAL_ERROR', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentisError');
  });
});
