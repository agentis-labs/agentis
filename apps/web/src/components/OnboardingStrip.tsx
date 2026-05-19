import { lazy, Suspense, useEffect, useState } from 'react';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../lib/workspaceData';

type WizardPreset = {
  role: 'orchestrator' | 'manager';
  spaceId?: string | null;
};

const AgentCreateWizard = lazy(() => import('./agents/AgentCreateWizard').then((m) => ({ default: m.AgentCreateWizard })));

export function OnboardingStrip() {
  const { spaces } = useWorkspaceData();
  const [wizardPreset, setWizardPreset] = useState<WizardPreset | null>(null);

  const wizardSpace = wizardPreset?.spaceId
    ? spaces.find((s) => s.id === wizardPreset.spaceId) ?? null
    : null;

  useEffect(() => {
    const onOrchestrator = () => setWizardPreset({ role: 'orchestrator' });
    const onManager = (e: Event) => {
      const spaceId = (e as CustomEvent<{ spaceId?: string }>).detail?.spaceId ?? null;
      setWizardPreset({ role: 'manager', spaceId });
    };
    window.addEventListener('agentis:commission-orchestrator', onOrchestrator);
    window.addEventListener('agentis:commission-manager', onManager);
    return () => {
      window.removeEventListener('agentis:commission-orchestrator', onOrchestrator);
      window.removeEventListener('agentis:commission-manager', onManager);
    };
  }, []);

  if (!wizardPreset) return null;

  return (
    <Suspense fallback={null}>
    <AgentCreateWizard
      open
      initialRole={wizardPreset?.role}
      initialSpaceId={wizardPreset?.spaceId ?? undefined}
      lockInitialRole={Boolean(wizardPreset?.role)}
      heading={wizardPreset?.role === 'orchestrator'
        ? 'Commission your orchestrator'
        : wizardPreset?.role === 'manager'
          ? `Assign a manager${wizardSpace ? ` for ${wizardSpace.name}` : ''}`
          : undefined}
      intro={wizardPreset?.role === 'orchestrator'
        ? 'This is the workspace brain. Give it a runtime first so every other surface has a real command target.'
        : wizardPreset?.role === 'manager'
          ? `Managers are optional, but ${wizardSpace?.name ?? 'this space'} will operate more cleanly with a coordinator above its workers and workflows.`
          : undefined}
      onClose={() => setWizardPreset(null)}
      onCreated={() => {
        setWizardPreset(null);
        void refreshWorkspaceSnapshot();
      }}
    />
    </Suspense>
  );
}
