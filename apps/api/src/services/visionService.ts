/**
 * VisionService — image understanding for channel image messages
 * (OMNICHANNEL-ORCHESTRATOR-10X §3.3 media ingestion).
 *
 * Sends an image to a vision-capable, OpenAI-compatible `/chat/completions`
 * endpoint resolved from the model router's `vision` role, and returns a short
 * text description that the orchestrator turn can reason over. Entirely optional
 * — with no vision model configured (or on any failure) it returns null and the
 * caller falls back to skipping the image, so it never breaks a connection.
 */

import type { ModelProfile } from './orchestratorModelRouter.js';
import type { Logger } from '../logger.js';

export interface VisionInput {
  bytes: Buffer;
  mimeType: string;
  /** Optional caption the sender attached. */
  caption?: string;
  /** Optional instruction override (e.g. design-DNA extraction). Falls back to the default describe prompt. */
  prompt?: string;
}

export interface VisionServiceDeps {
  profile: () => ModelProfile | null;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const DEFAULT_PROMPT =
  'Describe this image concisely for an assistant that cannot see it. Note any text, people, ' +
  'objects, and what the sender likely wants. Two or three sentences.';

export class VisionService {
  constructor(private readonly deps: VisionServiceDeps) {}

  get enabled(): boolean {
    return this.deps.profile() !== null;
  }

  /** Describe an image as text. Returns null when unconfigured or on failure. */
  async describe(input: VisionInput): Promise<string | null> {
    const profile = this.deps.profile();
    if (!profile) return null;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const url = resolveChatCompletionsUrl(profile.baseUrl);
      const dataUrl = `data:${input.mimeType};base64,${input.bytes.toString('base64')}`;
      const base = input.prompt ?? DEFAULT_PROMPT;
      const prompt = input.caption ? `${base}\nSender caption: ${input.caption}` : base;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: profile.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 300,
        }),
      });
      if (!res.ok) {
        this.deps.logger?.warn?.('vision.failed', { status: res.status });
        return null;
      }
      const json = (await res.json().catch(() => null)) as
        | { choices?: Array<{ message?: { content?: string } }> }
        | null;
      const text = json?.choices?.[0]?.message?.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch (err) {
      this.deps.logger?.warn?.('vision.error', { err: (err as Error).message });
      return null;
    }
  }
}

/** Append `/chat/completions` to an OpenAI-compatible base URL. */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}
