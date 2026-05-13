import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmTraceSpan } from '@agentis/core';
import { createLogger } from '../../src/logger.js';
import { createTelemetrySink } from '../../src/services/telemetrySink.js';

describe('TelemetrySink', () => {
  it('buffers spans and flushes them to the telemetry sidecar', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'agentis-telemetry-'));
    const sink = createTelemetrySink({
      dataDir,
      logger: createLogger({ level: 'error' }),
      flushIntervalMs: 0,
    });
    const span: LlmTraceSpan = {
      traceId: 'trace_xray',
      runId: 'run_xray',
      workflowId: 'workflow_xray',
      workspaceId: 'workspace_xray',
      nodeId: 'research_agent',
      nodeKind: 'agent_task',
      metrics: {
        promptTokens: 1200,
        completionTokens: 300,
        cachedTokens: 100,
        totalTokens: 1500,
        totalCostMicros: 420,
        latencyMs: 900,
      },
      contextStrategy: {
        windowLimit: 128_000,
        blocks: [
          { source: 'system', tokenCount: 200, wasTruncated: false, truncatedTokens: 0 },
          { source: 'retrieval', tokenCount: 1000, wasTruncated: false, truncatedTokens: 0 },
        ],
      },
      payloads: { rawPrompt: 'system prompt', rawCompletion: 'done', toolCalls: [] },
    };

    try {
      sink.emit(span);
      const spans = await sink.listSpans({ traceId: 'trace_xray' });
      expect(spans).toHaveLength(1);
      expect(spans[0]?.nodeId).toBe('research_agent');
      expect(spans[0]?.metrics.totalTokens).toBe(1500);
      expect(spans[0]?.contextStrategy?.blocks[1]?.source).toBe('retrieval');
    } finally {
      await sink.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});