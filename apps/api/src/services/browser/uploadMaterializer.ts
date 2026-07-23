/**
 * Upload materializer — turns workspace asset/artifact refs into real files on
 * disk that Playwright's `setInputFiles` can read, WITHOUT ever accepting a raw
 * agent-supplied filesystem path (arbitrary-read guard, BROWSERPOOL-10X §7).
 *
 * Bytes are resolved through {@link ArtifactService.resolveBytes} — which is
 * workspace-scoped and applies the safe-fetch guard to any remote ref — then
 * written to a throwaway temp dir we control. The caller uploads, then calls
 * `cleanup()` to remove the dir. Count + total size are capped.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { AgentisError } from '@agentis/core';
import type { ArtifactService } from '../artifactService.js';

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB across all files in one upload

export interface MaterializedUploads {
  paths: string[];
  cleanup: () => Promise<void>;
}

/** Build a materializer bound to one workspace's artifact store. */
export function makeUploadMaterializer(
  artifacts: ArtifactService,
  workspaceId: string,
): (refs: string[]) => Promise<MaterializedUploads> {
  return async (refs: string[]): Promise<MaterializedUploads> => {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'browser_session upload requires at least one asset ref');
    }
    if (refs.length > MAX_FILES) {
      throw new AgentisError('VALIDATION_FAILED', `browser_session upload accepts at most ${MAX_FILES} files`);
    }

    const dir = await mkdtemp(join(tmpdir(), 'agentis-upload-'));
    const cleanup = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
    try {
      const paths: string[] = [];
      let total = 0;
      for (let i = 0; i < refs.length; i++) {
        const resolved = await artifacts.resolveBytes(workspaceId, String(refs[i]));
        total += resolved.buffer.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new AgentisError('VALIDATION_FAILED', `browser_session upload exceeds ${MAX_TOTAL_BYTES} bytes total`);
        }
        // basename() strips any path components the resolved filename might carry.
        const name = basename(resolved.filename || `upload-${i}`) || `upload-${i}`;
        const path = join(dir, `${i}-${name}`);
        await writeFile(path, resolved.buffer);
        paths.push(path);
      }
      return { paths, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  };
}
