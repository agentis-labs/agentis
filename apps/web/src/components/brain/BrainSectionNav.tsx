import { BookOpen, Brain, Network, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BrainSection = 'map' | 'knowledge' | 'insights';

const SECTIONS: Array<{ value: BrainSection; label: string; icon: ReactNode }> = [
  { value: 'map', label: 'Map', icon: <Network size={12} /> },
  { value: 'knowledge', label: 'Knowledge', icon: <BookOpen size={12} /> },
  { value: 'insights', label: 'Learning', icon: <Brain size={12} /> },
];

export function BrainSectionNav({
  value,
  onChange,
  className,
}: {
  value: BrainSection;
  onChange: (value: BrainSection) => void;
  className?: string;
}) {
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
