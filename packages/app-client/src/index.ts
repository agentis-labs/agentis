import type { CollectionRecord, QuerySort } from '@agentis/core';

export const APP_CLIENT_PROTOCOL_VERSION = 1;
export const APP_CLIENT_MESSAGE_SOURCE = 'agentis.app-client';

export type AppClientDataRow = Record<string, unknown>;
export interface AppClientQuery {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  sort?: QuerySort[];
}

export type AppClientRequest =
  | { op: 'data.query'; payload: { collection: string; query?: AppClientQuery } }
  | { op: 'data.insert'; payload: { collection: string; record: Record<string, unknown> } }
  | { op: 'data.update'; payload: { collection: string; id: string; patch: Record<string, unknown> } }
  | { op: 'data.delete'; payload: { collection: string; id: string } }
  | { op: 'actions.invoke'; payload: { name: string; args?: Record<string, unknown> } }
  | { op: 'state.get'; payload: { key?: string } }
  | { op: 'state.set'; payload: { key: string; value: unknown } }
  | { op: 'navigation.go'; payload: { surface: string; params?: Record<string, unknown> } }
  | { op: 'files.upload'; payload: { file: File } };

export type AppClientEventHandler<T = unknown> = (payload: T) => void;

export interface AppClientTransport {
  request<T = unknown>(request: AppClientRequest): Promise<T>;
  subscribe?<T = unknown>(event: string, handler: AppClientEventHandler<T>): () => void;
}

export interface CreateAppClientOptions {
  appId: string;
  surface: string;
  token?: string;
  transport: AppClientTransport;
}

export interface AgentisAppClient {
  readonly version: 1;
  readonly appId: string;
  readonly surface: string;
  data: {
    query(collection: string, query?: AppClientQuery): Promise<AppClientDataRow[]>;
    insert(collection: string, record: Record<string, unknown>): Promise<unknown>;
    update(collection: string, id: string, patch: Record<string, unknown>): Promise<unknown>;
    delete(collection: string, id: string): Promise<unknown>;
  };
  actions: {
    invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  state: {
    get<T = unknown>(key?: string): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    subscribe<T = unknown>(key: string, handler: AppClientEventHandler<T>): () => void;
  };
  realtime: {
    subscribe<T = unknown>(event: string, handler: AppClientEventHandler<T>): () => void;
  };
  navigation: {
    go(surface: string, params?: Record<string, unknown>): Promise<void>;
  };
  files: {
    upload(file: File): Promise<unknown>;
  };
}

export function createAppClient(options: CreateAppClientOptions): AgentisAppClient {
  const request = options.transport.request.bind(options.transport);
  const subscribe = options.transport.subscribe?.bind(options.transport);
  return {
    version: APP_CLIENT_PROTOCOL_VERSION,
    appId: options.appId,
    surface: options.surface,
    data: {
      query: (collection, query) => request<AppClientDataRow[]>({ op: 'data.query', payload: { collection, query } }),
      insert: (collection, record) => request({ op: 'data.insert', payload: { collection, record } }),
      update: (collection, id, patch) => request({ op: 'data.update', payload: { collection, id, patch } }),
      delete: (collection, id) => request({ op: 'data.delete', payload: { collection, id } }),
    },
    actions: {
      invoke: (name, args) => request({ op: 'actions.invoke', payload: { name, args } }),
    },
    state: {
      get: (key) => request({ op: 'state.get', payload: { key } }),
      set: async (key, value) => {
        await request({ op: 'state.set', payload: { key, value } });
      },
      subscribe: (key, handler) => subscribe?.(`state:${key}`, handler) ?? noop,
    },
    realtime: {
      subscribe: (event, handler) => subscribe?.(event, handler) ?? noop,
    },
    navigation: {
      go: async (surface, params) => {
        await request({ op: 'navigation.go', payload: { surface, params } });
      },
    },
    files: {
      upload: (file) => request({ op: 'files.upload', payload: { file } }),
    },
  };
}

export interface CreateInProcessAppClientOptions {
  appId: string;
  surface: string;
  query(collection: string, query?: AppClientQuery): Promise<AppClientDataRow[]>;
  insert?(collection: string, record: Record<string, unknown>): Promise<CollectionRecord | unknown>;
  update?(collection: string, id: string, patch: Record<string, unknown>): Promise<CollectionRecord | unknown>;
  delete?(collection: string, id: string): Promise<unknown>;
  invokeAction(name: string, args?: Record<string, unknown>): Promise<unknown>;
  getState(key?: string): unknown;
  setState(key: string, value: unknown): void | Promise<void>;
  navigate(surface: string, params?: Record<string, unknown>): void | Promise<void>;
  uploadFile?(file: File): Promise<unknown>;
  subscribeRealtime?<T = unknown>(event: string, handler: AppClientEventHandler<T>): () => void;
}

export function createInProcessAppClient(options: CreateInProcessAppClientOptions): AgentisAppClient {
  const listeners = new Map<string, Set<AppClientEventHandler>>();
  const emit = (event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  const subscribe = <T = unknown>(event: string, handler: AppClientEventHandler<T>) => {
    const set = listeners.get(event) ?? new Set<AppClientEventHandler>();
    set.add(handler as AppClientEventHandler);
    listeners.set(event, set);
    const realtimeOff = options.subscribeRealtime?.(event, handler);
    return () => {
      set.delete(handler as AppClientEventHandler);
      realtimeOff?.();
    };
  };
  return createAppClient({
    appId: options.appId,
    surface: options.surface,
    transport: {
      subscribe,
      request: async <T = unknown>(request: AppClientRequest): Promise<T> => {
        let result: unknown;
        switch (request.op) {
          case 'data.query':
            result = await options.query(request.payload.collection, request.payload.query);
            break;
          case 'data.insert':
            if (!options.insert) throw new Error('data.insert is not available in this runtime');
            result = await options.insert(request.payload.collection, request.payload.record);
            break;
          case 'data.update':
            if (!options.update) throw new Error('data.update is not available in this runtime');
            result = await options.update(request.payload.collection, request.payload.id, request.payload.patch);
            break;
          case 'data.delete':
            if (!options.delete) throw new Error('data.delete is not available in this runtime');
            result = await options.delete(request.payload.collection, request.payload.id);
            break;
          case 'actions.invoke':
            result = await options.invokeAction(request.payload.name, request.payload.args);
            break;
          case 'state.get':
            result = options.getState(request.payload.key);
            break;
          case 'state.set':
            await options.setState(request.payload.key, request.payload.value);
            emit(`state:${request.payload.key}`, request.payload.value);
            result = undefined;
            break;
          case 'navigation.go':
            await options.navigate(request.payload.surface, request.payload.params);
            result = undefined;
            break;
          case 'files.upload':
            if (!options.uploadFile) throw new Error('files.upload is not available in this runtime');
            result = await options.uploadFile(request.payload.file);
            break;
          default:
            assertNever(request);
        }
        return result as T;
      },
    },
  });
}

export interface CreatePostMessageAppClientOptions {
  appId: string;
  surface: string;
  targetWindow?: Window;
  targetOrigin?: string;
  timeoutMs?: number;
}

export function createPostMessageAppClient(options: CreatePostMessageAppClientOptions): AgentisAppClient {
  const targetWindow = options.targetWindow ?? window.parent;
  const targetOrigin = options.targetOrigin ?? '*';
  const timeoutMs = options.timeoutMs ?? 15_000;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  const onMessage = (event: MessageEvent) => {
    const message = event.data as AppClientResponse | undefined;
    if (!message || message.source !== APP_CLIENT_MESSAGE_SOURCE || message.version !== APP_CLIENT_PROTOCOL_VERSION) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? 'app-client bridge request failed'));
  };

  window.addEventListener('message', onMessage);

  return createAppClient({
    appId: options.appId,
    surface: options.surface,
    transport: {
      request: <T = unknown>(request: AppClientRequest): Promise<T> =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`app-client bridge request timed out: ${request.op}`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          targetWindow.postMessage(
            {
              source: APP_CLIENT_MESSAGE_SOURCE,
              version: APP_CLIENT_PROTOCOL_VERSION,
              id,
              op: request.op,
              payload: request.payload,
            } satisfies AppClientMessage,
            targetOrigin,
          );
        }).then((value) => value as T),
    },
  });
}

export interface AppClientMessage {
  source: typeof APP_CLIENT_MESSAGE_SOURCE;
  version: typeof APP_CLIENT_PROTOCOL_VERSION;
  id: number;
  op: AppClientRequest['op'];
  payload: AppClientRequest['payload'];
}

export interface AppClientResponse {
  source: typeof APP_CLIENT_MESSAGE_SOURCE;
  version: typeof APP_CLIENT_PROTOCOL_VERSION;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const noop = () => {};

function assertNever(value: never): never {
  throw new Error(`Unhandled app-client request: ${JSON.stringify(value)}`);
}
