import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { ComponentType } from 'react';
import { Check, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { ClaudeIcon, CodexIcon, CursorIcon, HermesIcon, HttpIcon, OpenClawIcon } from '../icons';
import { HarnessInstallSlideOver } from './HarnessInstallSlideOver';
import { ModelChooser } from './ModelChooser';

export type AdapterType = 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http';

export interface AdapterModelOption {
  id: string;
  label: string;
  tier?: 'flagship' | 'balanced' | 'fast' | 'auto';
  recommended?: boolean;
}

export interface RuntimeConfig {
  openclawGatewayId: string;
  openclawGatewayUrl: string;
  openclawModel: string;
  openclawDeviceTokenCredentialId: string;
  openclawAgentName: string;
  openclawSessionKeyStrategy: string;
  openclawSessionKey: string;
  openclawTimeoutSec: string;
  openclawPayloadTemplate: string;
  hermesBinaryPath: string;
  hermesCwd: string;
  hermesModel: string;
  hermesMaxTurns: string;
  hermesExtraArgs: string;
  hermesEnv: string;
  hermesTimeoutSec: string;
  hermesGraceSec: string;
  claudeBinaryPath: string;
  claudeCwd: string;
  claudeModel: string;
  claudeMaxTurns: string;
  claudeAllowedTools: string;
  claudeExtraArgs: string;
  claudeEnv: string;
  claudeTimeoutSec: string;
  codexBinaryPath: string;
  codexCwd: string;
  codexModel: string;
  codexMaxTurns: string;
  codexReasoningEffort: string;
  codexFastMode: string;
  codexBypassApprovalsAndSandbox: string;
  codexExtraArgs: string;
  codexEnv: string;
  codexTimeoutSec: string;
  cursorBinaryPath: string;
  cursorCwd: string;
  cursorModel: string;
  cursorExtraArgs: string;
  cursorEnv: string;
  cursorTimeoutSec: string;
  httpBaseUrl: string;
  httpAuthCredentialId: string;
  httpSharedSecretCredentialId: string;
  httpDispatchPath: string;
  httpCancelPath: string;
  httpHealthPath: string;
  httpMethod: string;
  httpHeaders: string;
  httpPayloadTemplate: string;
  httpDispatchTimeoutMs: string;
  httpModel: string;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  openclawGatewayId: '',
  openclawGatewayUrl: '',
  openclawModel: '',
  openclawDeviceTokenCredentialId: '',
  openclawAgentName: '',
  openclawSessionKeyStrategy: 'issue',
  openclawSessionKey: '',
  openclawTimeoutSec: '120',
  openclawPayloadTemplate: '',
  hermesBinaryPath: '',
  hermesCwd: '',
  hermesModel: '',
  hermesMaxTurns: '24',
  hermesExtraArgs: '',
  hermesEnv: '',
  hermesTimeoutSec: '',
  hermesGraceSec: '',
  claudeBinaryPath: '',
  claudeCwd: '',
  claudeModel: '',
  claudeMaxTurns: '24',
  claudeAllowedTools: '',
  claudeExtraArgs: '',
  claudeEnv: '',
  claudeTimeoutSec: '',
  codexBinaryPath: '',
  codexCwd: '',
  codexModel: '',
  codexMaxTurns: '24',
  codexReasoningEffort: '',
  codexFastMode: 'false',
  codexBypassApprovalsAndSandbox: 'true',
  codexExtraArgs: '',
  codexEnv: '',
  codexTimeoutSec: '',
  cursorBinaryPath: '',
  cursorCwd: '',
  cursorModel: '',
  cursorExtraArgs: '',
  cursorEnv: '',
  cursorTimeoutSec: '',
  httpBaseUrl: '',
  httpAuthCredentialId: '',
  httpSharedSecretCredentialId: '',
  httpDispatchPath: '/task',
  httpCancelPath: '',
  httpHealthPath: '/health',
  httpMethod: 'POST',
  httpHeaders: '',
  httpPayloadTemplate: '',
  httpDispatchTimeoutMs: '30000',
  httpModel: '',
};

export interface HarnessDetectionResult {
  adapterType: AdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;
  binaryPath?: string;
  detectedModel?: string;
  detectedVersion?: string;
  authStatus?: 'authenticated' | 'unknown';
  authDetail?: string;
  config?: Record<string, unknown>;
  installCommand?: string;
}

interface HarnessInstallOption {
  adapterType: AdapterType;
  canAutoInstall: boolean;
  installCommand?: string;
  manualUrl?: string;
  manualInstructions?: string;
}

const ADAPTERS: Array<{
  id: AdapterType;
  title: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  installCommand?: string;
}> = [
  { id: 'openclaw', title: 'OpenClaw', icon: OpenClawIcon },
  { id: 'hermes_agent', title: 'Hermes', icon: HermesIcon, installCommand: 'Install the Hermes Agent CLI' },
  { id: 'claude_code', title: 'Claude', icon: ClaudeIcon, recommended: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', title: 'Codex', icon: CodexIcon, recommended: true, installCommand: 'npm install -g @openai/codex' },
  { id: 'cursor', title: 'Cursor', icon: CursorIcon, installCommand: 'Install Cursor and enable the Cursor Agent CLI' },
  { id: 'http', title: 'HTTP', icon: HttpIcon },
];



export function RuntimePicker({
  adapterType,
  runtimeConfig,
  onAdapterChange,
  onConfigChange,
  editing = false,
  detections: controlledDetections,
  detecting: controlledDetecting,
  onRefreshDetections,
}: {
  adapterType: AdapterType;
  runtimeConfig: RuntimeConfig;
  onAdapterChange: (value: AdapterType) => void;
  onConfigChange: (value: RuntimeConfig) => void;
  editing?: boolean;
  detections?: HarnessDetectionResult[];
  detecting?: boolean;
  onRefreshDetections?: () => Promise<void> | void;
}) {
  const [internalDetections, setInternalDetections] = useState<HarnessDetectionResult[]>([]);
  const [internalDetecting, setInternalDetecting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showGatewayForm, setShowGatewayForm] = useState(false);
  const [gatewayUrlDraft, setGatewayUrlDraft] = useState('');
  const [gatewayConnecting, setGatewayConnecting] = useState(false);
  const [gatewayError, setGatewayError] = useState('');
  const [installOptions, setInstallOptions] = useState<HarnessInstallOption[]>([]);
  const [installingAdapter, setInstallingAdapter] = useState<AdapterType | null>(null);
  const userPickedRef = useRef(false);

  const detections = controlledDetections ?? internalDetections;
  const detecting = controlledDetecting ?? internalDetecting;

  async function refreshDetections() {
    if (controlledDetections !== undefined) {
      await onRefreshDetections?.();
      return;
    }
    setInternalDetecting(true);
    try {
      const result = await api<{ adapters?: HarnessDetectionResult[]; harnesses?: HarnessDetectionResult[] }>('/v1/harness/detect');
      setInternalDetections(result.adapters ?? result.harnesses ?? []);
    } catch {
      setInternalDetections([]);
    } finally {
      setInternalDetecting(false);
    }
  }

  useEffect(() => {
    if (controlledDetections !== undefined) return;
    void refreshDetections();
  }, [controlledDetections]);

  useEffect(() => {
    let cancelled = false;
    void api<{ adapters: HarnessInstallOption[] }>('/v1/harness/install-options')
      .then((result) => {
        if (!cancelled) setInstallOptions(result.adapters ?? []);
      })
      .catch(() => {
        if (!cancelled) setInstallOptions([]);
      });
    return () => { cancelled = true; };
  }, []);

  const detectionByType = useMemo(
    () => new Map(detections.map((detection) => [detection.adapterType, detection])),
    [detections],
  );
  const installOptionByType = useMemo(
    () => new Map(installOptions.map((option) => [option.adapterType, option])),
    [installOptions],
  );
  const foundDetections = useMemo(
    () => detections.filter((detection) => detection.status === 'found'),
    [detections],
  );
  const activeAdapter = ADAPTERS.find((adapter) => adapter.id === adapterType) ?? ADAPTERS[0]!;
  const activeDetection = detectionByType.get(adapterType);
  const openClawReady = activeDetection?.status === 'found' || Boolean(runtimeConfig.openclawGatewayUrl || runtimeConfig.openclawGatewayId);

  useEffect(() => {
    if (editing || userPickedRef.current) return;
    if (foundDetections.length !== 1) return;
    const detection = foundDetections[0]!;
    if (adapterType !== detection.adapterType) onAdapterChange(detection.adapterType);
    const next = prefillConfigFromDetection(runtimeConfig, detection.adapterType, detection);
    if (next !== runtimeConfig) onConfigChange(next);
  }, [adapterType, editing, foundDetections, onAdapterChange, onConfigChange, runtimeConfig]);

  function chooseAdapter(value: AdapterType) {
    userPickedRef.current = true;
    onAdapterChange(value);
    const detection = detectionByType.get(value);
    if (!detection) return;
    const next = prefillConfigFromDetection(runtimeConfig, value, detection);
    if (next !== runtimeConfig) onConfigChange(next);
  }

  const setConfig = (key: keyof RuntimeConfig, value: string) => {
    onConfigChange({ ...runtimeConfig, [key]: value });
  };

  async function connectGateway() {
    const url = normalizeGatewayUrl(gatewayUrlDraft.trim());
    if (!url) { setGatewayError('Enter a gateway URL.'); return; }
    const parsed = parseUrl(url);
    if (!parsed) { setGatewayError('Invalid URL.'); return; }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') { setGatewayError('Use ws:// or wss://.'); return; }
    setGatewayConnecting(true);
    setGatewayError('');
    try {
      const healthUrl = gatewayHealthUrl(url);
      const response = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      onConfigChange({ ...runtimeConfig, openclawGatewayUrl: url });
      setShowGatewayForm(false);
    } catch (err) {
      setGatewayError(`Could not reach gateway: ${(err as Error).message}`);
    } finally {
      setGatewayConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-canvas text-text-primary">
              <activeAdapter.icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">{activeAdapter.title}</div>
              <div className="text-xs text-text-muted">To switch harness, recreate the agent</div>
            </div>
          </div>
          <HarnessModelPassthrough
            adapterType={adapterType}
            config={runtimeConfig}
            onConfigChange={onConfigChange}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {detecting && detections.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              Detecting runtimes on this machine...
            </div>
          ) : null}
          <HarnessGrid
            adapters={ADAPTERS}
            adapterType={adapterType}
            detectionByType={detectionByType}
            installOptionByType={installOptionByType}
            detecting={detecting}
            onAdapterChange={chooseAdapter}
            onInstallRequest={(nextAdapter) => {
              setInstallingAdapter(nextAdapter);
            }}
            editing={editing}
          />
          {adapterType === 'openclaw' && !openClawReady ? (
            <div className="rounded-lg border border-line bg-surface-2 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-canvas text-text-primary">
                  <OpenClawIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary">OpenClaw needs a gateway to connect.</div>
                  <div className="mt-1 text-xs text-text-muted leading-relaxed">
                    A gateway is an OpenClaw server that owns your agent sessions, channels, and connectivity.
                  </div>
                </div>
              </div>
              {!showGatewayForm ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowGatewayForm(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[11px] font-semibold text-canvas hover:bg-accent-hover"
                  >
                    Connect a gateway →
                  </button>
                  <a
                    href="https://openclaw.dev/docs/gateway"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-3 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  >
                    What is OpenClaw? <ExternalLink size={10} />
                  </a>
                </div>
              ) : (
                <div className="space-y-2 border-t border-line pt-3">
                  <div className="text-xs font-medium text-text-secondary">Gateway URL</div>
                  <input
                    type="url"
                    value={gatewayUrlDraft}
                    onChange={(event) => { setGatewayUrlDraft(event.target.value); setGatewayError(''); }}
                    placeholder="wss://gateway.example.com"
                    className={inputCls}
                    autoFocus
                  />
                  {gatewayError && <div className="text-[11px] text-danger">{gatewayError}</div>}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={gatewayConnecting}
                      onClick={() => void connectGateway()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {gatewayConnecting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      {gatewayConnecting ? 'Connecting…' : 'Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowGatewayForm(false); setGatewayError(''); }}
                      className="inline-flex h-8 items-center rounded-btn border border-line px-3 text-[11px] text-text-secondary hover:bg-surface-3"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {!editing && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void refreshDetections()}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                <RefreshCw size={12} /> Refresh detection
              </button>
            </div>
          )}
          <ConnectionDetailsAccordion
            adapterType={adapterType}
            config={runtimeConfig}
            setConfig={setConfig}
            defaultOpen={activeDetection?.status !== 'found' && adapterType !== 'claude_code' && adapterType !== 'codex'}
          />
          <HarnessModelPassthrough
            adapterType={adapterType}
            config={runtimeConfig}
            onConfigChange={onConfigChange}
          />
        </div>
      )}
      {editing ? (
        <div className="rounded-lg border border-line bg-surface-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((value) => !value)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <span>Advanced connection settings</span>
            <span>{showAdvanced ? 'Hide' : 'Show'}</span>
          </button>
          {showAdvanced && <div className="border-t border-line p-3"><AdapterConfigFields adapterType={adapterType} config={runtimeConfig} setConfig={setConfig} /></div>}
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-text-muted">
          Additional options are available after commissioning.
        </div>
      )}
      {installingAdapter ? (
        <HarnessInstallSlideOver
          adapterType={installingAdapter}
          onClose={() => setInstallingAdapter(null)}
          onInstalled={(result) => {
            const nextConfig = prefillConfigFromInstall(runtimeConfig, installingAdapter, result);
            if (nextConfig !== runtimeConfig) onConfigChange(nextConfig);
            onAdapterChange(installingAdapter);
            setInstallingAdapter(null);
            void refreshDetections();
          }}
        />
      ) : null}
    </div>
  );
}

function detectionCommand(detection: HarnessDetectionResult): string {
  return stringOf(detection.config?.command)
    || stringOf(detection.config?.binaryPath)
    || detection.binaryPath
    || '';
}

function runtimeDetectionDetail(detection: HarnessDetectionResult): string {
  const command = detectionCommand(detection);
  return [
    detection.detectedVersion ? `v${detection.detectedVersion}` : 'Installed',
    command || detection.detail,
  ].filter(Boolean).join(' - ');
}

function HarnessModelPassthrough({
  adapterType,
  config,
  onConfigChange,
}: {
  adapterType: AdapterType;
  config: RuntimeConfig;
  onConfigChange: (value: RuntimeConfig) => void;
}) {
  const modelKey = adapterType === 'claude_code' ? 'claudeModel'
    : adapterType === 'codex' ? 'codexModel'
    : adapterType === 'cursor' ? 'cursorModel'
    : adapterType === 'hermes_agent' ? 'hermesModel'
    : adapterType === 'openclaw' ? 'openclawModel'
    : 'httpModel';
  const value = config[modelKey];

  return (
    <ModelChooser
      adapterType={adapterType}
      value={value}
      onChange={(next) => onConfigChange({ ...config, [modelKey]: next })}
    />
  );
}

function ConnectionDetailsAccordion({
  adapterType,
  config,
  setConfig,
  defaultOpen,
}: {
  adapterType: AdapterType;
  config: RuntimeConfig;
  setConfig: (key: keyof RuntimeConfig, value: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  useEffect(() => {
    setOpen(defaultOpen ?? false);
  }, [adapterType, defaultOpen]);

  if (adapterType === 'openclaw') return null;

  return (
    <div className="rounded-lg border border-line bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
      >
        <span>Connection settings</span>
        <span className="text-text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          {adapterType === 'http' ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Base URL"><input value={config.httpBaseUrl} onChange={(event) => setConfig('httpBaseUrl', event.target.value)} placeholder="https://agent.example.com" className={inputCls} /></Field>
              <Field label="Dispatch Path"><input value={config.httpDispatchPath} onChange={(event) => setConfig('httpDispatchPath', event.target.value)} placeholder="/task" className={inputCls} /></Field>
              <Field label="Auth credential ID"><input value={config.httpAuthCredentialId} onChange={(event) => setConfig('httpAuthCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'hermes_agent' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.hermesBinaryPath} onChange={(event) => setConfig('hermesBinaryPath', event.target.value)} placeholder="hermes" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.hermesCwd} onChange={(event) => setConfig('hermesCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.hermesTimeoutSec} onChange={(event) => setConfig('hermesTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'claude_code' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.claudeBinaryPath} onChange={(event) => setConfig('claudeBinaryPath', event.target.value)} placeholder="claude" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.claudeCwd} onChange={(event) => setConfig('claudeCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.claudeTimeoutSec} onChange={(event) => setConfig('claudeTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'codex' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.codexBinaryPath} onChange={(event) => setConfig('codexBinaryPath', event.target.value)} placeholder="codex" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.codexCwd} onChange={(event) => setConfig('codexCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.codexTimeoutSec} onChange={(event) => setConfig('codexTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'cursor' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.cursorBinaryPath} onChange={(event) => setConfig('cursorBinaryPath', event.target.value)} placeholder="agent" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.cursorCwd} onChange={(event) => setConfig('cursorCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.cursorTimeoutSec} onChange={(event) => setConfig('cursorTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function HarnessGrid({
  adapters,
  adapterType,
  detectionByType,
  installOptionByType,
  detecting,
  onAdapterChange,
  onInstallRequest,
  editing,
}: {
  adapters: typeof ADAPTERS;
  adapterType: AdapterType;
  detectionByType: Map<AdapterType, HarnessDetectionResult>;
  installOptionByType: Map<AdapterType, HarnessInstallOption>;
  detecting: boolean;
  onAdapterChange: (value: AdapterType) => void;
  onInstallRequest: (value: AdapterType) => void;
  editing?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
      {adapters.map((adapter) => {
        const Icon = adapter.icon;
        const selected = adapterType === adapter.id;
        const detection = detectionByType.get(adapter.id);
        const installOption = installOptionByType.get(adapter.id);
        const showInstallAction = !editing
          && adapter.id !== 'http'
          && detection?.status !== 'found'
          && Boolean(installOption);
        return (
          <div
            key={adapter.id}
            className={clsx(
              'relative flex min-w-0 flex-col gap-2 rounded-lg border p-2 text-center transition',
              selected ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-text-primary hover:border-accent/40 hover:bg-surface-3',
            )}
          >
            <button
              type="button"
              onClick={() => onAdapterChange(adapter.id)}
              className="flex h-20 flex-col items-center justify-center gap-2 rounded-md"
            >
              {adapter.recommended && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" />}
              {detecting && !detection ? <Loader2 className="h-5 w-5 animate-spin text-text-muted" /> : <Icon className="h-6 w-6" />}
              <span className="max-w-full truncate text-[12px] font-semibold">{adapter.title}</span>
              <span className={clsx(
                'rounded-full px-2 py-0.5 text-[10px]',
                detection?.status === 'found' ? 'bg-accent/10 text-accent' : 'bg-surface-3 text-text-muted',
              )}>
                {detecting && !detection ? 'Checking...' : detection?.status === 'found' ? (detection.authStatus === 'authenticated' ? 'Ready' : 'Installed') : detection?.status === 'error' ? 'Error' : 'Not installed'}
              </span>
            </button>
            {showInstallAction ? (
              <button
                type="button"
                onClick={() => onInstallRequest(adapter.id)}
                className="inline-flex h-7 items-center justify-center gap-1 rounded-btn border border-line bg-canvas px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                {installOption?.canAutoInstall ? <Download size={11} /> : <ExternalLink size={11} />}
                {installOption?.canAutoInstall ? 'Install' : 'Setup'}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function prefillConfigFromInstall(
  config: RuntimeConfig,
  adapterType: AdapterType,
  result: { binaryPath?: string; detectedModel?: string },
): RuntimeConfig {
  const binaryPath = stringOf(result.binaryPath);
  const detectedModel = stringOf(result.detectedModel);
  if (!binaryPath && !detectedModel) return config;
  if (adapterType === 'claude_code') {
    return {
      ...config,
      claudeBinaryPath: config.claudeBinaryPath || binaryPath,
      claudeModel: config.claudeModel || detectedModel || '',
    };
  }
  if (adapterType === 'codex') {
    return {
      ...config,
      codexBinaryPath: config.codexBinaryPath || binaryPath,
      codexModel: config.codexModel || detectedModel || '',
    };
  }
  if (adapterType === 'cursor') {
    return {
      ...config,
      cursorBinaryPath: config.cursorBinaryPath || binaryPath,
      cursorModel: config.cursorModel || detectedModel || '',
    };
  }
  if (adapterType === 'hermes_agent') {
    return {
      ...config,
      hermesBinaryPath: config.hermesBinaryPath || binaryPath,
      hermesModel: config.hermesModel || detectedModel || '',
    };
  }
  return config;
}

function prefillConfigFromDetection(config: RuntimeConfig, adapterType: AdapterType, detection: HarnessDetectionResult): RuntimeConfig {
  if (adapterType === 'openclaw') {
    const gatewayUrl = stringOf(detection.config?.gatewayUrl);
    const gatewayId = stringOf(detection.config?.gatewayId);
    const model = stringOf(detection.config?.model ?? detection.detectedModel);
    if (!gatewayUrl && !gatewayId && !model) return config;
    return {
      ...config,
      openclawGatewayUrl: config.openclawGatewayUrl || gatewayUrl,
      openclawGatewayId: config.openclawGatewayId || gatewayId,
      openclawModel: config.openclawModel || model,
    };
  }
  if (adapterType === 'claude_code') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      claudeBinaryPath: config.claudeBinaryPath || command,
      claudeModel: config.claudeModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'codex') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      codexBinaryPath: config.codexBinaryPath || command,
      codexModel: config.codexModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'cursor') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      cursorBinaryPath: config.cursorBinaryPath || command,
      cursorModel: config.cursorModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'hermes_agent') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      hermesBinaryPath: config.hermesBinaryPath || command,
      hermesModel: config.hermesModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'http') {
    const baseUrl = stringOf(detection.config?.baseUrl);
    const dispatchPath = stringOf(detection.config?.dispatchPath);
    const healthPath = stringOf(detection.config?.healthPath);
    if (!baseUrl && !dispatchPath && !healthPath) return config;
    return {
      ...config,
      httpBaseUrl: config.httpBaseUrl || baseUrl,
      httpDispatchPath: config.httpDispatchPath || dispatchPath || DEFAULT_RUNTIME_CONFIG.httpDispatchPath,
      httpHealthPath: config.httpHealthPath || healthPath || DEFAULT_RUNTIME_CONFIG.httpHealthPath,
    };
  }
  return config;
}

function AdapterConfigFields({
  adapterType,
  config,
  setConfig,
}: {
  adapterType: AdapterType;
  config: RuntimeConfig;
  setConfig: (key: keyof RuntimeConfig, value: string) => void;
}) {
  if (adapterType === 'openclaw') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Gateway ID"><input value={config.openclawGatewayId} onChange={(event) => setConfig('openclawGatewayId', event.target.value)} placeholder="Gateway ID" className={inputCls} /></Field>
        <Field label="Gateway URL"><input value={config.openclawGatewayUrl} onChange={(event) => setConfig('openclawGatewayUrl', event.target.value)} placeholder="wss://gateway.example.com" className={inputCls} /></Field>
        <Field label="Device token credential ID"><input value={config.openclawDeviceTokenCredentialId} onChange={(event) => setConfig('openclawDeviceTokenCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
        <Field label="Agent Name"><input value={config.openclawAgentName} onChange={(event) => setConfig('openclawAgentName', event.target.value)} placeholder="Agent Name" className={inputCls} /></Field>
        <Field label="Session key strategy"><select value={config.openclawSessionKeyStrategy} onChange={(event) => setConfig('openclawSessionKeyStrategy', event.target.value)} className={inputCls}><option value="issue">Issue</option><option value="fixed">Fixed</option><option value="run">Run</option></select></Field>
        <Field label="Session key"><input value={config.openclawSessionKey} onChange={(event) => setConfig('openclawSessionKey', event.target.value)} placeholder="Fixed session key" className={inputCls} /></Field>
        <Field label="Timeout"><input value={config.openclawTimeoutSec} onChange={(event) => setConfig('openclawTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Payload template"><textarea value={config.openclawPayloadTemplate} onChange={(event) => setConfig('openclawPayloadTemplate', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'hermes_agent') {
    return (
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Binary path"><input value={config.hermesBinaryPath} onChange={(event) => setConfig('hermesBinaryPath', event.target.value)} placeholder="hermes" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.hermesCwd} onChange={(event) => setConfig('hermesCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Max turns"><input value={config.hermesMaxTurns} onChange={(event) => setConfig('hermesMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Extra args"><input value={config.hermesExtraArgs} onChange={(event) => setConfig('hermesExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.hermesEnv} onChange={(event) => setConfig('hermesEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.hermesTimeoutSec} onChange={(event) => setConfig('hermesTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Grace"><input value={config.hermesGraceSec} onChange={(event) => setConfig('hermesGraceSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'claude_code') {
    return (
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Binary path"><input value={config.claudeBinaryPath} onChange={(event) => setConfig('claudeBinaryPath', event.target.value)} placeholder="claude" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.claudeCwd} onChange={(event) => setConfig('claudeCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Max turns"><input value={config.claudeMaxTurns} onChange={(event) => setConfig('claudeMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Allowed tools"><input value={config.claudeAllowedTools} onChange={(event) => setConfig('claudeAllowedTools', event.target.value)} placeholder="FileRead, FileWrite" className={inputCls} /></Field>
        <Field label="Extra args"><input value={config.claudeExtraArgs} onChange={(event) => setConfig('claudeExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.claudeEnv} onChange={(event) => setConfig('claudeEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.claudeTimeoutSec} onChange={(event) => setConfig('claudeTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'codex') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Binary path"><input value={config.codexBinaryPath} onChange={(event) => setConfig('codexBinaryPath', event.target.value)} placeholder="codex" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.codexCwd} onChange={(event) => setConfig('codexCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Max turns"><input value={config.codexMaxTurns} onChange={(event) => setConfig('codexMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Reasoning effort"><select value={config.codexReasoningEffort} onChange={(event) => setConfig('codexReasoningEffort', event.target.value)} className={inputCls}><option value="">Default</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Xhigh</option></select></Field>
        <Field label="Fast mode"><select value={config.codexFastMode} onChange={(event) => setConfig('codexFastMode', event.target.value)} className={inputCls}><option value="false">Off</option><option value="true">On</option></select></Field>
        <Field label="Bypass approvals"><select value={config.codexBypassApprovalsAndSandbox} onChange={(event) => setConfig('codexBypassApprovalsAndSandbox', event.target.value)} className={inputCls}><option value="true">On</option><option value="false">Off</option></select></Field>
        <Field label="Extra args"><input value={config.codexExtraArgs} onChange={(event) => setConfig('codexExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.codexEnv} onChange={(event) => setConfig('codexEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.codexTimeoutSec} onChange={(event) => setConfig('codexTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'cursor') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Binary path"><input value={config.cursorBinaryPath} onChange={(event) => setConfig('cursorBinaryPath', event.target.value)} placeholder="agent" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.cursorCwd} onChange={(event) => setConfig('cursorCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Extra args"><input value={config.cursorExtraArgs} onChange={(event) => setConfig('cursorExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.cursorEnv} onChange={(event) => setConfig('cursorEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.cursorTimeoutSec} onChange={(event) => setConfig('cursorTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Base URL"><input value={config.httpBaseUrl} onChange={(event) => setConfig('httpBaseUrl', event.target.value)} placeholder="https://agent.example.com" className={inputCls} /></Field>
      <Field label="Dispatch Path"><input value={config.httpDispatchPath} onChange={(event) => setConfig('httpDispatchPath', event.target.value)} placeholder="/task" className={inputCls} /></Field>
      <Field label="Cancel Path"><input value={config.httpCancelPath} onChange={(event) => setConfig('httpCancelPath', event.target.value)} placeholder="/cancel" className={inputCls} /></Field>
      <Field label="Health Path"><input value={config.httpHealthPath} onChange={(event) => setConfig('httpHealthPath', event.target.value)} placeholder="/health" className={inputCls} /></Field>
      <Field label="Method"><select value={config.httpMethod} onChange={(event) => setConfig('httpMethod', event.target.value)} className={inputCls}><option value="POST">POST</option><option value="GET">GET</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option></select></Field>
      <Field label="Auth credential ID"><input value={config.httpAuthCredentialId} onChange={(event) => setConfig('httpAuthCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
      <Field label="Shared secret credential ID"><input value={config.httpSharedSecretCredentialId} onChange={(event) => setConfig('httpSharedSecretCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
      <Field label="Dispatch Timeout"><input value={config.httpDispatchTimeoutMs} onChange={(event) => setConfig('httpDispatchTimeoutMs', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      <Field label="Headers"><textarea value={config.httpHeaders} onChange={(event) => setConfig('httpHeaders', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
      <Field label="Payload template"><textarea value={config.httpPayloadTemplate} onChange={(event) => setConfig('httpPayloadTemplate', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>{children}</label>;
}

export function configToRuntimeConfig(adapterType: AdapterType, stored: Record<string, unknown>): RuntimeConfig {
  const base = { ...DEFAULT_RUNTIME_CONFIG };
  if (adapterType === 'openclaw') return { ...base, openclawGatewayId: stringOf(stored.gatewayId), openclawGatewayUrl: stringOf(stored.gatewayUrl), openclawModel: stringOf(stored.model), openclawDeviceTokenCredentialId: stringOf(stored.deviceTokenCredentialId), openclawAgentName: stringOf(stored.agentName), openclawSessionKeyStrategy: stringOf(stored.sessionKeyStrategy, DEFAULT_RUNTIME_CONFIG.openclawSessionKeyStrategy), openclawSessionKey: stringOf(stored.sessionKey), openclawTimeoutSec: stringOf(stored.timeoutSec, DEFAULT_RUNTIME_CONFIG.openclawTimeoutSec), openclawPayloadTemplate: jsonText(stored.payloadTemplate) };
  if (adapterType === 'hermes_agent') return { ...base, hermesBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), hermesCwd: stringOf(stored.cwd), hermesModel: stringOf(stored.model), hermesMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.hermesMaxTurns), hermesExtraArgs: arrayText(stored.extraArgs), hermesEnv: jsonText(stored.env), hermesTimeoutSec: stringOf(stored.timeoutSec), hermesGraceSec: stringOf(stored.graceSec) };
  if (adapterType === 'claude_code') return { ...base, claudeBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), claudeCwd: stringOf(stored.cwd), claudeModel: stringOf(stored.model), claudeMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.claudeMaxTurns), claudeAllowedTools: arrayText(stored.allowedTools), claudeExtraArgs: arrayText(stored.extraArgs), claudeEnv: jsonText(stored.env), claudeTimeoutSec: stringOf(stored.timeoutSec) };
  if (adapterType === 'codex') return { ...base, codexBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), codexCwd: stringOf(stored.cwd), codexModel: stringOf(stored.model, DEFAULT_RUNTIME_CONFIG.codexModel), codexMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.codexMaxTurns), codexReasoningEffort: stringOf(stored.modelReasoningEffort), codexFastMode: boolText(stored.fastMode, DEFAULT_RUNTIME_CONFIG.codexFastMode), codexBypassApprovalsAndSandbox: boolText(stored.dangerouslyBypassApprovalsAndSandbox, DEFAULT_RUNTIME_CONFIG.codexBypassApprovalsAndSandbox), codexExtraArgs: arrayText(stored.extraArgs), codexEnv: jsonText(stored.env), codexTimeoutSec: stringOf(stored.timeoutSec) };
  if (adapterType === 'cursor') return { ...base, cursorBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), cursorCwd: stringOf(stored.cwd), cursorModel: stringOf(stored.model, DEFAULT_RUNTIME_CONFIG.cursorModel), cursorExtraArgs: arrayText(stored.extraArgs), cursorEnv: jsonText(stored.env), cursorTimeoutSec: stringOf(stored.timeoutSec) };
  return { ...base, httpBaseUrl: stringOf(stored.baseUrl), httpAuthCredentialId: stringOf(stored.authCredentialId), httpSharedSecretCredentialId: stringOf(stored.sharedSecretCredentialId), httpDispatchPath: stringOf(stored.dispatchPath, DEFAULT_RUNTIME_CONFIG.httpDispatchPath), httpCancelPath: stringOf(stored.cancelPath), httpHealthPath: stringOf(stored.healthPath, DEFAULT_RUNTIME_CONFIG.httpHealthPath), httpMethod: stringOf(stored.method, DEFAULT_RUNTIME_CONFIG.httpMethod).toUpperCase(), httpHeaders: jsonText(stored.headers), httpPayloadTemplate: jsonText(stored.payloadTemplate), httpDispatchTimeoutMs: stringOf(stored.dispatchTimeoutMs, DEFAULT_RUNTIME_CONFIG.httpDispatchTimeoutMs), httpModel: stringOf(stored.model) };
}

export function runtimeConfigToAdapterConfig(adapterType: AdapterType, config: RuntimeConfig): Record<string, unknown> {
  if (adapterType === 'openclaw') return compact({ gatewayId: config.openclawGatewayId, gatewayUrl: normalizeGatewayUrl(config.openclawGatewayUrl), model: config.openclawModel, agentName: config.openclawAgentName, deviceTokenCredentialId: config.openclawDeviceTokenCredentialId, sessionKeyStrategy: config.openclawSessionKeyStrategy, sessionKey: config.openclawSessionKey, timeoutSec: positiveNumber(config.openclawTimeoutSec), payloadTemplate: jsonObject(config.openclawPayloadTemplate) });
  if (adapterType === 'hermes_agent') return compact({ binaryPath: config.hermesBinaryPath, command: config.hermesBinaryPath, cwd: config.hermesCwd, model: config.hermesModel, maxTurns: positiveNumber(config.hermesMaxTurns), extraArgs: splitArgs(config.hermesExtraArgs), env: jsonStringRecord(config.hermesEnv), timeoutSec: positiveNumber(config.hermesTimeoutSec), graceSec: positiveNumber(config.hermesGraceSec) });
  if (adapterType === 'claude_code') return compact({ binaryPath: config.claudeBinaryPath, command: config.claudeBinaryPath, cwd: config.claudeCwd, model: config.claudeModel, maxTurns: positiveNumber(config.claudeMaxTurns), allowedTools: splitCsv(config.claudeAllowedTools), extraArgs: splitArgs(config.claudeExtraArgs), env: jsonStringRecord(config.claudeEnv), timeoutSec: positiveNumber(config.claudeTimeoutSec) });
  if (adapterType === 'codex') return compact({ binaryPath: config.codexBinaryPath, command: config.codexBinaryPath, cwd: config.codexCwd, model: config.codexModel, maxTurns: positiveNumber(config.codexMaxTurns), modelReasoningEffort: config.codexReasoningEffort, fastMode: boolValue(config.codexFastMode), dangerouslyBypassApprovalsAndSandbox: boolValue(config.codexBypassApprovalsAndSandbox), extraArgs: splitArgs(config.codexExtraArgs), env: jsonStringRecord(config.codexEnv), timeoutSec: positiveNumber(config.codexTimeoutSec) });
  if (adapterType === 'cursor') return compact({ binaryPath: config.cursorBinaryPath, command: config.cursorBinaryPath, cwd: config.cursorCwd, model: config.cursorModel, extraArgs: splitArgs(config.cursorExtraArgs), env: jsonStringRecord(config.cursorEnv), timeoutSec: positiveNumber(config.cursorTimeoutSec) });
  return compact({ baseUrl: config.httpBaseUrl, authCredentialId: config.httpAuthCredentialId, sharedSecretCredentialId: config.httpSharedSecretCredentialId, dispatchPath: config.httpDispatchPath, cancelPath: config.httpCancelPath, healthPath: config.httpHealthPath, method: config.httpMethod, headers: jsonStringRecord(config.httpHeaders), payloadTemplate: jsonObject(config.httpPayloadTemplate), dispatchTimeoutMs: positiveNumber(config.httpDispatchTimeoutMs), model: config.httpModel });
}

export function runtimeModelFor(adapterType: AdapterType, config: RuntimeConfig): string | null {
  if (adapterType === 'openclaw') return config.openclawModel || null;
  if (adapterType === 'http') return config.httpModel || null;
  if (adapterType === 'hermes_agent') return config.hermesModel || null;
  if (adapterType === 'claude_code') return config.claudeModel || null;
  if (adapterType === 'codex') return config.codexModel || DEFAULT_RUNTIME_CONFIG.codexModel;
  return config.cursorModel || DEFAULT_RUNTIME_CONFIG.cursorModel;
}

export function runtimeLabelFor(adapterType: AdapterType, config: RuntimeConfig): string {
  if (adapterType === 'openclaw') return config.openclawModel || config.openclawAgentName || 'OpenClaw';
  if (adapterType === 'hermes_agent') return config.hermesModel || 'Hermes Agent';
  if (adapterType === 'claude_code') return config.claudeModel || 'Claude Code';
  if (adapterType === 'codex') return config.codexModel || DEFAULT_RUNTIME_CONFIG.codexModel;
  if (adapterType === 'cursor') return config.cursorModel || DEFAULT_RUNTIME_CONFIG.cursorModel;
  return config.httpModel || 'HTTP / Webhook';
}

export function isV1AdapterType(value: string): value is AdapterType {
  return ADAPTERS.some((adapter) => adapter.id === value);
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== '' && value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)));
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeGatewayUrl(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value;
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  return parsed.toString();
}

function gatewayHealthUrl(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value.replace(/\/$/, '') + '/health';
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/health`;
  return parsed.toString();
}

function stringOf(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : '';
}

function jsonText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return JSON.stringify(value, null, 2);
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function jsonStringRecord(value: string): Record<string, string> | undefined {
  const object = jsonObject(value);
  if (!object) return undefined;
  const entries = Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function boolText(value: unknown, fallback: string): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' && (value === 'true' || value === 'false')) return value;
  return fallback;
}

function boolValue(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function splitCsv(value: string): string[] | undefined {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function splitArgs(value: string): string[] | undefined {
  const entries = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((entry) => entry.replace(/^"|"$/g, '')) ?? [];
  return entries.length > 0 ? entries : undefined;
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const inputCls = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';
const textareaCls = `${inputCls} min-h-20 resize-y font-mono text-xs`;

