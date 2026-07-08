import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  BookHeart, FileText, LockKeyhole, Network, NotebookPen, Plus, Search, Trash2, Save,
  Folder, FolderOpen, ChevronDown, ChevronRight, X, Pin, PinOff, Share2, Bold, Italic,
  Underline, Strikethrough, List, ListOrdered, ListTodo, Quote, Code, Minus, Check,
  AlertCircle, RefreshCw, UploadCloud, Paperclip, FileArchive, Brain,
  Columns2, Eye, Link2, PenLine
} from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { ScopedBrainMap } from './ScopedBrainMap';
import { WorkspaceDocDropZone } from '../knowledge/WorkspaceDocDropZone';
import { NoteMarkdownPreview, findBacklinks } from './NoteMarkdownPreview';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from '../knowledge/types';

interface PersonalNote {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  pinned: boolean;
  updatedAt: string;
  score?: number;
}

interface AgentRow { id: string; name: string }
interface Grant { agentId: string; agentName: string; accessLevel: string }

function safeParseTags(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags.map(t => String(t).trim());
  }
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map(t => String(t).trim());
        }
      } catch (e) {
        // Fallback
      }
    }
    if (trimmed.includes(',')) {
      return trimmed.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}

interface FolderNode {
  name: string;
  fullPath: string;
  subfolders: FolderNode[];
  notes: PersonalNote[];
}

function countTotalNotes(node: FolderNode): number {
  let count = node.notes.length;
  for (const sub of node.subfolders) {
    count += countTotalNotes(sub);
  }
  return count;
}

function buildFolderTree(
  foldersList: string[],
  notesList: PersonalNote[]
): FolderNode {
  const root: FolderNode = {
    name: 'Root',
    fullPath: '',
    subfolders: [],
    notes: [],
  };

  const getOrCreateNode = (pathStr: string): FolderNode => {
    if (!pathStr || pathStr === 'Uncategorized') {
      let uncategorized = root.subfolders.find(f => f.fullPath === 'Uncategorized');
      if (!uncategorized) {
        uncategorized = {
          name: 'Uncategorized',
          fullPath: 'Uncategorized',
          subfolders: [],
          notes: [],
        };
        root.subfolders.push(uncategorized);
      }
      return uncategorized;
    }

    const parts = pathStr.split('/');
    let current = root;
    let currentPath = '';

    for (const part of parts) {
      if (!part.trim()) continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let next = current.subfolders.find(f => f.fullPath === currentPath);
      if (!next) {
        next = {
          name: part,
          fullPath: currentPath,
          subfolders: [],
          notes: [],
        };
        current.subfolders.push(next);
      }
      current = next;
    }

    return current;
  };

  for (const f of foldersList) {
    if (f !== 'Uncategorized') {
      getOrCreateNode(f);
    }
  }

  for (const note of notesList) {
    const parsedTags = safeParseTags(note.tags);
    const folderPath = parsedTags[0] || 'Uncategorized';
    const node = getOrCreateNode(folderPath);
    node.notes.push(note);
  }

  const sortNode = (node: FolderNode) => {
    node.subfolders.sort((a, b) => a.name.localeCompare(b.name));
    node.notes.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    for (const child of node.subfolders) {
      sortNode(child);
    }
  };

  sortNode(root);

  const uncategorizedIdx = root.subfolders.findIndex(f => f.fullPath === 'Uncategorized');
  if (uncategorizedIdx !== -1) {
    const uncategorized = root.subfolders.splice(uncategorizedIdx, 1)[0];
    if (uncategorized) {
      root.subfolders.push(uncategorized);
    }
  }

  return root;
}

export function PersonalBrainPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [notes, setNotes] = useState<PersonalNote[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  
  // Explorer & Search
  const [query, setQuery] = useState('');
  
  // Collapsible Folders State
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderNameInput, setNewFolderNameInput] = useState('');
  const [parentFolderPathForNewSubfolder, setParentFolderPathForNewSubfolder] = useState('');

  // Editor State
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editFolder, setEditFolder] = useState('Uncategorized');
  const [tempFolderName, setTempFolderName] = useState('');

  // Ref for textarea & formatting state
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Obsidian-style editor: edit / split / preview, [[wikilink]] autocomplete.
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('edit');
  const [wikiQuery, setWikiQuery] = useState<string | null>(null);
  const [wikiAnchor, setWikiAnchor] = useState<number>(-1);

  /** Detect an open `[[fragment` immediately before the caret. */
  const detectWikilink = useCallback((value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const open = upToCaret.lastIndexOf('[[');
    if (open === -1) { setWikiQuery(null); return; }
    const fragment = upToCaret.slice(open + 2);
    if (fragment.includes(']]') || fragment.includes('\n') || fragment.length > 80) {
      setWikiQuery(null);
      return;
    }
    setWikiQuery(fragment);
    setWikiAnchor(open);
  }, []);

  const insertWikilink = useCallback((title: string) => {
    const textarea = textareaRef.current;
    if (!textarea || wikiAnchor < 0) return;
    const caret = textarea.selectionStart;
    const next = `${editContent.slice(0, wikiAnchor)}[[${title}]]${editContent.slice(caret)}`;
    setEditContent(next);
    setWikiQuery(null);
    requestAnimationFrame(() => {
      textarea.focus();
      const position = wikiAnchor + title.length + 4;
      textarea.setSelectionRange(position, position);
    });
  }, [editContent, wikiAnchor]);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loadedNoteId, setLoadedNoteId] = useState<string | null>(null);
  
  // Agent Access State
  const [agentId, setAgentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'map' | 'notes'>('map');
  const [showAccessModal, setShowAccessModal] = useState(false);

  // Files / Digital Brain State
  const [personalFiles, setPersonalFiles] = useState<KnowledgeDocumentRow[]>([]);
  const [personalBase, setPersonalBase] = useState<KnowledgeBaseRow | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const PERSONAL_BASE_NAME = 'Personal Brain Files';

  const loadFiles = useCallback(async () => {
    try {
      const baseData = await api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases');
      const bases = baseData.knowledgeBases ?? [];
      const base = bases.find(b => b.name === PERSONAL_BASE_NAME) ?? null;
      setPersonalBase(base);
      if (base) {
        const docData = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
        setPersonalFiles((docData.documents ?? []).map(d => ({ ...d, knowledgeBaseName: PERSONAL_BASE_NAME })));
      } else {
        setPersonalFiles([]);
      }
    } catch {
      setPersonalFiles([]);
    }
  }, []);

  const load = useCallback(async () => {
    const [noteData, agentData, grantData] = await Promise.all([
      api<{ notes: PersonalNote[] }>('/v1/personal-brain/notes'),
      api<{ agents: AgentRow[] }>('/v1/agents'),
      api<{ grants: Grant[] }>('/v1/personal-brain/grants'),
    ]);
    setNotes(noteData.notes);
    setAgents(agentData.agents);
    setGrants(grantData.grants);
    if (!agentId && agentData.agents[0]) setAgentId(agentData.agents[0].id);
  }, [agentId]);

  useEffect(() => { void load().catch(() => {}); void loadFiles().catch(() => {}); }, [load, loadFiles]);

  /** Dashed-wikilink click: create the missing note and open it (Obsidian behavior). */
  const createNoteFromWikilink = useCallback(async (title: string) => {
    try {
      const created = await api<{ note: { id: string } }>(`/v1/personal-brain/notes`, {
        method: 'POST',
        body: JSON.stringify({ title, content: `# ${title}\n` }),
      });
      await load();
      if (created?.note?.id) setSelectedNoteId(created.note.id);
    } catch {
    }
  }, [load]);

  async function deleteFile(doc: KnowledgeDocumentRow) {
    const ok = await confirm({
      title: `Delete "${doc.name}"?`,
      body: 'This file will be permanently removed from your Personal Brain.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/v1/knowledge-bases/${doc.knowledgeBaseId}/documents/${doc.id}`, { method: 'DELETE' });
      toast.success('File removed', doc.name);
      if (selectedFileId === doc.id) setSelectedFileId(null);
      await loadFiles();
    } catch (error) {
      toast.error('Could not delete file', apiErrorMessage(error));
    }
  }

  // Group notes by folder (using tags[0] as the folder name)
  const notesByFolder = useMemo(() => {
    const grouped: Record<string, PersonalNote[]> = {};
    for (const note of notes) {
      const parsedTags = safeParseTags(note.tags);
      const folderName = parsedTags[0] || 'Uncategorized';
      if (!grouped[folderName]) {
        grouped[folderName] = [];
      }
      grouped[folderName].push(note);
    }
    return grouped;
  }, [notes]);

  // Get sorted list of all active folders
  const folders = useMemo(() => {
    const active = Object.keys(notesByFolder);
    const all = Array.from(new Set([...active, ...customFolders]));
    return all.sort((a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    });
  }, [notesByFolder, customFolders]);

  const folderTree = useMemo(() => {
    return buildFolderTree(folders, notes);
  }, [folders, notes]);

  // Sync editor with selected note ONLY when selectedNoteId changes or notes initially load
  useEffect(() => {
    if (!selectedNoteId && notes.length > 0) {
      setSelectedNoteId(notes[0]?.id ?? null);
      return;
    }
    
    if (selectedNoteId !== loadedNoteId) {
      setLoadedNoteId(selectedNoteId);
      setSaveStatus('idle');
      
      if (selectedNoteId === 'new') {
        setEditTitle('');
        setEditContent('');
        if (!editFolder) setEditFolder('Uncategorized');
      } else if (selectedNoteId) {
        const activeNote = notes.find((n) => n.id === selectedNoteId);
        if (activeNote) {
          setEditTitle(activeNote.title ?? '');
          setEditContent(activeNote.content);
          const parsedTags = safeParseTags(activeNote.tags);
          setEditFolder(parsedTags[0] || 'Uncategorized');
        }
      } else {
        setEditTitle('');
        setEditContent('');
        setEditFolder('Uncategorized');
      }
    }
  }, [selectedNoteId, notes, loadedNoteId]);

  // Debounced Auto-Saving
  useEffect(() => {
    if (!selectedNoteId || selectedNoteId === 'new') return;
    const activeNote = notes.find((n) => n.id === selectedNoteId);
    if (!activeNote) return;

    // Do not auto-save if content is empty (prevents API validation errors)
    if (!editContent.trim()) {
      return;
    }

    const activeFolderTag = safeParseTags(activeNote.tags)[0] || 'Uncategorized';
    const folderTag = editFolder && editFolder !== 'Uncategorized' && editFolder !== '__new__' ? [editFolder] : [];

    const hasChanges =
      editTitle.trim() !== (activeNote.title ?? '').trim() ||
      editContent.trim() !== activeNote.content.trim() ||
      editFolder !== activeFolderTag;

    if (!hasChanges) {
      return;
    }

    setSaveStatus('saving');

    const delayDebounce = setTimeout(async () => {
      try {
        await api(`/v1/personal-brain/notes/${selectedNoteId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: editTitle.trim() || null,
            content: editContent.trim(),
            tags: folderTag,
          }),
        });
        setSaveStatus('saved');
        
        // Quietly update the notes list to sync left pane folders, avoiding resets
        const noteData = await api<{ notes: PersonalNote[] }>('/v1/personal-brain/notes');
        setNotes(noteData.notes);
      } catch (error) {
        console.error('Auto-save failed:', error);
        setSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(delayDebounce);
  }, [editTitle, editContent, editFolder, selectedNoteId, notes]);

  // Transition saved status back to idle after 3 seconds
  useEffect(() => {
    if (saveStatus === 'saved') {
      const timer = setTimeout(() => {
        setSaveStatus('idle');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  // Editor rich text formatting utilities
  const insertFormatting = (prefix: string, suffix = prefix) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = editContent;
    
    const selectedText = val.substring(start, end);
    let newVal = '';
    let newStart = start;
    let newEnd = end;
    
    // Check if already wrapped
    const hasPrefix = val.substring(start - prefix.length, start) === prefix;
    const hasSuffix = val.substring(end, end + suffix.length) === suffix;
    
    if (hasPrefix && hasSuffix) {
      // Unwrap
      newVal = val.substring(0, start - prefix.length) + selectedText + val.substring(end + suffix.length);
      newStart = start - prefix.length;
      newEnd = end - prefix.length;
    } else if (selectedText.startsWith(prefix) && selectedText.endsWith(suffix)) {
      // Unwrap inner
      newVal = val.substring(0, start) + selectedText.substring(prefix.length, selectedText.length - suffix.length) + val.substring(end);
      newStart = start;
      newEnd = end - prefix.length - suffix.length;
    } else {
      // Wrap
      newVal = val.substring(0, start) + prefix + selectedText + suffix + val.substring(end);
      newStart = start + prefix.length;
      newEnd = end + prefix.length;
    }
    
    setEditContent(newVal);
    
    // Restore selection and focus
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(newStart, newEnd);
    }, 0);
  };

  const toggleLinePrefix = (prefix: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = editContent;
    
    const beforeText = val.substring(0, start);
    const startOfLine = beforeText.lastIndexOf('\n') + 1;
    const afterText = val.substring(end);
    const endOfLineIndex = afterText.indexOf('\n');
    const endOfLine = endOfLineIndex === -1 ? val.length : end + endOfLineIndex;
    
    const affectedText = val.substring(startOfLine, endOfLine);
    const lines = affectedText.split('\n');
    
    let hasPrefix = true;
    const prefixEscaped = prefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const isNumberedPattern = prefix === '1. ';
    const regex = isNumberedPattern ? /^\s*\d+\.\s/ : new RegExp('^\\s*' + prefixEscaped);
    
    for (const line of lines) {
      if (line.trim() && !regex.test(line)) {
        hasPrefix = false;
        break;
      }
    }
    
    const newLines = lines.map((line, idx) => {
      if (!line.trim() && lines.length > 1) return line;
      if (hasPrefix) {
        if (isNumberedPattern) {
          return line.replace(/^\s*\d+\.\s/, '');
        } else {
          return line.replace(regex, '');
        }
      } else {
        const indentMatch = line.match(/^(\s*)/);
        const indent = (indentMatch ? indentMatch[1] : '') || '';
        const content = line.substring(indent.length);
        const currentPrefix = isNumberedPattern ? `${idx + 1}. ` : prefix;
        return `${indent}${currentPrefix}${content}`;
      }
    });
    
    const newAffectedText = newLines.join('\n');
    const newVal = val.substring(0, startOfLine) + newAffectedText + val.substring(endOfLine);
    
    setEditContent(newVal);
    const lengthDiff = newAffectedText.length - affectedText.length;
    
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(startOfLine, endOfLine + lengthDiff);
    }, 0);
  };

  const handleIndent = (outdent = false) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = editContent;
    
    const beforeText = val.substring(0, start);
    const startOfLine = beforeText.lastIndexOf('\n') + 1;
    const afterText = val.substring(end);
    const endOfLineIndex = afterText.indexOf('\n');
    const endOfLine = endOfLineIndex === -1 ? val.length : end + endOfLineIndex;
    
    const affectedText = val.substring(startOfLine, endOfLine);
    const lines = affectedText.split('\n');
    
    const newLines = lines.map((line) => {
      if (outdent) {
        if (line.startsWith('  ')) return line.substring(2);
        if (line.startsWith(' ')) return line.substring(1);
        return line;
      } else {
        return '  ' + line;
      }
    });
    
    const newAffectedText = newLines.join('\n');
    const newVal = val.substring(0, startOfLine) + newAffectedText + val.substring(endOfLine);
    
    setEditContent(newVal);
    const lengthDiff = newAffectedText.length - affectedText.length;
    
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(startOfLine, endOfLine + lengthDiff);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isMeta = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    
    if (isMeta) {
      if (e.code === 'KeyB') {
        e.preventDefault();
        insertFormatting('**');
      } else if (e.code === 'KeyI') {
        e.preventDefault();
        insertFormatting('*');
      } else if (e.code === 'KeyU') {
        e.preventDefault();
        insertFormatting('<u>', '</u>');
      } else if (e.code === 'KeyX' && isShift) {
        e.preventDefault();
        insertFormatting('~~');
      } else if (e.code === 'Digit8') {
        e.preventDefault();
        toggleLinePrefix('- ');
      } else if (e.code === 'Digit7') {
        e.preventDefault();
        toggleLinePrefix('1. ');
      } else if (e.code === 'Digit9') {
        e.preventDefault();
        toggleLinePrefix('- [ ] ');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleIndent(e.shiftKey);
    }
  };

  async function togglePin() {
    if (!selectedNoteId || selectedNoteId === 'new') return;
    const activeNote = notes.find((n) => n.id === selectedNoteId);
    if (!activeNote) return;
    const newPinned = !activeNote.pinned;
    
    setSaveStatus('saving');
    try {
      await api(`/v1/personal-brain/notes/${selectedNoteId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          pinned: newPinned,
        }),
      });
      setSaveStatus('saved');
      toast.success(newPinned ? 'Note pinned' : 'Note unpinned');
      await load();
    } catch (error) {
      setSaveStatus('error');
      toast.error('Could not update pinning state');
    }
  }

  async function save() {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      const folderTag = editFolder && editFolder !== 'Uncategorized' && editFolder !== '__new__' ? [editFolder] : [];
      if (selectedNoteId === 'new') {
        const response = await api<{ note: PersonalNote }>('/v1/personal-brain/notes', {
          method: 'POST',
          body: JSON.stringify({
            title: editTitle.trim() || null,
            content: editContent.trim(),
            tags: folderTag,
          }),
        });
        toast.success('Saved to Personal Brain');
        await load();
        if (response.note?.id) {
          setSelectedNoteId(response.note.id);
        }
      } else if (selectedNoteId) {
        await api(`/v1/personal-brain/notes/${selectedNoteId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: editTitle.trim() || null,
            content: editContent.trim(),
            tags: folderTag,
          }),
        });
        toast.success('Note updated');
        await load();
      }
    } catch (error) {
      toast.error('Could not save note', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function search() {
    if (!query.trim()) { await load(); return; }
    try {
      const data = await api<{ notes: PersonalNote[] }>('/v1/personal-brain/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.trim() }),
      });
      setNotes(data.notes);
      if (data.notes.length > 0) {
        setSelectedNoteId(data.notes[0]?.id ?? null);
      } else {
        setSelectedNoteId(null);
      }
    } catch (error) {
      toast.error('Search failed', apiErrorMessage(error));
    }
  }

  async function remove(id: string) {
    const note = notes.find((n) => n.id === id);
    const ok = await confirm({
      title: `Delete "${note?.title?.trim() || 'Untitled note'}"?`,
      body: 'This note will be permanently deleted.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/v1/personal-brain/notes/${id}`, { method: 'DELETE' });
      toast.success('Note deleted');
      if (selectedNoteId === id) {
        setSelectedNoteId(null);
      }
      await load();
    } catch (error) {
      toast.error('Could not delete note', apiErrorMessage(error));
    }
  }

  async function grant() {
    if (!agentId) return;
    await api(`/v1/personal-brain/grants/${agentId}`, { method: 'PUT', body: JSON.stringify({ accessLevel: 'read' }) });
    await load();
    toast.success('Access granted', 'Relevant personal notes may be included in that agent context.');
  }

  async function revoke(id: string) {
    await api(`/v1/personal-brain/grants/${id}`, { method: 'DELETE' });
    await load();
  }

  const grantedIds = useMemo(() => new Set(grants.map((grantItem) => grantItem.agentId)), [grants]);

  function handleNewNote(folderName = 'Uncategorized') {
    setSelectedNoteId('new');
    setEditTitle('');
    setEditContent('');
    setEditFolder(folderName);
  }

  function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = newFolderNameInput.trim();
    if (!name) return;
    
    const folderPath = parentFolderPathForNewSubfolder 
      ? `${parentFolderPathForNewSubfolder}/${name}`
      : name;

    if (!customFolders.includes(folderPath)) {
      setCustomFolders(prev => [...prev, folderPath]);
    }
    setNewFolderNameInput('');
    setCreatingFolder(false);
    setParentFolderPathForNewSubfolder('');
    setCollapsedFolders(prev => ({ ...prev, [folderPath]: false }));
    handleNewNote(folderPath);
  }

  function handleAddTempFolder() {
    const name = tempFolderName.trim();
    if (!name) return;
    if (!customFolders.includes(name)) {
      setCustomFolders(prev => [...prev, name]);
    }
    setEditFolder(name);
    setTempFolderName('');
  }

  const toggleFolder = (folderName: string) => {
    setCollapsedFolders(prev => ({
      ...prev,
      [folderName]: !prev[folderName]
    }));
  };

  const renderFolderNode = (node: FolderNode, depth = 0) => {
    const isCollapsed = collapsedFolders[node.fullPath] ?? false;
    const paddingLeft = `${depth * 12 + 8}px`;
    const indentBorder = depth > 0;

    return (
      <div key={node.fullPath} className="space-y-1">
        <div 
          className="group/folder flex items-center justify-between rounded-btn hover:bg-surface-2 transition-colors relative"
          style={{ paddingLeft }}
        >
          <button
            type="button"
            onClick={() => toggleFolder(node.fullPath)}
            className="flex items-center gap-1.5 text-left text-[12px] font-semibold text-text-primary flex-1 min-w-0 py-1.5"
          >
            <span className="text-text-muted shrink-0">
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </span>
            <span className="text-accent shrink-0">
              {isCollapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
            </span>
            <span className="truncate flex-1">{node.name}</span>
            <span className="text-[10px] text-text-muted shrink-0 rounded bg-surface-3 px-1 py-0.5 ml-1">
              {countTotalNotes(node)}
            </span>
          </button>
          
          {node.fullPath !== 'Uncategorized' && (
            <div className="opacity-0 group-hover/folder:opacity-100 flex items-center gap-0.5 pr-1.5 transition-opacity shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedFolders(prev => ({ ...prev, [node.fullPath]: false }));
                  handleNewNote(node.fullPath);
                }}
                className="p-0.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
                title="New note in this folder"
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedFolders(prev => ({ ...prev, [node.fullPath]: false }));
                  setParentFolderPathForNewSubfolder(node.fullPath);
                  setCreatingFolder(true);
                }}
                className="p-0.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
                title="New subfolder"
              >
                <Folder size={13} className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {!isCollapsed && (
          <div 
            className="space-y-1 relative"
            style={{ 
              marginLeft: `${depth * 12 + 14}px`,
              borderLeft: indentBorder ? '1px solid rgba(255,255,255,0.06)' : 'none',
              paddingLeft: indentBorder ? '6px' : '0px'
            }}
          >
            {node.subfolders.map(sub => renderFolderNode(sub, depth + 1))}

            {node.notes.map((note) => {
              const isSelected = selectedNoteId === note.id;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => setSelectedNoteId(note.id)}
                  className={`group w-full text-left rounded-btn p-2 flex flex-col gap-0.5 transition-colors ${
                    isSelected ? 'bg-accent-soft text-text-primary border border-accent/20' : 'hover:bg-surface-2/65 text-text-secondary border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 w-full">
                    <span className="truncate text-[11.5px] font-medium flex-1 flex items-center gap-1">
                      <FileText size={11} className={isSelected ? 'text-accent' : 'text-text-muted'} />
                      <span className="truncate">{note.title || 'Untitled note'}</span>
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {note.pinned && (
                        <Pin size={10} className="text-accent shrink-0" />
                      )}
                      <span className="text-[9px] text-text-muted">{formatDate(note.updatedAt)}</span>
                    </div>
                  </div>
                  <p className={`text-[10.5px] line-clamp-1 leading-relaxed w-full ${isSelected ? 'text-text-primary' : 'text-text-muted'}`}>
                    {note.content}
                  </p>
                </button>
              );
            })}

            {node.subfolders.length === 0 && node.notes.length === 0 && (
              <button
                type="button"
                onClick={() => handleNewNote(node.fullPath)}
                className="w-full text-left rounded p-1.5 text-[11px] text-text-muted hover:text-text-primary hover:bg-surface-2/40 italic flex items-center gap-1 pl-4"
              >
                <Plus size={11} /> Empty folder. Create note?
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-6">
        <span className="text-[12px] font-semibold text-text-muted">Private space explorer</span>
        <div className="flex items-center gap-1.5 text-[12px]">
          <button type="button" onClick={() => setView('map')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'map' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><Network size={12} /> Map</button>
          <button type="button" onClick={() => setView('notes')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'notes' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><NotebookPen size={12} /> Notes & access</button>
          <button type="button" onClick={() => setShowAccessModal(true)} className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors"><LockKeyhole size={12} /> Agent Access</button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'map' ? (
          <ScopedBrainMap
            endpoint="/v1/personal-brain/graph"
            detailEndpoint="/v1/personal-brain/graph/node"
            layoutKey="personal"
            emptyMessage="Capture notes and preferences to begin mapping your Personal Brain."
          />
        ) : (
          <div className="h-full px-6 py-5 overflow-hidden flex flex-col gap-4">
            {/* Drop Zone — digital brain upload */}
            <WorkspaceDocDropZone
              bases={personalBase ? [personalBase] : []}
              selectedBaseId={personalBase?.id ?? null}
              onUploaded={loadFiles}
              createBasePath="/v1/knowledge-bases"
              uploadPathForBase={(baseId) => `/v1/knowledge-bases/${baseId}/documents`}
              defaultBaseName="Personal Brain Files"
              defaultBaseDescription="Private files stored in your Personal Brain."
              title="Your digital brain"
              description="PDF, Markdown, TXT, DOCX, CSV — private to you."
              accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json,.xlsx,.xls,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              compact
              showDescribeImages={false}
              hideBaseSelector
            />
            <div className="flex flex-1 min-h-0 gap-4 max-w-[1600px] mx-auto w-full overflow-hidden">
              
              {/* 1. Left Explorer Pane (Folders & Files) */}
              <aside className="flex flex-col w-[260px] shrink-0 rounded-card border border-line bg-surface overflow-hidden">
                <div className="p-3 border-b border-line flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-text-muted flex items-center gap-1.5">
                      <Brain size={11} className="text-accent" />
                      Personal Brain
                      {personalFiles.length > 0 && (
                        <span className="rounded bg-accent/20 text-accent px-1.5 py-0.5 text-[9px] font-bold">{personalFiles.length}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setParentFolderPathForNewSubfolder('');
                        setCreatingFolder(true);
                      }}
                      className="p-1 rounded-btn hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors text-[11px] font-medium flex items-center gap-1"
                      title="New folder"
                    >
                      <Plus size={13} /> Folder
                    </button>
                  </div>
                  
                  {creatingFolder && (
                    <form onSubmit={handleCreateFolder} className="mb-2 space-y-2 rounded-btn border border-line bg-surface-2 p-2">
                      <input
                        autoFocus
                        value={newFolderNameInput}
                        onChange={(e) => setNewFolderNameInput(e.target.value)}
                        placeholder={
                          parentFolderPathForNewSubfolder
                            ? `Subfolder under ${parentFolderPathForNewSubfolder.split('/').pop()}...`
                            : "Folder name..."
                        }
                        className="h-8 w-full rounded-input border border-line bg-canvas px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                      />
                      <div className="flex gap-1.5">
                        <Button type="submit" size="sm" variant="primary">Create</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setCreatingFolder(false);
                            setNewFolderNameInput('');
                            setParentFolderPathForNewSubfolder('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                  
                  <div className="relative">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
                      placeholder="Search notes..."
                      className="h-8 w-full rounded-input border border-line bg-surface-2 pl-7 pr-3 text-[12px] text-text-primary outline-none focus:border-accent"
                    />
                    <Search size={12} className="absolute left-2.5 top-2.5 text-text-muted" />
                  </div>
                </div>
                
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {folderTree.subfolders.length === 0 ? (
                    <p className="px-2 py-5 text-[12px] leading-relaxed text-text-muted text-center">No folders or notes found.</p>
                  ) : (
                    folderTree.subfolders.map(sub => renderFolderNode(sub, 0))
                  )}

                  {/* Uploaded Files — integrated as a collapsible folder node in the tree */}
                  {personalFiles.length > 0 && (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => setCollapsedFolders(prev => ({ ...prev, '__uploaded__': !prev['__uploaded__'] }))}
                        className="group w-full flex items-center gap-1.5 rounded-btn px-2 py-1.5 hover:bg-surface-2/60 text-text-muted hover:text-text-primary transition-colors"
                      >
                        {collapsedFolders['__uploaded__']
                          ? <ChevronRight size={12} className="shrink-0 opacity-60" />
                          : <ChevronDown size={12} className="shrink-0 opacity-60" />}
                        <FileArchive size={12} className="text-accent/70 shrink-0" />
                        <span className="text-[11px] font-semibold flex-1 text-left truncate">Uploaded Files</span>
                        <span className="text-[9px] bg-surface-3 text-text-muted px-1.5 py-0.5 rounded-full shrink-0">{personalFiles.length}</span>
                      </button>
                      {!collapsedFolders['__uploaded__'] && (
                        <div className="ml-4 space-y-0.5 mt-0.5">
                          {personalFiles.map((doc) => {
                            const isSelected = selectedFileId === doc.id;
                            const ext = doc.name.split('.').pop()?.toLowerCase() ?? '';
                            return (
                              <button
                                key={doc.id}
                                type="button"
                                onClick={() => { setSelectedFileId(doc.id); setSelectedNoteId(null); }}
                                className={`group w-full text-left rounded-btn px-2 py-1.5 flex items-center gap-2 transition-colors ${
                                  isSelected ? 'bg-accent-soft text-text-primary border border-accent/20' : 'hover:bg-surface-2/65 text-text-secondary border border-transparent'
                                }`}
                              >
                                <Paperclip size={11} className={isSelected ? 'text-accent shrink-0' : 'text-text-muted shrink-0'} />
                                <span className="truncate text-[11px] font-medium flex-1">{doc.name}</span>
                                <span className={`text-[9px] px-1 rounded shrink-0 ${
                                  isSelected ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-text-muted'
                                }`}>{ext}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0">
                  <button
                    type="button"
                    onClick={() => handleNewNote('Uncategorized')}
                    className="p-3 border-t border-line inline-flex w-full items-center justify-center gap-2 text-[12px] font-medium text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors"
                  >
                    <Plus size={13} /> New note
                  </button>
                </div>
              </aside>
              
              {/* 2. Center Pane — File detail OR Note editor */}
              <section className="flex-1 flex flex-col rounded-card border border-line/20 bg-surface overflow-hidden">
                {selectedFileId ? (
                  (() => {
                    const doc = personalFiles.find(f => f.id === selectedFileId);
                    if (!doc) return null;
                    const ext = doc.name.split('.').pop()?.toUpperCase() ?? 'FILE';
                    const mimeLabel = doc.mimeType.replace('application/', '').replace('text/', '').replace('vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx').replace('vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
                    return (
                      <div className="flex-1 flex flex-col min-h-0">
                        {/* File header */}
                        <div className="flex items-center justify-between px-6 py-3 shrink-0">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                              <Paperclip size={15} className="text-accent" />
                            </div>
                            <div>
                              <p className="text-[13px] font-semibold text-text-primary leading-tight truncate max-w-[360px]">{doc.name}</p>
                              <p className="text-[11px] text-text-muted mt-0.5">{mimeLabel} • {doc.status}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void deleteFile(doc)}
                            className="p-1.5 rounded-btn text-text-muted hover:text-danger hover:bg-danger-soft transition-colors"
                            title="Delete file"
                          >
                            <Trash2 size={13.5} />
                          </button>
                        </div>

                        {/* File detail card */}
                        <div className="flex-1 overflow-y-auto px-6 py-4">
                          <div className="rounded-card border border-line/30 bg-surface-2/30 p-6 max-w-[540px] flex flex-col gap-5">
                            {/* Big type badge */}
                            <div className="flex items-center gap-4">
                              <div className="h-16 w-16 rounded-xl bg-accent/10 border border-accent/20 flex flex-col items-center justify-center shrink-0">
                                <Paperclip size={20} className="text-accent mb-1" />
                                <span className="text-[9px] font-bold text-accent tracking-widest">{ext}</span>
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <p className="text-[15px] font-bold text-text-primary leading-snug">{doc.name}</p>
                                <div className="flex flex-wrap gap-2">
                                  <span className="text-[11px] bg-surface-3 px-2 py-0.5 rounded text-text-muted">{mimeLabel}</span>
                                  <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                                    doc.status === 'ready' ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'
                                  }`}>{doc.status}</span>
                                </div>
                              </div>
                            </div>

                            {/* Stats grid */}
                            <div className="grid grid-cols-2 gap-3">
                              {doc.tokenCount != null && (
                                <div className="rounded-lg bg-surface-2 px-4 py-3">
                                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Tokens</p>
                                  <p className="text-[18px] font-bold text-text-primary mt-0.5">{doc.tokenCount.toLocaleString()}</p>
                                </div>
                              )}
                              {doc.chunks != null && (
                                <div className="rounded-lg bg-surface-2 px-4 py-3">
                                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Chunks</p>
                                  <p className="text-[18px] font-bold text-text-primary mt-0.5">{doc.chunks}</p>
                                </div>
                              )}
                              {doc.createdAt && (
                                <div className="rounded-lg bg-surface-2 px-4 py-3 col-span-2">
                                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Stored on</p>
                                  <p className="text-[13px] font-medium text-text-primary mt-0.5">
                                    {new Date(doc.createdAt).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                  </p>
                                </div>
                              )}
                            </div>

                            {/* Context info */}
                            <div className="rounded-lg border border-accent/15 bg-accent/5 px-4 py-3 flex items-start gap-3">
                              <Brain size={15} className="text-accent shrink-0 mt-0.5" />
                              <p className="text-[12px] text-text-secondary leading-relaxed">
                                This file is indexed in your Personal Brain and can be surfaced as context for agents you grant access to. Content is private to you.
                              </p>
                            </div>

                            {/* Delete */}
                            <button
                              type="button"
                              onClick={() => void deleteFile(doc)}
                              className="mt-1 inline-flex items-center gap-2 px-3 py-2 rounded-btn bg-danger-soft text-danger hover:bg-danger/20 text-[12px] font-semibold transition-colors self-start"
                            >
                              <Trash2 size={13} /> Remove file
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : selectedNoteId ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    {/* Compact Top Header */}
                    <div className="flex items-center justify-between px-6 py-3 shrink-0">
                      <div className="flex items-center gap-3">
                        <FileText size={15} className="text-accent shrink-0" />
                        <span className="text-[12px] font-semibold text-text-primary shrink-0">
                          {selectedNoteId === 'new' ? 'Creating note...' : 'Editing note'}
                        </span>
                        
                        {/* Compact Folder Selector inline in top header */}
                        <div className="flex items-center gap-1.5 text-[11px] text-text-muted bg-surface-2/60 px-2 py-0.5 rounded-btn border border-line/15 shrink-0 focus-within:border-accent/40 focus-within:ring-0">
                          <Folder size={11} className="text-accent shrink-0" />
                          <select
                            value={editFolder}
                            onChange={(e) => setEditFolder(e.target.value)}
                            className="h-5 rounded border-0 bg-transparent px-1 text-[11px] text-text-secondary outline-none focus:outline-none focus:ring-0 cursor-pointer font-semibold pr-1"
                          >
                            <option value="Uncategorized">Uncategorized</option>
                            {folders.filter(f => f !== 'Uncategorized').map(f => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                            <option value="__new__">+ New folder...</option>
                          </select>
                          
                          {editFolder === '__new__' && (
                            <div className="flex items-center gap-1 ml-1 animate-scale-in border-l border-line/40 pl-1.5 shrink-0">
                              <input
                                autoFocus
                                value={tempFolderName}
                                onChange={(e) => setTempFolderName(e.target.value)}
                                placeholder="Folder name..."
                                className="h-5 w-24 rounded border border-line bg-surface-3 px-1.5 text-[10px] text-text-primary outline-none focus:border-accent"
                              />
                              <button
                                type="button"
                                onClick={handleAddTempFolder}
                                className="px-1.5 h-5 rounded bg-accent text-[10px] font-semibold text-on-accent hover:bg-accent/80 transition-colors"
                              >
                                Add
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Auto-Save Status Badge */}
                        {selectedNoteId !== 'new' && (
                          <div className="ml-1 transition-all duration-300 shrink-0">
                            {saveStatus === 'saving' && (
                              <div className="flex items-center gap-1.5 text-[11px] text-text-muted bg-surface-2 px-2 py-0.5 rounded border border-line/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse-dot" />
                                <span>Saving...</span>
                              </div>
                            )}
                            {saveStatus === 'saved' && (
                              <div className="flex items-center gap-1.5 text-[11px] text-success bg-success-soft px-2 py-0.5 rounded border border-success/20 animate-fade-in">
                                <Check size={11} className="shrink-0" />
                                <span>Saved</span>
                              </div>
                            )}
                            {saveStatus === 'error' && (
                              <div className="flex items-center gap-1.5 text-[11px] text-danger bg-danger-soft px-2 py-0.5 rounded border border-danger/20">
                                <AlertCircle size={11} className="shrink-0" />
                                <span>Failed to save</span>
                                <button type="button" onClick={() => void save()} className="underline ml-1 font-semibold hover:text-danger/80">Retry</button>
                              </div>
                            )}
                            {saveStatus === 'idle' && (
                              <div className="flex items-center gap-1 text-[11px] text-text-muted opacity-60">
                                <Check size={11} className="shrink-0 text-text-muted/65" />
                                <span>All changes saved</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Header Actions */}
                      {selectedNoteId !== 'new' && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          {/* Pin Toggle */}
                          <button
                            type="button"
                            onClick={() => void togglePin()}
                            className={`p-1.5 rounded-btn transition-colors ${
                              notes.find(n => n.id === selectedNoteId)?.pinned 
                                ? 'text-accent bg-accent-soft border border-accent/20' 
                                : 'text-text-muted hover:text-text-primary hover:bg-surface-2'
                            }`}
                            title={notes.find(n => n.id === selectedNoteId)?.pinned ? "Unpin Note" : "Pin Note"}
                          >
                            <Pin size={13.5} className={notes.find(n => n.id === selectedNoteId)?.pinned ? "" : "rotate-45"} />
                          </button>

                          {/* Inline Share/Access Badge */}
                          <button
                            type="button"
                            onClick={() => setShowAccessModal(true)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-btn text-[11px] font-semibold transition-colors text-text-muted hover:text-text-primary hover:bg-surface-2 border border-line/30"
                            title="Manage Agent Access"
                          >
                            <Share2 size={12.5} />
                            <span>Share</span>
                            {grants.length > 0 && (
                              <span className="bg-accent text-canvas text-[9px] font-bold px-1.5 py-0.5 rounded-pill ml-0.5 shrink-0 leading-none">
                                {grants.length}
                              </span>
                            )}
                          </button>

                          {/* Quick Delete */}
                          <button
                            type="button"
                            onClick={() => void remove(selectedNoteId)}
                            className="p-1.5 rounded-btn text-text-muted hover:text-danger hover:bg-danger-soft transition-colors"
                            title="Delete note"
                          >
                            <Trash2 size={13.5} />
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {/* Scrollable Note Canvas */}
                    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                      {/* Note Title Input placed prominently at the top */}
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="Note title..."
                        className="text-[20px] font-bold bg-transparent px-6 pt-5 pb-3 text-text-primary outline-none placeholder:text-text-muted border-b border-transparent focus:border-transparent w-full shrink-0"
                      />

                      {/* Formatting Toolbar directly below title, acting as header for textarea */}
                      <div className="flex items-center gap-1 px-4 py-1.5 bg-surface-2/20 overflow-x-auto shrink-0 scrollbar-none">
                        {/* Text formats */}
                        <div className="flex items-center gap-0.5 pr-2 mr-2 shrink-0">
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('**')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Bold (Ctrl+B)"
                          >
                            <Bold size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('*')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Italic (Ctrl+I)"
                          >
                            <Italic size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('<u>', '</u>')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Underline (Ctrl+U)"
                          >
                            <Underline size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('~~')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Strikethrough (Ctrl+Shift+X)"
                          >
                            <Strikethrough size={13} />
                          </button>
                        </div>

                        {/* Lists */}
                        <div className="flex items-center gap-0.5 pr-2 mr-2 shrink-0">
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleLinePrefix('- ')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Bullet List (Ctrl+Shift+8)"
                          >
                            <List size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleLinePrefix('1. ')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Numbered List (Ctrl+Shift+7)"
                          >
                            <ListOrdered size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleLinePrefix('- [ ] ')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Checklist (Ctrl+Shift+9)"
                          >
                            <ListTodo size={13} />
                          </button>
                        </div>

                        {/* Inserts & Utilities */}
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleLinePrefix('> ')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Blockquote"
                          >
                            <Quote size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('`', '`')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Code Snippet"
                          >
                            <Code size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleLinePrefix('---')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Horizontal Line"
                          >
                            <Minus size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormatting('[[', ']]')}
                            className="p-1.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
                            title="Link to another note ([[…]])"
                          >
                            <Link2 size={13} />
                          </button>
                        </div>

                        {/* View mode: edit / split / preview (Obsidian-style) */}
                        <div className="ml-auto flex shrink-0 items-center rounded-md border border-line bg-surface p-0.5">
                          {([
                            { mode: 'edit' as const, icon: <PenLine size={12} />, label: 'Edit' },
                            { mode: 'split' as const, icon: <Columns2 size={12} />, label: 'Split' },
                            { mode: 'preview' as const, icon: <Eye size={12} />, label: 'Read' },
                          ]).map((option) => (
                            <button
                              key={option.mode}
                              type="button"
                              onClick={() => setViewMode(option.mode)}
                              className={`flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-semibold transition-colors ${
                                viewMode === option.mode ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
                              }`}
                              title={option.label}
                            >
                              {option.icon} {option.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Editor surface: textarea and/or rendered preview */}
                      <div className="relative flex min-h-[300px] flex-1 overflow-hidden">
                        {viewMode !== 'preview' && (
                          <textarea
                            ref={textareaRef}
                            value={editContent}
                            onChange={(e) => {
                              setEditContent(e.target.value);
                              detectWikilink(e.target.value, e.target.selectionStart);
                            }}
                            onKeyDown={handleKeyDown}
                            onBlur={() => setTimeout(() => setWikiQuery(null), 200)}
                            placeholder="Write in Markdown. Link related notes with [[Note title]] — type [[ for suggestions."
                            className={`${viewMode === 'split' ? 'w-1/2 border-r border-line' : 'w-full'} flex-none resize-none bg-transparent p-6 text-[13.5px] leading-relaxed text-text-secondary outline-none placeholder:text-text-muted font-sans selection:bg-accent-soft selection:text-text-primary focus:outline-none`}
                          />
                        )}
                        {viewMode !== 'edit' && (
                          <div className={`${viewMode === 'split' ? 'w-1/2' : 'w-full'} min-w-0`}>
                            <NoteMarkdownPreview
                              content={editContent}
                              notes={notes}
                              onNavigate={(noteId) => setSelectedNoteId(noteId)}
                              onCreate={(title) => void createNoteFromWikilink(title)}
                            />
                          </div>
                        )}
                        {/* [[wikilink]] autocomplete */}
                        {wikiQuery !== null && viewMode !== 'preview' && (() => {
                          const matches = notes
                            .filter((note) => note.id !== selectedNoteId && note.title)
                            .filter((note) => note.title!.toLowerCase().includes(wikiQuery.toLowerCase()))
                            .slice(0, 6);
                          if (matches.length === 0 && !wikiQuery.trim()) return null;
                          return (
                            <div className="absolute bottom-3 left-6 z-10 w-72 overflow-hidden rounded-md border border-line bg-surface-2 shadow-lg">
                              <p className="border-b border-line px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Link note</p>
                              {matches.map((note) => (
                                <button
                                  key={note.id}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => insertWikilink(note.title!)}
                                  className="block w-full truncate px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-accent-soft hover:text-accent"
                                >
                                  {note.title}
                                </button>
                              ))}
                              {wikiQuery.trim() && !matches.some((m) => m.title!.toLowerCase() === wikiQuery.trim().toLowerCase()) && (
                                <button
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => insertWikilink(wikiQuery.trim())}
                                  className="block w-full truncate border-t border-line px-3 py-1.5 text-left text-[12px] text-text-muted hover:bg-surface-3 hover:text-text-primary"
                                >
                                  Link as new: “{wikiQuery.trim()}?
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Backlinks — notes that reference this one */}
                      {selectedNoteId !== 'new' && editTitle.trim() && (() => {
                        const backlinks = findBacklinks(notes, editTitle, selectedNoteId);
                        if (backlinks.length === 0) return null;
                        return (
                          <div className="shrink-0 border-t border-line px-6 py-2.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Linked from {backlinks.length} note{backlinks.length === 1 ? '' : 's'}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {backlinks.map((note) => (
                                <button
                                  key={note.id}
                                  type="button"
                                  onClick={() => setSelectedNoteId(note.id)}
                                  className="inline-flex items-center gap-1 rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted hover:border-accent hover:text-accent"
                                >
                                  <Link2 size={10} /> {note.title ?? 'Untitled'}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    
                    {/* Editor Footer */}
                    <div className="flex items-center justify-between px-6 py-3 bg-surface-2/40 text-[11px] text-text-muted shrink-0">
                      <span>
                        {editContent.trim() ? editContent.trim().split(/\s+/).length : 0} words • {editContent.length} characters
                      </span>
                      <div className="flex items-center gap-2">
                        {selectedNoteId !== 'new' && (
                          <button
                            type="button"
                            onClick={() => void remove(selectedNoteId)}
                            className="px-2.5 py-1.5 rounded bg-danger-soft text-danger hover:bg-danger/25 text-[11px] font-semibold transition-colors flex items-center gap-1.5"
                            title="Delete note"
                          >
                            <Trash2 size={11} /> Delete Note
                          </button>
                        )}
                        
                        {(() => {
                          const activeNote = notes.find((n) => n.id === selectedNoteId);
                          const activeFolderTag = activeNote ? (safeParseTags(activeNote.tags)[0] || 'Uncategorized') : 'Uncategorized';
                          const isUnsaved = activeNote && (
                            editTitle.trim() !== (activeNote.title ?? '').trim() ||
                            editContent.trim() !== activeNote.content.trim() ||
                            editFolder !== activeFolderTag
                          );

                          const buttonText = (() => {
                            if (selectedNoteId === 'new') return 'Create Note';
                            if (saveStatus === 'saving') return 'Saving...';
                            if (saveStatus === 'saved') return 'Saved';
                            if (saveStatus === 'error') return 'Retry Save';
                            if (isUnsaved) return 'Save Now';
                            return 'Saved';
                          })();

                          const isButtonDisabled = (() => {
                            if (selectedNoteId === 'new') return !editContent.trim();
                            if (saveStatus === 'saving') return true;
                            if (saveStatus === 'saved') return true;
                            if (saveStatus === 'error') return false;
                            return !isUnsaved;
                          })();

                          const buttonVariant = (() => {
                            if (selectedNoteId === 'new') return 'primary';
                            if (saveStatus === 'error') return 'danger';
                            if (isUnsaved) return 'primary';
                            return 'secondary';
                          })();

                          return (
                            <Button
                              variant={buttonVariant}
                              size="sm"
                              loading={saving || saveStatus === 'saving'}
                              disabled={isButtonDisabled}
                              onClick={() => void save()}
                              iconLeft={buttonText === 'Saved' ? <Check size={12} /> : <Save size={12} />}
                            >
                              {buttonText}
                            </Button>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-canvas/30">
                    <Brain size={42} className="text-text-muted mb-3 opacity-40 animate-pulse" />
                    <h3 className="text-[13px] font-semibold text-text-primary">Personal Brain</h3>
                    <p className="mt-1 text-[12px] text-text-muted max-w-[260px] leading-relaxed">
                      Select a note or upload a file using the drop zone above.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleNewNote('Uncategorized')}
                      className="mt-3 px-3 py-1.5 rounded bg-accent-soft text-accent text-[12px] font-semibold hover:bg-accent/20 transition-colors inline-flex items-center gap-1.5"
                    >
                      <Plus size={13} /> Write a note
                    </button>
                  </div>
                )}
              </section>

            </div>
          </div>
        )}
      </div>

      {/* 3. Global Agent Access Modal (Frees up horizontal space!) */}
      {showAccessModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="rounded-card border border-line bg-surface max-w-md w-full p-6 shadow-xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2 text-heading text-text-primary">
                <LockKeyhole size={16} className="text-accent" />
                <span>Agent Access Control</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAccessModal(false)}
                className="p-1 rounded-btn hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={15} />
              </button>
            </div>
            
            <p className="text-[12px] leading-relaxed text-text-secondary">
              Personal Brain is strictly private by default. When you grant read access, that specific agent will be allowed to securely fetch relevant context from your notes.
            </p>
            
            <div className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Grant access to agent</span>
              <div className="flex gap-2">
                <select
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  className="h-9 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={!agentId || grantedIds.has(agentId)}
                  onClick={() => void grant()}
                >
                  Grant Access
                </Button>
              </div>
            </div>
            
            <div className="border-t border-line pt-3 flex-1 overflow-y-auto max-h-[220px] space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Currently Authorized Agents</span>
              {grants.length === 0 ? (
                <p className="text-[12px] text-text-muted py-2 text-center">No agents have access yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {grants.map((grantItem) => (
                    <div key={grantItem.agentId} className="flex items-center justify-between gap-2 rounded-btn bg-surface-2 px-3 py-2 border border-line/40">
                      <div>
                        <p className="text-[12px] font-medium text-text-primary">{grantItem.agentName}</p>
                        <p className="text-[10px] text-text-muted capitalize">{grantItem.accessLevel} access</p>
                      </div>
                      <button
                        type="button"
                        className="text-[11px] font-semibold text-danger hover:underline"
                        onClick={() => void revoke(grantItem.agentId)}
                      >
                        Revoke Access
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="border-t border-line pt-3 flex justify-end">
              <Button onClick={() => setShowAccessModal(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}



