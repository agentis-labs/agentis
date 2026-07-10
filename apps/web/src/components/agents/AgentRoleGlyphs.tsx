export function OrchestratorGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
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

export function ManagerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
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

export function WorkerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

/**
 * The shared monochrome role glyph — hexagon (orchestrator), diamond (manager),
 * square (specialist/worker). Use this everywhere a role is iconified so the
 * whole app speaks one visual language. Accepts a role or tier string.
 */
export function RoleGlyph({ role, size = 16 }: { role?: string | null; size?: number }) {
  const kind = (role ?? '').toLowerCase();
  if (kind === 'orchestrator') return <OrchestratorGlyph size={size} />;
  if (kind === 'manager') return <ManagerGlyph size={size} />;
  return <WorkerGlyph size={size} />;
}
