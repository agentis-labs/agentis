import { useMemo, useState, type ReactNode } from 'react';
import { Copy, GripVertical, Layers3, Plus, Settings2, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { AppSurface, CollectionInfo, SurfaceAction, SurfaceKind, ViewNode } from '@agentis/core';
import { SurfaceCanvas } from './SurfaceCanvas';
import {
  SURFACE_GROUPS,
  blockLabel,
  buildBlock,
  isBlockKind,
  type BlockKind,
  type PaletteItem,
} from './surfaceTemplates';
import {
  canHaveChildren,
  duplicateNodeAtPath,
  getNodeAtPath,
  removeNodeAtPath,
  updateNodeAtPath,
} from './viewTree';

type RowLikeNode = { type: 'Row' | 'Grid'; gap?: number; widths?: number[]; children: ViewNode[] };
type RowNode = { type: 'Row'; gap?: number; widths?: number[]; children: ViewNode[] };
type StackNode = { type: 'Stack'; gap?: number; children: RowNode[] };

interface StudioSurfaceBuilderProps {
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

export function StudioSurfaceBuilder({
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
}: StudioSurfaceBuilderProps) {
  const [selectedPath, setSelectedPath] = useState<number[]>([]);
  const view = useMemo(() => normalizeRows(parseDraft(draft)), [draft]);
  const selectedNode = getNodeAtPath(view, selectedPath);

  function commit(next: ViewNode, nextSelectedPath = selectedPath) {
    const normalized = normalizeRows(next);
    onDraftChange(JSON.stringify(normalized, null, 2));
    setSelectedPath(nextSelectedPath);
  }

  function mergeActions(next: SurfaceAction[]) {
    const byName = new Map(actions.map((action) => [action.name, action]));
    for (const action of next) byName.set(action.name, action);
    onActionsChange([...byName.values()]);
  }

  function addBlock(kind: BlockKind, rowIndex = view.children.length) {
    const built = buildBlock(kind, collections);
    if (built.actions?.length) mergeActions(built.actions);
    const rows = [...view.children];
    const at = Math.max(0, Math.min(rowIndex, rows.length));
    rows.splice(at, 0, { type: 'Row', gap: 12, widths: [1], children: [built.node] });
    commit({ ...view, children: rows }, [at, 0]);
  }

  function addBlockToRow(kind: BlockKind, rowIndex: number, blockIndex?: number) {
    const built = buildBlock(kind, collections);
    if (built.actions?.length) mergeActions(built.actions);
    const rows = view.children.map((row, index) => {
      if (index !== rowIndex) return row;
      const children = [...row.children];
      const widths = [...(row.widths ?? row.children.map(() => 1))];
      const at = blockIndex == null ? children.length : Math.max(0, Math.min(blockIndex, children.length));
      children.splice(at, 0, built.node);
      widths.splice(at, 0, 1);
      return { ...row, children, widths };
    });
    const nextIndex = blockIndex == null ? rows[rowIndex]!.children.length - 1 : blockIndex;
    commit({ ...view, children: rows }, [rowIndex, nextIndex]);
  }

  function moveRow(rowIndex: number, dir: -1 | 1) {
    const target = rowIndex + dir;
    if (target < 0 || target >= view.children.length) return;
    const rows = [...view.children];
    [rows[rowIndex], rows[target]] = [rows[target]!, rows[rowIndex]!];
    commit({ ...view, children: rows }, selectedPath[0] === rowIndex ? [target, ...(selectedPath.slice(1))] : selectedPath);
  }

  function removeRow(rowIndex: number) {
    const rows = view.children.filter((_, index) => index !== rowIndex);
    commit({ ...view, children: rows }, []);
  }

  function moveBlock(rowIndex: number, blockIndex: number, dir: -1 | 1) {
    const target = blockIndex + dir;
    const row = view.children[rowIndex];
    if (!row || target < 0 || target >= row.children.length) return;
    const rows = view.children.map((item, index) => {
      if (index !== rowIndex) return item;
      const children = [...item.children];
      const widths = [...(item.widths ?? item.children.map(() => 1))];
      [children[blockIndex], children[target]] = [children[target]!, children[blockIndex]!];
      [widths[blockIndex], widths[target]] = [widths[target] ?? 1, widths[blockIndex] ?? 1];
      return { ...item, children, widths };
    });
    commit({ ...view, children: rows }, [rowIndex, target]);
  }

  function duplicateBlock(path: number[]) {
    commit(duplicateNodeAtPath(view, path), siblingPath(path, 1));
  }

  function removeBlock(path: number[]) {
    commit(removeNodeAtPath(view, path), []);
  }

  function setBlockWidth(rowIndex: number, blockIndex: number, width: number) {
    const rows = view.children.map((row, index) => {
      if (index !== rowIndex) return row;
      const widths = row.widths ?? row.children.map(() => 1);
      const next = [...widths];
      next[blockIndex] = width;
      return { ...row, widths: next };
    });
    commit({ ...view, children: rows });
  }

  function updateSelected(mutator: (node: ViewNode) => ViewNode) {
    if (!selectedNode) return;
    commit(updateNodeAtPath(view, selectedPath, mutator));
  }

  return (
    <div className="grid h-full grid-cols-[236px_minmax(0,1fr)_300px] overflow-hidden">
      <aside className="min-h-0 overflow-auto border-r border-line bg-surface">
        <div className="border-b border-line px-3 py-3">
          <div className="text-[12px] font-semibold text-text-primary">Studio blocks</div>
          <div className="mt-1 text-[11px] leading-relaxed text-text-muted">Drag blocks into rows or click to add a new row.</div>
        </div>
        <div className="space-y-5 p-3">
          {SURFACE_GROUPS.map((group) => (
            <PaletteGroup key={group.title} title={group.title} items={group.items} onAdd={(kind) => addBlock(kind)} />
          ))}
        </div>
      </aside>

      <main className="min-h-0 overflow-auto bg-canvas p-5" onClick={() => setSelectedPath([])} role="presentation">
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-3">
          <DropBetweenRows index={0} onDropBlock={addBlock} />
          {view.children.map((row, rowIndex) => (
            <RowEditor
              key={rowIndex}
              appId={appId}
              row={row}
              rowIndex={rowIndex}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
              onChangeBlock={(blockIndex, node) => commit(updateNodeAtPath(view, [rowIndex, blockIndex], () => node), [rowIndex, blockIndex])}
              onDropBlock={addBlockToRow}
              onMoveRow={moveRow}
              onRemoveRow={removeRow}
              onMoveBlock={moveBlock}
              onDuplicateBlock={duplicateBlock}
              onRemoveBlock={removeBlock}
              onWidthChange={setBlockWidth}
            />
          ))}
          {view.children.length === 0 ? (
            <div className="flex min-h-80 flex-col items-center justify-center rounded-card border border-dashed border-line bg-surface/60 p-8 text-center">
              <Layers3 size={28} className="text-text-muted" />
              <div className="mt-3 text-[13px] font-semibold text-text-primary">Drop Studio blocks here</div>
              <div className="mt-1 max-w-sm text-[12px] leading-relaxed text-text-muted">Rows are the layout unit. Add a block to create a row, then tune each card's flex width.</div>
            </div>
          ) : null}
        </div>
      </main>

      <aside className="min-h-0 overflow-auto border-l border-line bg-surface">
        <div className="border-b border-line px-3 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-text-primary">
            <Settings2 size={14} /> Surface
          </div>
          <SurfaceControls
            current={current}
            onUpdate={onUpdateSurface}
            onDuplicate={onDuplicateSurface}
            onDelete={onDeleteSurface}
          />
        </div>
        <div className="p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Properties</div>
          {selectedNode ? (
            <NodeInspector node={selectedNode} collections={collections} onChange={updateSelected} />
          ) : (
            <div className="rounded-card border border-line bg-canvas p-3 text-[12px] text-text-muted">
              Select a block card to edit its Studio config.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function PaletteGroup({ title, items, onAdd }: { title: string; items: PaletteItem[]; onAdd: (kind: BlockKind) => void }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            draggable
            title={item.hint}
            onClick={() => onAdd(item.kind)}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-agentis-block', item.kind);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            className="flex h-[74px] flex-col items-start justify-between rounded-card border border-line bg-canvas p-2 text-left text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:bg-surface-2 hover:text-text-primary"
          >
            <span className="text-text-muted">{item.icon}</span>
            <span className="font-medium leading-tight">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RowEditor({
  appId,
  row,
  rowIndex,
  selectedPath,
  onSelect,
  onChangeBlock,
  onDropBlock,
  onMoveRow,
  onRemoveRow,
  onMoveBlock,
  onDuplicateBlock,
  onRemoveBlock,
  onWidthChange,
}: {
  appId: string;
  row: RowNode;
  rowIndex: number;
  selectedPath: number[];
  onSelect: (path: number[]) => void;
  onChangeBlock: (blockIndex: number, node: ViewNode) => void;
  onDropBlock: (kind: BlockKind, rowIndex: number, blockIndex?: number) => void;
  onMoveRow: (rowIndex: number, dir: -1 | 1) => void;
  onRemoveRow: (rowIndex: number) => void;
  onMoveBlock: (rowIndex: number, blockIndex: number, dir: -1 | 1) => void;
  onDuplicateBlock: (path: number[]) => void;
  onRemoveBlock: (path: number[]) => void;
  onWidthChange: (rowIndex: number, blockIndex: number, width: number) => void;
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-2 shadow-card" onClick={(event) => event.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-6 items-center gap-1 rounded-btn border border-line bg-canvas px-2 text-[11px] text-text-muted">
          <GripVertical size={12} /> Row {rowIndex + 1}
        </span>
        <button type="button" onClick={() => onMoveRow(rowIndex, -1)} className="rounded-btn border border-line px-2 py-1 text-[11px] text-text-secondary hover:bg-canvas">Up</button>
        <button type="button" onClick={() => onMoveRow(rowIndex, 1)} className="rounded-btn border border-line px-2 py-1 text-[11px] text-text-secondary hover:bg-canvas">Down</button>
        <button type="button" onClick={() => onRemoveRow(rowIndex)} className="ml-auto rounded-btn border border-danger/30 bg-danger-soft px-2 py-1 text-[11px] text-danger">Delete row</button>
      </div>
      <div className="flex gap-2" style={{ gap: row.gap ?? 12 }}>
        {row.children.map((block, blockIndex) => {
          const path = [rowIndex, blockIndex];
          const selected = pathsEqual(path, selectedPath);
          return (
            <div key={blockIndex} className="min-w-[180px]" style={{ flex: `${row.widths?.[blockIndex] ?? 1} 1 0` }}>
              <DropInsideRow rowIndex={rowIndex} blockIndex={blockIndex} onDropBlock={onDropBlock} />
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(path)}
                onKeyDown={(event) => { if (event.key === 'Enter') onSelect(path); }}
                className={clsx('group overflow-hidden rounded-card border bg-canvas transition-shadow', selected ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'border-line hover:border-line-strong')}
              >
                <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-text-secondary">{nodeTitle(block)}</span>
                  <button type="button" aria-label="Move block left" onClick={(event) => { event.stopPropagation(); onMoveBlock(rowIndex, blockIndex, -1); }} className="rounded p-1 text-text-muted hover:bg-canvas">←</button>
                  <button type="button" aria-label="Move block right" onClick={(event) => { event.stopPropagation(); onMoveBlock(rowIndex, blockIndex, 1); }} className="rounded p-1 text-text-muted hover:bg-canvas">→</button>
                  <button type="button" aria-label="Duplicate block" onClick={(event) => { event.stopPropagation(); onDuplicateBlock(path); }} className="rounded p-1 text-text-muted hover:bg-canvas"><Copy size={12} /></button>
                  <button type="button" aria-label="Delete block" onClick={(event) => { event.stopPropagation(); onRemoveBlock(path); }} className="rounded p-1 text-danger hover:bg-danger-soft"><Trash2 size={12} /></button>
                </div>
                <div className="p-2">
                  <SurfaceCanvas appId={appId} view={block} selectedPath={[]} onSelect={() => onSelect(path)} onChange={(node) => onChangeBlock(blockIndex, node)} />
                </div>
                <div className="border-t border-line px-2 py-1.5">
                  <label className="flex items-center gap-2 text-[10px] text-text-muted">
                    Flex
                    <input
                      type="range"
                      min={1}
                      max={4}
                      step={1}
                      value={row.widths?.[blockIndex] ?? 1}
                      onChange={(event) => onWidthChange(rowIndex, blockIndex, Number(event.target.value))}
                      className="min-w-0 flex-1"
                    />
                    <span className="w-4 text-right">{row.widths?.[blockIndex] ?? 1}</span>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
        <DropInsideRow rowIndex={rowIndex} onDropBlock={onDropBlock} />
      </div>
      <DropBetweenRows index={rowIndex + 1} onDropBlock={(kind, index) => onDropBlock(kind, index)} />
    </section>
  );
}

function DropBetweenRows({ index, onDropBlock }: { index: number; onDropBlock: (kind: BlockKind, rowIndex: number) => void }) {
  return (
    <div
      className="flex h-8 items-center justify-center rounded-card border border-dashed border-transparent text-[11px] text-text-muted transition-colors hover:border-accent/40 hover:bg-accent-soft/20"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => {
        event.preventDefault();
        const kind = event.dataTransfer.getData('application/x-agentis-block');
        if (isBlockKind(kind)) onDropBlock(kind, index);
      }}
    >
      Drop here for new row
    </div>
  );
}

function DropInsideRow({ rowIndex, blockIndex, onDropBlock }: { rowIndex: number; blockIndex?: number; onDropBlock: (kind: BlockKind, rowIndex: number, blockIndex?: number) => void }) {
  return (
    <div
      className="mb-2 flex min-h-8 min-w-20 items-center justify-center rounded-card border border-dashed border-line bg-surface/60 px-3 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft/20"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => {
        event.preventDefault();
        const kind = event.dataTransfer.getData('application/x-agentis-block');
        if (isBlockKind(kind)) onDropBlock(kind, rowIndex, blockIndex);
      }}
    >
      <Plus size={12} />
    </div>
  );
}

function SurfaceControls({ current, onUpdate, onDuplicate, onDelete }: { current: AppSurface; onUpdate: (patch: { kind?: SurfaceKind; shareable?: boolean }) => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      <label className="block text-[11px] font-medium text-text-muted">
        Surface kind
        <select value={current.kind} onChange={(event) => onUpdate({ kind: event.target.value as SurfaceKind })} className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent">
          {(['page', 'dashboard', 'thread', 'embed', 'public'] as SurfaceKind[]).map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 rounded-btn border border-line bg-canvas px-2 py-2 text-[12px] text-text-secondary">
        <input type="checkbox" checked={current.shareable} onChange={(event) => onUpdate({ shareable: event.target.checked })} />
        Shareable
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onDuplicate} className="rounded-btn border border-line bg-canvas px-2 py-1.5 text-[12px] text-text-secondary hover:bg-surface-2">Duplicate</button>
        <button type="button" onClick={onDelete} className="rounded-btn border border-danger/30 bg-danger-soft px-2 py-1.5 text-[12px] text-danger">Delete</button>
      </div>
    </div>
  );
}

function NodeInspector({ node, collections, onChange }: { node: ViewNode; collections: CollectionInfo[]; onChange: (mutator: (node: ViewNode) => ViewNode) => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-line bg-canvas p-3">
        <div className="text-[12px] font-semibold text-text-primary">{nodeTitle(node)}</div>
        <div className="mt-1 text-[11px] text-text-muted">{node.type}</div>
      </div>
      <NodeFields node={node} collections={collections} onChange={onChange} />
    </div>
  );
}

function NodeFields({ node, collections, onChange }: { node: ViewNode; collections: CollectionInfo[]; onChange: (mutator: (node: ViewNode) => ViewNode) => void }) {
  if (node.type === 'Heading' || node.type === 'Text' || node.type === 'Markdown') {
    return <PropertyTextarea label="Content" value={node.value} onChange={(value) => onChange((current) => ({ ...current, value } as ViewNode))} />;
  }
  if (node.type === 'Card' || node.type === 'Section') {
    return <PropertyInput label="Title" value={node.title ?? ''} onChange={(title) => onChange((current) => ({ ...current, title } as ViewNode))} />;
  }
  if (node.type === 'Stack' || node.type === 'Row' || node.type === 'Grid') {
    return <PropertyInput label="Gap" value={String(node.gap ?? 12)} onChange={(gap) => onChange((current) => ({ ...current, gap: Number(gap) || 0 } as ViewNode))} />;
  }
  if (node.type === 'Metric') {
    return (
      <>
        <PropertyInput label="Label" value={node.label} onChange={(label) => onChange((current) => ({ ...current, label } as ViewNode))} />
        <PropertyInput label="Value" value={bindableToInput(node.value)} onChange={(value) => onChange((current) => ({ ...current, value: inputToBindable(value) } as ViewNode))} />
        <PropertyInput label="Delta" value={bindableToInput(node.delta ?? '')} onChange={(delta) => onChange((current) => ({ ...current, delta: inputToBindable(delta) } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'Table' || node.type === 'Chart' || node.type === 'DataBoard') {
    return <DataBlockFields node={node} collections={collections} onChange={onChange} />;
  }
  if (node.type === 'Button') {
    return (
      <>
        <PropertyInput label="Label" value={node.label} onChange={(label) => onChange((current) => ({ ...current, label } as ViewNode))} />
        <PropertyInput label="Action" value={node.action.action} onChange={(action) => onChange((current) => ({ ...current, action: { ...(current as Extract<ViewNode, { type: 'Button' }>).action, action } } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'DocumentViewer') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyTextarea label="Content" value={node.content} onChange={(content) => onChange((current) => ({ ...current, content } as ViewNode))} />
        <PropertyInput label="Download name" value={node.downloadName ?? ''} onChange={(downloadName) => onChange((current) => ({ ...current, downloadName } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'Narrative') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyTextarea label="Narrative" value={node.value} onChange={(value) => onChange((current) => ({ ...current, value } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'WebEmbed') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyInput label="HTTPS URL" value={node.url} onChange={(url) => onChange((current) => ({ ...current, url } as ViewNode))} />
        <PropertyInput label="Height" value={String(node.height ?? 320)} onChange={(height) => onChange((current) => ({ ...current, height: Number(height) || 320 } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'CodeViewer') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyInput label="Language" value={node.language ?? ''} onChange={(language) => onChange((current) => ({ ...current, language } as ViewNode))} />
        <PropertyTextarea label="Code" value={node.code} onChange={(code) => onChange((current) => ({ ...current, code } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'StatusBoard') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyTextarea label="Items JSON" value={JSON.stringify(node.items, null, 2)} onChange={(value) => {
          const items = safeJson(value, node.items);
          onChange((current) => ({ ...current, items } as ViewNode));
        }} />
      </>
    );
  }
  if (node.type === 'MapView') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyInput label="Region" value={node.region ?? ''} onChange={(region) => onChange((current) => ({ ...current, region } as ViewNode))} />
        <PropertyTextarea label="Pins JSON" value={JSON.stringify(node.pins ?? [], null, 2)} onChange={(value) => onChange((current) => ({ ...current, pins: safeJson(value, (current as Extract<ViewNode, { type: 'MapView' }>).pins ?? []) } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'ConversationThread') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyTextarea label="Messages JSON" value={JSON.stringify(node.messages ?? [], null, 2)} onChange={(value) => onChange((current) => ({ ...current, messages: safeJson(value, (current as Extract<ViewNode, { type: 'ConversationThread' }>).messages ?? []) } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'MediaGallery') {
    return (
      <>
        <TitleInput node={node} onChange={onChange} />
        <PropertyTextarea label="Items JSON" value={JSON.stringify(node.items, null, 2)} onChange={(value) => onChange((current) => ({ ...current, items: safeJson(value, (current as Extract<ViewNode, { type: 'MediaGallery' }>).items) } as ViewNode))} />
      </>
    );
  }
  return <div className="rounded-card border border-line bg-canvas p-3 text-[12px] text-text-muted">No editable fields for this block.</div>;
}

function DataBlockFields({ node, collections, onChange }: { node: Extract<ViewNode, { type: 'Table' | 'Chart' | 'DataBoard' }>; collections: CollectionInfo[]; onChange: (mutator: (node: ViewNode) => ViewNode) => void }) {
  return (
    <>
      <label className="block text-[11px] font-medium text-text-muted">
        Collection
        <select value={node.bind.collection} onChange={(event) => onChange((current) => ({ ...current, bind: { ...(current as typeof node).bind, collection: event.target.value } } as ViewNode))} className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent">
          {collections.length === 0 ? <option value={node.bind.collection}>{node.bind.collection}</option> : null}
          {collections.map((collection) => <option key={collection.id} value={collection.name}>{collection.name}</option>)}
        </select>
      </label>
      {node.type === 'Table' ? (
        <PropertyInput label="Columns" value={node.columns.map((column) => column.key).join(', ')} onChange={(value) => onChange((current) => ({ ...current, columns: value.split(',').map((part) => part.trim()).filter(Boolean).map((key) => ({ key, label: key })) } as ViewNode))} />
      ) : null}
      {node.type === 'Chart' ? (
        <>
          <PropertyInput label="X field" value={node.x} onChange={(x) => onChange((current) => ({ ...current, x } as ViewNode))} />
          <PropertyInput label="Y field" value={node.y} onChange={(y) => onChange((current) => ({ ...current, y } as ViewNode))} />
        </>
      ) : null}
      {node.type === 'DataBoard' ? (
        <>
          <PropertyInput label="Group by" value={node.groupBy} onChange={(groupBy) => onChange((current) => ({ ...current, groupBy } as ViewNode))} />
          <PropertyInput label="Title field" value={node.titleField ?? ''} onChange={(titleField) => onChange((current) => ({ ...current, titleField } as ViewNode))} />
        </>
      ) : null}
    </>
  );
}

function TitleInput({ node, onChange }: { node: Extract<ViewNode, { title?: string }>; onChange: (mutator: (node: ViewNode) => ViewNode) => void }) {
  return <PropertyInput label="Title" value={node.title ?? ''} onChange={(title) => onChange((current) => ({ ...current, title } as ViewNode))} />;
}

function PropertyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent" />
    </label>
  );
}

function PropertyTextarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 min-h-24 w-full resize-y rounded-md border border-line bg-canvas p-2 font-mono text-[12px] text-text-primary outline-none focus:border-accent" />
    </label>
  );
}

function parseDraft(draft: string): ViewNode {
  try {
    const parsed = JSON.parse(draft) as ViewNode;
    return parsed && typeof parsed === 'object' && 'type' in parsed ? parsed : emptyRows();
  } catch {
    return emptyRows();
  }
}

function normalizeRows(node: ViewNode): StackNode {
  if (node.type === 'Stack') {
    const rows = node.children.flatMap((child) => child.type === 'Row' ? [normalizeRow(child)] : [{ type: 'Row' as const, gap: 12, widths: [1], children: [child] }]);
    return { ...node, type: 'Stack', gap: node.gap ?? 12, children: rows };
  }
  if (node.type === 'Row') return { type: 'Stack', gap: 12, children: [normalizeRow(node)] };
  return { type: 'Stack', gap: 12, children: [{ type: 'Row', gap: 12, widths: [1], children: [node] }] };
}

function normalizeRow(row: RowLikeNode): RowNode {
  const widths = row.widths ?? row.children.map(() => 1);
  return { type: 'Row', gap: row.gap ?? 12, widths: row.children.map((_, index) => widths[index] ?? 1), children: row.children };
}

function emptyRows(): StackNode {
  return { type: 'Stack', gap: 12, children: [] };
}

function nodeTitle(node: ViewNode): string {
  if (node.type === 'Table') return 'Data table';
  if (node.type === 'ActivityStream') return node.title ?? 'Message feed';
  if (node.type === 'AgentConsole') return node.title ?? 'Agent card';
  if ('title' in node && node.title) return node.title;
  if (node.type === 'Metric') return node.label;
  if (node.type === 'Heading' || node.type === 'Text' || node.type === 'Markdown') return node.value.slice(0, 40);
  if (node.type === 'Button') return node.label;
  return blockLabel(typeToKind(node.type));
}

function typeToKind(type: ViewNode['type']): BlockKind {
  const map: Partial<Record<ViewNode['type'], BlockKind>> = {
    Chart: 'chart',
    DocumentViewer: 'document_viewer',
    MapView: 'map',
    StatusBoard: 'status_board',
    WebEmbed: 'web_embed',
    Narrative: 'narrative',
    ConversationThread: 'conversation_thread',
    CodeViewer: 'code_viewer',
    MediaGallery: 'media_gallery',
    Card: 'card',
    Row: 'row',
    Stack: 'stack',
    Heading: 'heading',
    Text: 'text',
    Button: 'button',
  };
  return map[type] ?? 'card';
}

function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function siblingPath(path: number[], delta: number): number[] {
  const next = [...path];
  next[next.length - 1] = (next[next.length - 1] ?? 0) + delta;
  return next;
}

function bindableToInput(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$row === 'string') return `$row.${record.$row}`;
    if (typeof record.$state === 'string') return `$state.${record.$state}`;
    if (typeof record.$bind === 'string') return `$bind.${record.$bind}`;
  }
  return value == null ? '' : String(value);
}

function inputToBindable(value: string) {
  if (value.startsWith('$row.')) return { $row: value.slice(5) };
  if (value.startsWith('$state.')) return { $state: value.slice(7) };
  if (value.startsWith('$bind.')) return { $bind: value.slice(6) };
  return value;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
