/**
 * Flagship example extension — "Post to X (with optional image)"
 * (INTEGRATION-CEILING-10X §5).
 *
 * Proves the whole paved road built in this pass end to end, using nothing
 * beyond what any user can now do from the product:
 *   1. Phase 2 (generic OAuth2) — register X's real OAuth endpoints as a
 *      custom provider (no Agentis-core change; X is not special-cased here,
 *      any OAuth2 API would work identically).
 *   2. Phase 3 (credential + multipart) — the extension references its token
 *      ONLY by name (`credential: 'x_token'`) and uploads the image via
 *      `formData` — the host attaches the real secret and encodes real
 *      multipart bytes; the sandboxed script never sees either.
 *
 * This is a TEMPLATE to fork for whatever service you actually need — not a
 * commitment to maintain a growing list of platform-specific connectors. The
 * two real X endpoints below are exactly what X's own docs describe: v1.1
 * media upload (multipart) → v2 tweet creation referencing the returned
 * media id. See `apps/api/tests/extensions/postToXExample.test.ts` for a
 * full run of this EXACT source against a mock server — the example and the
 * proof are the same code, so they cannot drift apart.
 *
 * Setup for a real deployment (all product actions, zero code):
 *   1. Settings → Integrations → Custom OAuth connections → Add:
 *        id: x, authUrl: https://x.com/i/oauth2/authorize,
 *        tokenUrl: https://api.x.com/2/oauth2/token, pkce: true,
 *        scopes: tweet.read, tweet.write, users.read, offline.access
 *      (client id/secret from developer.x.com → your app → Keys and tokens.)
 *   2. Connect it → mints an encrypted credential.
 *   3. Install this extension, then bind credentialKey "x_token" to that
 *      credential (operator-only — the extension's own code can never do this).
 */

export const postToXManifest = {
  name: 'Post to X',
  slug: 'post-to-x',
  version: '1.0.0',
  runtime: 'node_worker' as const,
  description: 'Post a tweet, optionally with one image, using a credential you connect via Settings → Integrations.',
  permissions: ['network', 'credentials'] as const,
  allowedDomains: ['api.x.com', 'upload.twitter.com'],
  credentialKeys: ['x_token'],
  operations: [
    {
      name: 'post',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Tweet text.' },
          imageBase64: { type: 'string', description: 'Optional base64 image bytes to attach.' },
          imageMime: { type: 'string', description: 'Image MIME type (default image/png).' },
        },
        required: ['text'],
      },
      outputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  ],
};

export const postToXSource = `
export async function post(inputs, ctx) {
  const { text, imageBase64, imageMime } = inputs;
  let mediaId;

  if (imageBase64) {
    // X v1.1 media upload — multipart. The extension only ever names the
    // credential; the real bearer token is attached by the host, never read here.
    const uploadRes = await ctx.http.fetch('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      credential: 'x_token',
      formData: [
        { name: 'media', filename: 'image', contentType: imageMime || 'image/png', dataBase64: imageBase64 },
      ],
    });
    const uploadBody = await uploadRes.json();
    if (!uploadRes.ok) {
      throw new Error('media upload failed: ' + JSON.stringify(uploadBody));
    }
    mediaId = uploadBody.media_id_string;
  }

  // X v2 tweet creation, referencing the uploaded media id if present.
  const payload = { text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) };
  const tweetRes = await ctx.http.fetch('https://api.x.com/2/tweets', {
    method: 'POST',
    credential: 'x_token',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const tweetBody = await tweetRes.json();
  if (!tweetRes.ok) {
    throw new Error('tweet creation failed: ' + JSON.stringify(tweetBody));
  }
  return { id: tweetBody.data && tweetBody.data.id, text: tweetBody.data && tweetBody.data.text };
}
`.trim();
