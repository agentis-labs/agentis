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
