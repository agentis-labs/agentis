import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { ArtifactService } from '../../src/services/artifactService.js';
import { DocumentExtractionService } from '../../src/services/documentExtractionService.js';
import { ConversationAttachmentContextService } from '../../src/services/conversation/conversationAttachmentContext.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('ConversationAttachmentContextService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('injects actual attachment contents with provenance and a context manifest', async () => {
    const artifactId = randomUUID();
    const specification = `# Talki Sales\n\n${'Create leads, durable subject state, follow-ups, dashboards, verification, and delivery.\n'.repeat(140)}END-OF-SPEC`;
    ctx.db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: 'document',
      title: 'talki-spec.md',
      content: specification,
      metadata: { name: 'talki-spec.md', mime: 'text/markdown' },
    }).run();
    const service = new ConversationAttachmentContextService({
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
      documents: new DocumentExtractionService({ logger: ctx.logger }),
      logger: ctx.logger,
    });
    const result = await service.compile({
      workspaceId: ctx.workspace.id,
      body: 'Implement the attached specification.',
      attachmentIds: [artifactId],
      historyMessages: 12,
    });

    expect(result.prompt).toContain(specification);
    expect(result.prompt).toContain('END-OF-SPEC');
    expect(result.manifest.attachments[0]?.extractedChars).toBeGreaterThan(8_000);
    expect(result.prompt).toContain(`<attachment id="${artifactId}"`);
    expect(result.manifest).toMatchObject({ historyMessages: 12, attachmentCount: 1 });
    expect(result.manifest.attachments[0]).toMatchObject({
      artifactId,
      name: 'talki-spec.md',
      status: 'ready',
      extraction: 'text',
    });
    expect(result.manifest.attachments[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads a Windows UTF-16 text artifact all the way into the agent prompt', async () => {
    const artifactId = randomUUID();
    const specification = 'Implementação completa — ações, validação e entrega sem perder requisitos.';
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(specification, 'utf16le'),
    ]);
    ctx.db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: 'document',
      title: 'windows-spec.txt',
      content: `data:text/plain;base64,${bytes.toString('base64')}`,
      metadata: { name: 'windows-spec.txt', mime: 'text/plain' },
    }).run();

    const service = new ConversationAttachmentContextService({
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
      documents: new DocumentExtractionService({ logger: ctx.logger }),
      logger: ctx.logger,
    });
    const result = await service.compile({
      workspaceId: ctx.workspace.id,
      body: 'Follow the attached specification.',
      attachmentIds: [artifactId],
    });

    expect(result.prompt).toContain(specification);
    expect(result.manifest.attachments[0]).toMatchObject({
      artifactId,
      name: 'windows-spec.txt',
      status: 'ready',
      extraction: 'text',
    });
  });

  it('preserves an unsupported channel attachment in a non-strict capability manifest', async () => {
    const artifactId = randomUUID();
    ctx.db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: 'image',
      title: 'horse.jpg',
      content: `data:image/jpeg;base64,${Buffer.from('pixels').toString('base64')}`,
      metadata: { name: 'horse.jpg', mime: 'image/jpeg' },
    }).run();
    const service = new ConversationAttachmentContextService({
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
      documents: new DocumentExtractionService({ logger: ctx.logger }),
      logger: ctx.logger,
    });

    const result = await service.compile({
      workspaceId: ctx.workspace.id,
      body: 'What is in this image?',
      attachmentIds: [artifactId],
      strict: false,
    });

    expect(result.prompt).toContain('<attachment_capability_status>');
    expect(result.prompt).toContain('horse.jpg');
    expect(result.manifest.attachments[0]).toMatchObject({ status: 'unsupported', extraction: 'none' });
  });

  it('forwards images natively when no hosted vision profile exists', async () => {
    const artifactId = randomUUID();
    ctx.db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: 'image',
      title: 'screen.png',
      content: `data:image/png;base64,${Buffer.from('pixels').toString('base64')}`,
      metadata: { name: 'screen.png', mime: 'image/png' },
    }).run();
    const service = new ConversationAttachmentContextService({
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
      documents: new DocumentExtractionService({ logger: ctx.logger }),
      logger: ctx.logger,
      materialize: async (input) => ({
        path: `C:/agentis/runtime/${input.artifactId}.png`,
        name: input.name,
        mimeType: input.mimeType,
        kind: 'image',
      }),
    });

    const result = await service.compile({
      workspaceId: ctx.workspace.id,
      body: 'Inspect the screenshot.',
      attachmentIds: [artifactId],
      strict: false,
    });

    expect(result.runtimeInputAttachments).toHaveLength(1);
    expect(result.prompt).toContain('Inspect the actual image before answering');
    expect(result.manifest.attachments[0]).toMatchObject({ status: 'ready', extraction: 'none' });
  });

  it('understands video through local frames and audio transcription', async () => {
    const artifactId = randomUUID();
    ctx.db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: 'data',
      title: 'demo.mp4',
      content: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      metadata: { name: 'demo.mp4', mime: 'video/mp4' },
    }).run();
    const service = new ConversationAttachmentContextService({
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
      documents: new DocumentExtractionService({ logger: ctx.logger }),
      logger: ctx.logger,
      transcription: { transcribe: async () => 'This is the spoken request.' },
      materializeVideoFrames: async (input) => [{
        path: `C:/agentis/runtime/${input.artifactId}-frame-1.jpg`,
        name: `${input.name} frame 1`,
        mimeType: 'image/jpeg',
        kind: 'image',
      }],
    });

    const result = await service.compile({
      workspaceId: ctx.workspace.id,
      body: 'What happens in this video?',
      attachmentIds: [artifactId],
      strict: false,
    });

    expect(result.prompt).toContain('Audio transcript:\nThis is the spoken request.');
    expect(result.prompt).toContain('Representative frames');
    expect(result.runtimeInputAttachments).toHaveLength(1);
    expect(result.manifest.attachments[0]).toMatchObject({ status: 'ready', extraction: 'vision' });
  });
});
