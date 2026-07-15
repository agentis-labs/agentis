import { describe, it } from 'vitest';
import { AntigravityAdapter } from '../../src/adapters/AntigravityAdapter.js';
import { ClaudeCodeAdapter } from '../../src/adapters/ClaudeCodeAdapter.js';
import { CodexAdapter } from '../../src/adapters/CodexAdapter.js';
import { CursorAdapter } from '../../src/adapters/CursorAdapter.js';
import { HermesAgentAdapter } from '../../src/adapters/HermesAgentAdapter.js';
import { HttpAdapter } from '../../src/adapters/HttpAdapter.js';
import { LocalLlmAdapter } from '../../src/adapters/LocalLlmAdapter.js';
import { OpenClawAdapter } from '../../src/adapters/OpenClawAdapter.js';
import { createLogger } from '../../src/logger.js';
import { expectAdapterCapabilityConformance } from './runtimeCapabilityConformance.js';

const logger = createLogger({ level: 'error' });
const mcpServers = [{ name: 'agentis', url: 'http://127.0.0.1:3737/mcp', headers: {} }];

describe('native runtime capability conformance', () => {
  it('OpenClaw declares its gateway-owned powers without claiming Agentis tool calling', () => {
    expectAdapterCapabilityConformance(
      new OpenClawAdapter({ agentId: 'openclaw', gatewayUrl: 'wss://gateway.test', logger }),
      { available: [
        'interaction.chat',
        'execution.terminal',
        'execution.browser',
        'execution.computer-use',
        'execution.long-running',
        'execution.pausable',
        'memory.inject',
      ], unavailableProbe: 'interaction.tool-calling' },
    );
  });

  it('Claude Code changes native-MCP supply only when a server is mounted', () => {
    const baseline = [
      'interaction.chat',
      'interaction.tool-calling',
      'execution.file-system',
      'execution.terminal',
      'execution.long-running',
      'memory.inject',
      'memory.ingest',
    ] as const;
    expectAdapterCapabilityConformance(
      new ClaudeCodeAdapter({ agentId: 'claude', logger }),
      { available: [...baseline], unavailableProbe: 'protocol.native-mcp' },
    );
    expectAdapterCapabilityConformance(
      new ClaudeCodeAdapter({ agentId: 'claude-mcp', logger, mcpServers }),
      { available: [...baseline, 'protocol.native-mcp'] },
    );
  });

  it('Codex gates browser, computer-use, and native MCP on their explicit options', () => {
    const baseline = [
      'interaction.chat',
      'interaction.tool-calling',
      'execution.file-system',
      'execution.terminal',
      'execution.long-running',
      'memory.inject',
      'memory.ingest',
    ] as const;
    expectAdapterCapabilityConformance(
      new CodexAdapter({ agentId: 'codex', logger }),
      { available: [...baseline], unavailableProbe: 'execution.browser' },
    );
    expectAdapterCapabilityConformance(
      new CodexAdapter({ agentId: 'codex-powered', logger, browser: true, mcpServers }),
      { available: [
        ...baseline,
        'execution.browser',
        'execution.computer-use',
        'protocol.native-mcp',
      ] },
    );
  });

  it('Cursor declares its codebase index and pausable process contract', () => {
    expectAdapterCapabilityConformance(
      new CursorAdapter({ agentId: 'cursor', logger }),
      { available: [
        'interaction.chat',
        'interaction.tool-calling',
        'execution.file-system',
        'execution.terminal',
        'execution.long-running',
        'execution.pausable',
        'workspace.codebase-index',
        'memory.inject',
        'memory.ingest',
      ], unavailableProbe: 'protocol.native-mcp' },
    );
  });

  it('Hermes Agent distinguishes ACP activity, CLI markers, and mounted MCP', () => {
    const execution = [
      'interaction.chat',
      'execution.file-system',
      'execution.terminal',
      'execution.long-running',
      'execution.pausable',
      'memory.inject',
      'memory.ingest',
    ] as const;
    expectAdapterCapabilityConformance(
      new HermesAgentAdapter({ agentId: 'hermes-acp', logger, chatTransport: 'acp' }),
      { available: [...execution], unavailableProbe: 'interaction.tool-calling' },
    );
    expectAdapterCapabilityConformance(
      new HermesAgentAdapter({ agentId: 'hermes-cli', logger, chatTransport: 'cli' }),
      { available: [...execution, 'interaction.tool-calling'], unavailableProbe: 'protocol.native-mcp' },
    );
    expectAdapterCapabilityConformance(
      new HermesAgentAdapter({ agentId: 'hermes-mcp', logger, chatTransport: 'acp', mcpServers }),
      { available: [...execution, 'interaction.tool-calling', 'protocol.native-mcp'] },
    );
  });

  it('Antigravity does not confuse marker-shaped activity with native MCP', () => {
    expectAdapterCapabilityConformance(
      new AntigravityAdapter({ agentId: 'antigravity', logger }),
      { available: [
        'interaction.chat',
        'interaction.tool-calling',
        'execution.file-system',
        'execution.terminal',
        'execution.long-running',
        'memory.inject',
        'memory.ingest',
      ], unavailableProbe: 'protocol.native-mcp' },
    );
  });

  it('HTTP capability supply follows its declared chat/tool contract', () => {
    expectAdapterCapabilityConformance(
      new HttpAdapter({ agentId: 'http-task', dispatchUrl: 'https://agent.test/task', logger }),
      { available: ['execution.long-running', 'memory.inject'], unavailableProbe: 'interaction.chat' },
    );
    expectAdapterCapabilityConformance(
      new HttpAdapter({
        agentId: 'http-tools',
        dispatchUrl: 'https://agent.test/task',
        chatUrl: 'https://agent.test/chat',
        supportsTools: true,
        logger,
      }),
      { available: [
        'interaction.chat',
        'interaction.tool-calling',
        'execution.long-running',
        'memory.inject',
      ], unavailableProbe: 'execution.file-system' },
    );
    expectAdapterCapabilityConformance(
      new HttpAdapter({
        agentId: 'http-custom',
        dispatchUrl: 'https://agent.test/task',
        capabilityManifest: [{
          id: 'vendor.video-render',
          available: true,
          source: 'advertised',
          version: '2',
        }],
        logger,
      }),
      {
        available: ['execution.long-running', 'memory.inject'],
        additionalAvailable: ['vendor.video-render'],
      },
    );
  });

  it('local LLM exposes model/tool interaction but no unimplemented host powers', () => {
    expectAdapterCapabilityConformance(
      new LocalLlmAdapter({
        agentId: 'local',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'hermes-3',
        logger,
      }),
      { available: ['interaction.chat', 'interaction.tool-calling', 'memory.inject'] },
    );
  });
});
