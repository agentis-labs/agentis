/**
 * Domain error taxonomy.
 *
 * Errors are typed by code so the API layer can map them to HTTP responses
 * without leaking internal details, and so the dashboard can render specific
 * remediation copy per failure mode.
 */

export type AgentisErrorCode =
  // Auth
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_FORBIDDEN'
  // Validation
  | 'VALIDATION_FAILED'
  // Resources
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_CONFLICT'
  // Engine
  | 'WORKFLOW_GRAPH_INVALID'
  | 'WORKFLOW_RUN_NOT_FOUND'
  | 'WORKFLOW_RUN_INVALID_STATE'
  // Adapters
  | 'ADAPTER_UNAVAILABLE'
  | 'ADAPTER_TIMEOUT'
  | 'ADAPTER_REJECTED'
  // Skills
  | 'SKILL_NOT_FOUND'
  | 'SKILL_TIMEOUT'
  | 'SKILL_NETWORK_VIOLATION'
  | 'SKILL_DOCKER_UNAVAILABLE'
  | 'SKILL_RUNTIME_UNAVAILABLE'
  | 'SKILL_SSRF_BLOCKED'
  // Trigger
  | 'TRIGGER_INVALID_CONFIG'
  | 'TRIGGER_NOT_ACTIVE'
  // Replay
  | 'REPLAY_TARGET_INVALID'
  // Skill registry
  | 'SKILL_REGISTRY_UNAVAILABLE'
  | 'SKILL_REGISTRY_HASH_MISMATCH'
  | 'SKILL_REGISTRY_SCAN_BLOCKED'
  | 'SKILL_REGISTRY_PERMISSION_NOT_ACKNOWLEDGED'
  // Webhook
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_REPLAY_DETECTED'
  | 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE'
  // Channel bridge (Batch 4)
  | 'CHANNEL_SIGNATURE_INVALID'
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_KIND_UNAVAILABLE'
  | 'CHANNEL_CONNECTION_INACTIVE'
  | 'CHANNEL_BRIDGE_UNAVAILABLE'
  | 'CHANNEL_DISCORD_INBOUND_UNAVAILABLE'
  // Tenancy / safety
  | 'CROSS_WORKSPACE_ACCESS'
  | 'OPERATION_RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface AgentisErrorPayload {
  code: AgentisErrorCode;
  message: string;
  /** Operator-facing remediation hint. Optional. */
  remediation?: string;
  /** Structured detail safe to expose to the client. */
  details?: Record<string, unknown>;
}

export class AgentisError extends Error {
  readonly code: AgentisErrorCode;
  readonly httpStatus: number;
  readonly remediation?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentisErrorCode,
    message: string,
    options: { httpStatus?: number; remediation?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AgentisError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultStatusFor(code);
    this.remediation = options.remediation;
    this.details = options.details;
  }

  toJSON(): AgentisErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function defaultStatusFor(code: AgentisErrorCode): number {
  switch (code) {
    case 'AUTH_INVALID_CREDENTIALS':
    case 'AUTH_TOKEN_EXPIRED':
    case 'AUTH_TOKEN_INVALID':
    case 'CHANNEL_SIGNATURE_INVALID':
      return 401;
    case 'AUTH_FORBIDDEN':
    case 'CROSS_WORKSPACE_ACCESS':
    case 'SKILL_REGISTRY_PERMISSION_NOT_ACKNOWLEDGED':
      return 403;
    case 'RESOURCE_NOT_FOUND':
    case 'WORKFLOW_RUN_NOT_FOUND':
    case 'SKILL_NOT_FOUND':
      return 404;
    case 'RESOURCE_CONFLICT':
    case 'WORKFLOW_RUN_INVALID_STATE':
      return 409;
    case 'VALIDATION_FAILED':
    case 'WORKFLOW_GRAPH_INVALID':
    case 'WEBHOOK_SIGNATURE_INVALID':
    case 'WEBHOOK_REPLAY_DETECTED':
    case 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE':
    case 'SKILL_REGISTRY_HASH_MISMATCH':
    case 'SKILL_REGISTRY_SCAN_BLOCKED':
    case 'SKILL_NETWORK_VIOLATION':
    case 'SKILL_SSRF_BLOCKED':
    case 'TRIGGER_INVALID_CONFIG':
    case 'TRIGGER_NOT_ACTIVE':
    case 'REPLAY_TARGET_INVALID':
    case 'CHANNEL_SEND_FAILED':
    case 'CHANNEL_KIND_UNAVAILABLE':
    case 'CHANNEL_CONNECTION_INACTIVE':
    case 'CHANNEL_DISCORD_INBOUND_UNAVAILABLE':
      return 422;
    case 'OPERATION_RATE_LIMITED':
      return 429;
    case 'ADAPTER_UNAVAILABLE':
    case 'SKILL_REGISTRY_UNAVAILABLE':
    case 'SKILL_DOCKER_UNAVAILABLE':
    case 'SKILL_RUNTIME_UNAVAILABLE':
    case 'CHANNEL_BRIDGE_UNAVAILABLE':
      return 503;
    case 'ADAPTER_TIMEOUT':
    case 'SKILL_TIMEOUT':
      return 504;
    default:
      return 500;
  }
}
