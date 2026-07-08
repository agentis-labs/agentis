/**
 * connectorLogo — resolves a brand logo URL for a connector slug so the
 * integration catalog reads like Zapier/Composio (real logos, not glyphs).
 *
 * Logos are real brand SVGs bundled under `apps/web/public/connectors/<id>.svg`
 * (imported from the n8n node library via scripts/import-connector-logos.mjs),
 * served statically with no remote CDN dependency. The set of ids that actually
 * have a bundled logo lives in the generated `connectorLogos.generated.ts`, so
 * we never emit a URL for a connector without an asset (no broken-img flash).
 * Connectors without a brand logo fall back to the colored initial chip —
 * callers must still pass an onError handler (see `<ConnectorLogo>`).
 */
import { CONNECTOR_LOGO_IDS } from './connectorLogos.generated';

/** Alternate slugs that should resolve to a canonical bundled logo id. */
const SLUG_ALIASES: Record<string, string> = {
  amazonsqs: 'sqs',
  amazons3: 's3',
  microsoftoutlook: 'outlook',
  postgresql: 'postgres',
  twitter: 'twitter_x',
  x: 'twitter_x',
  googlesheets: 'google_sheets',
  googledocs: 'google_docs',
  googledrive: 'google_drive',
};

/** A brand-logo URL for a connector slug, or null when none should be shown. */
export function connectorLogoUrl(slug: string | undefined | null): string | null {
  if (!slug) return null;
  // A custom integration may carry an absolute URL or app-rooted path as its icon.
  if (/^(https?:\/\/|\/)/i.test(slug)) return slug;
  const key = slug.toLowerCase();
  const id = CONNECTOR_LOGO_IDS.has(key) ? key : SLUG_ALIASES[key];
  if (!id || !CONNECTOR_LOGO_IDS.has(id)) return null;
  return `/connectors/${id}.svg`;
}

/** A stable accent color seeded from the slug, for the fallback initial chip. */
export function connectorAccent(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 55% 55%)`;
}
