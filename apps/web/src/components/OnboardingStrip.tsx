import { lazy, Suspense, useEffect, useState } from 'react';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../lib/workspaceData';

type WizardPreset = {
  role: 'orchestrator' | 'manager';
};

const AgentCreateWizard = lazy(() => import('./agents/AgentCreateWizard').then((m) => ({ default: m.AgentCreateWizard })));

export function OnboardingStrip() {
  const [wizardPreset, setWizardPreset] = useState<WizardPreset | null>(null);

  useEffect(() => {
    const onOrchestrator = () => setWizardPreset({ role: 'orchestrator' });
    const onManager = () => setWizardPreset({ role: 'manager' });
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
      lockInitialRole={Boolean(wizardPreset?.role)}
      heading={wizardPreset?.role === 'orchestrator'
        ? 'Commission your orchestrator'
        : wizardPreset?.role === 'manager'
          ? 'Commission a manager'
          : undefined}
      intro={wizardPreset?.role === 'orchestrator'
        ? 'This is the workspace orchestrator. Give it a runtime first so every other surface has a real command target.'
        : wizardPreset?.role === 'manager'
          ? 'Managers are optional, but the workspace will operate more cleanly with a coordinator above its specialists and workflows.'
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



