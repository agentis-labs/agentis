# `.agentis` — Portable Workspace Bundle (backup / share / sell)

## Goal

Capture a whole workspace — agents, apps, workflows, extensions, abilities,
integrations, knowledge, (optionally) data — as one `.agentis` artifact an operator
can **back up**, **share**, or **sell**. Built as the workspace-scope superset of the
existing single-app `.agentisapp` packager, **not** a parallel format.

## Architecture

`.agentis` = `workspaceBundleEnvelopeSchema` (core `package.ts`): a
`workspaceBundleManifestSchema` body (composed from the existing per-entity schemas
+ an `apps: AppManifest[]` array) wrapped with a profile + sha256 integrity + provenance.

The **export profile** is the safety dimension, enforced **structurally** (not a UI checkbox):

| Profile | Secrets | Data rows | Embeddings | Path |
|---|---|---|---|---|
| `backup` | included | all | kept | `backup.ts` (whole-DB snapshot) — NOT the manifest path |
| `share` | **never** (slots only) | schema-only | dropped (recompiled on install) | manifest |
| `sell` | **never** | schema-only | dropped | manifest + scrub gate + signature/licence |

Secrets are AES-GCM ciphertext under the `secrets.json` key (`credentials.encryptedValue`);
they ride only inside an encrypted DB via the `backup` path, never inside a manifest.

Install reuses the two **proven** engines rather than a new one:
- workspace-shared entities (agents / bare workflows / extensions / abilities / knowledge)
  → `PackagerService.usePackage` → `activateAgentisPackage` (graph-ref rebind + security scan);
- each Agentic App → `AppPackager.fromManifest` (surfaces + collection schemas).

## Phases

- **P0 — Format + profiles** (core types): `exportProfileSchema`, `workspaceBundleManifestSchema`, `workspaceBundleEnvelopeSchema`, `workspaceBundlePreviewSchema`.
- **P1 — Workspace export**: `WorkspacePackager.toManifest` / `exportWorkspace` enumerate the workspace, reuse per-entity shapers, strip secrets + embeddings by profile.
- **P2 — Unified install**: `WorkspacePackager.installBundle` orchestrates `PackagerService` (shared entities) + `AppPackager.fromManifest` (apps). Checksum + `scanArtifactBytes` gate + `permissionsAcknowledged`.
- **P3 — Backup profile** = full fidelity via `backup.ts` (`createBackup`/`restoreBackup`), wrapped to one artifact. **(shipped — backup/restore endpoints)**
- **P4 — Sell trust layer**: scrub gate + RSA-SHA256 signature + import-time verify + licence surfacing **(shipped)**; commerce/entitlement explicitly out of scope.
- **P5 — Routes + UI**: routes + web export/import surface **(shipped)**.

## Implementation log

### 2026-06-29 — Spine shipped (P0–P2 + P5 backend)
- **P0** `packages/core/src/types/package.ts`: added `exportProfileSchema`, `bundleAuthorSchema`, `workspaceBundleManifestSchema` (composes `agentContentsSchema`/`extensionContentsSchema`/`workflowContentsSchema`/`integrationContentsSchema`/`abilityPackageContentsSchema` + `appManifestSchema[]`), `workspaceBundleEnvelopeSchema` (sha256 + profile + author/license/signature), `workspaceBundlePreviewSchema`. (Reused `appManifestSchema` from `manifest.ts` — no import cycle.)
- **P1+P2** new `apps/api/src/services/workspacePackager.ts`: `toManifest` (enumerates agents, apps→`AppPackager.toManifest`, bare workflows `appId IS NULL`, non-builtin extensions, abilities via `AbilityService.export`, knowledge bases→seeds, credentials→**slots only**; drops embeddings for share/sell); `exportWorkspace` (+ `sell` scrub gate via `registryScanner`); `preview`; `installBundle` (orchestrates `PackagerService` + `AppPackager.fromManifest`; checksum + scan + `permissionsAcknowledged`; backup profile refused on manifest path); `deserialize` (tamper-reject).
- **P5 backend** new `apps/api/src/routes/workspaceBundle.ts` — `POST /v1/workspace/bundle/{export,preview,import}`; wired in `bootstrap.ts`.
- **Tests** `apps/api/tests/services/workspacePackager.test.ts` (6, green): share captures all entities + zero secret leakage (slots only); re-import into a fresh workspace recreates agent/app/collection/workflow/extension; tampered envelope rejected; install without `permissionsAcknowledged` rejected; `sell` blocks on a secret in the payload; backup profile refused on the manifest path.
- `pnpm -r typecheck` green (10 packages).

### 2026-06-29 — P3 + P4 + P5 shipped (full e2e)
- **P4 signing** `workspacePackager.ts`: optional `signer` dep; `sell` exports are RSA-SHA256 signed over the canonical manifest, self-certifying (`signature` + `signerPublicKeyPem` travel in the envelope, core `package.ts`); `deserialize` verifies and rejects a re-checksummed tamper. Bootstrap passes the workspace RS256 keypair from `secrets`.
- **P3 backup** `routes/workspaceBundle.ts`: `POST /backup` (whole-install snapshot via `backup.ts createBackup` → data dir) + `POST /restore` (`restoreBackup`, requires restart). Honest: backup is whole-install + local-filesystem, not workspace-sliced.
- **P5 UI** `apps/web/src/lib/workspaceBundle.ts` (export/preview/import/backup client + `isWorkspaceBundle` guard); `components/packages/WorkspaceBundleModal.tsx` (export profile picker share|sell + licence + full-backup button; import preview = counts + required-credential chips + warnings + signed badge → install). Wired into `PackagesPage`: "Export workspace" header button + `.agentis` files dropped via Import route to the preview/confirm modal (not a silent import).
- **Tests** `workspacePackager.test.ts` now 7 green (added sell signing + re-checksummed-tamper rejection). `pnpm -r typecheck` green (10 packages).
- ⚠️ Not live-smoked over HTTP: the API dev server's first-run boot is environmentally broken here (never bound). Verified at the service layer (the routes are thin wrappers over the tested `WorkspacePackager` + `backup.ts`).

### Still deferred
- **Integrations** enumeration in `toManifest` (currently `[]` — no standalone integrations table; connectors travel via workflow/extension config).
- **Opt-in seed data** for `share` (collections are schema-only on the manifest path; full data only via `backup`).
- **Commerce/entitlement** (payment, license keys) — out of scope by design.
