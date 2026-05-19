import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import type { ViewportContext } from '@agentis/core';
import { api } from '../lib/api';
import { Button } from '../components/shared/Button';
import { useToast } from '../components/shared/Toast';

interface CreateAppResponse {
  app?: {
    id: string;
    slug: string;
    name?: string;
    path?: string;
  };
  appId?: string;
  appSlug?: string;
}

const ICON_COLORS = ['#22c55e', '#06b6d4', '#f59e0b', '#f43f5e', '#8b5cf6', '#14b8a6', '#eab308'];

export function AppCreationWizard() {
  const nav = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [imageData, setImageData] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const trimmedName = name.trim();
  const initials = useMemo(() => appInitials(trimmedName || 'New app'), [trimmedName]);
  const iconColor = useMemo(() => colorForName(trimmedName || 'New app'), [trimmedName]);
  const canCreate = trimmedName.length >= 2 && !creating;

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => setImageData((loadEvent.target?.result as string) ?? null);
    reader.readAsDataURL(file);
  }

  async function createDraftApp() {
    if (!canCreate) return;
    setCreating(true);
    try {
      const goal = `Design and build ${trimmedName} as an Agentis agentic app.`;
      const res = await api<CreateAppResponse>('/v1/apps', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          goal,
          description: '',
          appKind: 'custom',
          creationMode: 'orchestrated_draft',
          iconGlyph: initials,
          iconColor,
          iconUrl: imageData,
          surfaces: [{ type: 'thread' }],
        }),
      });
      const app = res.app;
      const slug = app?.slug ?? res.appSlug;
      const appId = app?.id ?? res.appId;
      const destination = app?.path ?? (slug ? `/apps/${slug}?layer=canvas&build=1` : '/apps');
      nav(destination);

      window.setTimeout(() => {
        const viewportOverride: ViewportContext = {
          surface: 'app_detail',
          route: destination,
          title: `${trimmedName} · App builder`,
          resourceId: appId,
          resourceKind: 'app',
          metadata: {
            layer: 'canvas',
            buildMode: true,
            source: 'app_creation_launcher',
          },
        };
        window.dispatchEvent(new CustomEvent('agentis:chat-panel-open', {
          detail: {
            initialDraft: buildOrchestratorDraft({ appId, slug, name: trimmedName }),
            initialViewportOverride: viewportOverride,
            autoSendInitialDraft: true,
            buildSession: { appId, slug, name: trimmedName },
          },
        }));
      }, 120);
    } catch (error) {
      toast.error('Failed to create app', String(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-full bg-canvas">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-6 py-8">
        <button
          type="button"
          onClick={() => nav('/apps')}
          className="mb-8 inline-flex w-fit items-center gap-1.5 text-[12px] text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={14} />
          Apps
        </button>

        <main className="grid flex-1 items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_360px]">
          <section className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
              <Sparkles size={12} />
              Orchestrator build session
            </div>
            <h1 className="text-[42px] font-semibold leading-[0.95] tracking-[-0.04em] text-text-primary">
              Start with the app. Let Agentis build the system behind it.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-text-secondary">
              Give the app a face and a name. Agentis will open the canvas, dock the orchestrator, and begin turning the idea into workflows, agents, data, and deployable surfaces.
            </p>

            <div className="mt-8 space-y-4">
              <div className="space-y-2">
                <label htmlFor="app-create-name" className="text-[12px] font-medium text-text-secondary">App name</label>
                <input
                  id="app-create-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Zero-Inbox SDR Engine"
                  className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[16px] text-text-primary outline-none transition focus:border-accent"
                  autoFocus
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  size="md"
                  iconLeft={<ImagePlus size={15} />}
                  onClick={() => fileRef.current?.click()}
                >
                  {imageData ? 'Change image' : 'Add real image'}
                </Button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageChange} />
                {imageData && (
                  <Button variant="ghost" size="md" iconLeft={<X size={14} />} onClick={() => setImageData(null)}>
                    Remove image
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-3 pt-4">
                <Button variant="primary" size="md" disabled={!canCreate} onClick={() => void createDraftApp()}>
                  {creating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                  Open canvas with orchestrator
                </Button>
                <span className="text-[12px] text-text-muted">The next screen is the app canvas, not another form.</span>
              </div>
            </div>
          </section>

          <aside className="rounded-card border border-line bg-surface p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Draft app identity</div>
            <div className="mt-5 flex items-center gap-4">
              <div
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-card border border-line text-[26px] font-semibold text-white"
                style={{ backgroundColor: iconColor }}
              >
                {imageData ? <img src={imageData} alt="" className="h-full w-full object-cover" /> : initials}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[20px] font-semibold tracking-[-0.02em] text-text-primary">
                  {trimmedName || 'Untitled app'}
                </div>
                <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                  Draft shell, canvas, and orchestrator build log are created together.
                </div>
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-4 text-[12px] leading-6 text-text-secondary">
              The orchestrator will ask for the app’s job, suggest the architecture, then compose workflows and agents directly into the draft.
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

function buildOrchestratorDraft({ appId, slug, name }: { appId?: string; slug?: string; name: string }) {
  return [
    `We are building a new Agentis app: ${name}.`,
    '',
    'Start by asking me what this app should do. Then help me shape it into an agentic application with workflows, agents, data, brain, surfaces, and deploy behavior.',
    '',
    'When the plan is clear, use agentis.app.compose to complete this existing draft instead of creating a duplicate app.',
    `Draft app id: ${appId ?? 'unknown'}`,
    `Draft app slug: ${slug ?? 'unknown'}`,
    '',
    'Show your thinking as a useful build log: requirements, proposed architecture, created workflows, created agents, and canvas updates.',
  ].join('\n');
}

function appInitials(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || 'A';
}

function colorForName(value: string): string {
  const total = value.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return ICON_COLORS[total % ICON_COLORS.length] ?? ICON_COLORS[0]!;
}
