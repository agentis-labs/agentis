/**
 * Media tool family — the ONE generic multimodal capability (GAP: no image/media
 * generation existed). `agentis.media.generate` dispatches by modality to whatever
 * provider/model is registered (image today; audio/speech/video as providers are
 * added), persists each output as an artifact, and returns it in the SAME shape a
 * screenshot does — so it renders inline in chat and attaches via channel.send with
 * zero extra wiring. No vendor is baked in; the provider is swappable.
 */

import { AgentisError, type MediaModality, type MediaReferenceImage } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const MODALITIES: MediaModality[] = ['image', 'audio', 'speech', 'video'];

export function registerMediaTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.media.generate',
        family: 'run',
        mcpExposed: true,
        description:
          '[MEDIA] Generate media from a prompt — image today (audio/speech/video as providers are added) — and optionally EDIT / re-render reference images by passing `images`. Returns artifact refs that render inline in chat and attach via agentis.channel.send (url: "artifact:<id>"). Modality dispatches to whatever model/provider is configured; no fixed vendor. Reach for this on "make / generate / render / edit an image".',
        inputSchema: {
          type: 'object',
          properties: {
            modality: { type: 'string', enum: MODALITIES, description: 'What to produce. Default "image".' },
            prompt: { type: 'string', description: 'What to create (for an edit, describe the change).' },
            images: {
              type: 'array',
              items: { type: 'string' },
              description: 'Reference inputs to edit / re-render — each an artifact:<id>, a data: URL, or an http(s) URL. Present ⇒ edit; absent ⇒ generate from scratch.',
            },
            size: { type: 'string', description: 'Provider-agnostic size hint, e.g. 1024x1024.' },
            n: { type: 'number', description: 'How many to produce (default 1).' },
          },
          required: ['prompt'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.media) throw new AgentisError('MEDIA_UNAVAILABLE', 'Media generation is not configured on this workspace.');
        const modality = (typeof args.modality === 'string' && (MODALITIES as string[]).includes(args.modality) ? args.modality : 'image') as MediaModality;
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) throw new AgentisError('VALIDATION_FAILED', 'prompt is required');

        // Resolve any reference images (artifact:/data:/http) to bytes for editing.
        const refs = Array.isArray(args.images) ? args.images.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
        const images: MediaReferenceImage[] = [];
        if (refs.length) {
          if (!deps.artifacts) throw new AgentisError('MEDIA_UNAVAILABLE', 'Cannot resolve reference images (artifact service unavailable).');
          for (const ref of refs) {
            const resolved = await deps.artifacts.resolveBytes(ctx.workspaceId, ref);
            images.push({ b64: resolved.buffer.toString('base64'), mime: resolved.mimeType });
          }
        }

        const { provider, assets } = await deps.media.generate(
          {
            workspaceId: ctx.workspaceId,
            ...(ctx.userId ? { userId: ctx.userId } : {}),
            agentId: ctx.agentId ?? null,
            appId: ctx.appId ?? null,
            runId: ctx.runId ?? null,
            conversationId: ctx.conversationId ?? null,
          },
          {
            modality,
            prompt,
            ...(images.length ? { images } : {}),
            ...(typeof args.size === 'string' && args.size.trim() ? { size: args.size.trim() } : {}),
            ...(typeof args.n === 'number' ? { n: args.n } : {}),
          },
        );

        const first = assets[0];
        return {
          generated: true,
          modality,
          provider,
          // Screenshot convention (artifactId/ref/mimeType) → chat + channel render it.
          ...(first ? { artifactId: first.artifactId, ref: first.ref, mimeType: first.mimeType } : {}),
          assets,
          message: first
            ? `Generated ${assets.length} ${modality}(s). Attach with agentis.channel.send (url: "${first.ref}"), or reference the artifact id.`
            : `No ${modality} was produced.`,
        };
      },
    },
  ]);
}
