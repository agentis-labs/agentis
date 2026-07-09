import clsx from 'clsx';
import { ManagerGlyph, OrchestratorGlyph, WorkerGlyph } from './AgentRoleGlyphs';

export type AgentSetupRole = 'orchestrator' | 'manager' | 'worker';

export interface AgentSetupAgent {
  id: string;
  name: string;
  role?: string | null;
}

export interface AgentImportSetupValue {
  name: string;
  role: AgentSetupRole;
  reportsTo: string;
}

export interface AgentImportOverrides {
  name?: string;
  role?: string | null;
  reportsTo?: string | null;
}

type GlyphComponent = (props: { size?: number }) => JSX.Element;

const ROLE_OPTIONS: Array<{
  value: AgentSetupRole;
  title: string;
  subtitle: string;
  icon: GlyphComponent;
}> = [
  {
    value: 'orchestrator',
    title: 'Orchestrator',
    subtitle: 'Owns workspace routing. Only one can exist.',
    icon: OrchestratorGlyph,
  },
  {
    value: 'manager',
    title: 'Manager',
    subtitle: 'Coordinates a domain under the orchestrator.',
    icon: ManagerGlyph,
  },
  {
    value: 'worker',
    title: 'Specialist',
    subtitle: 'Focused execution agent with its own Brain.',
    icon: WorkerGlyph,
  },
];

export function normalizeAgentSetupRole(role?: string | null): AgentSetupRole {
  if (role === 'orchestrator' || role === 'manager') return role;
  return 'worker';
}

export function createDefaultAgentImportSetup({
  name,
  role,
  existingAgents,
  preferOrchestratorWhenEmpty = false,
}: {
  name?: string | null;
  role?: string | null;
  existingAgents: AgentSetupAgent[];
  preferOrchestratorWhenEmpty?: boolean;
}): AgentImportSetupValue {
  const orchestrator = findOrchestrator(existingAgents);
  let nextRole = role ? normalizeAgentSetupRole(role) : preferOrchestratorWhenEmpty && !orchestrator ? 'orchestrator' : 'worker';
  if (nextRole === 'orchestrator' && orchestrator) nextRole = 'worker';
  return {
    name: name?.trim() || 'Imported agent',
    role: nextRole,
    reportsTo: defaultReportsTo(nextRole, existingAgents),
  };
}

export function agentImportSetupToOverrides(value: AgentImportSetupValue): AgentImportOverrides {
  return {
    name: value.name.trim(),
    role: value.role,
    reportsTo: value.role === 'orchestrator' ? undefined : value.reportsTo || undefined,
  };
}

export function AgentImportSetupPanel({
  value,
  existingAgents,
  onChange,
  compact = false,
}: {
  value: AgentImportSetupValue;
  existingAgents: AgentSetupAgent[];
  onChange: (value: AgentImportSetupValue) => void;
  compact?: boolean;
}) {
  const orchestrator = findOrchestrator(existingAgents);
  const supervisors = supervisorOptions(value.role, existingAgents);
  const roleMeta = ROLE_OPTIONS.find((option) => option.value === value.role);

  function patch(update: Partial<AgentImportSetupValue>) {
    onChange({ ...value, ...update });
  }

  function setRole(role: AgentSetupRole) {
    patch({ role, reportsTo: defaultReportsTo(role, existingAgents) });
  }

  return (
    <section className={clsx('space-y-3', !compact && 'rounded-lg border border-line bg-surface-2 p-3')}>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-text-secondary">Name</span>
        <input
          value={value.name}
          onChange={(event) => patch({ name: event.target.value })}
          className={inputCls}
          placeholder="Agent name"
        />
      </label>

      <div className="space-y-2">
        <span className="text-xs font-medium text-text-secondary">Role</span>
        <div className="flex flex-wrap gap-2">
          {ROLE_OPTIONS.map((option) => {
            const GlyphIcon = option.icon;
            const selected = value.role === option.value;
            const blocked = option.value === 'orchestrator' && Boolean(orchestrator) && value.role !== 'orchestrator';
            return (
              <button
                key={option.value}
                type="button"
                disabled={blocked}
                title={blocked ? `An orchestrator already exists: ${orchestrator?.name}` : option.subtitle}
                onClick={() => setRole(option.value)}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                  selected ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-text-secondary hover:border-accent/40 hover:text-text-primary',
                  blocked && 'cursor-not-allowed opacity-40',
                )}
              >
                <GlyphIcon size={11} />
                {option.title}
                {blocked && <span className="text-[10px] text-text-muted">(exists)</span>}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-text-muted">{roleMeta?.subtitle}</p>
      </div>

      {value.role === 'orchestrator' ? (
        <div className={clsx('rounded-lg border px-3 py-2.5 text-[12px]', orchestrator ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-bg-base text-text-muted')}>
          {orchestrator
            ? `A workspace orchestrator already exists: ${orchestrator.name}.`
            : 'This agent will become the workspace orchestrator.'}
        </div>
      ) : (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-text-secondary">{value.role === 'manager' ? 'Reports to' : 'Supervised by'}</span>
          <select value={value.reportsTo} onChange={(event) => patch({ reportsTo: event.target.value })} className={inputCls}>
            <option value="">{value.role === 'manager' ? 'No orchestrator selected' : 'No supervisor selected'}</option>
            {supervisors.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}{agent.role ? ` - ${roleLabel(agent.role)}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

const inputCls = 'w-full rounded-input border border-line bg-bg-base px-3 py-2 text-sm text-text-primary outline-none transition focus:border-accent';

function findOrchestrator(agents: AgentSetupAgent[]): AgentSetupAgent | null {
  return agents.find((agent) => agent.role === 'orchestrator') ?? null;
}

function managers(agents: AgentSetupAgent[]): AgentSetupAgent[] {
  return agents.filter((agent) => agent.role === 'manager');
}

function supervisorOptions(role: AgentSetupRole, agents: AgentSetupAgent[]): AgentSetupAgent[] {
  const orchestrator = findOrchestrator(agents);
  if (role === 'manager') return orchestrator ? [orchestrator] : [];
  if (role === 'worker') return [...managers(agents), ...(orchestrator ? [orchestrator] : [])];
  return [];
}

function defaultReportsTo(role: AgentSetupRole, agents: AgentSetupAgent[]): string {
  const options = supervisorOptions(role, agents);
  return options[0]?.id ?? '';
}

function roleLabel(role: string): string {
  if (role === 'orchestrator') return 'orchestrator';
  if (role === 'manager') return 'manager';
  return 'specialist';
}
