# Agentis OAuth Strategy — One Smooth Flow Across Every Distribution

**Status:** Strategy RFC (implementation pending)
**Date:** June 10, 2026
**Scope:** How Agentis users authorize external sources (Slack, Google, GitHub, Notion, …) for connectors, channels, and the Workspace Brain's `KnowledgeSource` sync — across every way Agentis ships: **open-source self-host (GitHub)**, **downloadable desktop app**, and **hosted web**.
**Relationship to existing code:** extends the shipped `OAuthService` + `CredentialVault` (AES-256-GCM at rest) and the CORA Source Fabric's `SourceSyncContext.accessToken` resolution. No parallel token store, ever.

---

## 1. The Problem

OAuth is where open-source agent platforms traditionally break in three ways:

1. **The client-secret problem.** Providers issue a `client_id` + `client_secret`. A secret committed to a public repo is burned; a secret embedded in a desktop binary is extractable. Open-source projects therefore either ship broken OAuth or force every user to create their own developer app — ten browser tabs, redirect-URI copy-pasting, scope checklists. That is the opposite of the Brain's "60–120 seconds of owner attention" onboarding budget.
2. **The redirect problem.** Hosted web apps can register `https://app.agentis.dev/callback`; a self-hosted instance lives at `http://192.168.1.50:3001` or behind Tailscale; a desktop app has no stable URL at all. One registered redirect URI cannot serve all three.
3. **The distribution problem.** The user explicitly requires the experience be *unique and smooth* regardless of distribution. A flow that works only on the hosted web tier creates a two-class product and kills the open-source value proposition.

## 2. Design Principles

1. **One mental model everywhere:** the user clicks **Connect**, a browser opens, they approve, the window closes, the source is connected. Whatever happens underneath must converge on that.
2. **Secrets never ship.** No `client_secret` in the repo, in binaries, or in localStorage. PKCE where the provider supports public clients; a broker where it does not.
3. **Tokens live in the user's vault.** Whatever path issues the token, the refresh + access tokens land ONLY in the local `CredentialVault` (AES-256-GCM, user-held key). The broker (when used) is a **pass-through exchanger, not a token store**.
4. **Self-host never depends on Agentis infrastructure.** The broker is a convenience default, not a requirement. BYO-app mode must be first-class and well-documented.
5. **Extend, don't duplicate.** One `OAuthService`, one vault, one connection model shared by workflow connectors, channels, and CORA `KnowledgeSource`s.

## 3. The Architecture: Three Rungs, One Flow

Every connection attempt resolves down this ladder automatically — the user never chooses a "mode":

```text
Rung 1: PKCE public client (no secret anywhere)        — preferred
Rung 2: Agentis Connect broker (hosted secret keeper)  — default for secret-requiring providers
Rung 3: BYO developer app (user-supplied credentials)  — always available, required for full self-host autonomy
```

### 3.1 Rung 1 — PKCE public clients (no secret at all)

Where the provider supports **OAuth 2.1 public clients with PKCE** and loopback/custom-scheme redirects, Agentis registers ONE public client per provider and bakes only the **client_id** (public by definition) into the codebase:

- Flow: `authorization_code` + PKCE (S256), `state` for CSRF, no client secret.
- Redirect: **loopback** — the local API briefly listens on `http://127.0.0.1:{port}/oauth/callback` (RFC 8252 §7.3; Google explicitly supports per-request loopback ports for desktop clients).
- Works identically for: desktop app (spawns system browser), self-host (server opens/prints the URL), hosted web (standard redirect).
- Provider reality check: **GitHub** (device flow + PKCE-capable Apps), **Google** ("Desktop app" client type: PKCE, loopback, secret treated as non-confidential) qualify today. **Slack** does not (secret required, no device flow) → Rung 2.

### 3.2 Rung 2 — "Agentis Connect", the stateless token broker

For providers that demand a confidential client (Slack, Notion, most CRMs), Anthropic-style OSS projects converge on a small hosted broker. Ours:

- **A tiny stateless service** (`connect.agentis.dev`) holding the provider `client_secret`s. Open-source its code too — the *secrets* are the only private part, so self-hosters can run their own broker with their own apps.
- Flow:
  1. Local Agentis generates PKCE verifier + state, opens `https://connect.agentis.dev/start/{provider}?state=…&code_challenge=…&return=…`.
  2. Broker redirects to the provider with ITS client_id/secret and its stable registered redirect URI.
  3. On callback, the broker exchanges code→tokens **in memory**, then immediately hands tokens to the user's instance via the `return` channel (below) and forgets them. **No database. No token at rest. Nothing to breach.**
  4. Local instance stores tokens in the vault.
- **Return channel** (the redirect problem solved): the broker's final page POSTs the sealed token bundle to the user's loopback (`http://127.0.0.1:{port}`) when reachable, or renders a one-time **copy code** (encrypted to the instance's ephemeral public key sent in step 1) the user pastes into Agentis — the universal fallback that works through any NAT/VPN/headless SSH session.
- Sealing: tokens are encrypted by the broker to the X25519 public key the local instance generated for this attempt — even the copy-paste blob is useless to an interceptor. The broker can never decrypt traffic it relayed after the fact; the instance key is single-use.
- Trust posture, documented loudly in the README: the broker sees tokens **in transit, in memory, once**. Users who don't accept that use Rung 3 with zero feature loss.
- Refresh: refresh happens **locally** when the provider allows public refresh; where a secret is required for refresh (Slack token rotation), the instance calls the broker's `/refresh/{provider}` with the sealed refresh token — same stateless in-and-out contract.

### 3.3 Rung 3 — BYO developer app (full sovereignty)

Always available in Settings → Connections → "Use my own app":

- The user supplies client_id (+ secret, stored in the vault like any credential) and we provide **per-provider copy-paste setup recipes** (exact redirect URI to register — including their own host/port — scopes list, app-type gotchas).
- The connection UI generates the exact values to paste into the provider console, mirroring how the existing connector setup drawers already work.
- Self-hosters who run their own broker get Rung 2 ergonomics with Rung 3 sovereignty: `AGENTIS_CONNECT_URL=https://connect.mycompany.com`.

### 3.4 Device-code flow (headless bonus rung)

For SSH-only/server installs where no browser can reach the instance: providers with **device authorization grant** (GitHub today; Google for limited scopes) get a fourth path — Agentis prints `Go to github.com/login/device and enter ABCD-1234`. Auto-selected when the API detects no display and no reachable loopback.

## 4. Distribution Matrix

| | Hosted web | Desktop app | Self-host (Docker/VPS) | Headless SSH |
|---|---|---|---|---|
| Browser opens | same tab redirect | system browser | server prints/opens URL | device code or copy-code |
| Redirect target | app callback route | loopback 127.0.0.1 | loopback or copy-code | n/a |
| Rung 1 (PKCE) | ✓ | ✓ | ✓ | via device flow |
| Rung 2 (broker) | ✓ | ✓ | ✓ (or self-hosted broker) | ✓ via copy-code |
| Rung 3 (BYO) | ✓ | ✓ | ✓ | ✓ |
| Token storage | server vault | local vault | local vault | local vault |

The user-visible flow is identical in all cells: **Connect → approve in browser → connected**. Only the plumbing differs, and the ladder resolves it silently.

## 5. What This Unlocks for the Workspace Brain

- `validateConnection()` health checks (already implemented per `KnowledgeSource`) become the post-OAuth smoke test: connect → validate → the source card flips to **Ready** → first sample sync feeds the trust preview (RFC §14.7 Moment 3).
- The CORA quickstart's **Connect** state stops being a dead-end: each suggested source card deep-links straight into this ladder.
- Scopes follow least privilege per source family (RFC §16.2): Slack `channels:history,channels:read,users:read` (+`groups:history` only when the owner includes private channels); Google `drive.readonly` (`drive.metadata.readonly` when text export is off); GitHub `repo:read`/fine-grained read-only PAT guidance for Rung 3.
- Token refresh integrates with the Source Fabric: a 401 during sync marks the connection `needs_attention` with a one-click **Reconnect** (the ladder re-runs, the vault row updates, cursors survive).

## 6. Implementation Plan

> **Status (2026-06-11):** the **web/self-host popup flow is LIVE** and wired into the Brain's Connect drawer. The existing `OAuthService` already implements PKCE, single-use TTL'd `state`, the provider registry (Google/Slack/GitHub/Notion/…), code→token exchange, the popup callback that mints an encrypted vault credential and `postMessage`s `credentialId` back, **and proxy/broker mode (Rung 2) via `AGENTIS_OAUTH_PROXY_URL`**. The Brain added read-sync scopes (`brain_slack` → `channels:history,channels:read,users:read`; `brain_google_drive` → `drive.readonly`; `brain_github` → `repo,read:user`) and the Source Fabric unwraps the OAuth token bundle to the bearer token at sync time. The Connect drawer offers **“Sign in with X”** (one-click) with a stored-token fallback. **Remaining:** desktop loopback-listener variant (P0 below), per-provider BYO setup recipes (P1), the open-source stateless broker + sealed return channel (P2), device flow + reconnect UX (P3).

1. **P0 — Loopback PKCE engine** in `OAuthService`: verifier/state/loopback-listener lifecycle for the **desktop** distribution (the web/self-host redirect+popup variant is done). GitHub + Google land here. Desktop gets smooth flows with zero infrastructure.
2. **P1 — BYO recipes**: per-provider setup drawer (exact redirect URIs incl. detected host), vault-stored client credentials, Slack lands here first (BYO-only until the broker ships).
3. **P2 — Agentis Connect broker**: stateless exchanger + sealed return channel + copy-code fallback; open-source the broker; register hosted provider apps; flip Slack/Notion defaults from BYO to broker.
4. **P3 — Device flow + reconnect UX**: headless path; `needs_attention` → Reconnect; scope-upgrade prompts when a learning brief needs more than the current grant (§14.14 continuing-onboarding rule: ask only when meaning/authority/exposure changes).

## 7. Security Invariants (binding)

1. No `client_secret` in the repository, binaries, or browser storage — broker or vault only.
2. Tokens at rest exist ONLY in `CredentialVault` rows; the broker stores nothing and logs no token material.
3. Every flow uses PKCE + `state`, even confidential-client flows through the broker.
4. The sealed return channel encrypts to a single-use instance key; copy-codes expire in 10 minutes.
5. Loopback listeners bind 127.0.0.1 only, accept exactly one callback, and shut down on success/timeout.
6. Scope requests are generated from the connection's learning brief / connector needs — never a static kitchen-sink list.
7. Disconnecting a source revokes at the provider (where supported), deletes the vault row, and triggers the CORA revocation sweep (RFC §16.3).
