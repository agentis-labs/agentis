# Recording Runbook

Use this for the first public technical demo.

## 60-second version

1. Open **Command Center**.
2. Show the mission board: three projects, multiple managers, active approvals.
3. Open the ops drawer and show workflow rules, live runs, agent trace, approvals.
4. Switch to **Repo Control** and show release blockers tied to repos.
5. Switch to **Automation Lab** and show local mock integrations plus scheduled workflows.
6. Switch to **Launch Studio** and show the publish queue blocked by approval.
7. Close on the message: local agent fleet, multiple apps, observable workflows, approval-gated autonomy.

## 5-minute version

1. Start with the mission:
   `Prepare Agentis, browser-ops-kit, and personal-brain for public launch this week.`
2. Explain the hierarchy:
   The Brain -> managers -> specialists.
3. Show each app as a manager-owned workspace:
   Command Center, Repo Control, Automation Lab, Research Desk, Launch Studio, Operator Desk.
4. Run one workflow from Repo Control.
5. Run one approval-gated workflow from Launch Studio or Operator Desk.
6. Approve it in the approval inbox.
7. Show the new record appearing in the app collection.
8. Export/import framing:
   The entire workspace travels as one `.agentis` bundle with no secrets.

## Technical talking points

- The demo imports through `/v1/workspace/bundle/import`.
- App sample rows are hydrated through `/v1/apps/:id/collections/:name/records`.
- Workflow rules are patched through `/v1/apps/:id/workflows/:wid/binding`.
- Mock services run locally on `127.0.0.1:4747`.
- The default workflows are deterministic, so no paid model keys are required.
- Real adapters can be attached to the seeded manager/specialist agents later.

