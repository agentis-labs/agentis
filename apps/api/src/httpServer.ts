import type { Server as HttpServer } from 'node:http';

export interface ListenHttpServerOptions {
  port: number;
  hostname: string;
}

export function listenHttpServer(
  server: HttpServer,
  options: ListenHttpServerOptions,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve(server);
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.hostname);
  });
}