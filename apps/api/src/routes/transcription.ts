import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { TranscriptionService } from '../services/transcriptionService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function buildTranscriptionRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  transcription: TranscriptionService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/status', (c) => c.json({ available: deps.transcription.enabled }));

  app.post('/', async (c) => {
    if (!deps.transcription.enabled) {
      return c.json({
        error: {
          code: 'TRANSCRIPTION_UNAVAILABLE',
          message: 'Configure a transcription model in Settings → Runtimes.',
        },
      }, 503);
    }

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'An audio file is required.' } }, 422);
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'Audio recording exceeds the 25 MB limit.' } }, 413);
    }

    const transcript = await deps.transcription.transcribe({
      bytes: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type || 'audio/webm',
      filename: file.name || 'dictation.webm',
    });
    if (!transcript) {
      return c.json({
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: 'The transcription provider returned no text.',
        },
      }, 502);
    }
    return c.json({ transcript });
  });

  return app;
}
