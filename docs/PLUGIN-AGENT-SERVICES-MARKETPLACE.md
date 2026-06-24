# Plugin / Agent Service Marketplace

> Status: Canonical marketplace naming doc for external agent-facing services.
> Canonical relationship: Apps are built inside Agentis; Plugins / Agent Services are external capabilities an App or agent can call.

## Definition

A **Plugin / Agent Service** is an installable external capability for agents: AgentMail-style APIs, enrichment providers, search layers, messaging services, browser runtimes, and other products whose primary user is an agent.

This is deliberately not the same thing as an **Agentic App**. An Agentic App is the deployable product an agent builds and operates inside Agentis: identity, surfaces, logic, data, agents, memory, and policy.

## Boundaries

| Primitive | Built by | Used by | Owns UI/data? | Example |
|---|---|---|---|---|
| Agentic App | Agent inside Agentis | Human end-users and the operator agent | Yes | A CRM an agent builds and runs for a sales team |
| Plugin / Agent Service | External builder or operator | Agents and Apps | Usually no; may expose an embedded panel | AgentMail, search API, enrichment API |
| Extension | Operator/power user | Local Agentis runtime | No | Deterministic local tool or runtime adapter |

## Carry Forward From The Archived Plan

- Capability manifests stay useful, but they describe plugin capabilities, not Apps.
- Semantic discovery remains an agent-facing marketplace feature.
- Runtime tiers still apply: native SDK, persistent edge connection, or HTTP bridge.
- Billing attaches to agent/action usage and can later be shared with App billing.

## Product Rule

New product copy should reserve **App** for the first-class product primitive introduced in `AGENTIC-APPS-10X-MASTERPLAN.md`. Use **Plugin** or **Agent Service** for external marketplace capabilities.
