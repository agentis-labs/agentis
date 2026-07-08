interface BudgetBarProps {
  currentCents?: number | null;
  limitCents?: number | null;
}

export function BudgetBar({ currentCents, limitCents }: BudgetBarProps) {
  const current = currentCents ?? 0;
  const limit = limitCents ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span>This month</span>
        <span>{money(current)}{limit > 0 ? ` / ${money(limit)}` : ''}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}


