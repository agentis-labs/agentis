import clsx from 'clsx';

export type ChatScopeRole = 'orchestrator' | 'manager' | 'worker';

export interface ChatScopeIdentityInput {
  name: string;
  role: ChatScopeRole;
}

export function formatChatScopeName(scope: ChatScopeIdentityInput): string {
  const trimmedName = scope.name.trim();
  if (trimmedName) return trimmedName;
  if (scope.role === 'orchestrator') return 'Orchestrator';
  if (scope.role === 'manager') return 'Manager';
  return 'Worker';
}

export function formatChatScopeDescriptor(
  scope: ChatScopeIdentityInput,
  workspaceName?: string | null,
): string {
  if (scope.role === 'orchestrator') {
    const trimmedWorkspaceName = workspaceName?.trim();
    return trimmedWorkspaceName ? `${trimmedWorkspaceName} Orchestrator` : 'Orchestrator';
  }
  return scope.role === 'manager' ? 'Manager' : 'Worker';
}

export function formatChatScopePlaceholder(name: string, hasPendingApproval = false): string {
  const trimmedName = name.trim();
  if (!trimmedName) return hasPendingApproval ? 'Review pending approval...' : 'Message...';
  return hasPendingApproval
    ? `Review pending approval or ask ${trimmedName}...`
    : `Ask ${trimmedName}...`;
}

export function ChatScopeGlyph({
  role,
  size = 14,
  className,
}: {
  role: ChatScopeRole;
  size?: number;
  className?: string;
}) {
  if (role === 'orchestrator') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
        <polygon
          points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (role === 'manager') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
        <polygon
          points="8,1.5 14.5,8 8,14.5 1.5,8"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function ChatScopeBadge({
  role,
  active = false,
  size = 14,
  className,
}: {
  role: ChatScopeRole;
  active?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border bg-canvas',
        active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-text-primary',
        className,
      )}
    >
      <ChatScopeGlyph role={role} size={size} />
    </span>
  );
}
