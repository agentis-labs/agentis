import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeInputAttachment } from '@agentis/core';

/**
 * Materializes durable artifacts as content-addressed, read-only runtime inputs.
 * CLI harnesses need a real path for native image/file input; generation output
 * remains in the artifact store and is not mixed into this cache.
 */
export class RuntimeInputAttachmentStore {
  readonly #videoJobs = new Map<string, Promise<RuntimeInputAttachment[]>>();

  constructor(private readonly root: string) {}

  async materialize(input: {
    workspaceId: string;
    name: string;
    mimeType: string;
    bytes: Buffer;
  }): Promise<RuntimeInputAttachment> {
    const hash = createHash('sha256').update(input.bytes).digest('hex');
    const workspaceKey = createHash('sha256').update(input.workspaceId).digest('hex').slice(0, 16);
    const dir = path.resolve(this.root, workspaceKey);
    await mkdir(dir, { recursive: true });
    const extension = safeExtension(input.name, input.mimeType);
    const target = path.join(dir, `${hash}${extension}`);
    try {
      await writeFile(target, input.bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return {
      path: target,
      name: input.name,
      mimeType: input.mimeType,
      kind: input.mimeType.startsWith('image/') ? 'image' : 'file',
    };
  }

  /**
   * Produce a small, content-addressed visual contact sheet as individual JPEG
   * inputs. This gives image-capable runtimes useful video/GIF context without
   * requiring a hosted vision provider or exposing the original media publicly.
   */
  async materializeVideoFrames(input: {
    workspaceId: string;
    name: string;
    mimeType: string;
    bytes: Buffer;
  }): Promise<RuntimeInputAttachment[]> {
    const source = await this.materialize(input);
    const key = source.path;
    const existing = this.#videoJobs.get(key);
    if (existing) return existing;
    const job = this.#extractVideoFrames(source, input.name).finally(() => this.#videoJobs.delete(key));
    this.#videoJobs.set(key, job);
    return job;
  }

  async #extractVideoFrames(source: RuntimeInputAttachment, originalName: string): Promise<RuntimeInputAttachment[]> {
    const frameDir = `${source.path}.frames`;
    await mkdir(frameDir, { recursive: true });
    const cached = await listFrames(frameDir, originalName);
    if (cached.length) return cached;
    const output = path.join(frameDir, 'frame-%02d.jpg');
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source.path,
      '-vf', "fps=1/5,scale='min(1280,iw)':-2",
      '-frames:v', '4',
      output,
    ]);
    return listFrames(frameDir, originalName);
  }
}

async function listFrames(frameDir: string, originalName: string): Promise<RuntimeInputAttachment[]> {
  const entries = (await readdir(frameDir).catch(() => []))
    .filter((name) => /^frame-\d+\.jpg$/i.test(name))
    .sort()
    .slice(0, 4);
  return entries.map((name, index) => ({
    path: path.join(frameDir, name),
    name: `${originalName} (frame ${index + 1})`,
    mimeType: 'image/jpeg',
    kind: 'image' as const,
  }));
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.AGENTIS_FFMPEG_PATH?.trim() || 'ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errors: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('video frame extraction timed out'));
    }, 90_000);
    timer.unref?.();
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((total, item) => total + item.length, 0) < 16_384) errors.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg is unavailable for video understanding: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`video frame extraction failed (${code}): ${Buffer.concat(errors).toString('utf8').trim().slice(0, 500)}`));
    });
  });
}

function safeExtension(name: string, mimeType: string): string {
  const fromName = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const mime = mimeType.split(';', 1)[0]!.toLowerCase();
  return mime === 'image/jpeg' ? '.jpg'
    : mime === 'image/png' ? '.png'
      : mime === 'image/webp' ? '.webp'
        : mime === 'image/gif' ? '.gif'
          : mime === 'application/pdf' ? '.pdf'
            : '.bin';
}
