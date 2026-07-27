/**
 * MediaService — the runtime behind the generic `agentis.media.*` capability.
 *
 * It is a tiny registry: providers (each {@link MediaProvider}) register the
 * modalities they can produce; `generate` dispatches by modality, runs the
 * provider, and persists each result to the AssetStore so it comes back as an
 * `artifact:<id>` ref — the SAME shape screenshots use, so chat/channels render
 * it with zero extra code. No provider is hardcoded: the default OpenAI-compatible
 * image provider is registered from env in bootstrap, and swapping it (or adding
 * audio/video/a home-grown harness) is `service.register(anotherProvider)`.
 */

import { AgentisError, type MediaModality, type MediaProvider, type MediaGenerateRequest, type GeneratedMedia } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { AssetStore } from './assetStore.js';
import type { WorkspaceMediaConfigService } from './workspace/workspaceMediaConfigService.js';

export interface MediaGenerateContext {
  workspaceId: string;
  userId?: string;
  agentId?: string | null;
  appId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  nodeId?: string | null;
}

export interface MediaGeneratedAsset {
  artifactId: string;
  ref: string; // artifact:<id>
  mimeType: string;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4' };

/**
 * A provider whose {baseUrl,model,apiKey} can be overridden per workspace
 * (Settings → Media), mirroring how chat models are already free-text/
 * provider-agnostic (OrchestratorModelRouter). `envDefaults` seeds the
 * instance-wide fallback; `build` constructs a fresh {@link MediaProvider}
 * from whatever config actually applies for a given call.
 */
export interface ConfigurableMediaFactory {
  modality: MediaModality;
  envDefaults: { baseUrl: string; apiKey?: string; model: string };
  build: (cfg: { baseUrl: string; apiKey: string; model: string }) => MediaProvider;
}

export class MediaService {
  private readonly providers: MediaProvider[] = [];
  private readonly configurable = new Map<MediaModality, ConfigurableMediaFactory>();
  constructor(private readonly deps: { assetStore?: AssetStore; logger: Logger; workspaceMediaConfig?: WorkspaceMediaConfigService }) {}

  register(provider: MediaProvider): void {
    this.providers.push(provider);
    this.deps.logger.info('media.provider.registered', { id: provider.id, modalities: provider.modalities });
  }

  /**
   * Register a provider factory that a workspace can override with its own
   * {baseUrl, model, apiKey} — e.g. point at OpenRouter, a self-hosted
   * endpoint, or just a different model, with no Agentis-core code change and
   * no restart. When an instance-wide API key is present, also registers the
   * env-default instance so the zero-config path keeps working unchanged.
   */
  registerConfigurable(factory: ConfigurableMediaFactory): void {
    this.configurable.set(factory.modality, factory);
    if (factory.envDefaults.apiKey) {
      this.register(factory.build({
        baseUrl: factory.envDefaults.baseUrl,
        apiKey: factory.envDefaults.apiKey,
        model: factory.envDefaults.model,
      }));
    }
    this.deps.logger.info('media.provider.configurable_registered', { modality: factory.modality, hasEnvDefault: Boolean(factory.envDefaults.apiKey) });
  }

  /** Modalities the workspace can currently produce (drives capability advertising). */
  modalities(): MediaModality[] {
    return [...new Set(this.providers.flatMap((p) => [...p.modalities]))];
  }

  private providerFor(modality: MediaModality): MediaProvider | undefined {
    return this.providers.find((p) => p.modalities.includes(modality));
  }

  /**
   * Resolve the provider for one call: a per-workspace override (Settings →
   * Media) wins if one exists for this modality, freshly built from the
   * override merged over the env default (missing baseUrl/apiKey inherit the
   * env default — same merge rule as WorkspaceModelConfigService); otherwise
   * fall back to the statically registered / env-configured provider.
   */
  private resolveProvider(workspaceId: string, modality: MediaModality): MediaProvider | undefined {
    const factory = this.configurable.get(modality);
    const override = factory && this.deps.workspaceMediaConfig
      ? this.deps.workspaceMediaConfig.resolveOverride(workspaceId, modality)
      : null;
    if (factory && override) {
      const apiKey = override.apiKey ?? factory.envDefaults.apiKey;
      if (!apiKey) {
        throw new AgentisError('MEDIA_UNAVAILABLE', `No API key configured for ${modality} generation — set one in Settings → Media for model "${override.model}".`);
      }
      return factory.build({
        baseUrl: override.baseUrl ?? factory.envDefaults.baseUrl,
        apiKey,
        model: override.model,
      });
    }
    return this.providerFor(modality);
  }

  /** Generate media, persist each output as an artifact, return the refs. */
  async generate(ctx: MediaGenerateContext, req: MediaGenerateRequest): Promise<{ provider: string; assets: MediaGeneratedAsset[] }> {
    const provider = this.resolveProvider(ctx.workspaceId, req.modality);
    if (!provider) {
      throw new AgentisError('MEDIA_UNAVAILABLE', `No media provider is configured for "${req.modality}". Available: ${this.modalities().join(', ') || 'none'}.`);
    }
    if (!this.deps.assetStore) throw new AgentisError('MEDIA_UNAVAILABLE', 'Asset store not configured — cannot persist generated media.');

    const produced = await provider.generate(req);
    const assets: MediaGeneratedAsset[] = [];
    for (let i = 0; i < produced.length; i += 1) {
      const bytes = await toBytes(produced[i]!);
      const mime = produced[i]!.mime;
      const stored = await this.deps.assetStore.put({
        bytes,
        mime,
        name: `${req.modality}-${Date.now()}-${i}.${EXT[mime] ?? 'bin'}`,
        title: req.prompt.slice(0, 80),
        workspaceId: ctx.workspaceId,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        agentId: ctx.agentId ?? null,
        appId: ctx.appId ?? null,
        runId: ctx.runId ?? null,
        conversationId: ctx.conversationId ?? null,
        nodeId: ctx.nodeId ?? null,
        metadataExtra: { generatedBy: provider.id, modality: req.modality },
      });
      assets.push({ artifactId: stored.id, ref: `artifact:${stored.id}`, mimeType: mime });
    }
    return { provider: provider.id, assets };
  }
}

async function toBytes(item: GeneratedMedia): Promise<Buffer> {
  if (item.b64) return Buffer.from(item.b64, 'base64');
  if (item.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new AgentisError('MEDIA_UNAVAILABLE', 'Provider returned neither bytes nor a URL.');
}

// ── Default provider: any OpenAI-compatible /images endpoint (no lock-in) ─────

export interface OpenAiImageProviderConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;   // e.g. gpt-image-1
}

/**
 * Image provider over the OpenAI images REST shape (/images/generations and
 * /images/edits). Point `baseUrl` at ANY compatible endpoint — this is one
 * adapter behind the {@link MediaProvider} seam, not a vendor commitment.
 */
export function openAiImageProvider(cfg: OpenAiImageProviderConfig): MediaProvider {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    id: `openai-image:${cfg.model}`,
    modalities: ['image'] as const,
    async generate(req: MediaGenerateRequest): Promise<GeneratedMedia[]> {
      const n = Math.max(1, Math.min(req.n ?? 1, 4));
      const size = req.size ?? '1024x1024';
      const edit = (req.images?.length ?? 0) > 0;
      let res: Response;
      if (edit) {
        // Reference image(s) present → EDIT. Multipart, one `image[]` per reference.
        const form = new FormData();
        form.set('model', cfg.model);
        form.set('prompt', req.prompt);
        form.set('size', size);
        form.set('n', String(n));
        req.images!.forEach((img, i) => form.append('image[]', new Blob([Buffer.from(img.b64, 'base64')], { type: img.mime }), `ref-${i}.${EXT[img.mime] ?? 'png'}`));
        res = await fetch(`${base}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
      } else {
        res = await fetch(`${base}/images/generations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, prompt: req.prompt, size, n }),
        });
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new AgentisError('MEDIA_PROVIDER_ERROR', `image ${edit ? 'edit' : 'generation'} failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const items = body.data ?? [];
      if (items.length === 0) throw new AgentisError('MEDIA_PROVIDER_ERROR', 'image provider returned no data');
      return items.map((d) => ({ mime: 'image/png', ...(d.b64_json ? { b64: d.b64_json } : {}), ...(d.url ? { url: d.url } : {}) }));
    },
  };
}
