/**
 * AbilityDetailPage — Premium Specialist DNA Studio & Integration Hub.
 *
 * Squeezed, space-efficient workspace featuring:
 *   - Thin Squeezed top header bar (all status indicators and action buttons inline).
 *   - Sticky Left Sidebar Navigation with Lucide Icons.
 *   - Focused, single-column workspace tabs for each of the 6 Specialist DNA layers.
 *   - High-fidelity Overview Dashboard with Quick-Edit redirect links.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Download, FileText, MessageSquare, Plus, RefreshCw,
  Settings as SettingsIcon, Trash2, Upload, Wand2,
  Check, Folder,
  Lock, Unlock, Globe, Link2, FileJson, FileCode, CheckCircle2,
  Trash, History, Cpu, Database, Play, AlertCircle, AlertTriangle, X, HelpCircle, Layers,
  Compass, ShieldAlert, Award, FileCode2, Image as ImageIcon,
  LayoutGrid, User, SlidersHorizontal, ShieldCheck, BookOpen, Settings2, XCircle, Wrench,
  ChevronDown
} from 'lucide-react';
import { Button, IconButton } from '../components/shared/Button';
import { StatusBadge, StatusDot } from '../components/shared/StatusBadge';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { AbilityCompileConfigDrawer } from '../components/abilities/AbilityCompileConfigDrawer';
import {
  abilitiesApi,
  compileStatusLabel,
  compileStatusTone,
  COMPILE_STAGE_LABELS,
  COMPILE_STAGE_ORDER,
  DOMAIN_TAGS,
  downloadAbilityPackage,
  type Ability,
  type AbilityCompileStage,
  type AbilityExample,
  type AbilityKnowledge,
  type AbilityKnowledgeSourceType,
  type CompileConfigResponse,
} from '../lib/abilities';
import { api, apiErrorMessage } from '../lib/api';

type Tab = 'overview' | 'persona' | 'specs' | 'rules' | 'knowledge' | 'examples' | 'settings';

interface AgentRow {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatarGlyph?: string | null;
  colorHex?: string | null;
  role?: string | null;
}

const ABILITY_ICON_OPTIONS = ['⚡', '🎨', '🔧', '📊', '⚖️', '✍️', '🔒', '💡', '🚀', '🎯', '🧪', '📝', '💼', '🏗️', '🌐', '🤖', '💻', '🔍', '📱', '🧠'] as const;
const DOMAIN_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: 'Engineering', items: ['ui_engineering', 'backend_engineering', 'devops'] },
  { label: 'Data',        items: ['data_analysis'] },
  { label: 'Business',    items: ['legal', 'sales', 'finance'] },
  { label: 'Creative',    items: ['content', 'design'] },
  { label: 'Research',    items: ['research'] },
  { label: 'Other',       items: ['custom'] },
];

export function AbilityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [ability, setAbility] = useState<Ability | null>(null);
  const [examples, setExamples] = useState<AbilityExample[]>([]);
  const [knowledge, setKnowledge] = useState<AbilityKnowledge[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const initialTabSet = useRef(false);

  useEffect(() => {
    if (ability && !initialTabSet.current) {
      initialTabSet.current = true;
      const isEmpty =
        ability.name === 'Untitled ability' &&
        Object.keys(ability.specs).filter((k) => k !== '__persona_locked').length === 0 &&
        examples.length === 0;
      if (isEmpty) {
        setTab('persona');
      }
    }
  }, [ability, examples]);

  // Identity states
  const [editName, setEditName] = useState('');
  const [editIconEmoji, setEditIconEmoji] = useState('⚡');
  const [editDomainTag, setEditDomainTag] = useState('custom');
  const [editDescription, setEditDescription] = useState('');

  // Specs, rules, tool hints
  const [editSpecs, setEditSpecs] = useState<Array<{ key: string; value: string }>>([]);
  const [editRulesAlways, setEditRulesAlways] = useState<string[]>([]);
  const [editRulesNever, setEditRulesNever] = useState<string[]>([]);
  const [editToolHints, setEditToolHints] = useState<string[]>([]);

  // Direct Specialist Persona editor state
  const [editPersona, setEditPersona] = useState('');
  const [personaLocked, setPersonaLocked] = useState(false);

  // Icon picker + domain dropdown open states
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);

  // Asset creation tab states
  const [activeAssetTab, setActiveAssetTab] = useState<'upload' | 'url' | 'note'>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [expandedKnowledgeIds, setExpandedKnowledgeIds] = useState<Set<string>>(new Set());
  const [expandedExampleIds, setExpandedExampleIds] = useState<Set<string>>(new Set());

  // Inline forms
  const [assetUrl, setAssetUrl] = useState('');
  const [assetUrlTitle, setAssetUrlTitle] = useState('');
  const [assetUrlSummary, setAssetUrlSummary] = useState('');
  const [assetUrlImportance, setAssetUrlImportance] = useState(0.60);
  const [assetNoteTitle, setAssetNoteTitle] = useState('');
  const [assetNoteContent, setAssetNoteContent] = useState('');
  const [assetNoteImportance, setAssetNoteImportance] = useState(0.60);
  const [addingAsset, setAddingAsset] = useState(false);

  // Run promotion flywheel states
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRunDetail, setSelectedRunDetail] = useState<any | null>(null);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);

  // Agent integration states
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [pinnedAgents, setPinnedAgents] = useState<Record<string, { pinned: boolean; enabled: boolean }>>({});
  const [loadingPins, setLoadingPins] = useState(false);

  // Example editor popup
  const [editingExample, setEditingExample] = useState<AbilityExample | null>(null);

  const [saving, setSaving] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Real phase reported by the server, refreshed by the status poll.
  const [compileStage, setCompileStage] = useState<AbilityCompileStage | null>(null);
  const [compileConfig, setCompileConfig] = useState<CompileConfigResponse | null>(null);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      setCompileConfig(await abilitiesApi.getCompileConfig());
    } catch {
      // The detail page still works without this best-effort warning.
    }
  }, []);

  useEffect(() => { void refreshConfig(); }, [refreshConfig]);

  useEffect(() => {
    if (!ability) return;
    setEditName(ability.name);
    setEditIconEmoji(ability.iconEmoji ?? '⚡');
    setEditDomainTag(ability.domainTag ?? 'custom');
    setEditDescription(ability.description ?? '');
    setEditSpecs(
      Object.entries(ability.specs)
        .filter(([key]) => key !== '__persona_locked')
        .map(([key, value]) => ({
          key,
          value: value ?? '',
        }))
    );
    setEditRulesAlways(ability.rulesAlways);
    setEditRulesNever(ability.rulesNever);
    setEditToolHints(ability.toolHints);
    setPersonaLocked(ability.specs.__persona_locked === 'true');
    setEditPersona(ability.compiledPrompt ?? '');
  }, [ability]);

  const isDirty = useMemo(() => {
    if (!ability) return false;
    
    const originalSpecs = Object.entries(ability.specs)
      .filter(([k, v]) => k.trim() !== '' && k !== '__persona_locked')
      .map(([k, v]) => `${k.trim()}:${(v ?? '').trim()}`)
      .sort()
      .join(',');
      
    const currentSpecs = editSpecs
      .filter(item => item.key.trim() !== '' && item.key !== '__persona_locked')
      .map(item => `${item.key.trim()}:${item.value.trim()}`)
      .sort()
      .join(',');
      
    const originalAlways = [...ability.rulesAlways].sort().join(',');
    const currentAlways = editRulesAlways.filter(r => r.trim() !== '').sort().join(',');
    
    const originalNever = [...ability.rulesNever].sort().join(',');
    const currentNever = editRulesNever.filter(r => r.trim() !== '').sort().join(',');
    
    const originalHints = [...ability.toolHints].sort().join(',');
    const currentHints = editToolHints.filter(h => h.trim() !== '').sort().join(',');

    const originalPersonaLocked = ability.specs.__persona_locked === 'true';
    const currentPersonaLocked = personaLocked;

    const originalPersona = ability.compiledPrompt ?? '';
    const currentPersona = editPersona;

    return (
      editName.trim() !== ability.name ||
      editIconEmoji.trim() !== (ability.iconEmoji ?? '⚡') ||
      editDomainTag !== (ability.domainTag ?? 'custom') ||
      editDescription.trim() !== (ability.description ?? '') ||
      originalSpecs !== currentSpecs ||
      originalAlways !== currentAlways ||
      originalNever !== currentNever ||
      originalHints !== currentHints ||
      originalPersonaLocked !== currentPersonaLocked ||
      originalPersona !== currentPersona
    );
  }, [ability, editName, editIconEmoji, editDomainTag, editDescription, editSpecs, editRulesAlways, editRulesNever, editToolHints, personaLocked, editPersona]);

  const refresh = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [a, ex, kn] = await Promise.all([
        abilitiesApi.get(id),
        abilitiesApi.listExamples(id),
        abilitiesApi.listKnowledge(id),
      ]);
      setAbility(a.ability);
      setExamples(ex.examples);
      setKnowledge(kn.knowledge);
    } catch (err) {
      toast.error('Could not load ability', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  const loadAgentPins = useCallback(async () => {
    if (!id) return;
    setLoadingPins(true);
    try {
      const agentsRes = await api<{ agents: AgentRow[] }>('/v1/agents');
      const agentsList = agentsRes.agents ?? [];
      setAgents(agentsList);

      const pinsMap: Record<string, { pinned: boolean; enabled: boolean }> = {};
      await Promise.all(
        agentsList.map(async (agent) => {
          try {
            const pinsRes = await abilitiesApi.pins.list(agent.id);
            const foundPin = pinsRes.pins?.find((p) => p.abilityId === id);
            pinsMap[agent.id] = {
              pinned: !!foundPin,
              enabled: foundPin ? foundPin.enabled : false,
            };
          } catch (e) {
            pinsMap[agent.id] = { pinned: false, enabled: false };
          }
        })
      );
      setPinnedAgents(pinsMap);
    } catch (err) {
      toast.error('Could not load agent pin integrations', apiErrorMessage(err));
    } finally {
      setLoadingPins(false);
    }
  }, [id, toast]);

  useEffect(() => {
    if (tab === 'settings') {
      void loadAgentPins();
    }
  }, [tab, loadAgentPins]);

  const handleDiscardChanges = useCallback(() => {
    if (!ability) return;
    setEditName(ability.name);
    setEditIconEmoji(ability.iconEmoji ?? '⚡');
    setEditDomainTag(ability.domainTag ?? 'custom');
    setEditDescription(ability.description ?? '');
    setEditSpecs(
      Object.entries(ability.specs)
        .filter(([key]) => key !== '__persona_locked')
        .map(([key, value]) => ({
          key,
          value: value ?? '',
        }))
    );
    setEditRulesAlways(ability.rulesAlways);
    setEditRulesNever(ability.rulesNever);
    setEditToolHints(ability.toolHints);
    setPersonaLocked(ability.specs.__persona_locked === 'true');
    setEditPersona(ability.compiledPrompt ?? '');
    toast.success('Changes discarded');
  }, [ability, toast]);

  const handleSaveChanges = useCallback(async () => {
    if (!ability || !id) return;
    setSaving(true);
    
    const specsRecord: Record<string, string> = {};
    for (const entry of editSpecs) {
      const k = entry.key.trim();
      const v = entry.value.trim();
      if (k && k !== '__persona_locked') specsRecord[k] = v;
    }
    if (personaLocked) {
      specsRecord['__persona_locked'] = 'true';
    }

    try {
      await abilitiesApi.update(id, {
        name: editName.trim() || 'Untitled ability',
        iconEmoji: editIconEmoji.trim() || '⚡',
        domainTag: editDomainTag === 'custom' ? 'custom' : editDomainTag,
        description: editDescription.trim() || null,
        specs: specsRecord,
        rulesAlways: editRulesAlways.map(r => r.trim()).filter(Boolean),
        rulesNever: editRulesNever.map(r => r.trim()).filter(Boolean),
        toolHints: editToolHints.map(h => h.trim()).filter(Boolean),
        compiledPrompt: personaLocked ? editPersona : (ability.compiledPrompt ?? null),
      });
      toast.success('Ability saved successfully');
      await refresh();
    } catch (err) {
      toast.error('Failed to save ability', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [ability, id, editName, editIconEmoji, editDomainTag, editDescription, editSpecs, editRulesAlways, editRulesNever, editToolHints, personaLocked, editPersona, refresh, toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Compile-status polling — fetches the server-reported phase every 1.5s
  // while compiling. The stage drives the progress UI (no more cosmetic
  // ticker), so the user always sees what the worker is actually doing.
  useEffect(() => {
    if (!id) return;
    if (ability?.compileStatus !== 'compiling' && !compiling) return;

    const statusPoll = setInterval(async () => {
      try {
        const status = await abilitiesApi.status(id);
        setCompileStage(status.compileStage ?? null);
        if (status.compileStatus !== 'compiling') {
          clearInterval(statusPoll);
          setCompiling(false);
          setCancelling(false);
          setCompileStage(null);
          await refresh();
        } else {
          setAbility((prev) => prev ? {
            ...prev,
            compileStatus: 'compiling',
            compileStage: status.compileStage,
            compileCancelRequested: status.compileCancelRequested,
          } : prev);
        }
      } catch {
        // Transient network error — keep polling.
      }
    }, 1_500);

    return () => clearInterval(statusPoll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ability?.compileStatus, compiling, id]);

  const handleCancelCompile = useCallback(async () => {
    if (!ability || cancelling) return;
    setCancelling(true);
    try {
      await abilitiesApi.cancelCompile(ability.id);
      toast.info('Cancel requested', 'Worker will stop at the next stage boundary.');
    } catch (err) {
      setCancelling(false);
      toast.error('Cancel failed', apiErrorMessage(err));
    }
  }, [ability, cancelling, toast]);

  if (loading || !ability) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center justify-between border-b border-line px-6 py-3.5 bg-surface shrink-0">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex-1 flex overflow-hidden">
          <div className="w-[220px] border-r border-line bg-surface p-4 gap-2 flex flex-col">
            <Skeleton className="h-9 w-full rounded" />
            <Skeleton className="h-9 w-full rounded" />
            <Skeleton className="h-9 w-full rounded" />
          </div>
          <div className="flex-1 p-6 space-y-4">
            <Skeleton className="h-32 rounded-card" />
            <Skeleton className="h-64 rounded-card" />
          </div>
        </div>
      </div>
    );
  }

  const tone = compileStatusTone(ability.compileStatus);
  const badgeTone = tone === 'green' ? 'accent' : tone === 'amber' ? 'warn' : tone === 'red' ? 'danger' : 'muted';
  const isCompiling = compiling || ability.compileStatus === 'compiling';
  const hasCompileModel = compileConfig?.hasModel ?? true;
  const compileButtonLabel = isCompiling
    ? (ability.compileCancelRequested || cancelling ? 'Cancelling' : 'Cancel')
    : isDirty
      ? (hasCompileModel ? 'Save & Compile' : 'Save & Template Compile')
      : ability.compileStatus === 'ready'
        ? (hasCompileModel ? 'Recompile' : 'Template Recompile')
        : (hasCompileModel ? 'Compile' : 'Template Compile');

  async function handleCompile() {
    if (!ability) return;
    setCompiling(true);
    setCompileStage('queued');
    // Optimistic status update — user sees feedback instantly.
    setAbility((prev) => prev ? { ...prev, compileStatus: 'compiling', compileStage: 'queued', compileCancelRequested: false } : prev);
    try {
      if (isDirty) {
        const specsRecord: Record<string, string> = {};
        for (const entry of editSpecs) {
          const k = entry.key.trim();
          const v = entry.value.trim();
          if (k && k !== '__persona_locked') specsRecord[k] = v;
        }
        if (personaLocked) {
          specsRecord['__persona_locked'] = 'true';
        }
        await abilitiesApi.update(ability.id, {
          name: editName.trim() || 'Untitled ability',
          iconEmoji: editIconEmoji.trim() || '⚡',
          domainTag: editDomainTag === 'custom' ? 'custom' : editDomainTag,
          description: editDescription.trim() || null,
          specs: specsRecord,
          rulesAlways: editRulesAlways.map(r => r.trim()).filter(Boolean),
          rulesNever: editRulesNever.map(r => r.trim()).filter(Boolean),
          toolHints: editToolHints.map(h => h.trim()).filter(Boolean),
          compiledPrompt: personaLocked ? editPersona : (ability.compiledPrompt ?? null),
        });
      }
      await abilitiesApi.compile(ability.id);
    } catch (err) {
      setCompiling(false);
      setCompileStage(null);
      setAbility((prev) => prev ? { ...prev, compileStatus: 'failed', compileStage: null } : prev);
      toast.error('Compile failed', apiErrorMessage(err));
    }
  }

  async function handleExport() {
    try {
      const pkg = await abilitiesApi.export(ability!.id);
      downloadAbilityPackage(pkg, ability!.slug);
      toast.success('Exported', `${ability!.name}.ability`);
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete ${ability!.name}?`,
      body: 'Removes the ability and every example, knowledge entry, and pin. Cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
      typeToConfirm: ability!.slug,
    });
    if (!ok) return;
    try {
      await abilitiesApi.delete(ability!.id);
      toast.success('Ability deleted', ability!.name);
      nav('/agents');
    } catch (err) {
      toast.error('Delete failed', apiErrorMessage(err));
    }
  }

  async function handleFileUploads(files: File[]) {
    if (!ability) return;
    for (const file of files) {
      try {
        await abilitiesApi.uploadKnowledgeFile(ability.id, file);
        toast.success(`Uploaded ${file.name}`);
        await refresh();
      } catch (err) {
        toast.error(`Failed to upload ${file.name}`, apiErrorMessage(err));
      }
    }
  }

  async function handleAddUrlAsset() {
    if (!ability) return;
    if (!assetUrl.trim() || !assetUrlSummary.trim()) {
      toast.warn('Missing fields', 'Please provide a URL and a brief summary of its content.');
      return;
    }
    setAddingAsset(true);
    try {
      const parsedTitle = assetUrlTitle.trim() || new URL(assetUrl).hostname;
      await abilitiesApi.addKnowledge(ability.id, {
        title: parsedTitle,
        content: assetUrlSummary.trim(),
        sourceUrl: assetUrl.trim(),
        sourceType: 'url',
        importanceScore: assetUrlImportance,
      });
      toast.success('URL asset added successfully');
      setAssetUrl('');
      setAssetUrlTitle('');
      setAssetUrlSummary('');
      await refresh();
    } catch (err) {
      toast.error('Failed to add URL asset', apiErrorMessage(err));
    } finally {
      setAddingAsset(false);
    }
  }

  async function handleAddNoteAsset() {
    if (!ability) return;
    if (!assetNoteContent.trim()) {
      toast.warn('Content missing', 'Please write some content for the note.');
      return;
    }
    setAddingAsset(true);
    try {
      await abilitiesApi.addKnowledge(ability.id, {
        title: assetNoteTitle.trim() || 'Manual Note',
        content: assetNoteContent.trim(),
        sourceType: 'manual',
        importanceScore: assetNoteImportance,
      });
      toast.success('Note asset added successfully');
      setAssetNoteTitle('');
      setAssetNoteContent('');
      await refresh();
    } catch (err) {
      toast.error('Failed to add note asset', apiErrorMessage(err));
    } finally {
      setAddingAsset(false);
    }
  }

  async function handleTogglePin(agentId: string) {
    const isPinned = pinnedAgents[agentId]?.pinned;
    try {
      if (isPinned) {
        await abilitiesApi.pins.unpin(agentId, id!);
        setPinnedAgents(prev => ({
          ...prev,
          [agentId]: { pinned: false, enabled: false }
        }));
        toast.success('Ability unpinned from agent');
      } else {
        await abilitiesApi.pins.pin(agentId, id!);
        setPinnedAgents(prev => ({
          ...prev,
          [agentId]: { pinned: true, enabled: true }
        }));
        toast.success('Ability pinned to agent');
      }
    } catch (err) {
      toast.error('Failed to toggle pin', apiErrorMessage(err));
    }
  }

  async function openRunHistory() {
    setShowRunHistory(true);
    setLoadingRuns(true);
    setSelectedRunDetail(null);
    try {
      const data = await api<{ runs: any[] }>('/v1/runs?limit=20');
      setRecentRuns(data.runs ?? []);
    } catch (err) {
      try {
        const fallback = await api<{ events: any[] }>('/v1/history?type=runs&limit=20');
        setRecentRuns(fallback.events ?? []);
      } catch {
        setRecentRuns([]);
      }
    } finally {
      setLoadingRuns(false);
    }
  }

  async function handleSelectRun(runId: string) {
    setLoadingRunDetail(true);
    try {
      const data = await api<{ run: any }>(`/v1/runs/${runId}`);
      setSelectedRunDetail(data.run);
    } catch (err) {
      toast.error('Could not load run details', apiErrorMessage(err));
    } finally {
      setLoadingRunDetail(false);
    }
  }

  function handleImportNode(node: any) {
    const taskInput = extractNodeText(node.inputs);
    const responseOutput = extractNodeText(node.output);
    
    setEditingExample({
      id: '',
      abilityId: ability!.id,
      inputText: taskInput,
      outputText: responseOutput,
      inputMediaUrl: null,
      mediaDescription: null,
      qualityScore: 0.85,
      source: 'promoted_from_run',
      originRunId: selectedRunDetail.id,
      createdAt: new Date().toISOString(),
    });
    
    setShowRunHistory(false);
    setSelectedRunDetail(null);
  }

  const navTabs: ReadonlyArray<{
    readonly value: Tab;
    readonly label: string;
    readonly icon: React.ReactNode;
    readonly count?: number;
  }> = [
    { value: 'overview', label: 'Overview', icon: <LayoutGrid size={14} /> },
    { value: 'persona', label: 'Persona', icon: <User size={14} /> },
    { value: 'specs', label: 'Specs', icon: <SlidersHorizontal size={14} /> },
    { value: 'rules', label: 'Rules', icon: <ShieldCheck size={14} /> },
    { value: 'knowledge', label: 'References', icon: <BookOpen size={14} />, count: knowledge.length },
    { value: 'examples', label: 'Examples', icon: <MessageSquare size={14} />, count: examples.length },
    { value: 'settings', label: 'Settings', icon: <Settings2 size={14} /> },
  ];

  const compileDate = ability?.lastCompiledAt ? new Date(ability.lastCompiledAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const personaReady = editPersona?.trim().length > 0;
  const personaText = personaReady
    ? `${personaLocked ? 'Custom override active' : `Auto-synthesized${compileDate ? ` on ${compileDate}` : ''}`} · ${editPersona.trim().length} chars`
    : 'Empty — compile to generate automatically from your specs and rules';

  const activeSpecs = editSpecs.filter(s => s.key.trim() !== '');
  const specsReady = activeSpecs.length > 0;
  const specsText = specsReady
    ? `${activeSpecs.length} key-value pair${activeSpecs.length === 1 ? '' : 's'} defined`
    : 'Empty — add specs to define specialist parameters';

  const alwaysCount = editRulesAlways.filter(Boolean).length;
  const neverCount = editRulesNever.filter(Boolean).length;
  const hintsCount = editToolHints.filter(Boolean).length;
  const rulesReady = alwaysCount > 0 || neverCount > 0 || hintsCount > 0;
  const rulesText = rulesReady
    ? `${alwaysCount} always · ${neverCount} never · ${hintsCount} tool preference${hintsCount === 1 ? '' : 's'}`
    : 'Empty — add rules to guide specialist behavior';

  const knowledgeReady = knowledge.length > 0;
  const knowledgeText = knowledgeReady
    ? `${knowledge.length} document${knowledge.length === 1 ? '' : 's'}`
    : 'Empty — upload files or links to seed reference grounded knowledge';

  const examplesReady = examples.length >= 5;
  const examplesText = examples.length > 0
    ? `${examples.length} example${examples.length === 1 ? '' : 's'}${examples.length < 5 ? ' — add 5+ to improve quality' : ''}`
    : 'Empty — add task-response pairs to show exact behavior';

  const readinessItems = [
    {
      label: 'Persona',
      status: personaReady ? 'accent' as const : 'warn' as const,
      text: personaText,
    },
    {
      label: 'Specs',
      status: specsReady ? 'accent' as const : 'warn' as const,
      text: specsText,
    },
    {
      label: 'Rules',
      status: rulesReady ? 'accent' as const : 'warn' as const,
      text: rulesText,
    },
    {
      label: 'Knowledge',
      status: knowledgeReady ? 'accent' as const : 'warn' as const,
      text: knowledgeText,
    },
    {
      label: 'Examples',
      status: examplesReady ? 'accent' as const : 'warn' as const,
      text: examplesText,
    },
  ];

  return (
    <div className="flex h-full flex-col bg-surface-base select-none">
      
      <header className="flex flex-wrap items-center justify-between border-b border-line px-6 py-2 bg-surface shrink-0 z-30 shadow-sm gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/agents"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-surface hover:text-text-primary text-text-muted hover:border-line-strong transition-all shrink-0"
            aria-label="Back to abilities"
          >
            <ArrowLeft size={13} />
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-md flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 border border-line shadow-sm shrink-0">{editIconEmoji}</span>
            <span className="font-semibold text-text-primary text-[15px] max-w-[180px] sm:max-w-xs truncate">{editName || 'Untitled ability'}</span>
          </div>
          
          <div className="flex flex-wrap items-center gap-1.5 ml-2">
            <StatusBadge
              tone={badgeTone as 'accent' | 'warn' | 'danger' | 'muted'}
              label={compileStatusLabel(ability.compileStatus)}
              pulse={ability.compileStatus === 'compiling'}
              size="sm"
            />
            {!hasCompileModel && (
              <button
                type="button"
                onClick={() => setConfigDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn-soft/60 px-2.5 py-0.5 text-[11px] font-semibold text-warn hover:border-warn/50 hover:bg-warn-soft transition-colors"
                title="No model is configured. Compile will use the free template fallback."
              >
                <AlertTriangle size={11} />
                Template mode
              </button>
            )}
            {isDirty && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-500 bg-amber-500/10 px-2.5 py-0.5 rounded-full animate-pulse shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unsaved
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" iconLeft={<Download size={13} />} onClick={handleExport} className="h-8 py-0">
            Export
          </Button>
          {isDirty && !isCompiling && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSaveChanges}
              loading={saving}
              disabled={saving}
              className="h-8 py-0 text-text-muted"
            >
              Save draft
            </Button>
          )}
          <Button
            variant={isCompiling ? 'danger' : 'primary'}
            size="sm"
            iconLeft={isCompiling ? <X size={13} /> : <Wand2 size={13} />}
            onClick={isCompiling ? handleCancelCompile : handleCompile}
            loading={false}
            disabled={ability.compileCancelRequested || cancelling}
            className="h-8 py-0"
          >
            {compileButtonLabel}
          </Button>
        </div>
      </header>

      {ability.description && (
        <div className="px-6 py-1 bg-surface-2/40 border-b border-line text-[11px] text-text-muted truncate shrink-0">
          <span className="font-semibold text-text-secondary">Specialist Core:</span> {ability.description}
        </div>
      )}

      {isCompiling && (() => {
        const stage = (ability.compileStage ?? compileStage ?? 'queued') as AbilityCompileStage;
        const stageIdx = COMPILE_STAGE_ORDER.indexOf(stage);
        const cancelRequested = ability.compileCancelRequested || cancelling;
        return (
          <div className="border-b border-accent/20 bg-accent/8 px-6 py-2.5 shrink-0 animate-in fade-in duration-200">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-accent" />
              </span>
              <span className="text-[11px] font-semibold text-accent flex-1 truncate">
                {cancelRequested ? 'Cancelling…' : (COMPILE_STAGE_LABELS[stage] + '…')}
              </span>
              <span className="text-[10px] text-text-muted font-medium hidden sm:block">
                Stage {Math.max(0, stageIdx) + 1} of {COMPILE_STAGE_ORDER.length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelCompile}
                disabled={cancelRequested}
                className="h-7 py-0 text-[10px] text-danger hover:bg-danger-soft"
                iconLeft={<X size={11} />}
              >
                {cancelRequested ? 'Cancelling' : 'Cancel'}
              </Button>
            </div>
            {/* Step progress dots — real, not cosmetic. */}
            <div className="flex gap-1.5 mt-2 ml-6">
              {COMPILE_STAGE_ORDER.map((_, i) => (
                <span
                  key={i}
                  className={`h-1 rounded-full transition-all duration-500 ${
                    i < stageIdx ? 'bg-accent w-4' : i === stageIdx ? 'bg-accent w-6 animate-pulse' : 'bg-line w-4'
                  }`}
                />
              ))}
            </div>
          </div>
        );
      })()}
      {!isCompiling && ability.compileStatus === 'failed' && ability.compileError && (
        <div className="border-b border-danger/25 bg-danger-soft px-6 py-2 text-[11px] text-danger font-medium flex items-center gap-1.5 shrink-0 animate-in fade-in duration-200">
          <AlertCircle size={13} /> Compile failed: {ability.compileError}
        </div>
      )}
      {!isCompiling && ability.compileStatus === 'dirty' && (
        <div className="border-b border-warn/25 bg-warn-soft px-6 py-2 text-[11px] text-warn font-medium flex items-center gap-1.5 shrink-0 animate-in fade-in duration-200">
          <AlertCircle size={13} /> Draft behavior changes pending compiler publication. Click Compile to sync.
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        
        <aside className="w-[220px] shrink-0 border-r border-line bg-surface p-4 flex flex-col gap-1.5 sticky top-0 overflow-y-auto">
          {navTabs.map((t) => {
            const isActive = tab === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={`flex items-center gap-2.5 w-full text-left px-3.5 py-2.5 rounded-xl text-[12px] font-semibold transition-all border outline-none ${
                  isActive
                    ? 'bg-accent/10 border-accent/20 text-accent font-bold shadow-sm'
                    : 'border-transparent hover:bg-surface-2 text-text-secondary hover:text-text-primary'
                }`}
              >
                <span className={isActive ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'}>
                  {t.icon}
                </span>
                <span className="truncate">{t.label}</span>
                {t.count !== undefined && t.count > 0 && (
                  <span className={`ml-auto text-[10px] px-1.5 py-0.2 rounded-full font-bold leading-normal shrink-0 ${
                    isActive ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-text-muted'
                  }`}>
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </aside>

        <main className="flex-1 overflow-y-auto p-6 bg-surface-base min-w-0">
          
          {tab === 'overview' && (
            <div className="flex flex-col gap-6 max-w-4xl">
              
              <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
                  <h3 className="text-[12px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <LayoutGrid size={14} className="text-accent" /> READINESS
                  </h3>
                  {!hasCompileModel && (
                    <button
                      type="button"
                      onClick={() => setConfigDrawerOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn-soft/50 px-2.5 py-1 text-[10.5px] font-bold text-warn hover:border-warn/50"
                    >
                      <AlertTriangle size={11} />
                      Template fallback active
                    </button>
                  )}
                </div>
                
                <div className="grid grid-cols-[auto_120px_1fr] items-center gap-x-4 gap-y-3.5 pl-1">
                  {readinessItems.map((item, idx) => (
                    <div key={idx} className="contents">
                      <StatusDot tone={item.status} size={8} />
                      <span className="font-bold text-text-primary text-[13px]">{item.label}</span>
                      <span className="text-[12px] text-text-secondary font-medium">{item.text}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
                  <h3 className="text-[12px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <User size={14} className="text-accent" /> PERSONA PREVIEW (read-only)
                  </h3>
                  <button
                    type="button"
                    onClick={() => setTab('persona')}
                    className="text-[11px] font-bold text-accent hover:underline flex items-center gap-0.5 transition-colors"
                  >
                    Open Persona ›
                  </button>
                </div>
                
                <div className="rounded-xl bg-surface-2/65 p-4 border border-line shadow-inner max-h-48 overflow-y-auto">
                  {editPersona?.trim() ? (
                    <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary font-mono">
                      {editPersona}
                    </p>
                  ) : (
                    <p className="text-[12px] text-text-muted italic">
                      No prompt synthesized yet. Enter guidelines and trigger Compile to auto-synthesize specialist persona.
                    </p>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-text-primary border-b border-line pb-3 mb-4 flex items-center gap-2">
                  <RefreshCw size={14} className="text-accent" /> COMPILE STATUS
                </h3>
                <div className="flex flex-col gap-2.5 pl-1">
                  <div className="text-[13px] text-text-secondary">
                    <span className="font-semibold text-text-primary">Last compiled:</span>{' '}
                    {ability.lastCompiledAt ? new Date(ability.lastCompiledAt).toLocaleString() : 'Never'}{' '}
                    ·{' '}
                    <span className="capitalize">{ability.compileStatus}</span>
                  </div>
                  <div className="text-[12px] text-text-muted font-medium flex items-center gap-3">
                    <span>Domain: <span className="font-bold text-text-secondary uppercase">{editDomainTag.replace(/_/g, ' ')}</span></span>
                    <span>·</span>
                    <span>Version: <span className="font-bold text-text-secondary">v{ability.version}</span></span>
                    <span>·</span>
                    <span>Token budget: <span className="font-bold text-text-secondary">{ability.tokenBudget ?? 'default'}</span></span>
                  </div>
                </div>
              </section>

            </div>
          )}

          {tab === 'persona' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              {/* Identity card */}
              <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
                <header className="mb-4 border-b border-line pb-3">
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <User size={15} className="text-accent" /> Identity
                  </h3>
                  <span className="text-[11px] text-text-muted mt-0.5 block">Set the ability's icon, name, and knowledge domain.</span>
                </header>
                <div className="grid gap-4 sm:grid-cols-[100px_1fr_1fr]">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1">Icon</label>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => { setIconPickerOpen(v => !v); setDomainOpen(false); }}
                        className="h-10 w-full flex items-center justify-center rounded-input border border-line bg-surface-2 text-[20px] hover:border-accent transition-all shadow-sm"
                        title="Choose icon"
                      >
                        {editIconEmoji}
                      </button>
                      {iconPickerOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setIconPickerOpen(false)} />
                          <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-card border border-line bg-surface shadow-dropdown p-2 animate-in fade-in zoom-in-95 duration-100">
                            <div className="grid grid-cols-5 gap-1 mb-2">
                              {ABILITY_ICON_OPTIONS.map(icon => (
                                <button
                                  key={icon}
                                  type="button"
                                  onClick={() => { setEditIconEmoji(icon); setIconPickerOpen(false); }}
                                  className={`h-9 w-9 flex items-center justify-center rounded-btn text-[18px] transition-colors ${
                                    editIconEmoji === icon ? 'bg-accent/15 border border-accent/30' : 'hover:bg-surface-2'
                                  }`}
                                >
                                  {icon}
                                </button>
                              ))}
                            </div>
                            <div className="border-t border-line/60 pt-2">
                              <input
                                value={editIconEmoji}
                                onChange={(e) => setEditIconEmoji(e.target.value.slice(0, 4))}
                                placeholder="Custom…"
                                className="h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-center text-[14px] focus:border-accent focus:outline-none"
                              />
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1">Ability Name</label>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Senior UI Engineer"
                      className="h-10 w-full rounded-input border border-line bg-surface-2 px-3.5 text-[13px] font-semibold text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1">Knowledge Domain</label>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => { setDomainOpen(v => !v); setIconPickerOpen(false); }}
                        className="h-10 w-full flex items-center justify-between rounded-input border border-line bg-surface-2 px-3 text-[13px] font-semibold text-text-primary hover:border-line-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm"
                      >
                        <span className="flex items-center gap-2">
                          <Folder size={13} className="text-text-muted shrink-0" />
                          {DOMAIN_TAGS.find(t => t.value === editDomainTag)?.label ?? 'Custom'}
                        </span>
                        <ChevronDown size={13} className={`text-text-muted transition-transform duration-150 ${domainOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {domainOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setDomainOpen(false)} />
                          <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-card border border-line bg-surface shadow-dropdown overflow-hidden animate-in fade-in zoom-in-95 duration-100">
                            {DOMAIN_GROUPS.map(group => (
                              <div key={group.label}>
                                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2/50 border-b border-line/40">
                                  <Folder size={10} className="text-text-muted" />
                                  <span className="text-[10px] font-bold uppercase tracking-wide text-text-muted">{group.label}</span>
                                </div>
                                {group.items.map(tagValue => {
                                  const tag = DOMAIN_TAGS.find(t => t.value === tagValue);
                                  if (!tag) return null;
                                  const isSelected = editDomainTag === tagValue;
                                  return (
                                    <button
                                      key={tagValue}
                                      type="button"
                                      onClick={() => { setEditDomainTag(tagValue); setDomainOpen(false); }}
                                      className={`w-full flex items-center justify-between px-5 py-2 text-left text-[12px] transition-colors ${
                                        isSelected
                                          ? 'bg-accent/10 text-accent font-semibold'
                                          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                                      }`}
                                    >
                                      {tag.label}
                                      {isSelected && <Check size={11} />}
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              {/* Persona card */}
              <section className="rounded-xl border border-line bg-surface p-6 shadow-sm flex flex-col">
                <header className="mb-4 border-b border-line pb-3 shrink-0">
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <User size={15} className="text-accent" /> Persona
                  </h3>
                  <span className="text-[11px] text-text-muted mt-0.5 block">A short sentence describing what makes this specialist unique — generated from your specs and rules on compile.</span>
                </header>

                <div className="relative flex-1">
                  <textarea
                    value={editPersona}
                    onChange={(e) => {
                      setEditPersona(e.target.value);
                      if (!personaLocked) {
                        setPersonaLocked(true);
                        toast.info('Custom override active', 'Your edit locked the persona as a custom override.');
                      }
                    }}
                    rows={12}
                    placeholder="Compile to generate this automatically from your specs and rules."
                    className="w-full rounded-xl border border-line p-4 font-mono text-[12px] leading-relaxed transition-all shadow-inner focus:outline-none focus:ring-1 focus:ring-accent resize-none bg-surface-2 border-line text-text-primary focus:border-accent"
                  />
                  {personaReady && (
                    <div className={`absolute right-3.5 bottom-3.5 flex items-center gap-1 rounded px-2.5 py-1 bg-surface border border-line text-[10px] font-bold ${
                      personaLocked ? 'text-amber-500' : 'text-accent'
                    }`}>
                      {personaLocked ? <Lock size={11} /> : <Unlock size={11} />}
                      {personaLocked ? 'Custom Override Active (Locked)' : 'Auto-Synthesis Active'}
                    </div>
                  )}
                </div>

                {personaReady && (
                  <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-line bg-surface-2 mt-4 text-[12px] text-text-secondary">
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-0.5 shrink-0 ${personaLocked ? 'text-amber-500' : 'text-accent'}`}>ℹ</span>
                      <div>
                        <span className="font-semibold block text-text-primary">
                          {personaLocked ? 'Custom override active' : `Auto-synthesized${compileDate ? ` on ${compileDate}` : ''}`}
                        </span>
                        <span>
                          {personaLocked
                            ? 'Auto-synthesis is disabled. Changes to specs and rules will not overwrite this persona.'
                            : 'Editing this text will lock it as a custom override — auto-synthesis will not overwrite it on future compiles.'}
                        </span>
                      </div>
                    </div>
                    {personaLocked && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Reset to auto-synthesis?',
                            body: 'Your custom changes will be discarded, and the persona will be automatically re-synthesized from your specs and rules on compile.',
                            confirmLabel: 'Reset',
                            tone: 'danger',
                          });
                          if (!ok) return;
                          setPersonaLocked(false);
                          setEditPersona(ability.compiledPrompt ?? '');
                          toast.success('Reset to auto-synthesis');
                        }}
                        className="shrink-0"
                      >
                        Reset to auto-synthesis
                      </Button>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === 'specs' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
                <header className="mb-4 border-b border-line pb-3">
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <SlidersHorizontal size={15} className="text-accent" /> Specs
                  </h3>
                  <span className="text-[11px] text-text-muted mt-0.5 block">Structured domain specifications every response follows.</span>
                </header>

                <div className="space-y-5">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1">Overview Description</label>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      rows={3}
                      placeholder="What this specialist excels at (e.g. producing WCAG 2.1 AA compliant components)"
                      className="w-full rounded-input border border-line bg-surface-2 px-3.5 py-2.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm resize-none"
                    />
                  </div>

                  <div className="border-t border-line/60 pt-4">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-2">Specs</label>
                    <EditableSpecsList specs={editSpecs} onChange={setEditSpecs} />
                  </div>
                </div>
              </section>
            </div>
          )}

          {tab === 'rules' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              
              <div className="grid gap-6 md:grid-cols-2">
                <section className="rounded-xl border border-line bg-surface p-5 shadow-sm flex flex-col">
                  <header className="mb-4 border-b border-line pb-3">
                    <h3 className="text-[12px] font-bold text-text-primary flex items-center gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-500" /> Always
                    </h3>
                  </header>
                  <div className="flex-1">
                    <EditableRuleList
                      rules={editRulesAlways}
                      onChange={setEditRulesAlways}
                      placeholder="e.g. Always use semantic HTML"
                      addButtonLabel="Add always rule"
                    />
                  </div>
                </section>

                <section className="rounded-xl border border-line bg-surface p-5 shadow-sm flex flex-col">
                  <header className="mb-4 border-b border-line pb-3">
                    <h3 className="text-[12px] font-bold text-text-primary flex items-center gap-1.5">
                      <XCircle size={13} className="text-danger" /> Never
                    </h3>
                  </header>
                  <div className="flex-1">
                    <EditableRuleList
                      rules={editRulesNever}
                      onChange={setEditRulesNever}
                      placeholder="e.g. Never inline raw CSS styles"
                      addButtonLabel="Add never rule"
                    />
                  </div>
                </section>
              </div>

              <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                <header className="mb-4 border-b border-line pb-3">
                  <h3 className="text-[12px] font-bold text-text-primary flex items-center gap-1.5">
                    <Wrench size={13} className="text-accent" /> Tool preferences
                  </h3>
                </header>
                <EditableRuleList
                  rules={editToolHints}
                  onChange={setEditToolHints}
                  placeholder="e.g. PREFER search_docs before writing raw definitions"
                  addButtonLabel="Add tool hint instruction"
                />
              </section>

            </div>
          )}

          {tab === 'knowledge' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              
              <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
                <header className="mb-4 border-b border-line pb-3">
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                    <BookOpen size={15} className="text-accent" /> References
                  </h3>
                  <span className="text-[11px] text-text-muted mt-0.5 block">Provide reference articles, notes, or URLs this ability will search and retrieve per task.</span>
                </header>

                <div className="flex items-center gap-2 mb-4 border-b border-line pb-3">
                  <button
                    type="button"
                    onClick={() => setActiveAssetTab('upload')}
                    className={`px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all border outline-none ${
                      activeAssetTab === 'upload' ? 'bg-accent/10 border-accent/20 text-accent font-bold' : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                  >
                    Ingest Files
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveAssetTab('url')}
                    className={`px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all border outline-none ${
                      activeAssetTab === 'url' ? 'bg-accent/10 border-accent/20 text-accent font-bold' : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                  >
                    URL
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveAssetTab('note')}
                    className={`px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all border outline-none ${
                      activeAssetTab === 'note' ? 'bg-accent/10 border-accent/20 text-accent font-bold' : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                  >
                    Note
                  </button>
                </div>

                <div className="mb-6">
                  {activeAssetTab === 'upload' && (
                    <div
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={e => void handleFileUploads(Array.from(e.dataTransfer.files))}
                      className={`relative flex flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center transition-all ${
                        isDragging
                          ? 'border-accent bg-accent-soft/20 text-accent scale-[0.99] shadow-sm'
                          : 'border-line bg-surface-2 text-text-muted hover:border-line-strong hover:bg-surface-3/30'
                      }`}
                    >
                      <input
                        type="file"
                        id="knowledge-file-input-canvas-tab"
                        className="hidden"
                        multiple
                        accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.json,.xlsx,.xls,.png,.jpg,.jpeg,.webp,text/*,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={async (e) => {
                          if (e.target.files) {
                            await handleFileUploads(Array.from(e.target.files));
                          }
                        }}
                      />
                      <label htmlFor="knowledge-file-input-canvas-tab" className="cursor-pointer w-full h-full flex flex-col items-center justify-center">
                        <Upload size={28} className={`mb-2 ${isDragging ? 'text-accent animate-bounce' : 'text-text-muted'}`} />
                        <span className="text-[12px] font-bold text-text-secondary block">
                          Drag & drop documents here or click to browse
                        </span>
                        <span className="text-[10px] text-text-muted mt-1 block">
                          PDF, DOCX, Markdown, CSV, XLSX, HTML, JSON, and images (up to 10 MB)
                        </span>
                      </label>
                    </div>
                  )}

                  {activeAssetTab === 'url' && (
                    <div className="space-y-4 p-4 rounded-xl border border-line bg-surface-2 animate-in fade-in duration-200">
                      <div>
                        <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Source URL</div>
                        <input
                          value={assetUrl}
                          onChange={(e) => setAssetUrl(e.target.value)}
                          className="h-9 w-full rounded-input border border-line bg-surface px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                          placeholder="https://nextjs.org/docs"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Title (optional)</div>
                          <input
                            value={assetUrlTitle}
                            onChange={(e) => setAssetUrlTitle(e.target.value)}
                            className="h-9 w-full rounded-input border border-line bg-surface px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                            placeholder="Next.js Docs"
                          />
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Retrieval Importance</div>
                          <div className="flex items-center gap-2 h-9">
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={assetUrlImportance}
                              onChange={(e) => setAssetUrlImportance(parseFloat(e.target.value))}
                              className="flex-1 cursor-pointer accent-accent"
                            />
                            <span className="w-8 text-right font-mono text-[11px] text-text-secondary font-bold">{assetUrlImportance.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase text-text-muted mb-1">URL Reference Summary</div>
                        <textarea
                          value={assetUrlSummary}
                          onChange={(e) => setAssetUrlSummary(e.target.value)}
                          rows={3}
                          className="w-full rounded-input border border-line bg-surface p-3 text-[12px] text-text-primary focus:border-accent focus:outline-none resize-none shadow-sm"
                          placeholder="Summarize the core concepts covered on this reference URL so the semantic router matches it accurately."
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        className="w-full"
                        onClick={handleAddUrlAsset}
                        loading={addingAsset}
                        disabled={addingAsset || !assetUrl.trim() || !assetUrlSummary.trim()}
                      >
                        Add URL
                      </Button>
                    </div>
                  )}

                  {activeAssetTab === 'note' && (
                    <div className="space-y-4 p-4 rounded-xl border border-line bg-surface-2 animate-in fade-in duration-200">
                      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
                        <div>
                          <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Note Title</div>
                          <input
                            value={assetNoteTitle}
                            onChange={(e) => setAssetNoteTitle(e.target.value)}
                            className="h-9 w-full rounded-input border border-line bg-surface px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                            placeholder="e.g. Accessibility Standards"
                          />
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Retrieval Importance</div>
                          <div className="flex items-center gap-2 h-9">
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={assetNoteImportance}
                              onChange={(e) => setAssetNoteImportance(parseFloat(e.target.value))}
                              className="flex-1 cursor-pointer accent-accent"
                            />
                            <span className="w-8 text-right font-mono text-[11px] text-text-secondary font-bold">{assetNoteImportance.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase text-text-muted mb-1">Reference Content</div>
                        <textarea
                          value={assetNoteContent}
                          onChange={(e) => setAssetNoteContent(e.target.value)}
                          rows={6}
                          className="w-full rounded-input border border-line bg-surface p-3 text-[12px] text-text-primary focus:border-accent focus:outline-none resize-none shadow-sm"
                          placeholder="Paste reference materials, documentation text, code guidelines, or standards directly."
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        className="w-full"
                        onClick={handleAddNoteAsset}
                        loading={addingAsset}
                        disabled={addingAsset || !assetNoteContent.trim()}
                      >
                        Add note
                      </Button>
                    </div>
                  )}
                </div>

                <div className="border-t border-line/60 pt-4">
                  <div className="text-[12px] font-bold text-text-primary mb-3">
                    References ({knowledge.length})
                  </div>
                  
                  {knowledge.length === 0 ? (
                    <div className="rounded-xl border border-line/60 bg-surface-2/20 p-12 text-center text-[12px] text-text-muted italic">
                      No reference documentation uploaded yet. Use the uploader tabs above to seed grounded content.
                    </div>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {knowledge.map((k) => (
                        <li
                          key={k.id}
                          className="rounded-xl border border-line bg-surface-2/45 group/asset hover:border-line-strong hover:bg-surface transition-all shrink-0 overflow-hidden"
                        >
                          <div className="flex items-center gap-3 p-3.5">
                            <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-lg bg-surface border border-line overflow-hidden">
                              {k.sourceType === 'image' && k.sourceUrl?.startsWith('data:')
                                ? <img src={k.sourceUrl} alt={k.title || 'image'} className="h-7 w-7 object-cover" />
                                : <span className="text-accent flex items-center justify-center h-full w-full">{k.sourceType === 'url' ? <Globe size={13} /> : k.sourceType === 'document' ? <FileText size={13} /> : k.sourceType === 'image' ? <ImageIcon size={13} /> : <FileCode2 size={13} />}</span>
                              }
                            </span>
                            <button
                              type="button"
                              onClick={() => setExpandedKnowledgeIds(prev => { const next = new Set(prev); if (next.has(k.id)) next.delete(k.id); else next.add(k.id); return next; })}
                              className="flex-1 min-w-0 text-left"
                            >
                              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <span className="text-[12.5px] font-bold text-text-primary truncate max-w-sm">{k.title || 'Reference'}</span>
                                <span className="rounded border border-line text-[9px] font-bold bg-surface px-1.5 py-0.5 uppercase tracking-wider text-text-muted">{k.sourceType}</span>
                              </div>
                              {!expandedKnowledgeIds.has(k.id) && (
                                k.sourceType === 'image' && k.sourceUrl?.startsWith('data:')
                                  ? <img src={k.sourceUrl} alt="" className="mt-1.5 h-10 max-w-[160px] rounded object-contain" />
                                  : <p className="text-[11px] text-text-muted truncate max-w-xl">
                                      {k.sourceType === 'image' ? (k.title || 'Image reference') : `${k.content.slice(0, 120)}${k.content.length > 120 ? '…' : ''}`}
                                    </p>
                              )}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <IconButton
                                icon={<Trash2 size={12} />}
                                label="Delete Reference"
                                size="sm"
                                variant="ghost"
                                className="opacity-0 group-hover/asset:opacity-100 focus:opacity-100 hover:text-danger text-text-muted transition-all"
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: 'Delete Reference?',
                                    body: 'Removing this reference means the ability no longer has access to this content. Trigger Compile afterward.',
                                    confirmLabel: 'Remove',
                                    tone: 'danger',
                                  });
                                  if (!ok) return;
                                  try {
                                    await abilitiesApi.deleteKnowledge(ability.id, k.id);
                                    toast.success('Reference removed');
                                    await refresh();
                                  } catch (err) {
                                    toast.error('Delete failed', apiErrorMessage(err));
                                  }
                                }}
                              />
                              <ChevronDown size={13} className={`text-text-muted transition-transform duration-200 ${expandedKnowledgeIds.has(k.id) ? 'rotate-180' : ''}`} />
                            </div>
                          </div>
                          {expandedKnowledgeIds.has(k.id) && (
                            <div className="px-4 pb-4 border-t border-line/40 pt-3">
                              {k.sourceType === 'image' && k.sourceUrl?.startsWith('data:')
                                ? <img src={k.sourceUrl} alt={k.title || 'Image'} className="max-w-full max-h-64 rounded-lg object-contain border border-line" />
                                : <p className="text-[11.5px] text-text-secondary whitespace-pre-wrap leading-relaxed font-medium">
                                    {k.content}
                                  </p>
                              }
                              {k.sourceUrl && !k.sourceUrl.startsWith('data:') && (
                                <a
                                  href={k.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10.5px] text-accent hover:underline flex items-center gap-0.5 mt-2 font-bold"
                                >
                                  <Link2 size={11} /> {k.sourceUrl}
                                </a>
                              )}
                              <div className="mt-2 text-[9.5px] font-mono text-text-muted">Importance: {k.importanceScore.toFixed(2)}</div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

            </div>
          )}

          {tab === 'examples' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              
              <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
                <header className="mb-4 flex items-center justify-between border-b border-line pb-3">
                  <div>
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-text-primary flex items-center gap-2">
                      <MessageSquare size={15} className="text-accent" /> Examples
                    </h3>
                    <span className="text-[11px] text-text-muted mt-0.5 block">Exemplify perfect behavior. KNN-retrieval injects relevant task-response templates directly.</span>
                  </div>
                  
                  <div className="flex items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={openRunHistory}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-accent hover:text-accent-hover transition-colors border border-accent/20 bg-accent/5 rounded-lg px-3 py-1.5 shadow-sm"
                    >
                      <History size={12} /> Import execution run
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingExample({
                        id: '',
                        abilityId: ability!.id,
                        inputText: '',
                        outputText: '',
                        inputMediaUrl: null,
                        mediaDescription: null,
                        qualityScore: 0.85,
                        source: 'user_curated',
                        originRunId: null,
                        createdAt: new Date().toISOString(),
                      })}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-accent hover:text-accent-hover transition-colors border border-accent/20 bg-accent/5 rounded-lg px-3 py-1.5 shadow-sm"
                    >
                      <Plus size={12} /> Add custom example
                    </button>
                  </div>
                </header>

                <div className="space-y-4">
                  {examples.length === 0 ? (
                    <div className="rounded-xl border border-line/60 bg-surface-2/20 p-12 text-center text-[12px] text-text-muted italic">
                      No examples yet. Add task-response pairs to show the ability exactly how to behave.
                    </div>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {examples.map((ex) => (
                        <li
                          key={ex.id}
                          className="rounded-xl border border-line bg-surface-2/30 flex flex-col relative group/item hover:border-line-strong hover:bg-surface transition-all overflow-hidden"
                        >
                          <div className="flex items-center gap-2.5 p-3.5">
                            <button
                              type="button"
                              onClick={() => setExpandedExampleIds(prev => { const next = new Set(prev); if (next.has(ex.id)) next.delete(ex.id); else next.add(ex.id); return next; })}
                              className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                            >
                              <span className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-text-muted shrink-0">
                                {ex.source.replace(/_/g, ' ')}
                              </span>
                              <span className="text-[11px] text-text-muted truncate max-w-lg font-medium">
                                {(ex.inputText.split('\n')[0] ?? '').slice(0, 80)}{(ex.inputText.split('\n')[0] ?? '').length > 80 || ex.inputText.includes('\n') ? '…' : ''}
                              </span>
                            </button>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[9.5px] text-text-muted font-mono font-bold">{ex.qualityScore.toFixed(2)}</span>
                              <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-all">
                                <IconButton
                                  icon={<FileText size={12} />}
                                  label="Edit"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEditingExample(ex)}
                                />
                                <IconButton
                                  icon={<Trash2 size={12} />}
                                  label="Delete"
                                  size="sm"
                                  variant="ghost"
                                  className="hover:text-danger"
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: 'Delete Behavioral Example?',
                                      body: 'This removes this training template from specialist dispatch. Trigger Compile afterward.',
                                      confirmLabel: 'Delete',
                                      tone: 'danger',
                                    });
                                    if (!ok) return;
                                    try {
                                      await abilitiesApi.deleteExample(ability.id, ex.id);
                                      toast.success('Exemplar deleted successfully');
                                      await refresh();
                                    } catch (err) {
                                      toast.error('Delete failed', apiErrorMessage(err));
                                    }
                                  }}
                                />
                              </div>
                              <ChevronDown size={13} className={`text-text-muted transition-transform duration-200 ${expandedExampleIds.has(ex.id) ? 'rotate-180' : ''}`} />
                            </div>
                          </div>
                          {expandedExampleIds.has(ex.id) && (
                            <div className="px-4 pb-4 border-t border-line/40 pt-3">
                              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 text-[12px]">
                                <div className="rounded-xl bg-surface p-3 border border-line shadow-inner">
                                  <div className="text-[9px] font-bold uppercase text-text-muted mb-1.5 tracking-wider">Input</div>
                                  <p className="text-text-secondary whitespace-pre-wrap font-semibold leading-relaxed">{ex.inputText}</p>
                                </div>
                                <div className="rounded-xl bg-surface p-3 border border-line shadow-inner">
                                  <div className="text-[9px] font-bold uppercase text-text-muted mb-1.5 tracking-wider">Response</div>
                                  <p className="text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">{ex.outputText}</p>
                                </div>
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

            </div>
          )}

          {tab === 'settings' && (
            <div className="flex flex-col gap-6 max-w-4xl animate-in fade-in duration-200">
              
              <div className="grid gap-6 md:grid-cols-2">
                
                <div className="space-y-6 flex flex-col">
                  
                  <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                    <header className="mb-3 border-b border-line pb-3">
                      <h3 className="text-[12px] font-bold text-text-primary flex items-center gap-1.5">
                        <SettingsIcon size={14} className="text-accent" /> Token budget
                      </h3>
                    </header>
                    <p className="text-[12px] text-text-muted leading-relaxed mb-4">
                      Define the maximum context tokens this ability can consume per run. Leave empty to inherit the default workspace system quota.
                    </p>
                    <div className="flex items-center gap-2.5">
                      <input
                        type="number"
                        value={ability.tokenBudget == null ? '' : String(ability.tokenBudget)}
                        onChange={async (e) => {
                          const v = e.target.value.trim() === '' ? null : Number(e.target.value);
                          if (v !== null && (!Number.isFinite(v) || v <= 0)) return;
                          try {
                            await abilitiesApi.update(ability.id, { tokenBudget: v });
                            toast.success('Budget cap updated successfully');
                            await refresh();
                          } catch (err) {
                            toast.error('Save failed', apiErrorMessage(err));
                          }
                        }}
                        placeholder="Inherit workspace default"
                        min={0}
                        className="h-10 w-full max-w-[200px] rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary font-bold focus:border-accent focus:outline-none"
                      />
                      <span className="text-[11px] text-text-muted font-bold">tokens cap</span>
                    </div>
                  </section>

                  <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
                    <header className="mb-3 border-b border-line pb-3">
                      <h3 className="text-[12px] font-bold text-text-primary">
                        Compile status
                      </h3>
                    </header>
                    <p className="text-[12px] text-text-muted leading-relaxed mb-4">
                      Last compiled {ability.lastCompiledAt ? new Date(ability.lastCompiledAt).toLocaleString() : 'never'}. Compiles domain embeddings and updates semantic matching search structures.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      iconLeft={<RefreshCw size={12} />}
                      onClick={handleCompile}
                      disabled={ability.compileStatus === 'compiling'}
                    >
                      Compile ability
                    </Button>
                  </section>

                  <section className="rounded-xl border border-danger/30 bg-danger-soft/10 p-5 shadow-sm">
                    <header className="mb-3 border-b border-danger/20 pb-3">
                      <h3 className="text-[12px] font-bold text-danger">
                        Danger Zone
                      </h3>
                    </header>
                    <p className="text-[12px] text-text-secondary leading-relaxed mb-4">
                      Deleting this ability removes it from dispatch search maps. All Agent pins are immediately destroyed. This action is final.
                    </p>
                    <Button variant="danger" size="sm" iconLeft={<Trash2 size={12} />} onClick={handleDelete}>
                      Delete ability
                    </Button>
                  </section>

                </div>

                <div className="flex flex-col">
                  <section className="rounded-xl border border-line bg-surface p-5 shadow-sm flex flex-col h-full">
                    <header className="mb-3 border-b border-line pb-3">
                      <h3 className="text-[12px] font-bold text-text-primary flex items-center gap-1.5">
                        <Cpu size={14} className="text-accent" /> Always-on agents
                      </h3>
                    </header>
                    <p className="text-[12px] text-text-muted leading-relaxed mb-4">
                      Force specific agents to always use this ability — overrides automatic semantic matching.
                    </p>

                    <div className="flex-1">
                      {loadingPins ? (
                        <div className="space-y-2">
                          <Skeleton className="h-11 rounded-lg" />
                          <Skeleton className="h-11 rounded-lg" />
                          <Skeleton className="h-11 rounded-lg" />
                        </div>
                      ) : agents.length === 0 ? (
                        <div className="rounded-xl border border-line bg-surface-2 p-8 text-center text-[12px] text-text-muted italic">
                          No active agents in workspace to pin.
                        </div>
                      ) : (
                        <ul className="flex flex-col gap-2.5">
                          {agents.map((agent) => {
                            const state = pinnedAgents[agent.id] ?? { pinned: false, enabled: false };
                            return (
                              <li
                                key={agent.id}
                                className="rounded-xl border border-line bg-surface-2/45 px-3.5 py-2.5 flex items-center justify-between hover:bg-surface transition-all shrink-0"
                              >
                                <div className="flex items-center gap-3">
                                  <div
                                    className="h-8 w-8 rounded-full border border-line bg-surface flex items-center justify-center font-bold text-[11px] text-text-primary shrink-0 shadow-sm"
                                    style={{
                                      backgroundColor: agent.colorHex ?? undefined,
                                    }}
                                  >
                                    {agent.avatarUrl ? (
                                      <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full rounded-full object-cover" />
                                    ) : (
                                      <span>{agent.name.slice(0, 2).toUpperCase()}</span>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-[12.5px] font-semibold text-text-primary block truncate">{agent.name}</span>
                                    <span className="text-[9.5px] text-text-muted font-bold uppercase tracking-wider block leading-none mt-0.5">{agent.role || 'worker'}</span>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => void handleTogglePin(agent.id)}
                                  className={`h-6 rounded-full px-3.5 text-[9.5px] font-bold uppercase tracking-wider border transition-all ${
                                    state.pinned
                                      ? 'border-accent bg-accent-soft text-accent hover:bg-accent/15'
                                      : 'border-line bg-surface text-text-muted hover:border-line-strong hover:text-text-primary'
                                  }`}
                                >
                                  {state.pinned ? 'Pinned' : 'Pin Always'}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </section>
                </div>

              </div>

            </div>
          )}

        </main>
      </div>



      <AbilityCompileConfigDrawer
        open={configDrawerOpen}
        onClose={() => setConfigDrawerOpen(false)}
        onSaved={() => { void refreshConfig(); }}
      />

      {editingExample && (
        <ExampleEditor
          example={editingExample}
          onCancel={() => setEditingExample(null)}
          onSave={async (payload) => {
            try {
              if (editingExample.id) {
                await abilitiesApi.updateExample(ability.id, editingExample.id, payload);
                toast.success('Curated example updated successfully');
              } else {
                await abilitiesApi.addExample(ability.id, payload);
                toast.success('Curated example added successfully');
              }
              setEditingExample(null);
              await refresh();
            } catch (err) {
              toast.error('Save failed', apiErrorMessage(err));
            }
          }}
        />
      )}

      {showRunHistory && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 animate-in fade-in duration-200" role="dialog" aria-modal>
          <div className="w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal animate-in zoom-in-95 duration-200">
            <header className="flex items-center justify-between border-b border-line px-5 py-3 shrink-0">
              <h2 className="text-[14px] font-semibold text-text-primary flex items-center gap-2">
                <History size={16} className="text-accent" /> Import Behavioral Demonstration from Run History
              </h2>
              <IconButton icon={<X size={16} />} label="Close" onClick={() => setShowRunHistory(false)} />
            </header>
            
            <div className="flex flex-1 min-h-0">
              <div className="w-1/3 border-r border-line overflow-y-auto p-4 flex flex-col gap-2 shrink-0">
                <div className="text-[10px] font-semibold uppercase text-text-muted tracking-wider mb-1">Recent Execution Runs</div>
                {loadingRuns ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 rounded" />
                    <Skeleton className="h-10 rounded" />
                    <Skeleton className="h-10 rounded" />
                  </div>
                ) : recentRuns.length === 0 ? (
                  <div className="text-[12px] text-text-muted p-4 text-center">No runs logged.</div>
                ) : (
                  recentRuns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => void handleSelectRun(r.id)}
                      className={`w-full text-left p-2.5 rounded-lg border text-[11px] transition-all flex flex-col gap-1 ${
                        selectedRunDetail?.id === r.id
                          ? 'border-accent bg-accent-soft/10 text-accent font-bold'
                          : 'border-line hover:bg-surface-2'
                      }`}
                    >
                      <span className="font-semibold text-text-primary truncate">{r.workflowName || 'Workflow run'}</span>
                      <div className="flex items-center justify-between text-[10px] text-text-muted mt-0.5">
                        <span className="font-mono">run_{r.id.slice(-8)}</span>
                        <span>{new Date(r.startedAt || r.timestamp).toLocaleTimeString()}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-5 bg-surface-2/30 flex flex-col gap-4">
                {loadingRunDetail ? (
                  <div className="space-y-4">
                    <Skeleton className="h-16 rounded" />
                    <Skeleton className="h-32 rounded" />
                  </div>
                ) : !selectedRunDetail ? (
                  <div className="h-full flex flex-col items-center justify-center text-center text-text-muted p-8">
                    <Play size={32} className="mb-2 text-text-muted/60" />
                    <span className="text-[13px] font-semibold block text-text-secondary">Select an Execution Run</span>
                    <span className="text-[11px] max-w-xs mt-1 block">Pick a workflow run from the left panel to inspect its operational task blocks.</span>
                  </div>
                ) : (
                  <>
                    <div className="border-b border-line pb-3 shrink-0">
                      <div className="text-[10px] font-semibold uppercase text-text-muted mb-0.5">Selected Workflow Run</div>
                      <h3 className="text-[14px] font-semibold text-text-primary">{selectedRunDetail.workflowName || 'Workflow'}</h3>
                      <span className="text-[10px] font-mono text-text-muted">ID: {selectedRunDetail.id}</span>
                    </div>

                    <div className="flex-1 flex flex-col gap-3">
                      <div className="text-[10px] font-semibold uppercase text-text-muted tracking-wider">Completed Node Output Blocks</div>
                      {(!selectedRunDetail.nodes || selectedRunDetail.nodes.length === 0) ? (
                        <div className="text-[12px] text-text-muted p-4">No completed output blocks available.</div>
                      ) : (
                        <ul className="flex flex-col gap-3 overflow-y-auto pr-1">
                          {selectedRunDetail.nodes.filter((node: any) => node.status === 'completed').map((node: any) => (
                            <li key={node.id} className="rounded-xl border border-line bg-surface p-4 flex flex-col gap-3.5 shadow-sm relative group">
                              <div className="flex items-center justify-between border-b border-line pb-2">
                                <div className="min-w-0">
                                  <span className="text-[12px] font-semibold text-text-primary block truncate">{node.title}</span>
                                  <span className="text-[9px] font-bold text-accent uppercase tracking-wider">{node.type}</span>
                                </div>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className="opacity-90 group-hover:opacity-100 transition-opacity"
                                  onClick={() => handleImportNode(node)}
                                >
                                  Promote to Example
                                </Button>
                              </div>

                              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 text-[11px]">
                                <div className="rounded bg-surface-2 p-2.5 border border-line/60">
                                  <div className="text-[9px] font-semibold uppercase text-text-muted mb-1">Inputs</div>
                                  <p className="line-clamp-5 text-text-secondary font-mono leading-normal whitespace-pre-wrap">{extractNodeText(node.inputs)}</p>
                                </div>
                                <div className="rounded bg-surface-2 p-2.5 border border-line/60">
                                  <div className="text-[9px] font-semibold uppercase text-text-muted mb-1">Outputs</div>
                                  <p className="line-clamp-5 text-text-secondary font-mono leading-normal whitespace-pre-wrap">{extractNodeText(node.output)}</p>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function extractNodeText(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (val.prompt && typeof val.prompt === 'string') return val.prompt;
    if (val.content && typeof val.content === 'string') return val.content;
    if (val.result && typeof val.result === 'string') return val.result;
    if (val.text && typeof val.text === 'string') return val.text;
    return JSON.stringify(val, null, 2);
  }
  return String(val);
}

function EditableRuleList({
  rules,
  onChange,
  placeholder,
  addButtonLabel,
}: {
  rules: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addButtonLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, idx) => (
        <div key={idx} className="flex items-center gap-2 group/row animate-in fade-in duration-200">
          <input
            value={rule}
            onChange={(e) => onChange(rules.map((v, i) => (i === idx ? e.target.value : v)))}
            placeholder={placeholder}
            className="h-9 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm"
          />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Remove"
            size="sm"
            variant="ghost"
            className="opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-danger text-text-muted transition-all shrink-0"
            onClick={() => onChange(rules.filter((_, i) => i !== idx))}
          />
        </div>
      ))}
      <button
        type="button"
        className="self-start text-[11px] text-accent hover:text-accent-hover font-semibold flex items-center gap-1 mt-1 transition-colors border-none bg-transparent cursor-pointer"
        onClick={() => onChange([...rules, ''])}
      >
        <Plus size={11} className="inline mr-1" /> {addButtonLabel}
      </button>
    </div>
  );
}

function EditableSpecsList({
  specs,
  onChange,
}: {
  specs: Array<{ key: string; value: string }>;
  onChange: React.Dispatch<React.SetStateAction<Array<{ key: string; value: string }>>>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {specs.map((entry, idx) => (
        <div key={idx} className="grid grid-cols-[150px_1fr_auto] items-center gap-2 group/row animate-in fade-in duration-200">
          <input
            value={entry.key}
            onChange={(e) =>
              onChange((prev) =>
                prev.map((entry, i) => (i === idx ? { ...entry, key: e.target.value } : entry))
              )
            }
            placeholder="key (e.g. stack)"
            className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm"
          />
          <input
            value={entry.value}
            onChange={(e) =>
              onChange((prev) =>
                prev.map((entry, i) => (i === idx ? { ...entry, value: e.target.value } : entry))
              )
            }
            placeholder="value (e.g. React 19)"
            className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all shadow-sm"
          />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Remove"
            size="sm"
            variant="ghost"
            className="opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-danger text-text-muted transition-all shrink-0"
            onClick={() => onChange((prev) => prev.filter((_, i) => i !== idx))}
          />
        </div>
      ))}
      <button
        type="button"
        className="self-start text-[11px] text-accent hover:text-accent-hover font-semibold flex items-center gap-1 mt-1 transition-colors border-none bg-transparent cursor-pointer"
        onClick={() => onChange((prev) => [...prev, { key: '', value: '' }])}
      >
        <Plus size={11} className="inline mr-1" /> Add custom specification
      </button>
    </div>
  );
}

function ExampleEditor({
  example,
  onCancel,
  onSave,
}: {
  example: AbilityExample | null;
  onCancel: () => void;
  onSave: (payload: { inputText: string; outputText: string; qualityScore: number; source: any }) => Promise<void>;
}) {
  const [inputText, setInputText] = useState(example?.inputText ?? '');
  const [outputText, setOutputText] = useState(example?.outputText ?? '');
  const [quality, setQuality] = useState(example?.qualityScore ?? 0.85);
  const [submitting, setSubmitting] = useState(false);
  
  const canSave = inputText.trim().length > 0 && outputText.trim().length > 0;
  
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 animate-in fade-in duration-200" role="dialog" aria-modal>
      <div className="w-full max-w-2xl overflow-hidden rounded-card border border-line bg-surface shadow-modal animate-in zoom-in-95 duration-200">
        <header className="flex items-center justify-between border-b border-line px-5 py-3 shrink-0">
          <h2 className="text-[14px] font-semibold text-text-primary flex items-center gap-1.5">
            <MessageSquare size={15} className="text-accent" /> {example?.id ? 'Edit Curated Example' : 'New Curated Behavior Example'}
          </h2>
          <IconButton icon={<X size={16} />} label="Close" onClick={onCancel} />
        </header>
        <div className="space-y-4 px-5 py-4 overflow-y-auto max-h-[70vh]">
          <div>
            <div className="text-[10px] font-semibold uppercase text-text-muted mb-1 tracking-wider">Example Task Prompt</div>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={4}
              className="w-full rounded-input border border-line bg-surface-2 p-3 text-[12px] text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-none shadow-sm font-medium"
              placeholder="e.g. Build a responsive, accessible three-tier pricing grid layout"
              autoFocus
            />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase text-text-muted mb-1 tracking-wider">Ideal Specialist Response</div>
            <textarea
              value={outputText}
              onChange={(e) => setOutputText(e.target.value)}
              rows={8}
              className="w-full rounded-input border border-line bg-surface-2 p-3 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent shadow-sm"
              placeholder="Provide the high-quality, production-grade output standard expected of this specialist..."
            />
          </div>
          <div className="flex items-center gap-3 bg-surface-2 p-2.5 rounded-xl border border-line">
            <div className="text-[10px] font-semibold uppercase text-text-muted tracking-wider">Quality Weight</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={quality}
              onChange={(e) => setQuality(parseFloat(e.target.value))}
              className="flex-1 cursor-pointer accent-accent"
            />
            <span className="w-12 text-right font-mono text-[11px] text-text-secondary font-bold">{quality.toFixed(2)}</span>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3 shrink-0">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!canSave || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSave({
                  inputText: inputText.trim(),
                  outputText: outputText.trim(),
                  qualityScore: quality,
                  source: example?.source || 'user_curated',
                });
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {example?.id ? 'Save changes' : 'Add example'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
