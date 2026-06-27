/**
 * AppTeamStrip — the App's cast at a glance (LIVING-APPS-10X Phase R).
 *
 * Every App is born staffed (an operator + workers seated at creation). This
 * strip makes that visible: an overlapping avatar stack in the App command
 * chrome, owner first with a ring, each agent tipped with its role. Renders
 * nothing until a team loads, so an unstaffed/legacy App shows no clutter.
 */
import { useEffect, useState } from 'react';
import { Crown } from 'lucide-react';
import { appsApi, type AppTeam, type AppTeamMember } from '../../lib/appsApi';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function roleLabel(role: string | null): string {
  if (!role) return '';
  return role.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function Avatar({ member, index }: { member: AppTeamMember; index: number }) {
  const color = member.colorHex ?? '#64748b';
  const tip = `${member.name}${member.functionalRole ? ` · ${roleLabel(member.functionalRole)}` : ''}${member.isOwner ? ' · owner' : ''}`;
  return (
    <span
      title={tip}
      style={{ backgroundColor: `${color}1f`, color, borderColor: `${color}66`, zIndex: 10 - index }}
      className={`relative -ml-1.5 flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold first:ml-0 ${
        member.isOwner ? 'ring-1 ring-accent ring-offset-1 ring-offset-surface' : ''
      }`}
    >
      {member.avatarGlyph ? <span className="text-[11px] leading-none">{member.avatarGlyph}</span> : initials(member.name)}
      {member.isOwner ? (
        <Crown size={9} className="absolute -right-1 -top-1 text-accent" fill="currentColor" />
      ) : null}
    </span>
  );
}

export function AppTeamStrip({ appId, reloadKey = 0 }: { appId: string; reloadKey?: number }) {
  const [team, setTeam] = useState<AppTeam | null>(null);

  useEffect(() => {
    let cancelled = false;
    appsApi.team(appId).then((t) => { if (!cancelled) setTeam(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [appId, reloadKey]);

  if (!team || team.members.length === 0) return null;
  const shown = team.members.slice(0, 5);
  const overflow = team.members.length - shown.length;

  return (
    <div
      className="flex items-center"
      title={`This App's team: ${team.members.map((m) => `${m.name}${m.isOwner ? ' (owner)' : ''}`).join(', ')}`}
    >
      <div className="flex items-center pl-0.5">
        {shown.map((m, i) => <Avatar key={m.agentId} member={m} index={i} />)}
      </div>
      {overflow > 0 ? (
        <span className="-ml-1.5 flex h-6 min-w-6 items-center justify-center rounded-full border border-line bg-surface-2 px-1 text-[10px] font-semibold text-text-muted">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
