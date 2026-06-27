/**
 * SurfaceBuilder — the direct-manipulation interface editor.
 *
 * Three panes: a palette of the GenUI vocabulary (click to insert), the live
 * {@link SurfaceCanvas} (pixel-true to production — select, move, duplicate,
 * delete, and inline-edit any node in place), and an inspector for the selected
 * node's style + the surface's settings. No row normalization, no Save→preview
 * round-trip — what you build is what ships. Replaces the old row-based Studio.
 */
import { useState } from 'react';
import clsx from 'clsx';
import { Copy, Layers, Settings2, Trash2 } from 'lucide-react';
import type { AppSurface, CollectionInfo, StyleIntent, SurfaceAction, SurfaceKind, ViewNode } from '@agentis/core';
import { SurfaceCanvas } from './SurfaceCanvas';
import { SURFACE_GROUPS, buildBlock, isBlockKind, type BlockKind, type PaletteItem } from './surfaceTemplates';

const DND_MIME = 'application/agentis-block';
import {
  addChildAtPath,
  appendNode,
  canHaveChildren,
  duplicateNodeAtPath,
  emptySurfaceView,
  getNodeAtPath,
  parseViewDraft,
  pathToLastChild,
  removeNodeAtPath,
  updateNodeAtPath,
} from './viewTree';

interface SurfaceBuilderProps {
  appId: string;
  current: AppSurface;
  draft: string;
  actions: SurfaceAction[];
  collections: CollectionInfo[];
  onDraftChange: (value: string) => void;
  onActionsChange: (actions: SurfaceAction[]) => void;
  onUpdateSurface: (patch: { kind?: SurfaceKind; shareable?: boolean }) => void;
  onDuplicateSurface: () => void;
  onDeleteSurface: () => void;
}

export function SurfaceBuilder({
  appId,
  current,
  draft,
  actions,
  collections,
  onDraftChange,
  onActionsChange,
  onUpdateSurface,
  onDuplicateSurface,
  onDeleteSurface,
}: SurfaceBuilderProps) {
  const [selectedPath, setSelectedPath] = useState<number[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const view = parseViewDraft(draft) ?? emptySurfaceView();
  const selectedNode = getNodeAtPath(view, selectedPath);

  const setView = (next: ViewNode) => onDraftChange(JSON.stringify(next, null, 2));

  function mergeActions(next: SurfaceAction[]) {
    const byName = new Map(actions.map((action) => [action.name, action]));
    for (const action of next) byName.set(action.name, action);
    onActionsChange([...byName.values()]);
  }

  function addBlock(kind: BlockKind) {
    const built = buildBlock(kind, collections);
    if (built.actions?.length) mergeActions(built.actions);
    // Insert into the selected container, else append to the surface root.
    if (selectedNode && canHaveChildren(selectedNode)) {
      setView(addChildAtPath(view, selectedPath, built.node));
      return;
    }
    const next = appendNode(view, built.node);
    setView(next);
    setSelectedPath(pathToLastChild(next));
  }

  function updateSelected(mutator: (node: ViewNode) => ViewNode) {
    if (!selectedNode) return;
    setView(updateNodeAtPath(view, selectedPath, mutator));
  }

  function duplicateSelected() {
    if (selectedPath.length === 0) return;
    setView(duplicateNodeAtPath(view, selectedPath));
  }

  function deleteSelected() {
    if (selectedPath.length === 0) return;
    setView(removeNodeAtPath(view, selectedPath));
    setSelectedPath([]);
  }

  return (
    <div className="grid h-full grid-cols-[224px_minmax(0,1fr)_288px] overflow-hidden">
      {/* Palette */}
      <aside className="min-h-0 overflow-auto border-r border-line bg-surface">
        <div className="border-b border-line px-3 py-3">
          <div className="text-[12px] font-semibold text-text-primary">Add to surface</div>
          <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Click to insert{selectedNode && canHaveChildren(selectedNode) ? ` into the selected ${selectedNode.type}` : ' on the surface'}.
          </div>
        </div>
        <div className="space-y-4 p-3">
          {SURFACE_GROUPS.map((group) => (
            <PaletteGroup key={group.title} title={group.title} items={group.items} onAdd={addBlock} />
          ))}
        </div>
      </aside>

      {/* Live canvas (pixel-true; direct manipulation + drag-from-palette) */}
      <main
        className={clsx('min-h-0 overflow-auto bg-canvas p-5 transition-shadow', dragOver && 'shadow-[inset_0_0_0_2px_var(--color-accent)]')}
        onClick={() => setSelectedPath([])}
        role="presentation"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DND_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const kind = event.dataTransfer.getData(DND_MIME);
          if (isBlockKind(kind)) addBlock(kind);
        }}
      >
        <div className="w-full" onClick={(event) => event.stopPropagation()} role="presentation">
          {canHaveChildren(view) && view.children.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-card border border-dashed border-line bg-surface/50 p-8 text-center">
              <Layers size={26} className="text-text-muted" />
              <div className="mt-3 text-[13px] font-semibold text-text-primary">Empty surface</div>
              <div className="mt-1 max-w-sm text-[12px] leading-relaxed text-text-muted">Add a block from the left, or describe it to the agent above. Click any element to select, move, or edit it in place.</div>
            </div>
          ) : (
            <SurfaceCanvas appId={appId} view={view} selectedPath={selectedPath} onSelect={setSelectedPath} onChange={setView} />
          )}
        </div>
      </main>

      {/* Inspector */}
      <aside className="min-h-0 overflow-auto border-l border-line bg-surface">
        {selectedNode ? (
          <NodeInspector node={selectedNode} onChange={updateSelected} onDuplicate={duplicateSelected} onDelete={deleteSelected} />
        ) : (
          <SurfaceSettings current={current} onUpdate={onUpdateSurface} onDuplicate={onDuplicateSurface} onDelete={onDeleteSurface} />
        )}
      </aside>
    </div>
  );
}

function PaletteGroup({ title, items, onAdd }: { title: string; items: PaletteItem[]; onAdd: (kind: BlockKind) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            title={`${item.hint} — click or drag onto the canvas`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(DND_MIME, item.kind);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAdd(item.kind)}
            className="flex cursor-grab items-center gap-1.5 rounded-btn border border-line bg-canvas px-2 py-1.5 text-left text-[11px] text-text-secondary hover:border-accent/50 hover:text-text-primary active:cursor-grabbing"
          >
            <span className="shrink-0 text-text-muted">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Inspector ───────────────────────────────────────────────

const TONE_OPTIONS = ['', 'neutral', 'accent', 'success', 'warning', 'danger', 'info'];
const ELEVATION_OPTIONS = ['', 'flat', 'raised', 'inset', 'outline'];
const PAD_OPTIONS = ['', 'none', 'sm', 'md', 'lg', 'xl'];
const ACCENT_OPTIONS = ['', 'accent', 'blue', 'teal', 'purple', 'orange', 'rose', 'lime', 'info', 'success', 'warning', 'danger'];
const SIZE_OPTIONS = ['', 'sm', 'md', 'lg', 'xl'];

type StyleKey = 'tone' | 'elevation' | 'pad' | 'accent' | 'size';

/** Set a string-valued style key (the inspector only edits these), dropping it on ''. */
function setStyle(node: ViewNode, key: StyleKey, value: string | undefined): ViewNode {
  const nextStyle = { ...node.style } as Record<string, unknown>;
  if (!value) delete nextStyle[key];
  else nextStyle[key] = value;
  const cleaned = Object.keys(nextStyle).length > 0 ? (nextStyle as StyleIntent) : undefined;
  return { ...node, style: cleaned } as ViewNode;
}

function hasKey<K extends string>(node: ViewNode, key: K): node is ViewNode & Record<K, unknown> {
  return key in node;
}

function NodeInspector({
  node,
  onChange,
  onDuplicate,
  onDelete,
}: {
  node: ViewNode;
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const isText = node.type === 'Text' || node.type === 'Heading' || node.type === 'Markdown';
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-3 text-[12px] font-semibold text-text-primary">
        <Settings2 size={14} /> {node.type}
      </div>
      <div className="flex flex-col gap-3 p-3">
        {hasKey(node, 'title') ? (
          <Field label="Title">
            <input
              value={String((node as { title?: string }).title ?? '')}
              onChange={(event) => onChange((n) => ({ ...n, title: event.target.value }) as ViewNode)}
              className="h-8 w-full rounded-btn border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
            />
          </Field>
        ) : null}

        {isText ? (
          <Field label="Text">
            <textarea
              value={String((node as { value?: string }).value ?? '')}
              onChange={(event) => onChange((n) => ({ ...n, value: event.target.value }) as ViewNode)}
              rows={3}
              className="w-full resize-none rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
            />
          </Field>
        ) : null}

        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Style</div>
        <SelectField label="Tone" value={node.style?.tone ?? ''} options={TONE_OPTIONS} onChange={(v) => onChange((n) => setStyle(n, 'tone', v || undefined))} />
        <SelectField label="Elevation" value={node.style?.elevation ?? ''} options={ELEVATION_OPTIONS} onChange={(v) => onChange((n) => setStyle(n, 'elevation', v || undefined))} />
        <SelectField label="Padding" value={node.style?.pad ?? ''} options={PAD_OPTIONS} onChange={(v) => onChange((n) => setStyle(n, 'pad', v || undefined))} />
        <SelectField label="Accent" value={node.style?.accent ?? ''} options={ACCENT_OPTIONS} onChange={(v) => onChange((n) => setStyle(n, 'accent', v || undefined))} />
        {isText ? <SelectField label="Size" value={node.style?.size ?? ''} options={SIZE_OPTIONS} onChange={(v) => onChange((n) => setStyle(n, 'size', v || undefined))} /> : null}

        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onDuplicate} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-text-secondary hover:text-text-primary">
            <Copy size={12} /> Duplicate
          </button>
          <button type="button" onClick={onDelete} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-danger hover:bg-danger-soft">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function SurfaceSettings({
  current,
  onUpdate,
  onDuplicate,
  onDelete,
}: {
  current: AppSurface;
  onUpdate: (patch: { kind?: SurfaceKind; shareable?: boolean }) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-3 text-[12px] font-semibold text-text-primary">
        <Settings2 size={14} /> Surface
      </div>
      <div className="flex flex-col gap-3 p-3">
        <SelectField
          label="Kind"
          value={current.kind}
          options={['page', 'dashboard', 'thread', 'embed', 'public']}
          onChange={(v) => onUpdate({ kind: (v || 'page') as SurfaceKind })}
        />
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" checked={current.shareable} onChange={(event) => onUpdate({ shareable: event.target.checked })} />
          Shareable (public link)
        </label>
        <div className="mt-1 text-[11px] text-text-muted">Select an element on the canvas to edit it. Click empty space to return here.</div>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onDuplicate} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-text-secondary hover:text-text-primary">
            <Copy size={12} /> Duplicate
          </button>
          <button type="button" onClick={onDelete} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-danger hover:bg-danger-soft">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-text-muted">
      <span className="uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<string>; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-btn border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option === '' ? 'default' : option}</option>
        ))}
      </select>
    </Field>
  );
}
