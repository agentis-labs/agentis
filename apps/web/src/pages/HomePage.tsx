import { WorkspaceEcosystemCanvas } from '../components/home/WorkspaceEcosystemCanvas';
import { useWorkspaceData } from '../lib/workspaceData';

export function HomePage() {
  const { me, agents, approvals, activeRuns, failedRuns, artifacts, loading, fleet, counts, issues } = useWorkspaceData();

  return (
    <div className="h-full min-h-0 bg-canvas">
      <WorkspaceEcosystemCanvas
        me={me}
        agents={agents}
        activeRuns={activeRuns}
        artifacts={artifacts}
        snapshotLoading={loading}
        approvals={approvals}
        failedRuns={failedRuns}
        fleet={fleet}
        counts={counts}
        issues={issues}
      />
    </div>
  );
}



