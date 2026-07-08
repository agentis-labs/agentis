/**
 * Curated catalog of known HTTP MCP servers (CONNECTIONS-HONESTY §C2).
 *
 * The mount form should be "pick a provider", not "paste a URL". Each entry
 * pre-fills the URL + the auth SHAPE so an operator connects Supabase by
 * choosing it, not by knowing its endpoint. Only HTTP(S) servers belong here —
 * the client is streamable-HTTP only (stdio servers are out of scope).
 *
 * `authType` drives the mount UI:
 *   - 'none'   — public server, no secret.
 *   - 'oauth'  — connect the provider's OAuth (mint a vault credential), then
 *                pick it on the mount (wave-2 OAuth-bundle → Bearer).
 *   - 'token'  — a personal access / API token → vault secret → Bearer header.
 *   - 'header' — a JSON header map (e.g. a custom apikey header) → vault secret.
 *
 * `{url}` placeholders (e.g. Supabase's `project_ref`) are surfaced as a hint;
 * the operator fills them before mounting. Kept deliberately small + honest:
 * every entry is a REAL, publicly-documented hosted MCP endpoint.
 */

export type McpCatalogAuthType = 'none' | 'oauth' | 'token' | 'header';

export interface McpCatalogEntry {
  /** Stable id used by the integrations→MCP cross-link (`mcp:<id>`). */
  id: string;
  name: string;
  category: string;
  /** Server URL; may contain `{placeholder}` the operator must fill. */
  url: string;
  authType: McpCatalogAuthType;
  /** One line telling the operator exactly what secret/OAuth to provide. */
  authHint: string;
  description: string;
  docsUrl?: string;
  /** Matches the native-connector `service` id when the same provider exists there. */
  connectorService?: string;
}

export const MCP_SERVER_CATALOG: McpCatalogEntry[] = [
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Data',
    url: 'https://mcp.supabase.com/mcp',
    authType: 'oauth',
    authHint: 'Connect Supabase via OAuth (or paste a Personal Access Token), then pick that credential.',
    description: 'Query and manage a Supabase project: tables, rows, SQL, storage, edge functions.',
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    connectorService: 'supabase',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Code',
    url: 'https://api.githubcopilot.com/mcp/',
    authType: 'token',
    authHint: 'A GitHub Personal Access Token (repo scope) → stored as a Bearer secret.',
    description: 'Repos, issues, pull requests, Actions, and code search on GitHub.',
    docsUrl: 'https://github.com/github/github-mcp-server',
    connectorService: 'github',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    url: 'https://mcp.notion.com/mcp',
    authType: 'oauth',
    authHint: 'Connect Notion via OAuth, then pick that credential.',
    description: 'Read and write Notion pages, databases, and blocks.',
    docsUrl: 'https://developers.notion.com/docs/mcp',
    connectorService: 'notion',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Productivity',
    url: 'https://mcp.linear.app/mcp',
    authType: 'oauth',
    authHint: 'Connect Linear via OAuth, then pick that credential.',
    description: 'Create and update Linear issues, projects, and comments.',
    docsUrl: 'https://linear.app/docs/mcp',
    connectorService: 'linear',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'DevOps',
    url: 'https://mcp.vercel.com',
    authType: 'oauth',
    authHint: 'Connect Vercel via OAuth. Note: the MCP covers projects, deployment status, logs, and domains — to DEPLOY generated files, use the Vercel integration (vercel.create_deployment), not the MCP.',
    description: 'Inspect Vercel projects, deployments, build/runtime logs, and domains. (Deploying files uses the Vercel connector.)',
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    connectorService: 'vercel',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    url: 'https://mcp.stripe.com',
    authType: 'token',
    authHint: 'A Stripe restricted API key → stored as a Bearer secret.',
    description: 'Customers, payments, invoices, subscriptions, and balance on Stripe.',
    docsUrl: 'https://docs.stripe.com/mcp',
    connectorService: 'stripe',
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'Developer',
    url: 'https://mcp.context7.com/mcp',
    authType: 'none',
    authHint: 'No secret needed — public docs-retrieval server.',
    description: 'Up-to-date library docs and code examples for any package.',
    docsUrl: 'https://context7.com',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'Developer',
    url: 'https://mcp.deepwiki.com/mcp',
    authType: 'none',
    authHint: 'No secret needed — public GitHub-repo Q&A server.',
    description: 'Ask questions about any public GitHub repository.',
    docsUrl: 'https://deepwiki.com',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: 'AI',
    url: 'https://huggingface.co/mcp',
    authType: 'token',
    authHint: 'A Hugging Face access token → stored as a Bearer secret (or leave blank for public).',
    description: 'Search models, datasets, and Spaces; run inference endpoints.',
    docsUrl: 'https://huggingface.co/settings/mcp',
  },
];

/** Catalog entry for a native-connector `service` id, if a known MCP server covers it. */
export function mcpCatalogForConnector(service: string): McpCatalogEntry | undefined {
  return MCP_SERVER_CATALOG.find((e) => e.connectorService === service);
}
