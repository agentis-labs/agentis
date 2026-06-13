export type AmbientKind = 'local' | 'dev' | 'staging' | 'prod' | 'fleet' | 'custom';

export type GatewayStatus = 'connected' | 'degraded' | 'disconnected' | 'error';

export type ApprovalSource =
  | 'checkpoint'
  | 'phase_gate'
  | 'openclaw_exec'
  | 'package_install'
  | 'credential_access';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export type ActivityActorType = 'user' | 'agent' | 'gateway' | 'system' | 'hub';

export type AgentStatus = 'online' | 'busy' | 'offline' | 'error' | 'paused' | 'setting_up';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
}

export interface WorkspaceContext {
  workspaceId: string;
  ambientId: string | null;
  user: AuthenticatedUser;
}
