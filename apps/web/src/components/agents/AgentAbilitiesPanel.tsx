import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pin, PinOff, Sparkles } from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import { abilitiesApi, compileStatusLabel, compileStatusTone, type Ability, type AbilityPin } from '../../lib/abilities';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Skeleton } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';
import { useToast } from '../shared/Toast';

interface AgentAbilitiesPanelProps {
  agentId: string;
}

/**
 * Pin/unpin workspace abilities for a specific agent.
 *
 * Pinned abilities always inject for this agent regardless of task relevance.
 * Unpinned abilities can still auto-fire when ranked relevant by the shared pool.
 */
export function AgentAbilitiesPanel({ agentId }: AgentAbilitiesPanelProps) {
  const toast = useToast();
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [pins, setPins] = useState<AbilityPin[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setAbilities([]);
      setPins([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [{ abilities: list }, { pins: pinList }] = await Promise.all([
        abilitiesApi.list(),
        abilitiesApi.pins.list(agentId),
      ]);
      setAbilities(list);
      setPins(pinList);
    } catch (err) {
      toast.error('Could not load abilities', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pinById = useMemo(() => new Map(pins.map((pin) => [pin.abilityId, pin])), [pins]);

  async function togglePin(ability: Ability) {
    const pin = pinById.get(ability.id);
    try {
      if (!pin) {
        await abilitiesApi.pins.pin(agentId, ability.id);
        toast.success(`Pinned ${ability.name}`);
      } else if (pin.enabled) {
        await abilitiesApi.pins.setEnabled(agentId, ability.id, false);
        toast.success(`Disabled ${ability.name}`);
      } else {
        await abilitiesApi.pins.setEnabled(agentId, ability.id, true);
        toast.success(`Enabled ${ability.name}`);
      }
      await refresh();
    } catch (err) {
      toast.error('Pin failed', apiErrorMessage(err));
    }
  }

  async function unpin(ability: Ability) {
    try {
      await abilitiesApi.pins.unpin(agentId, ability.id);
      toast.success(`Unpinned ${ability.name}`);
      await refresh();
    } catch (err) {
      toast.error('Unpin failed', apiErrorMessage(err));
    }
  }

  if (!agentId) {
    return (
      <EmptyState
        icon={<Sparkles size={32} />}
        title="Select an agent first"
        body="Choose an active agent to manage pinned abilities."
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, idx) => (
          <Skeleton key={idx} className="h-14 rounded-card" />
        ))}
      </div>
    );
  }

  if (abilities.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={32} />}
        title="No workspace abilities yet"
        body="Create an ability in the workspace to make it available to every agent. Pin abilities here that should always apply to this agent."
        primaryAction={(
          <Link
            to="/agents"
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-medium text-canvas hover:bg-accent-hover"
          >
            Go to Abilities
          </Link>
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-text-muted">
        Pinned abilities <span className="font-medium text-text-secondary">always</span> inject for this agent, regardless of task relevance.
        Unpinned abilities still fire automatically when the workspace pool ranks them relevant. Pins are separate from the ability itself; unpinning here does not delete it.
      </p>
      <ul className="flex flex-col gap-2">
        {abilities.map((ability) => {
          const pin = pinById.get(ability.id);
          const pinned = Boolean(pin && pin.enabled);
          const dirty = ability.compileStatus !== 'ready';
          const tone = compileStatusTone(ability.compileStatus);
          const badgeTone = tone === 'green' ? 'accent' : tone === 'amber' ? 'warn' : tone === 'red' ? 'danger' : 'muted';

          return (
            <li
              key={ability.id}
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-3 py-2.5"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-surface-2 text-[16px]">
                {ability.iconEmoji ?? '\u26A1'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/abilities/${ability.id}`}
                    className="truncate text-[13px] font-medium text-text-primary hover:underline"
                  >
                    {ability.name}
                  </Link>
                  {ability.domainTag && (
                    <span className="rounded-pill border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
                      {ability.domainTag.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-text-muted">
                  {ability.description?.trim() || `Workspace ${ability.domainTag?.replace(/_/g, ' ') ?? 'custom'} specialist`}
                </div>
              </div>
              <StatusBadge
                tone={badgeTone as 'accent' | 'warn' | 'danger' | 'muted'}
                label={compileStatusLabel(ability.compileStatus)}
                pulse={ability.compileStatus === 'compiling'}
                size="sm"
              />
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant={pinned ? 'primary' : 'secondary'}
                  size="sm"
                  iconLeft={<Pin size={12} />}
                  onClick={() => void togglePin(ability)}
                  disabled={dirty && !pinned}
                  title={dirty && !pinned ? 'Compile the ability first to pin it' : undefined}
                >
                  {pinned ? 'Pinned' : pin ? 'Disabled' : 'Pin'}
                </Button>
                {pin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft={<PinOff size={12} />}
                    onClick={() => void unpin(ability)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
