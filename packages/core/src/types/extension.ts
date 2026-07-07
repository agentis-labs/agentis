/**
 * Extension manifest contract.
 *
 * Extensions are deterministic, sandboxed capability units. They are not agent
 * abilities or prompt instructions; they are executable runtime extensions.
 */
export type ExtensionRuntime = 'builtin' | 'node_worker' | 'docker_sandbox';

export type ExtensionPermission =
  | 'network'
  | 'network.unrestricted'
  | 'credentials'
  | 'workspace.read'
  | 'workspace.write'
  | 'filesystem'
  | 'spawn'
  // Listener / cross-run capabilities (EXTENSIONS-AND-LISTENER-10X §2.2).
  // Grant-only: the UI surfaces these explicitly and they are never
  // auto-granted from the registry.
  | 'listener'        // extension operation may be used as a Listener source
  | 'listener.emit'   // operation may call ctx.emit() (required for listener sources)
  | 'listener.cursor' // operation may read/write the Listener cursor
  | 'kv.read'         // read the workspace-scoped extension KV store
  | 'kv.write';       // write the workspace-scoped extension KV store

export interface ExtensionOperation {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /**
   * Marks this operation as a valid Listener source. When true, the operation
   * receives `ctx.emit()` / `ctx.cursor` and may run continuously as the
   * source of a persistent_listener trigger (EXTENSIONS-AND-LISTENER-10X §1.8).
   */
  isListenerSource?: boolean;
  /** Operator-facing copy + capability flags shown to workflow builders. */
  listenerConfig?: {
    emitsEvents?: boolean;
    cursorSupported?: boolean;
    description?: string;
  };
}

export interface ExtensionCredentialKey {
  key: string;
  label?: string;
  required?: boolean;
}

export interface ExtensionManifest {
  name: string;
  slug: string;
  version: string;
  runtime: ExtensionRuntime;
  /**
   * For builtin: the in-repo executor key.
   * For node_worker: relative entry file inside the bundle.
   * For docker_sandbox: relative entry path inside the mounted bundle.
   */
  entrypoint?: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  operations: ExtensionOperation[];
  /** Declared capabilities. Anything not declared is denied by the runtime. */
  permissions?: ExtensionPermission[];
  /** Workspace credential keys the extension may access when `credentials` is declared. */
  credentialKeys?: Array<string | ExtensionCredentialKey>;
  categories?: string[];
  capabilityTags: string[];
  timeoutMs?: number;
  allowedDomains?: string[];
  /** node_worker only: inline JavaScript module source. Exports one named function per operation. */
  source?: string;
  /** docker_sandbox only: absolute path to the unpacked extension bundle. */
  bundleDir?: string;
  /** Operation names that are valid Listener sources (mirror of operation.isListenerSource). */
  listenerOperations?: string[];
}

export interface ExtensionExecutionRequest {
  extensionId: string;
  manifest: ExtensionManifest;
  operationName: string;
  input: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
  runId?: string;
  taskId?: string;
}

export interface ExtensionExecutionResult {
  ok: true;
  output: Record<string, unknown>;
  durationMs: number;
  operationName: string;
}

export interface ExtensionExecutionFailure {
  ok: false;
  errorCode:
    | 'EXTENSION_TIMEOUT'
    | 'EXTENSION_NETWORK_VIOLATION'
    | 'EXTENSION_DOCKER_UNAVAILABLE'
    | 'EXTENSION_RUNTIME_UNAVAILABLE'
    | 'EXTENSION_SSRF_BLOCKED'
    | 'EXTENSION_INPUT_INVALID'
    | 'EXTENSION_OUTPUT_INVALID'
    | 'EXTENSION_PERMISSION_DENIED'
    | 'EXTENSION_MANIFEST_INVALID'
    | 'EXTENSION_OPERATION_NOT_FOUND'
    | 'EXTENSION_ENTRYPOINT_MISSING'
    | 'EXTENSION_INTERNAL'
    | 'EXTENSION_ABORTED'
    | 'VALIDATION_FAILED';
  message: string;
  durationMs: number;
  operationName?: string;
}

export type ExtensionExecutionOutcome = ExtensionExecutionResult | ExtensionExecutionFailure;
