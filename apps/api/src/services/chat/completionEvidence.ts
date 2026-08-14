import type { TurnToolObservation } from '../conversation/conversationTurnLease.js';

export type CompletionEvidenceKind = 'mutation' | 'agent' | 'workflow' | 'app' | 'extension' | 'verification';

export interface CompletionEvidenceVerdict {
  allowed: boolean;
  claimed: CompletionEvidenceKind[];
  missing: CompletionEvidenceKind[];
  replacement?: string;
}

/**
 * Last-mile honesty gate for runtime-authored final answers.
 *
 * Prompts tell models not to fabricate, but a model is not the authority on what
 * Agentis persisted. The turn's tool ledger is. This guard only intervenes when
 * an operator asked for a mutation and the final answer makes a strong completed
 * claim. Ordinary discussion, plans, questions, and future-tense intent pass
 * untouched.
 */
export function guardCompletionClaims(args: {
  userMessage: string;
  assistantText: string;
  observations: TurnToolObservation[];
}): CompletionEvidenceVerdict {
  const user = normalize(args.userMessage);
  const answer = args.assistantText.trim();
  if (!answer || !requestsMutation(user)) return { allowed: true, claimed: [], missing: [] };

  const claimed = completionClaims(answer);
  if (claimed.length === 0) return { allowed: true, claimed: [], missing: [] };

  const evidence = evidenceKinds(args.observations);
  const missing = claimed.filter((kind) => !evidence.has(kind));
  if (missing.length === 0) return { allowed: true, claimed, missing: [] };

  const successful = args.observations.filter(observationSucceeded).map((entry) => entry.name);
  const failed = args.observations.filter((entry) => !observationSucceeded(entry)).map((entry) => entry.name);
  const portuguese = /\b(nao|voce|crie|criar|faca|fazer|conserte|corrija|fluxo|agente|aplicativo)\b/.test(user);
  return {
    allowed: false,
    claimed,
    missing,
    replacement: portuguese
      ? portugueseReplacement(missing, successful, failed)
      : englishReplacement(missing, successful, failed),
  };
}

function requestsMutation(text: string): boolean {
  return /\b(create|build|make|add|update|change|fix|repair|configure|install|persist|save|delete|remove|deploy|publish|activate|implement|set\s*up|crie|criar|construa|construir|faca|fazer|adicione|adicionar|atualize|atualizar|mude|mudar|corrija|corrigir|conserte|consertar|configure|configurar|instale|instalar|persista|persistir|salve|salvar|delete|deletar|remova|remover|publique|publicar|ative|ativar|implemente|implementar|cree|crear|construya|agregue|actualice|corrija|configure|instale|guarde|elimine|publique|active|implemente)\b/.test(text);
}

function completionClaims(text: string): CompletionEvidenceKind[] {
  const claims = new Set<CompletionEvidenceKind>();
  for (const rawSegment of text.split(/\r?\n|(?<=[.!?;])\s+/)) {
    const segment = normalize(rawSegment);
    if (!segment || isFutureOrIntention(segment)) continue;
    const completed = /\b(created|built|added|updated|changed|fixed|repaired|configured|installed|persisted|saved|deleted|removed|deployed|published|activated|implemented|completed|done|ready|criei|criamos|criado|construi|construido|adicionei|adicionado|atualizei|atualizado|mudei|alterei|alterado|corrigi|corrigido|consertei|consertado|configurei|configurado|instalei|instalado|persisti|persistido|salvei|salvo|deletei|deletado|removi|removido|publiquei|publicado|ativei|ativado|implementei|implementado|conclui|concluido|pronto|cree|creado|construi|construido|agregue|agregado|actualice|actualizado|corregi|corregido|configure|configurado|instale|instalado|guarde|guardado|elimine|eliminado|publique|publicado|active|activado|implemente|implementado|completado|listo)\b/.test(segment);
    const verified = /\b(verified|validated|tests? passed|dry[ -]?run (?:is )?(?:green|passed)|\d+\s*\/\s*\d+ (?:tests?|scenarios?|cases?)? (?:passed|approved)|verificado|validado|testes? (?:passaram|aprovados)|dry[ -]?run verde|\d+\s*\/\s*\d+ (?:cenarios?|casos?|testes?)? aprovados|verificado|validado|pruebas? aprobadas)\b/.test(segment);
    if (!completed && !verified) continue;

    const segmentKinds = new Set<CompletionEvidenceKind>();
    if (/\b(agent|specialist|worker|manager|agente|especialista|gestor)\b/.test(segment)) segmentKinds.add('agent');
    if (/\b(workflow|flow|fluxo de trabalho|fluxo)\b/.test(segment)) segmentKinds.add('workflow');
    if (/\b(app|application|interface|dashboard|aplicativo|aplicacao|interfaz)\b/.test(segment)) segmentKinds.add('app');
    if (/\b(extension|capability|ability|plugin|extensao|capacidade|habilidade|extension)\b/.test(segment)) segmentKinds.add('extension');
    if (/\b(file|record|configuration|setting|database|collection|arquivo|registro|configuracao|banco de dados|colecao|archivo|registro|configuracion|base de datos|coleccion)\b/.test(segment)) segmentKinds.add('mutation');
    for (const kind of segmentKinds) claims.add(kind);
    if (verified) claims.add('verification');
  }
  return [...claims];
}

function evidenceKinds(observations: TurnToolObservation[]): Set<CompletionEvidenceKind> {
  const evidence = new Set<CompletionEvidenceKind>();
  for (const entry of observations) {
    if (!observationSucceeded(entry)) continue;
    const name = normalize(entry.name);
    if (entry.mutating) evidence.add('mutation');
    if (/(?:agents?[._ -](?:create|spawn)|agent[._ -]spawn|specialist[._ -]create)/.test(name) && hasIdentity(entry.result, ['agentId', 'id'])) evidence.add('agent');
    if (/(?:build_workflow|workflow[._ -](?:create|commit|patch|update))/.test(name) && hasIdentity(entry.result, ['workflowId', 'id'])) evidence.add('workflow');
    if (/(?:app[._ -](?:create|update)|ui[._ -]render|build_workflow)/.test(name) && hasIdentity(entry.result, ['appId', 'id'])) evidence.add('app');
    if (/(?:extension|component|ability|capability)[._ -](?:create|install|update)/.test(name) && hasIdentity(entry.result, ['extensionId', 'componentId', 'abilityId', 'id'])) evidence.add('extension');
    if (/(?:verify|validate|dry[._ -]?run|test|doctor|probe)/.test(name) && resultLooksVerified(entry.result)) evidence.add('verification');
  }
  return evidence;
}

function observationSucceeded(entry: TurnToolObservation): boolean {
  return entry.ok && resultProvidesCompletionEvidence(entry.result);
}

/** True only when a transport-successful result does not explicitly deny accomplishment. */
export function resultProvidesCompletionEvidence(value: unknown): boolean {
  return !resultDeniesSuccess(value);
}

function resultDeniesSuccess(value: unknown): boolean {
  const flat = flatten(value);
  for (const key of ['ok', 'success', 'passed', 'valid', 'verified', 'dispatched', 'persisted', 'committed', 'completed', 'activated', 'published']) {
    if (flat.get(key) === false) return true;
  }
  const status = firstString(flat, ['status', 'outcome', 'verdict']);
  if (status && /^(?:failed|error|blocked|not_accomplished|rejected|timed_out|timeout)$/.test(normalize(status))) return true;
  if (flat.has('error') && flat.get('error')) return true;
  // A create handler may return normally while explicitly declining the write.
  if (flat.get('created') === false && flat.get('reused') !== true && !hasIdentity(value, ['agentId', 'workflowId', 'appId', 'extensionId', 'id'])) return true;
  return false;
}

function resultLooksVerified(value: unknown): boolean {
  if (resultDeniesSuccess(value)) return false;
  const flat = flatten(value);
  for (const key of ['passed', 'valid', 'verified', 'ok']) if (flat.get(key) === true) return true;
  const text = [...flat.values()].filter((entry): entry is string => typeof entry === 'string').join(' ');
  return /\b(?:passed|green|approved|aprovado|aprovados|success|successful|accomplished)\b/i.test(text) || /\b\d+\s*\/\s*\d+\b/.test(text);
}

function hasIdentity(value: unknown, keys: string[]): boolean {
  const flat = flatten(value);
  return keys.some((key) => {
    const found = flat.get(key);
    return typeof found === 'string' && found.trim().length > 0;
  });
}

function flatten(value: unknown, target = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (!value || typeof value !== 'object' || depth > 5) return target;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!target.has(key)) target.set(key, entry);
    if (entry && typeof entry === 'object') flatten(entry, target, depth + 1);
  }
  return target;
}

function firstString(values: Map<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = values.get(key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isFutureOrIntention(text: string): boolean {
  return /\b(i will|i'll|going to|will now|vou|vamos|irei|pretendo|planejo|voy a|vamos a)\b/.test(text);
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function portugueseReplacement(missing: CompletionEvidenceKind[], successful: string[], failed: string[]): string {
  const labels = missing.map((kind) => PT_LABELS[kind]).join(', ');
  const recorded = successful.length > 0 ? ` Ferramentas concluídas registradas: ${unique(successful).join(', ')}.` : ' Nenhuma mutação persistida bem-sucedida foi registrada.';
  const failures = failed.length > 0 ? ` Operações sem evidência de sucesso: ${unique(failed).join(', ')}.` : '';
  return `A Agentis bloqueou a conclusão porque o runtime afirmou trabalho que o ledger deste turno não comprova. Evidência ausente: ${labels}.${recorded}${failures} Nada foi marcado como concluído; tente novamente ou inspecione o recurso antes de continuar.`;
}

function englishReplacement(missing: CompletionEvidenceKind[], successful: string[], failed: string[]): string {
  const labels = missing.map((kind) => EN_LABELS[kind]).join(', ');
  const recorded = successful.length > 0 ? ` Recorded successful tools: ${unique(successful).join(', ')}.` : ' No successful persisted mutation was recorded.';
  const failures = failed.length > 0 ? ` Operations without success evidence: ${unique(failed).join(', ')}.` : '';
  return `Agentis withheld the completion claim because this turn's ledger does not prove it. Missing evidence: ${labels}.${recorded}${failures} Nothing was marked complete; retry or inspect the resource before continuing.`;
}

const PT_LABELS: Record<CompletionEvidenceKind, string> = {
  mutation: 'mutação persistida', agent: 'agente persistido com ID', workflow: 'workflow persistido com ID',
  app: 'App persistido com ID', extension: 'extensão persistida com ID', verification: 'verificação funcional aprovada',
};
const EN_LABELS: Record<CompletionEvidenceKind, string> = {
  mutation: 'persisted mutation', agent: 'persisted agent ID', workflow: 'persisted workflow ID',
  app: 'persisted App ID', extension: 'persisted extension ID', verification: 'passed functional verification',
};

function unique(values: string[]): string[] { return [...new Set(values)]; }
