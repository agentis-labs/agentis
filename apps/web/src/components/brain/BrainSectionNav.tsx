import { BookOpen, Brain, FileCode, Network, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BrainSection = 'map' | 'knowledge' | 'skills' | 'examples' | 'insights';

const SECTIONS: Array<{ value: BrainSection; label: string; icon: ReactNode }> = [
  { value: 'map', label: 'Map', icon: <Network size={12} /> },
  { value: 'knowledge', label: 'Knowledge', icon: <BookOpen size={12} /> },
  { value: 'skills', label: 'Skills', icon: <FileCode size={12} /> },
  { value: 'examples', label: 'Examples', icon: <Sparkles size={12} /> },
  { value: 'insights', label: 'Learning', icon: <Brain size={12} /> },
];

export function BrainSectionNav({
  value,
  onChange,
  className,
  compact = false,
}: {
  value: BrainSection;
  onChange: (value: BrainSection) => void;
  className?: string;
  /** Floating-toolbar mode: active tab shows its label, the rest are icon-only. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div role="tablist" className={clsx('flex items-center gap-0.5', className)}>
        {SECTIONS.map((section) => {
          const active = section.value === value;
          return (
            <button
              key={section.value}
              role="tab"
              type="button"
              aria-selected={active}
              aria-label={section.label}
              title={section.label}
              onClick={() => onChange(section.value)}
              className={clsx(
                'inline-flex h-7 items-center gap-1.5 rounded-md text-[12px] transition-colors',
                active ? 'bg-surface-3 px-2.5 text-text-primary' : 'w-7 justify-center text-text-muted hover:bg-surface-3 hover:text-text-primary',
              )}
            >
              {section.icon}
              {active && section.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="tablist" className={clsx('flex items-center gap-1.5 text-[12px]', className)}>
      {SECTIONS.map((section) => {
        const active = section.value === value;
        return (
          <button
            key={section.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(section.value)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 transition-colors',
              active ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {section.icon}
            {section.label}
          </button>
        );
      })}
    </div>
  );
}



