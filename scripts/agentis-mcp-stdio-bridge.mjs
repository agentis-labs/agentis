#!/usr/bin/env node

/**
 * Minimal MCP stdio-to-HTTP bridge for local harnesses.
 *
 * Codex speaks MCP over stdio, while Agentis exposes a streamable HTTP JSON-RPC
 * endpoint at /v1/mcp/rpc. Keeping this bridge local avoids spawning `npx
 * mcp-remote` for every chat turn, which was adding cold-start latency and
 * occasionally missing Codex's MCP handshake window.
 */

const [, , targetUrl, ...rawArgs] = process.argv;

if (!targetUrl) {
  console.error('usage: agentis-mcp-stdio-bridge.mjs <url> [--header "name: value"]...');
  process.exit(2);
}

const headers = {};
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] !== '--header') continue;
  const value = rawArgs[i + 1] ?? '';
  i += 1;
  const colon = value.indexOf(':');
  if (colon <= 0) continue;
  headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
}

let buffer = '';
let framing = null;
let queue = Promise.resolve();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  drain();
});
process.stdin.on('end', () => {
  queue.catch(() => undefined).finally(() => process.exit(0));
});

function drain() {
  for (;;) {
    const message = readNextMessage();
    if (!message) return;
    queue = queue.then(() => handleMessage(message)).catch((err) => {
      console.error(`[agentis-mcp-bridge] ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function readNextMessage() {
  if (framing === 'content-length' || /^Content-Length:/i.test(buffer)) {
    framing = 'content-length';
    const rn = buffer.indexOf('\r\n\r\n');
    const nn = buffer.indexOf('\n\n');
    const headerEnd = rn >= 0 ? rn : nn;
    if (headerEnd < 0) return null;
    const separatorLength = rn >= 0 ? 4 : 2;
    const header = buffer.slice(0, headerEnd);
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + separatorLength);
      return null;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
    if (buffer.length < bodyStart + length) return null;
    const body = buffer.slice(bodyStart, bodyStart + length);
    buffer = buffer.slice(bodyStart + length);
    return body.trim();
  }

  const newline = buffer.indexOf('\n');
  if (newline < 0) return null;
  const line = buffer.slice(0, newline).trim();
  buffer = buffer.slice(newline + 1);
  return line || null;
}

async function handleMessage(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  const response = await postRpc(request);
  if (response) writeMessage(response);
}

async function postRpc(request) {
  const id = Array.isArray(request) ? null : request?.id ?? null;
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        ...headers,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    const text = await res.text();
    if (res.status === 202 || !text.trim()) return null;
    if (!res.ok) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `HTTP ${res.status}: ${text.slice(0, 500)}` },
      };
    }
    return JSON.parse(text);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function writeMessage(message) {
  const payload = JSON.stringify(message);
  if (framing === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    return;
  }
  process.stdout.write(`${payload}\n`);
}
