import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenHttpServer } from '../src/httpServer.js';

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    ),
  );
});

describe('listenHttpServer', () => {
  it('resolves once the server is listening', async () => {
    const server = createServer();
    servers.push(server);

    await expect(
      listenHttpServer(server, { port: 0, hostname: '127.0.0.1' }),
    ).resolves.toBe(server);
    expect(server.listening).toBe(true);
  });

  it('rejects when the requested port is already in use', async () => {
    const occupied = createServer();
    servers.push(occupied);
    await listenHttpServer(occupied, { port: 0, hostname: '127.0.0.1' });

    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address for occupied test server');
    }

    const contender = createServer();
    servers.push(contender);

    await expect(
      listenHttpServer(contender, { port: address.port, hostname: '127.0.0.1' }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(contender.listening).toBe(false);
  });
});