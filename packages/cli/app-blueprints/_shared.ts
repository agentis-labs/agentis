type DatasetTarget = 'knowledge' | 'memory' | 'evaluator_examples';
type ChunkingStrategy = 'per-row' | 'per-document' | 'per-function' | 'sliding-window' | 'semantic';

interface BlueprintDataset {
  key: string;
  label: string;
  description: string;
  acceptedFormats: string[];
  targetStore?: DatasetTarget;
  chunkingStrategy?: ChunkingStrategy;
  requiredFields?: string[];
  optional?: boolean;
  exportInstructions?: string;
}

interface BlueprintCredential {
  key: string;
  service: string;
  label: string;
  required?: boolean;
  oauthFlow?: boolean;
}

interface BlueprintSpec {
  slug: string;
  name: string;
  category: string;
  replaces: string;
  costSavedPerMonth: string;
  description: string;
  capabilityTags: string[];
  instructions: string;
  prompt: string;
  datasets: BlueprintDataset[];
  credentials?: BlueprintCredential[];
  seedTitle: string;
  seedContent: string;
  rubricContext: string;
  evaluatorCriteria: string;
  baselineMs?: number;
}

export function buildBlueprint(spec: BlueprintSpec) {
  const agentName = `${spec.name} Operator`;
  const agentRef = slugify(agentName);
  return {
    name: spec.name,
    slug: spec.slug,
    version: '1.0.0',
    description: spec.description,
    tags: ['blueprint', spec.category, 'agentis-app'],
    contents: {
      kind: 'agentis',
      agents: [
        {
          name: agentName,
          adapterType: 'claude_code',
          capabilityTags: spec.capabilityTags,
          config: { blueprintSlug: spec.slug },
          instructions: spec.instructions,
          avatarGlyph: 'Sparkles',
          runtimeModel: null,
          role: 'operator',
        },
      ],
      skills: [],
      workflows: [
        {
          slug: 'main',
          title: `${spec.name} Main Workflow`,
          summary: spec.description,
          graph: workflowGraph(spec, agentRef),
          settings: { blueprintSlug: spec.slug },
          maxConcurrentRuns: 3,
          concurrencyOverflow: 'queue',
        },
      ],
      integrations: [],
      credentialSlots: (spec.credentials ?? []).map((credential) => ({
        key: credential.key,
        service: credential.service,
        label: credential.label,
        required: credential.required ?? true,
        oauthFlow: credential.oauthFlow ?? false,
      })),
      datasetSpecs: spec.datasets.map((dataset) => ({
        key: dataset.key,
        label: dataset.label,
        description: dataset.description,
        icon: 'Database',
        acceptedFormats: dataset.acceptedFormats,
        targetStore: dataset.targetStore ?? 'knowledge',
        chunkingStrategy: dataset.chunkingStrategy ?? 'per-row',
        requiredFields: dataset.requiredFields,
        optional: dataset.optional ?? false,
        embeddingHint: dataset.description,
        sizeWarningAboveRows: 50000,
        example: {
          sampleColumns: dataset.requiredFields,
          exportInstructions: dataset.exportInstructions,
        },
      })),
      knowledgeSeeds: [
        {
          title: spec.seedTitle,
          content: spec.seedContent,
          metadata: { blueprintSlug: spec.slug, category: spec.category },
        },
      ],
      evaluatorRubrics: [
        {
          nodeKind: 'evaluator',
          context: spec.rubricContext,
          examples: [
            {
              input: { summary: 'Specific, sourced, action-oriented output with clear next step.' },
              expectedScore: 0.9,
              expectedBranch: 'pass',
              reason: spec.evaluatorCriteria,
            },
            {
              input: { summary: 'Generic output with no evidence or owner.' },
              expectedScore: 0.2,
              expectedBranch: 'fail',
              reason: 'Fails the blueprint quality bar.',
            },
          ],
        },
      ],
      workflowBaselines: [
        {
          workflowSlug: 'main',
          p50DurationMs: spec.baselineMs ?? 45000,
          p95DurationMs: (spec.baselineMs ?? 45000) * 3,
          expectedSuccessRate: 0.9,
          costCentsPerRun: 25,
          derivedFromRuns: 0,
        },
      ],
      entryWorkflowSlug: 'main',
      category: spec.category,
      replaces: spec.replaces,
      costSavedPerMonth: spec.costSavedPerMonth,
      readme: `${spec.name}\n\n${spec.description}\n\nImport the declared datasets before relying on autonomous decisions in production.`,
      screenshotUrls: [],
      crossAppDependencies: [],
    },
  };
}

function workflowGraph(spec: BlueprintSpec, agentRef: string) {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.85 },
    variables: [
      {
        name: 'payload',
        type: 'json',
        kind: 'input',
        required: false,
        description: 'Event, record, or batch item to process.',
      },
    ],
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        title: 'Manual or Webhook Trigger',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger', triggerType: 'manual' },
      },
      {
        id: 'retrieve',
        type: 'knowledge',
        title: 'Retrieve App Context',
        position: { x: 280, y: 0 },
        config: { kind: 'knowledge', knowledgeBaseId: '__seeds', query: '<inputs.payload>', topK: 5 },
      },
      {
        id: 'decide',
        type: 'agent_task',
        title: 'Draft Decision Brief',
        position: { x: 560, y: 0 },
        config: {
          kind: 'agent_task',
          agentPackageRef: agentRef,
          capabilityTags: spec.capabilityTags,
          prompt: spec.prompt,
          inputKeys: ['payload', 'retrieve'],
          outputKeys: ['brief', 'decision', 'nextSteps'],
          timeoutMs: 120000,
        },
      },
      {
        id: 'quality',
        type: 'evaluator',
        title: 'Quality Gate',
        position: { x: 840, y: 0 },
        config: {
          kind: 'evaluator',
          criteria: spec.evaluatorCriteria,
          inputPath: 'brief',
          threshold: 0.1,
        },
      },
      {
        id: 'respond',
        type: 'response',
        title: 'Return Result',
        position: { x: 1120, y: 0 },
        config: {
          kind: 'response',
          statusCode: 200,
          content: {
            blueprint: spec.slug,
            decision: '<decide>',
            quality: '<quality>',
          },
        },
      },
    ],
    edges: [
      { id: 'trigger-retrieve', source: 'trigger', target: 'retrieve' },
      { id: 'retrieve-decide', source: 'retrieve', target: 'decide' },
      { id: 'decide-quality', source: 'decide', target: 'quality' },
      { id: 'quality-respond', source: 'quality', target: 'respond' },
    ],
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}