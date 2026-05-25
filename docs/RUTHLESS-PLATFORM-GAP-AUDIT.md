# Agentis Ruthless Platform Gap Audit

Date: 2026-05-24  
Scope: current working tree, including uncommitted work, with the in-progress Brain/App work treated as context rather than the primary product under review.

## Verdict

Agentis is not release-safe and its current "V1 complete/frozen" posture is not credible.

There is a real product here: the monorepo builds, the platform surface is broad, and substantial implementation exists. That is precisely why the remaining gaps are dangerous. The code now exposes enough execution, credential, browser, webhook, OAuth, and installation surface that unfinished trust boundaries are no longer harmless placeholders.

The worst problems are not polish debt. They are authentication bypass, SSRF-capable workflow primitives, a sandbox that does not enforce its advertised network boundary, broken commissioning/API-key paths, execution paths that create non-durable or invisible runs, and recovery semantics that strand human approvals and subflows after restart.

Do not ship this as "complete", do not encourage third-party skill installation, and do not expose the server outside a tightly controlled local environment until the P0 list is closed and proven by tests.

## Reading Rules

Severity:

| Level | Meaning |
| --- | --- |
| P0 | Release blocker, security boundary failure, data/control-plane corruption, or primary documented path is dead. |
| P1 | Serious product correctness, durability, integrity, or operator trust failure that developers/users will hit. |
| P2 | Significant scalability, operability, UX, documentation, or maintainability failure. |
| P3 | Cleanup debt that will amplify future failures or erode confidence. |

Finding labels:

| Label | Meaning |
| --- | --- |
| CONFIRMED | Directly supported by current code paths. |
| CONTRACT | Code contradicts an advertised/documented contract. |
| BRANCH | Current uncommitted development state; must be fixed before merging, but is not used to dismiss platform fundamentals. |
| PROVE | The implementation is concerning and requires an adversarial/dynamic test before a release claim. |

## Immediate Stop-Ship List

| ID | Sev | Gap | Evidence | Consequence |
| --- | --- | --- | --- | --- |
| AUTH-01 | P0 | Unauthenticated local launch login bypass | `apps/api/src/routes/auth.ts:112-116` exposes `GET /launch` that issues access and refresh JWTs without checking the launch token whenever `NODE_ENV !== 'production'`; `apps/api/src/env.ts:5` defaults to development. `apps/web/tests/App.test.tsx` explicitly tests auto-login via that bare-URL GET path. | Any party that can reach a default/local server can become the operator. |
| API-01 | P0 | Documented bootstrap path is not mounted | `packages/cli/src/commands/bootstrap.ts:172,430` calls `/v1/bootstrap` and `/v1/bootstrap/import`; `apps/api/src/routes/bootstrap.ts` defines the route, but `apps/api/src/bootstrap.ts:434-478` never mounts it. | The agent setup flow in `AGENTS.md` and the CLI quick start fails against the actual app. |
| API-02 | P0 | Settings advertises API keys with no API | `apps/web/src/pages/SettingsPage.tsx:477-507` calls `/v1/auth/api-keys`; `apps/api/src/routes/auth.ts` implements only login, refresh, me, and launch; no API-key persistence surface was found. | The integration/bootstrap authentication story presented to users is non-functional. |
| CODE-01 | P0 | "Sandboxed" transform/run-code expression escapes to Node globals | `apps/api/src/engine/safeExpression.ts:51-99` uses token regexes plus `new Function`; a computed constructor expression was executed during this audit and returned `typeof process === "object"` without containing blocked tokens. It is exposed by workflow transforms and `AgentToolRuntime` `run_code` (`apps/api/src/services/agentToolRuntime.ts:121-124`). | A workflow or tool-using agent can escape the claimed pure-compute boundary into server-side code execution. |
| HOST-01 | P0 | CLI agent adapters disable their own safety boundary by default | `apps/api/src/adapters/CodexAdapter.ts:336-345` adds `--dangerously-bypass-approvals-and-sandbox` unless set to false; `apps/api/src/adapters/ClaudeCodeAdapter.ts:81-99` always uses `--dangerously-skip-permissions`. | Prompt injection or erroneous delegated work can perform unrestricted host actions outside Agentis approvals. |
| NET-01 | P0 | Workflow HTTP node is an SSRF primitive | `apps/api/src/engine/WorkflowEngine.ts:1923-2010` performs raw `fetch(config.url, ...)`, including inline auth, without `assertSafeUrl`; guarded implementations exist elsewhere (`apps/api/src/services/builtinSkills.ts:38`). | A workflow can access loopback, metadata endpoints, or private services and leak results. |
| NET-02 | P0 | Browser node is an unrestricted server-side browser | `apps/api/src/services/browserPool.ts:224-226` calls `page.setContent()` and `page.goto()` for workflow-controlled input without network interception or URL policy. | Workflows can read internal web applications, hit metadata/private resources, or perform arbitrary outbound browsing. |
| SBX-01 | P0 | Docker sandbox egress policy is decorative | `apps/api/src/skills/dockerSandboxRuntime.ts:93,99` puts allowed domains in an environment variable but starts containers with `NetworkMode: 'bridge'`; code inside the container is not forced through a filter. | An untrusted skill can ignore its manifest and exfiltrate data to any reachable host. |
| ENG-01 | P0 | Scheduler/event-chain runs are dequeued without a `workflow_runs` record | `apps/api/src/services/scheduler.ts:297-335` inserts only `workflow_run_queue`; `WorkflowEngine.startRun()` updates an assumed existing row (`apps/api/src/engine/WorkflowEngine.ts:170-198,3039+`), while `drainWorkflowQueue()` does not insert one (`:512-548`). | Scheduled/event-driven runs can run outside durable history, fail FK-backed recording, and disappear from the product. |
| ENG-02 | P0 | Approval and phase-gate resume state is process-memory only | `apps/api/src/engine/WorkflowEngine.ts:2398,2479-2494,2655` stores pending approval targets in `ctx.pendingApprovals`; restart recovery only loads `RUNNING` wait timers (`:240-315`). | A restart strands runs waiting for human decisions, contrary to the core durability promise. |
| ENG-03 | P0 | Subflow parent continuation is process-memory only | `apps/api/src/services/subflowExecutor.ts:61,92-96,133-174` keeps parent callbacks in `#pending`; no reconstruction path exists after restart. | Completed children no longer resume their waiting parents after process interruption. |
| REL-01 | P0 | Container builds intentionally conceal build failure | `Dockerfile:23-25` uses `pnpm ... build || true` for package and API builds. | A container image can build successfully while the backend or shared packages failed to compile. |
| REL-02 | P0 | Current branch violates the CI forbidden-concept check | `.github/workflows/ci.yml:51-54` bans `MemoryEntry`; matches currently exist in `apps/api/src/services/workspaceIntelligence.ts:33` and related references. | Current in-progress branch cannot pass its declared CI policy even though `pnpm build` passes. `BRANCH` |
| REL-03 | P0 | Current branch has a red repository test command | During this audit `pnpm test` failed in `@agentis/web`: reported 10 failed test files, 4 failed tests, and 4 unhandled errors, including stale `WorkflowCanvas.test.tsx` expectations and `src/lib/workspaceData.ts:328` unhandled rejections. | The active feature wave is not merge-ready and release claims cannot use green build/typecheck as a substitute. `BRANCH` |

## Security And Trust Boundaries

### Authentication, Sessions, And Secrets

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| AUTH-02 | P0 | CONFIRMED | Launch token is bypassed by GET and not single-use on POST | The comment for `POST /v1/auth/launch` describes validation of a random launch token, but a sibling GET bypasses it; POST accepts the same token repeatedly. | Remove tokenless login, consume/rotate a one-use token, rate-limit it, and cover exposed non-production binding in security tests. |
| AUTH-03 | P1 | CONTRACT | Refresh sessions are stateless and cannot be revoked or rotated | `apps/api/src/services/auth.ts:104-122` creates JWT refresh tokens; `apps/api/src/routes/auth.ts:85-96` accepts one and issues another. The documented hashed `refresh_tokens` store/session management is absent. | Store hashed refresh sessions, rotate on use, revoke/logout, revoke after credential changes, and test token replay. |
| AUTH-04 | P1 | CONFIRMED | Long-lived credentials live in browser `localStorage` | `apps/web/src/lib/api.ts:4-29` stores both JWTs in `localStorage`. | Move refresh/session material to hardened HttpOnly cookies or explicitly downgrade security claims and defend every script/render surface accordingly. |
| AUTH-05 | P1 | PROVE | Authentication rate limiting is process-local only | `apps/api/src/routes/auth.ts:36-62` explicitly documents an in-memory limiter. | Document single-instance security limits or use shared/persistent throttling before multi-instance/reverse-proxy exposure. |
| SEC-01 | P1 | CONFIRMED | Channel webhook secrets are not one-time secrets | `apps/api/src/routes/channels.ts:8-11` calls disclosure one-time, yet `GET /:id/webhook-info` returns persisted `row.webhookSecret` at `:101-113`; schema stores plaintext in `packages/db/src/sqlite/schema.ts:287,801`. | Encrypt/rotate inbound secrets and reveal only on creation or explicit rotation. |
| SEC-02 | P1 | CONFIRMED | Adapter configuration permits plaintext tokens/secrets to escape the vault pattern | `apps/api/src/routes/agentMutations.ts:400-405` accepts OpenClaw `config.authToken` when there is no credential reference; CLI adapter `env` maps are passed at `:464,480,497,515`. Stored agent config can therefore carry secrets. | Require credential IDs for secret fields, redact existing configuration, and add migration/validation for stored plaintext. |
| SEC-03 | P2 | PROVE | OAuth is not durable and trusts caller-selected return origin | `apps/api/src/services/oauthService.ts:101,112,136,153-156` holds authorization state only in memory; `apps/api/src/routes/oauth.ts:28-29,104-112` accepts an arbitrary HTTP(S) `origin` for `postMessage`. | Bind state durably to an allowed first-party origin and prove restart/multi-instance behavior. |
| SEC-04 | P2 | CONFIRMED | OAuth integration slugs are not provider-validated | `apps/api/src/routes/oauth.ts:27-29` accepts arbitrary `integrationSlug`; `OAuthService.startAuthorization()` picks scopes from it without enforcing `PROVIDER_DEFS[provider].slugs`. | Validate provider/slug pairs and test credential type binding. |

### Network, Rendering, And Executable Content

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| NET-03 | P1 | CONFIRMED | Existing SSRF helper is DNS-rebinding vulnerable | `apps/api/src/services/safeUrl.ts:109-141` and `packages/integrations/src/connectors/http.ts:139-163` validate resolved addresses, then callers fetch the original hostname, allowing a second DNS resolution. | Connect to a validated/pinned address while preserving TLS host verification, and validate every redirect hop. |
| NET-04 | P1 | CONFIRMED | Workflow HTTP node can persist inline secrets in graphs/exports | `WorkflowEngine.#executeHttpRequest` reads `config.auth.token`, username, and password directly at `apps/api/src/engine/WorkflowEngine.ts:1930-1942`. | Require credential vault references, prevent secret serialization, and migrate/redact existing graphs. |
| UI-01 | P1 | PROVE | Generated HTML output is an active exfiltration surface | `apps/web/src/components/workflows/RunOutputCard.tsx:179-226` and `WorkflowArtifactGrid.tsx:117` render workflow-produced HTML with `sandbox="allow-scripts"`. The frame is origin-isolated, but scripts can make outbound requests with data embedded in the output. | Decide whether active scripts are required; default to script-free previews or enforce a frame CSP/network policy and label unsafe output. |
| UI-02 | P1 | CONFIRMED | Hosted previews run scripts with `allow-same-origin` | `apps/web/src/components/workflows/OutputViewers.tsx:288-299,402-416` uses `sandbox="allow-scripts allow-same-origin"` for workflow-controlled URLs. | Remove the dangerous combination or route through an isolated preview origin with URL allowlisting. |
| UI-03 | P1 | PROVE | Workflow output creates arbitrary clickable URLs without a shared sanitizer | `apps/web/src/components/workflows/RunOutputCard.tsx:336-365` renders any record `url` as an anchor; unlike `ChatMarkdown.tsx:360+`, it applies no protocol filter. | Apply one URL sanitization policy across artifact, output, image, video, PDF, website, and deployment viewers. |
| BROWSER-01 | P2 | CONFIRMED | Chromium may be downloaded at first production use | `apps/api/src/bootstrap.ts` documents lazy Chromium installation for `BrowserPool`; browser operations depend on it at runtime. | Bake a pinned browser into the image/install artifact or fail installation preflight, not during a run. |
| CODE-02 | P1 | CONFIRMED | The product describes a security boundary that its evaluator explicitly disclaims | `safeExpression.ts:2-20` claims no I/O/process/network while admitting it is not a hard boundary; `packages/core/src/types/specialist.ts:76` describes `run_code` to agents as sandboxed pure compute. | Replace with a real isolate/parser-based evaluator or remove it from untrusted/agent-controlled execution. |
| HOST-02 | P1 | CONTRACT | Agent runtime configuration is intentionally host-code execution even without the unsafe defaults | Runtime picker permits binary paths, working directories, arguments, and environment (`apps/web/src/components/agents/RuntimePicker.tsx:763-823`); adapters spawn them on the server. | State the trust model plainly, constrain roles capable of configuration, audit executions, and provide a containerized/isolated mode. |
| FS-01 | P1 | CONFIRMED / CONTRACT | Workspace volume says it blocks symlink escapes but only performs lexical path checks | `apps/api/src/services/workspaceVolume.ts:8-12,45-54` claims symlink protection but never calls `realpath`/`lstat`; reads and writes then follow filesystem symlinks at `:68-96`. | Refuse symlink components or validate real parent/target containment for every operation, with escape tests. |
| WS-01 | P2 | CONFIRMED | Realtime server reflects arbitrary CORS origins while accepting credentials | `apps/api/src/websocket/rooms.ts:41-54` configures `cors: { origin: true, credentials: true }`. Token authentication prevents unauthenticated subscriptions, but this discards origin defense in depth. | Restrict origins to configured first-party UI origins and test cross-origin handshakes. |

## Workflow Correctness And Durability

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| WF-01 | P0 | CONFIRMED / CONTRACT | Workflow validation accepts arbitrary node kinds and shapes | `packages/core/src/schemas/workflow.ts:155-187` unions a passthrough fallback `{kind: string}` after stricter schemas. This contradicts the public discriminated-union/exhaustive-validation claim. | Split drafts from executable graphs; reject non-executable/unknown kinds at activation/run time. |
| WF-02 | P0 | CONFIRMED | Accepted unknown nodes have no execution terminal path | `apps/api/src/engine/WorkflowEngine.ts:812-1000` starts a node before a switch that has no unknown-kind default. | Hard-fail unsupported kinds before node start and add a regression test for persisted unknown graph data. |
| WF-03 | P1 | CONFIRMED | Recovery deliberately fails in-flight external work rather than making execution durable | `WorkflowEngine.recoverInterruptedRuns()` at `apps/api/src/engine/WorkflowEngine.ts:240-315` resumes only wait timers and fails other running work. | Either advertise at-most-once interruption failure, or implement operation tokens/idempotency/reconciliation for every external node class. |
| WF-04 | P1 | CONTRACT | "Test node" can perform real side effects | The `dryRunNode` comment in `apps/api/src/engine/WorkflowEngine.ts:320+` states HTTP calls, integration writes, and agent dispatches still occur. | Rename the feature to execution test with explicit warning, or implement mock/simulation boundaries. |
| WF-05 | P1 | CONFIRMED | Webhook idempotency key is globally scoped, not per trigger | `packages/db/src/sqlite/schema.ts:763-772` makes `deliveryId` globally unique; `TriggerRuntime.fireWebhook()` queries it without `triggerId` at `apps/api/src/engine/TriggerRuntime.ts:282-283`. | Use a composite `(trigger_id, delivery_id)` key and return only records belonging to the invoked trigger. |
| WF-06 | P1 | CONFIRMED | Duplicate webhook delivery can trigger duplicate side effects | `TriggerRuntime.fireWebhook()` checks prior delivery, invokes the workflow, then inserts delivery at `apps/api/src/engine/TriggerRuntime.ts:282-311`; concurrent requests race before insertion. | Atomically reserve the idempotency key before dispatch and finalize it transactionally. |
| WF-07 | P1 | CONFIRMED | Scheduling has two overlapping execution mechanisms | `apps/api/src/engine/TriggerRuntime.ts` hydrates `node-cron` jobs, while `apps/api/src/services/scheduler.ts` independently operates `schedule_runs` and queued execution. | Define one durable scheduling contract, migration path, and duplicate-prevention test suite. |
| WF-08 | P1 | PROVE | Async completion after process loss is dropped silently | `WorkflowEngine.notifyTaskCompleted()` returns immediately when a run is not in the in-memory map (`apps/api/src/engine/WorkflowEngine.ts:560+`); recovery does not rebuild external executions. | Store completion correlation durably and test callback arrival before/after restart. |
| WF-09 | P2 | CONFIRMED | Engine runtime state remains significantly in-memory | Running contexts, inflight dispatch count, swarm bookkeeping, approvals, and subflow callbacks live in maps/fields in `WorkflowEngine.ts` and `subflowExecutor.ts`. | Identify all durable invariants and prove crash recovery for each supported node type. |
| WF-10 | P2 | PROVE | Dynamic graph patching and graph snapshots need integrity/version proof | Engine updates graph/run snapshot during execution (`WorkflowEngine.ts:638-694`) while broad fallback config is allowed. | Persist graph version/hash and test replay, patch, recovery, and contract evaluation against the executed snapshot. |
| WF-11 | P0 | CONFIRMED | Agent-controlled `run_code` and workflow-controlled transform are execution capabilities, not deterministic data primitives | Same `CODE-01` escape applies through `AgentToolRuntime.execute(..., 'run_code', ...)` and `WorkflowEngine.#executeTransform()`. Creation guidance promotes transforms as deterministic/cheap safe primitives. | Disable these entry points until backed by a real non-escaping evaluator and adversarial test corpus. |

## Skills, Integrations, Registry, And Knowledge

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| SKILL-01 | P0 | CONFIRMED / CONTRACT | Registry "install" records bookkeeping, not an executable skill | `apps/api/src/routes/skillRegistry.ts:93-106` inserts `installedRegistryArtifacts` with `localResourceId: ''` and says dashboard creation will fill it; it does not create a skill/runtime artifact. | Make install atomic from verified artifact to persisted executable resource, or rename the action to inspect/download. |
| SKILL-02 | P1 | CONFIRMED | Registry permissions acknowledgement is performative | Install body is only `permissionsAcknowledged: true` (`skillRegistry.ts:45-46`); scan findings are known during/after the request. | Present verified manifest permissions and scan output before a second explicit install confirmation. |
| SKILL-03 | P0 | CONFIRMED | Local installed skills cannot satisfy their chosen runtime requirements | `apps/api/src/routes/skills.ts:25` accepts node/docker runtime without source or bundle path; `apps/api/src/services/skillRuntime.ts:70,102-107` requires `manifest.source` or `manifest.bundleDir`. | Implement artifact upload/persistence and validation, or remove unusable install routes from UI/API. |
| SKILL-04 | P1 | CONTRACT | Registry is configured to an external service by default | `apps/api/src/env.ts:39-41` defaults `AGENTIS_SKILL_REGISTRY_URL` to `https://clawhub.ai/api`, contradicting comments and zero-external-dependency/offline-first claims. | Default to disabled/unconfigured and require operator opt-in for outbound registry access. |
| INT-01 | P1 | CONFIRMED | Some advertised connector operations explicitly throw unimplemented | `packages/integrations/src/connectors/apiConnectors.ts:127` throws that operations are not implemented in this build. | Publish the implemented matrix, hide unsupported operations, and require integration contract tests per operation. |
| KB-01 | P1 | CONTRACT | Knowledge retrieval is lexical matching, not embeddings/vector retrieval | `apps/api/src/services/knowledgeBase.ts:77-79,211-239,386-393` stores `lexical-v1` and scores token overlap; architecture documents promise embeddings/cosine similarity. | Correct the documentation/product naming or implement durable embeddings and indexed retrieval. |
| KB-02 | P1 | CONFIRMED | Knowledge document ingestion is unbounded in request memory | `apps/api/src/routes/knowledgeBases.ts:131-163` reads multipart/raw/base64 content into buffers with no content length limit; PDF/DOCX parsers process it in service code. | Add request/body/file/page/token quotas, streaming/temp-file handling, timeout controls, and abuse tests. |
| KB-03 | P1 | CONFIRMED | Search performs an unindexed in-process scan over chunks | `apps/api/src/services/knowledgeBase.ts:211-239` loads candidate chunks and computes scoring in JS per request. | Introduce an indexed retrieval path and enforce per-workspace storage/query ceilings. |
| KB-04 | P2 | PROVE | Parser/runtime dependency risk is not isolated | User documents are fed to PDF/DOCX extraction in the API process (`knowledgeBase.ts:267-299`). | Sandbox/limit parsers, fuzz malformed documents, and establish ingestion failure quarantine. |

## API, Product Surface, And Operator Experience

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| API-03 | P1 | CONTRACT | OpenAPI claims every V1 route but documents only a narrow historical subset | `apps/api/src/openapi.ts:7,27` calls the hand-curated doc the source of truth; `apps/api/src/bootstrap.ts:434-478` mounts many undocumented routes including brain, tools, rooms, teams, budgets, scheduler, integrations, OAuth, artifacts, MCP, and knowledge bases. | Generate the document from route definitions or block route additions without contract coverage. |
| API-04 | P2 | CONFIRMED | Route modules exist without composition-root exposure | `apps/api/src/routes/admin.ts`, `bootstrap.ts`, and `transcripts.ts` define builders not mounted in `apps/api/src/bootstrap.ts`; the bootstrap one is demonstrably required by CLI/docs. | Remove dead modules or mount and test intended public endpoints. |
| API-05 | P2 | PROVE | Workspace-header naming is inconsistent in written/API contracts | `AGENTS.md` direct API example uses `x-agentis-workspace`, while OpenAPI text uses `x-agentis-workspace-id`; CLI/client behavior must be treated as source of truth until reconciled. | Choose one header contract, alias during migration, and test SDK/CLI/OpenAPI agreement. |
| AUDIT-01 | P1 | CONFIRMED / CONTRACT | "Universal" mutation audit silently omits new product surfaces | `apps/api/src/middleware/auditLog.ts:40-57` recognizes only a fixed set; mounted mutating families absent from it include `/v1/brain`, `/v1/issues`, `/v1/knowledge-bases`, `/v1/tools`, `/v1/mcp`, `/v1/oauth`, `/v1/integrations`, `/v1/rooms`, `/v1/spaces`, `/v1/teams`, `/v1/budgets`, `/v1/artifacts`, `/v1/ephemeral`, and scheduler surfaces. | Make audit coverage declarative per route or fail tests for unclassified mutation endpoints. |
| AUDIT-02 | P2 | CONFIRMED | Audit recording failure does not fail the operator mutation | `auditLog.ts:169-174` logs and swallows audit persistence failure after the mutation succeeds. | Decide whether audit is compliance-critical; if so, transact/outbox and surface failures. |
| UI-04 | P2 | CONTRACT | The UI displays capabilities whose backend path is absent or partial | Settings API keys, registry installation, and some document/brain/app surfaces appear navigable while their contracts are absent, bookkeeping-only, or in-progress. | Feature-gate incomplete surfaces and add end-to-end tests for every promoted CTA. |
| DOC-01 | P1 | CONTRACT | Multiple "authoritative" documents claim completeness that code disproves | `README.md`, `docs/V1-SPEC.md`, `docs/AGENTIS-V1-ARCHITECTURE.md`, `docs/PLATFORM-GAPS-PLAN.md`, and `docs/TODO.md` claim complete/frozen features contradicted by findings above. | Replace completion language with an honest capability matrix tied to passing acceptance tests. |
| DOC-02 | P3 | CONFIRMED | Documentation/code comments contain visibly corrupted encoding | Numerous files display mojibake for dashes, section symbols, and arrows, including API/web source comments and docs. | Normalize UTF-8 and add formatting/encoding checks if non-ASCII prose remains in source. |

## Storage, Migrations, Scale, And Operations

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| DB-01 | P1 | CONFIRMED | Schema changes bypass the stated versioned migration system | `packages/db/src/sqlite/migrations.ts` contains only v1 init and v2 agent memories; `packages/db/src/sqlite/index.ts:47-418` runs many table/column/index alterations and rebuilds outside the version registry. | Move every deployed mutation into ordered, recorded migrations with upgrade tests from supported versions. |
| DB-02 | P1 | CONFIRMED | Table rebuild migrations toggle foreign keys outside an explicit atomic migration boundary | `packages/db/src/sqlite/index.ts:278-418` executes rebuild scripts containing `PRAGMA foreign_keys = OFF/ON`; startup calls the embedded migration path before version stamping at `:39-40`. | Use transactional, tested migrations with integrity checks and crash/interruption recovery. |
| DB-03 | P1 | CONTRACT | Durable/runtime claims exceed the single-process storage topology | `apps/api/src/db.ts:48-56` rejects standard/Postgres mode; event bus, OAuth state, limits, and engine state are in process; SQLite is the only supported backend. | Clearly scope V1 to single-instance local operation or deliver a shared durable control plane. |
| DB-04 | P2 | PROVE | Backup, restore, secret rotation, and migration compatibility lack an observed release gate | Docs describe these operations, but the current review did not find a mandatory CI acceptance path exercising a real upgrade/restore with current feature tables. | Add backup/restore and old-schema-to-current test fixtures to release gating. |
| DB-05 | P2 | CONFIRMED | Backups copy the master secrets file in plaintext with no confidentiality or integrity envelope | `apps/api/src/services/backup.ts:12-15,103-123,176-194` copies `secrets.json` verbatim and trusts a JSON manifest; filesystem mode is the only stated protection. | Document that backups are equivalent to root credentials and support operator-supplied encryption/authentication for exported backups. |
| OPS-01 | P1 | CONFIRMED | Default external skill registry undermines local-first privacy and availability | Same evidence as `SKILL-04`; it is also an operational outbound dependency. | Explicit enablement, timeout/circuit behavior, telemetry/redaction policy, and offline test. |
| OPS-02 | P2 | CONFIRMED | Production runtime can mutate itself to obtain browser dependencies | Lazy browser installation documented in `apps/api/src/bootstrap.ts` makes run success depend on network/toolchain at invocation time. | Pin dependencies at install/build and make readiness fail before workflows are accepted. |
| OPS-03 | P2 | PROVE | Resource controls are uneven across execution surfaces | Knowledge ingestion is unbounded, browser loads network pages, workflow HTTP can fetch arbitrary responses, and active output HTML runs scripts; no unified workspace quota/cost/timeout boundary is evident. | Define and enforce quotas for request bytes, artifacts, network response sizes, browser time, concurrent jobs, and storage. |

## Test And Release Reality

| ID | Sev | Status | Finding | Evidence and developer-facing failure | Required close condition |
| --- | --- | --- | --- | --- | --- |
| TEST-01 | P0 | BRANCH | Build success is not CI readiness | On this tree, `pnpm typecheck` and `pnpm build` pass, but the CI terminology guard matches `MemoryEntry` in live source. | Make CI runnable locally and require the identical full gate before merge. |
| TEST-02 | P0 | BRANCH | The repository test command fails in the active development tree | `pnpm test` failed during this review in `@agentis/web`, with palette behavior assertions out of sync and unhandled `workspaceData.ts:328` rejections among the reported failures. | Restore a green repository test command before merging the current feature wave. |
| TEST-03 | P1 | CONFIRMED | The highest-risk failure paths need explicit adversarial tests | The vulnerabilities above are visible by static inspection: launch bypass, unguarded HTTP/browser, fake sandbox egress, missing queued run row, evaluator escape, and memory-only approval/subflow recovery. | Add tests that exploit or reproduce each failure before marking the fix closed. |
| TEST-04 | P1 | CONFIRMED | Composition testing did not prevent a completely unmounted documented API | A route module and CLI both exist for bootstrap, yet the composition root omits the route. | Add full-app contract tests for CLI onboarding and every UI-called endpoint, not only route-builder unit tests. |
| TEST-05 | P2 | CONFIRMED | Hand-curated API documentation cannot reliably track this pace of feature growth | The composition root has far more mounted route families than `openapi.ts`. | Add an automated mounted-route/OpenAPI coverage assertion or generate contracts. |
| REL-04 | P2 | CONFIRMED | Release language is detached from acceptance evidence | Docs mark batches/architecture complete while core setup/security/durability paths are missing or unsafe. | Define release gates by executable acceptance criteria, not roadmap completion checkboxes. |

## Promises That Currently Fail Their Own Claim

| Public/internal claim | What the current implementation actually proves | Impact |
| --- | --- | --- |
| "Spec implementation is complete" / frozen V1 | Bootstrap/API keys are absent from the mounted API; integrations, skills, recovery, knowledge retrieval, and audits are incomplete or contradictory. | Completion claims misdirect engineering and operator trust. |
| "Every external boundary parses via discriminated union" | Workflow config has an arbitrary passthrough fallback and dispatch has no unknown-kind terminal handler. | Invalid executable graphs reach runtime. |
| "Docker sandbox restricts egress to allowed domains" | Container receives a string environment hint while using normal bridge networking. | Third-party code executes with network exfiltration ability. |
| "Durable workflows, approvals, subflows, and scheduling" | Approvals/subflows rely on memory and scheduled queue paths do not insert run records. | Restart and automated execution semantics are not trustworthy. |
| "Registry install" | Install persists an acknowledgement/artifact row with an empty local resource binding. | Operators believe code is installed/secured when it is not runnable. |
| "Knowledge embeddings/vector search" | Search is token overlap scored over stored text chunks. | Retrieval quality and scale differ materially from the product story. |
| "Universal audit trail" | Fixed prefix list omits numerous mounted mutation routes. | Operator history is incomplete exactly on new capabilities. |
| "Zero external dependencies/local-first" | Registry URL defaults to an external ClawHub endpoint and browser may install at first use. | Offline/privacy/operability expectations are false by default. |

## Fix Order That Avoids Self-Deception

### Phase 0: Disable Or Block Unsafe Exposure

1. Remove unauthenticated `GET /v1/auth/launch` and make launch tokens single-use.
2. Disable `transform`/`run_code` until the evaluator is a real security boundary; make unsafe CLI adapter flags opt-in and conspicuous.
3. Disable workflow `http_request`, browser nodes, Docker third-party skill execution, and registry install in any exposed deployment until policy enforcement exists.
4. Remove `|| true` from Docker builds and repair the CI terminology conflict on the in-progress branch.
5. Stop describing the platform as V1 complete in user-facing docs.

### Phase 1: Restore Primary Product Contracts

1. Mount and integration-test `/v1/bootstrap` and `/v1/bootstrap/import`.
2. Either implement API keys end-to-end or remove them from Settings/bootstrap guidance.
3. Make OpenAPI and the CLI/UI endpoint contract match the mounted application.
4. Make skill install an actual verified installation transaction or remove the capability claim.

### Phase 2: Establish Enforced Security Boundaries

1. Centralize URL/egress policy for HTTP, browser, integrations, iframe previews, and skill sandboxes.
2. Replace decorative Docker allowlists with enforced network controls.
3. Replace inline workflow/adapter secrets with credential references and rotate exposed secrets.
4. Implement revocable refresh sessions and harden browser token storage.

### Phase 3: Make Execution Honestly Durable

1. Insert durable run rows before every dispatch source, including scheduler/event chain.
2. Persist approval/subflow correlation and reconstruct all waiting states after restart.
3. Reserve webhook idempotency keys atomically and scope them per trigger.
4. Define the supported interruption behavior for every node type and test it under crash/restart.

### Phase 4: Make Broad Features Real And Operable

1. Replace lexical KB marketing or implement indexed semantic retrieval with quotas.
2. Version all database migrations and run upgrade/backup/restore gates.
3. Complete audit coverage, resource limits, OAuth durability, preview safety, and feature gating.
4. Only then reconsider standard mode, horizontal scale, or public ecosystem language.

## Required Adversarial Acceptance Tests

Do not close this audit with happy-path unit tests. At minimum, add automated proof for:

| Test | Expected safe result |
| --- | --- |
| Request `GET /v1/auth/launch` without a token on a default non-production server | No session issued. |
| Reuse a valid launch token after its first successful exchange | Rejected. |
| Execute computed-property constructor escapes through transform and `run_code` | No access to Node globals, filesystem, processes, imports, network, or timers. |
| Commission Codex/Claude adapters without explicitly selecting unsafe execution | No dangerous permission/sandbox-bypass flag is passed to the child process. |
| Execute `http_request` against `127.0.0.1`, RFC1918, `169.254.169.254`, IPv6 local targets, DNS-rebinding fixture, and redirect-to-private fixture | Blocked before connection and no secret logged/exported. |
| Execute browser navigation/content that tries internal hosts and outbound exfiltration | Blocked or explicitly isolated according to policy. |
| Run an untrusted Docker skill that ignores `AGENTIS_SKILL_ALLOWED_DOMAINS` | Its forbidden outbound connection fails at the network boundary. |
| Trigger a scheduled/event-chain workflow | A durable `workflow_runs` record and consistent ledger/activity history exist before execution. |
| Restart during checkpoint, phase gate, subflow, external callback, and wait | Every supported case resumes or fails according to a documented deterministic contract. |
| Deliver two concurrent webhooks with the same trigger delivery key and two different triggers sharing a key | Exactly-once per trigger, no cross-trigger collision. |
| Install registry/local skills through the UI/API | A runnable, verified resource exists or the request is rejected before claiming installation. |
| Invoke every Settings/CLI onboarding API against the fully composed app | No UI/CLI endpoint targets a missing route. |
| Enumerate all successful mutating mounted endpoints | Each creates a required audit entry or is deliberately documented/exempted. |
| Ingest over-limit PDF/DOCX/base64 and malformed parser inputs | Rejected/quarantined within quotas without process exhaustion. |
| Render hostile workflow HTML and hostile artifact URL values | No UI-token theft, prohibited navigation, or unauthorized network disclosure. |
| Place a symlink inside a workspace volume pointing outside its root, then read/write through tools | Rejected without affecting or revealing the external path. |
| Upgrade and restore databases from every supported released schema | Data and FK integrity verified. |

## Audit Limits

This report is intentionally hostile to unjustified confidence, but it is still a static review of the present working tree, not a claim that no additional bugs exist.

What was verified during this pass:

- Repository architecture, major docs/claims, composition root, auth, workflow execution and recovery, scheduler/trigger paths, sandbox/browser/network helpers, skill registry/runtime, knowledge ingestion/search, OAuth, audit middleware, frontend output rendering, migrations, Dockerfile, CI check, CLI bootstrap calls, and Settings API-key calls were inspected.
- A non-destructive evaluator escape probe confirmed that an expression assembled from computed string properties can access the Node `process` global through `safeExpression`.
- `pnpm typecheck` passed on the current tree.
- `pnpm build` passed on the current tree.
- `pnpm test` failed in the current `@agentis/web` tree, reporting 10 failed test files, 4 failed tests, and 4 unhandled errors.
- The CI forbidden-concept regex has a current match for `MemoryEntry`, so build success does not equal current CI pass.

What still deserves a separate dynamic/red-team pass:

- Live exploit confirmation against a running server for all network/auth paths.
- Full test-suite and end-to-end results after the active Brain/App development settles.
- Dependency vulnerability and supply-chain review.
- Load, disk exhaustion, concurrency, crash-consistency, backup/restore, and migration fuzz testing.
- Fine-grained authorization review of every route and websocket event.

The correct reading is not "these are all possible problems." It is: these are already enough confirmed problems to reject a completeness claim and require a disciplined security/durability closure program.
