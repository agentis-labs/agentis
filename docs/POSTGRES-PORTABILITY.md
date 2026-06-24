# Postgres Portability — the gap between "local-first SQLite" and "hosted Postgres"

**Status:** advisory / planning. No port has started.
**Audience:** anyone who believes "the hosted version will just be Postgres."

The embedded SQLite runtime is the OSS, single-user, local-first tier — its
single-writer ceiling is **by design**, not a defect. Scale is supposed to come
from a future hosted Postgres deployment. This document is an honest accounting
of what that port actually costs, because today the gap is much wider than a
config flip, and it widens with every PR that adds a new synchronous DB call.

---

## 1. Where things stand (measured, not assumed)

| | SQLite (embedded) | Postgres (`AGENTIS_DATABASE_URL`) |
|---|---|---|
| Tables defined | **133** (`packages/db/src/sqlite/schema.ts`) | **7** (`packages/db/src/pg/schema.ts`, 123 lines) |
| Indexes defined | 266 live | **0** |
| Driver | `better-sqlite3` — **synchronous** | `postgres-js` — **asynchronous** |
| Brain/recall/observability tables | all present | **none present** |
| Boot in this mode | default | **throws** (`apps/api/src/db.ts`) |

`packages/db/src/pg/schema.ts` is a stub: `users` and a handful of others. None
of the tables this platform's hot paths touch — `knowledge_chunks`,
`memory_episodes`, `observability_events`, `workflow_runs`, `ledger_events` —
exist on the Postgres side, and no indexes are designed there.

## 2. The real cliff: sync → async

`better-sqlite3` returns rows **synchronously**; `postgres-js`
(`PostgresJsDatabase`) returns **Promises**. The application is written entirely
in the synchronous style:

```
~1,322 un-awaited Drizzle calls across 164 files
  .all()  → 317
  .get()  → 457
  .run()  → 548   (postgres-js has no .run(); it's .execute(), different shape)
```

The `DbHandle` abstraction in `apps/api/src/db.ts` can hide the **dialect** but
it **cannot hide sync-vs-async**. Porting therefore is not "swap the handle":

1. `await` every one of those ~1,322 call sites.
2. Make every enclosing function `async`.
3. Propagate `async` up the whole call tree — including the `WorkflowEngine`
   step loop and the synchronous observability writer
   (`apps/api/src/services/observability.ts` `.run()`), which today rely on
   reads returning instantly.
4. Translate `.run()` → `.execute()` and adjust return shapes.

This is a big-bang refactor with a 164-file blast radius, and nothing currently
prevents new code from adding to the pile.

## 3. Findings that carry forward (design them into the PG schema now)

These are **application-logic** problems, not SQLite quirks. They will bite the
hosted tier identically — or worse, because it is multi-tenant and every
statement is a network round-trip instead of an in-process call.

| Finding | Carry-forward note |
|---|---|
| Recall index on `knowledge_chunks` | Fixed for SQLite (migration v78). The PG schema must ship the equivalent `(workspace_id, scope_id, updated_at)` index from day one. PG currently has **0** indexes defined. |
| In-JS cosine over JSON-text embeddings (`KnowledgeStore`, `EpisodicMemoryStore`) | Multi-tenant Postgres is exactly where `pgvector` belongs — push KNN into the DB and store embeddings as a native vector/`BLOB`, not parsed-per-read JSON. Keeping the JS scan wastes the main reason to adopt Postgres. |
| Dashboard recomputes ~10 `count(*)`/`sum()` per request, uncached (`routes/dashboard.ts`) | `count(*)` scans on Postgres too. Use rolling counters (the `workspace_counters` table already exists) or a short-TTL cache. |
| Un-batched writes + N+1 (`routes/conversations.ts`, 4 event writes/step) | **Severity inverts upward.** Cheap in-process on SQLite; on Postgres each statement is a network round-trip. Batch per-step event writes into one transaction. |
| In-memory, auth-only rate limiter (`middleware/rateLimit.ts`) | Breaks across processes. A multi-instance deployment needs a shared store (Redis) and coverage on the expensive read/dispatch endpoints, not just auth. |
| `#runActivity` in-memory map | Fixed (`#disposeRunState`). Dialect-irrelevant; keep it. |

## 4. The single SQLite ceiling that correctly dissolves

The "one writer at a time" wall (WAL + `busy_timeout`) is the *whole point* of
moving to Postgres MVCC. It is not a finding to carry forward — it is the thing
the port exists to remove. Do not over-engineer around it on the SQLite side.

## 5. Recommendation — make the port incremental, not big-bang

1. **Introduce an async-shaped data-access seam now.** Route data access through
   an interface whose methods return `Promise`, even while the implementation
   resolves synchronously on `better-sqlite3` today. Then the Postgres port is
   "swap the implementation," and every new PR is written port-ready by
   construction. This is the highest-leverage move and it can start immediately
   without touching Postgres at all.
2. **Build the PG schema with indexes + `pgvector` designed in** — generated
   from / kept in lockstep with the SQLite schema, not mirrored after the fact.
   Start with the append-only event tables (`observability_events`,
   `activity_events`, `ledger_events`); they're the easiest to migrate and the
   heaviest under load.
3. **Externalize `WorkflowEngine` run state** so a second process can claim
   runs. The `workflow_run_queue` table + `DurableJobQueue` lease model already
   point the right direction.
4. **Load-test against seeded scale before launch** (100k `knowledge_chunks`,
   100k `observability_events` in one workspace). The findings in §3 light up
   far below 1,000 concurrent users — find the cliffs before users do.

Every month this is deferred, the §2 surface grows and the port gets more
expensive. The async-seam (step 1) is what stops the bleeding.
