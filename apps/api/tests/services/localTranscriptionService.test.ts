import { describe, expect, it, vi } from 'vitest';
import { decodeAudioPortable, LocalTranscriptionService } from '../../src/services/localTranscriptionService.js';

describe('LocalTranscriptionService', () => {
  it('loads one managed pipeline and transcribes decoded audio without provider configuration', async () => {
    vi.stubEnv('AGENTIS_TRANSCRIPTION_LANGUAGE', 'portuguese');
    const pipeline = vi.fn(async () => ({ text: '  áudio compreendido  ' }));
    const loadPipeline = vi.fn(async () => pipeline);
    const decodeAudio = vi.fn(async () => new Float32Array([0, 0.25, -0.25]));
    const service = new LocalTranscriptionService({
      dataDir: 'C:/agentis-test-data',
      loadPipeline,
      decodeAudio,
    });

    expect(await service.transcribe({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' }))
      .toBe('áudio compreendido');
    expect(await service.transcribe({ bytes: Buffer.from('ogg-2'), mimeType: 'audio/ogg' }))
      .toBe('áudio compreendido');
    expect(loadPipeline).toHaveBeenCalledOnce();
    expect(decodeAudio).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({ task: 'transcribe' }));
    expect(pipeline.mock.calls[0]?.[1]).toHaveProperty('language', 'portuguese');
    vi.unstubAllEnvs();
  });

  it('fails closed for oversized channel audio', async () => {
    const loadPipeline = vi.fn();
    const service = new LocalTranscriptionService({ dataDir: 'C:/agentis-test-data', loadPipeline });
    expect(await service.transcribe({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: 'audio/ogg' })).toBeNull();
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it('rejects a pathologically repetitive transcript that cannot fit the audio duration', async () => {
    const pipeline = vi.fn(async () => ({ text: ` ${'eu não sei o que é '.repeat(100)}` }));
    const service = new LocalTranscriptionService({
      dataDir: 'C:/agentis-test-data',
      loadPipeline: async () => pipeline,
      decodeAudio: async () => new Float32Array(16_000 * 2),
    });

    expect(await service.transcribe({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' })).toBeNull();
  });

  it('decodes and resamples through the portable npm codec without requiring system FFmpeg', async () => {
    vi.doMock('@audio/decode', () => ({
      default: async () => ({
        sampleRate: 48_000,
        // @audio/decode v3 returns AudioData, not a Web Audio AudioBuffer.
        channelData: [new Float32Array(48_000).fill(0.25)],
      }),
    }));

    const pcm = await decodeAudioPortable(Buffer.from('portable-audio'), 'ffmpeg-that-does-not-exist');

    expect(pcm).toHaveLength(16_000);
    expect(pcm[8_000]).toBeCloseTo(0.25);
    vi.doUnmock('@audio/decode');
  });
});
