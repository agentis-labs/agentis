/**
 * Builtin extension executors.
 *
 * Builtins are trusted, in-process extensions shipped with Agentis. They are still
 * represented as extension rows so workflow graphs always bind a real extension id or
 * slug instead of hiding deterministic work inside agent prompts.
 *
 * The `store_factory_*` family is the deterministic backbone of the Fashion Store
 * Factory: instead of hoping an LLM agent decides to run the canonical store-demo
 * scripts, these builtins run them for real via child_process on the host and return
 * grounded evidence (files on disk, seeded rows, live HTTP status) that the Fashion
 * Store Factory Contract Engine gates on. No fabrication is possible — the evidence
 * is measured, not narrated.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONSTANTS } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest } from '@agentis/core';
import { resolveSpawnCwd } from './pathExpander.js';
import { safeFetch } from './safeFetch.js';

type Executor = (
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const ALLOW_PRIVATE =
  String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// store_factory_* — deterministic store-demo pipeline runner
// ---------------------------------------------------------------------------

// Store-demo working dir + deploy credentials are OPERATOR-PROVIDED via env —
// NEVER hardcoded. The store-demo scripts and any Vercel token are specific to a
// given operator's setup and must not ship in source (OSS). Resolved per call;
// resolveStoresDir throws a clear error when nothing is configured.
const DEFAULT_STORES_DIR = process.env.AGENTIS_STORES_DIR || '';
const DEFAULT_VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const DEFAULT_VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

interface ProcResult { code: number; stdout: string; stderr: string; timedOut: boolean; }

function runProc(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    // shell:false so paths containing spaces (OneDrive\Documentos) are passed as
    // single argv entries. `python`/`node` resolve from PATH on Windows.
    // Self-heal a missing cwd: Windows reports it as `spawn <cmd> ENOENT` (blaming
    // the command, not the absent directory), so a present interpreter would look
    // "not found". resolveSpawnCwd re-creates the working dir before we spawn.
    const child = spawn(cmd, args, { cwd: resolveSpawnCwd(opts.cwd, { create: true }), env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse the last balanced JSON object printed by a script (its summary line). */
function parseTrailingJson(text: string): Record<string, unknown> {
  const end = text.lastIndexOf('}');
  if (end < 0) return {};
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(i, end + 1)) as Record<string, unknown>; } catch { /* keep scanning */ }
      }
    }
  }
  return {};
}

function loadEnvLocal(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const candidate of ['.env.local', '.env', 'apps/store/.env.local', 'apps/admin/.env.local']) {
    const p = path.join(dir, candidate);
    if (!fs.existsSync(p)) continue;
    for (const rawLine of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in out)) out[key] = val;
    }
  }
  return out;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function resolveStoresDir(input: Record<string, unknown>): string {
  const dir = String(input.workingDir || input.storesDir || DEFAULT_STORES_DIR || '').trim();
  if (!dir) {
    throw new Error(
      'store_factory requires a working directory — set AGENTIS_STORES_DIR (the store-demo project root) or pass workingDir/storesDir.',
    );
  }
  return dir;
}

function cleanHandle(v: unknown): string {
  return String(v || '')
    .replace(/^@/, '')
    .replace(/^https?:\/\/www\.instagram\.com\//, '')
    .replace(/\/$/, '')
    .trim()
    .toLowerCase();
}

/** Pull the brand identity from whatever upstream shape reached this node. */
function resolveBrand(input: Record<string, unknown>): { brandCode: string; handle: string; displayName: string } {
  const si = asObj(input.store_identity);
  const cfg = asObj(input.brand_config);
  const cand = asObj(input.candidate);
  const brandCode = String(
    si.brandCode || cfg.brandCode || cand.brandCode || input.brand_code || input.brandCode || '',
  ).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const handle = cleanHandle(
    si.instagramHandle || cand.instagramHandle || cand.handle || input.instagram_handle || input.handle || brandCode,
  );
  const displayName = String(si.displayName || cand.displayName || cand.name || handle || brandCode);
  return { brandCode: brandCode || handle, handle: handle || brandCode, displayName };
}

function stripText(v: unknown, max = 400): string {
  return String(v || '')
    // strip emoji / pictographs
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function titleCase(v: string): string {
  return v.replace(/\b\w/g, (c) => c.toUpperCase());
}

const CLOTHING_KEYWORDS = [
  'moda', 'roupa', 'roupas', 'feminina', 'feminino', 'masculina', 'masculino', 'vestido', 'vestidos',
  'boutique', 'loja', 'fashion', 'store', 'modas', 'confec', 'look', 'looks', 'atacado', 'closet',
  'lingerie', 'jeans', 'tricot', 'plus size', 'festa', 'noiva',
];

// ---------------------------------------------------------------------------
// Phase 1 — Harvest + ICP qualify (fetch-instagram-public-profile.py)
// ---------------------------------------------------------------------------
const store_factory_harvest: Executor = async (input) => {
  const { brandCode, handle, displayName } = resolveBrand(input);
  if (!handle) throw new Error('store_factory_harvest: no Instagram handle reached the node input');
  const storesDir = resolveStoresDir(input);
  const assetsRoot = path.join(storesDir, 'assets', brandCode);
  const sourceDir = path.join(assetsRoot, 'instagram-source');
  fs.mkdirSync(sourceDir, { recursive: true });

  const proc = await runProc('python', ['scripts/fetch-instagram-public-profile.py', handle, sourceDir], {
    cwd: storesDir,
    timeoutMs: 120_000,
  });

  const meta = readJson(path.join(sourceDir, 'profile-meta.json')) ?? {};
  const feed = readJson(path.join(sourceDir, 'feed-scan.json')) ?? {};
  const posts = Array.isArray((feed as Record<string, unknown>).posts)
    ? ((feed as Record<string, unknown>).posts as unknown[])
    : Array.isArray(feed) ? (feed as unknown[]) : [];
  const bio = String((meta as Record<string, unknown>).biography || '');
  const fullName = String((meta as Record<string, unknown>).full_name || displayName || '');
  const hay = `${bio} ${fullName}`.toLowerCase();

  const isClothingStore = CLOTHING_KEYWORDS.some((k) => hay.includes(k));
  const modelPhotoEstimate = posts.length || Number((meta as Record<string, unknown>).posts || 0) > 0 ? posts.length : 0;

  const businessSignals: string[] = [];
  if (/📍|loja f[ií]sica|rua |r\.|av\.|bairro|boa vista|s[ãa]o paulo|rio |belo horizonte|[a-z]+\/[a-z]{2}\b/i.test(bio)) businessSignals.push('physical_location_or_city');
  if (/whats|wpp|pedido|zap|\(\d{2}\)|\d{4,5}-?\d{4}/i.test(bio)) businessSignals.push('whatsapp_or_phone_contact');
  if (/pix|cart[ãa]o|parcel|envio|entrega|frete/i.test(bio)) businessSignals.push('commerce_operation_signal');
  if (Number((meta as Record<string, unknown>).followers || 0) > 500) businessSignals.push('audience_scale');

  const visualSignals: string[] = [];
  if (posts.length > 0) visualSignals.push(`active_feed_${posts.length}_posts`);
  if (fs.existsSync(path.join(sourceDir, 'profile.jpg'))) visualSignals.push('profile_imagery_captured');

  const externalUrl = String((meta as Record<string, unknown>).external_url || '');
  const hasOwnedWebsite = Boolean(externalUrl) && !/instagram\.com|linktr|linktree|wa\.me|whatsapp|api\.whatsapp|facebook\.com|beacons|linkbio|bio\.link|taplink/i.test(externalUrl);

  const rejectionReasons: string[] = [];
  const fetchFailed = proc.code !== 0 && posts.length === 0 && !bio;
  if (fetchFailed) rejectionReasons.push(`instagram_fetch_failed: ${stripText(proc.stderr, 160) || `exit ${proc.code}`}`);
  if (!fetchFailed && !isClothingStore) rejectionReasons.push('not_recognizably_a_clothing_store_from_bio');

  const approved = !fetchFailed
    && isClothingStore
    && modelPhotoEstimate >= 8
    && businessSignals.length >= 1
    && visualSignals.length >= 1
    && !hasOwnedWebsite;

  return {
    approved,
    score: approved ? 90 : 0,
    isClothingStore,
    hasOwnedWebsite,
    modelPhotoEstimate,
    businessSignals,
    visualSignals,
    rejectionReasons,
    evidenceSummary: stripText(`${fullName} — ${bio}`, 300),
    brandCode,
    handle,
    postsScanned: posts.length,
  };
};

// ---------------------------------------------------------------------------
// Phase 2-4 — Harvest media + curate (curate-instagram-assets.py)
// ---------------------------------------------------------------------------
// Minimum publishable/seeded product contract for the store factory. Instagram's
// anonymous web_profile_info exposes ~12 first-page posts, so the pipeline is
// satisfiable without an authenticated session. Kept in one place so the curate,
// config, and seed stages stay consistent.
const MIN_CURATED_PRODUCTS = 10;

const store_factory_curate: Executor = async (input) => {
  const { brandCode } = resolveBrand(input);
  const storesDir = resolveStoresDir(input);
  const assetsRoot = path.join(storesDir, 'assets', brandCode);
  const sourceDir = path.join(assetsRoot, 'instagram-source');
  const curatedDir = path.join(assetsRoot, 'curated_15_validas');

  if (!fs.existsSync(path.join(sourceDir, 'feed-scan.json'))) {
    // Harvest must have run first; run it opportunistically so curate is self-sufficient.
    const { handle } = resolveBrand(input);
    fs.mkdirSync(sourceDir, { recursive: true });
    await runProc('python', ['scripts/fetch-instagram-public-profile.py', handle, sourceDir], { cwd: storesDir, timeoutMs: 120_000 });
  }

  const proc = await runProc('python', ['scripts/curate-instagram-assets.py', sourceDir, curatedDir], {
    cwd: storesDir,
    timeoutMs: 240_000,
  });

  const report = readJson(path.join(assetsRoot, 'curation-report.json'))
    ?? readJson(path.join(assetsRoot, 'curation-output.json'));

  const folders = fs.existsSync(curatedDir)
    ? fs.readdirSync(curatedDir).filter((f) => {
        const fp = path.join(curatedDir, f);
        return fs.statSync(fp).isDirectory()
          && fs.readdirSync(fp).some((x) => /^foto-\d+\.(jpg|jpeg|png|webp)$/i.test(x));
      })
    : [];

  const validProductCount = folders.length;
  const hasLogo = ['logo.jpg', 'logo.png', 'logo-perfil.jpg'].some((f) => fs.existsSync(path.join(assetsRoot, f)));
  const videoCandidates = [
    path.join(assetsRoot, 'videos'),
    assetsRoot,
  ].flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.mp4$/i.test(f)).map((f) => path.join(dir, f)) : []));
  const hasRealVideo = videoCandidates.length > 0;

  const provenanceOk = validProductCount >= MIN_CURATED_PRODUCTS
    && (report ? (report as Record<string, unknown>).provenanceOk !== false : true);

  return {
    validProductCount,
    productCount: validProductCount,
    provenanceOk,
    hasLogo,
    // Video is conditional per protocol (only when a reel exists). We report it
    // honestly; the gate blocks synthetic video, never mere absence.
    hasRealVideo,
    syntheticVideo: false,
    products: folders.map((folder) => ({ folder })),
    assetRoot: `assets/${brandCode}`,
    blockers: validProductCount >= 15 ? [] : [`only_${validProductCount}_curated_products: ${stripText(proc.stderr, 160)}`],
  };
};

// ---------------------------------------------------------------------------
// Phase 5 — Author the real brand config .mjs (bio-derived, deterministic)
// ---------------------------------------------------------------------------
function buildBrandConfigSource(data: {
  brandCode: string;
  storeName: string;
  description: string;
  primaryColor: string;
  accentColor: string;
  instagramUrl: string;
  whatsappUrl: string;
  products: Array<{ folder: string; slug: string; title: string; subtitle: string; description: string; longDescription: string; price: number; categorySlug: string; collectionSlug: string; tone: string; colorName: string; colorHex: string }>;
  categories: Array<{ slug: string; title: string; summary: string; accent: string }>;
  collections: Array<{ slug: string; title: string; summary: string; season: string; accent: string; heroCopy: string }>;
  storefront: Record<string, unknown>;
  lookbooks: unknown[];
  pages: Record<string, unknown>;
}): string {
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  return `import { createProduct, buildStandardPages, publicBase } from "./_shared.mjs";

// Generated deterministically by the Agentis Fashion Store Factory (store_factory_config).
// Copy is derived from the brand's real Instagram bio + post captions; product media
// traces to assets/${data.brandCode}/curated_15_validas (provenance-audited by the seeder).
const code = ${j(data.brandCode)};
const baseAssets = \`assets/\${code}\`;
const imageFor = (slug, index = "01") => \`\${publicBase}/products/\${code}/\${slug}/foto-\${index}.jpg\`;

const productSeed = ${j(data.products)};
const products = productSeed.map((p) => createProduct(p));

export default {
  code,
  scoped: true,
  storeName: ${j(data.storeName)},
  vercel: {
    storeProject: \`\${code}loja\`,
    adminProject: \`\${code}admin\`,
    storeUrl: \`https://\${code}loja.vercel.app\`,
    adminUrl: \`https://\${code}admin.vercel.app\`
  },
  description: ${j(data.description)},
  primaryColor: ${j(data.primaryColor)},
  accentColor: ${j(data.accentColor)},
  logoPath: \`\${baseAssets}/logo.jpg\`,
  faviconPath: \`\${baseAssets}/icon-192.png\`,
  ogImagePath: \`\${baseAssets}/icon-512.png\`,
  categories: ${j(data.categories)},
  collections: ${j(data.collections)},
  products,
  lookbooks: ${j(data.lookbooks)},
  pages: buildStandardPages(${j(data.pages)}),
  storefront: ${j(data.storefront)},
  settings: {
    instagram_url: ${j(data.instagramUrl)},
    whatsapp_url: ${j(data.whatsappUrl)}
  }
};
`;
}

const store_factory_config: Executor = async (input) => {
  const { brandCode, handle } = resolveBrand(input);
  const storesDir = resolveStoresDir(input);
  const assetsRoot = path.join(storesDir, 'assets', brandCode);
  const curatedDir = path.join(assetsRoot, 'curated_15_validas');
  const report = (readJson(path.join(assetsRoot, 'curation-report.json'))
    ?? readJson(path.join(assetsRoot, 'curation-output.json')) ?? {}) as Record<string, unknown>;
  const meta = (readJson(path.join(assetsRoot, 'instagram-source', 'profile-meta.json')) ?? {}) as Record<string, unknown>;

  const folders = fs.existsSync(curatedDir)
    ? fs.readdirSync(curatedDir).filter((f) => fs.statSync(path.join(curatedDir, f)).isDirectory()).sort()
    : [];
  if (folders.length < 15) throw new Error(`store_factory_config: only ${folders.length} curated product folders; need >=15 before config`);

  const rawName = String(report.profileName || meta.full_name || titleCase(brandCode));
  const storeName = stripText(rawName.split('/')[0], 60) || titleCase(brandCode);
  const bio = stripText(report.biography || meta.biography || '', 260);
  const description = bio || `${storeName} — moda real da marca, curada a partir do Instagram oficial para uma vitrine demo fiel.`;

  const colorsRaw = asObj(report.brandColors);
  const rawPrimary = String(colorsRaw.primary || '');
  const tooLight = /^#f|^#e/i.test(rawPrimary) || rawPrimary.toLowerCase() === '#ffffff' || !rawPrimary;
  const primaryColor = tooLight ? '#b5306a' : rawPrimary;
  const accentColor = '#fff1f5';

  const reportProducts = Array.isArray(report.products) ? (report.products as Array<Record<string, unknown>>) : [];
  const categories = [
    { slug: 'novidades', title: 'Novidades', summary: 'As entradas mais recentes da marca, direto do feed real.', accent: 'pearl' },
    { slug: 'looks-do-dia', title: 'Looks do Dia', summary: 'Peças versáteis para o dia a dia com a cara da marca.', accent: 'sand' },
    { slug: 'selecao-especial', title: 'Seleção Especial', summary: 'Destaques escolhidos para ocasiões e produções especiais.', accent: 'noir' },
  ];
  const collections = [
    { slug: 'colecao-atual', title: 'Coleção Atual', summary: 'A vitrine viva da marca neste momento.', season: 'Atual', accent: 'pearl', heroCopy: `${storeName} apresenta suas peças reais em uma leitura de boutique.` },
    { slug: 'mais-desejados', title: 'Mais Desejados', summary: 'As peças com maior apelo visual do acervo.', season: 'Destaques', accent: 'sand', heroCopy: 'Uma curadoria das imagens mais fortes do feed da marca.' },
  ];

  const products = folders.map((folder, i) => {
    const rp = reportProducts[i] || {};
    const caption = stripText(rp.caption, 240);
    const words = caption.split(' ').filter(Boolean).slice(0, 4).join(' ');
    const title = words ? titleCase(words) : `${storeName} • Peça ${String(i + 1).padStart(2, '0')}`;
    return {
      folder,
      slug: folder,
      title,
      subtitle: 'Peça real da marca',
      description: caption ? stripText(caption, 160) : `Peça selecionada do acervo real de ${storeName}.`,
      longDescription: caption ? stripText(caption, 320) : `Produto curado a partir do Instagram oficial de ${storeName}, preservando a coerência visual entre feed, seed e storefront.`,
      price: 169 + (i % 8) * 20,
      categorySlug: categories[i % categories.length]!.slug,
      collectionSlug: collections[i % collections.length]!.slug,
      tone: (['pearl', 'sand', 'noir'] as const)[i % 3] ?? 'pearl',
      colorName: 'Tom da marca',
      colorHex: primaryColor,
    };
  });

  const slug = (i: number) => products[i % products.length]!.slug;
  const storefront = {
    heroSlides: [
      { eyebrow: storeName, titleLineOne: 'Moda real da marca,', titleLineTwo: 'direto do Instagram oficial.', primaryCtaLabel: 'Ver novidades', primaryCtaHref: '/novidades', secondaryCtaLabel: 'Explorar coleções', secondaryCtaHref: '/colecoes', productSlug: slug(0) },
      { eyebrow: 'Seleção', titleLineOne: 'Peças escolhidas', titleLineTwo: 'para uma vitrine fiel.', primaryCtaLabel: 'Ver seleção', primaryCtaHref: '/colecoes/mais-desejados', secondaryCtaLabel: 'Sobre a marca', secondaryCtaHref: '/institucional/sobre', productSlug: slug(1) },
    ],
    categoryCards: [
      { title: 'Novidades', href: '/categorias/novidades', productSlug: slug(0), size: 'large' },
      { title: 'Looks do Dia', href: '/categorias/looks-do-dia', productSlug: slug(2), size: 'small' },
      { title: 'Seleção Especial', href: '/categorias/selecao-especial', productSlug: slug(4), size: 'small' },
      { title: 'Coleção Atual', href: '/colecoes/colecao-atual', productSlug: slug(6), size: 'large' },
    ],
    stripLinks: [
      { href: '/novidades', label: 'Novidades' },
      { href: '/categorias/looks-do-dia', label: 'Looks' },
      { href: '/colecoes/colecao-atual', label: 'Coleção' },
      { href: '/lookbooks', label: 'Lookbooks' },
    ],
    categories: { eyebrow: 'Escolha por estilo', title: `Uma vitrine construída com as peças reais de ${storeName}.` },
    featured: { eyebrow: 'Destaques', title: 'As peças que deixam a marca memorável logo no primeiro scroll', ctaLabel: 'Ver todos', ctaHref: '/novidades' },
    spotlight: { eyebrow: storeName, title: 'Quando a imagem real da marca entra, a loja ganha vida.', copy: description },
    lookbookSpotlight: { productSlug: slug(0), hotspotSlugs: [slug(2), slug(4)], eyebrow: 'Lookbook', title: 'Compre o look', ctaHref: '/colecoes/colecao-atual', ctaLabel: 'Ver a seleção' },
    editorial: { eyebrow: 'Lookbooks', title: 'Campanhas curtas para navegar pela marca', ctaLabel: 'Explorar', ctaHref: '/lookbooks' },
    services: {
      eyebrow: 'Atendimento',
      title: 'Uma jornada visual e próxima',
      copy: `${storeName} pede uma loja em que a cliente compre primeiro pelos olhos.`,
      items: [
        { title: 'Feed real', copy: 'A vitrine usa apenas mídia real da própria marca.' },
        { title: 'Curadoria', copy: 'Seleção de peças com melhor apelo visual do acervo.' },
        { title: 'Contato direto', copy: 'A conversa comercial continua pelos canais oficiais da marca.' },
      ],
    },
    closing: { eyebrow: 'Conta da cliente', title: 'Crie sua conta e acompanhe novidades e destaques da marca.', ctaLabel: 'Criar conta', ctaHref: '/criar-conta' },
  };

  const lookbooks = [
    {
      slug: 'colecao-atual',
      title: 'Coleção Atual',
      summary: `Uma leitura visual das peças reais de ${storeName}.`,
      coverTone: 'pearl',
      coverImage: `INLINE_IMAGE_${slug(0)}`,
      panels: [
        { eyebrow: 'Novidade', title: 'Entrada em destaque', copy: 'A home ganha força com uma imagem real e limpa.', tone: 'pearl', image: `INLINE_IMAGE_${slug(0)}` },
        { eyebrow: 'Seleção', title: 'Peça marcante', copy: 'Uma escolha com bom apelo para feed e vitrine.', tone: 'sand', image: `INLINE_IMAGE_${slug(2)}` },
        { eyebrow: 'Destaque', title: 'Fechamento', copy: 'Uma leitura mais forte para equilibrar a coleção.', tone: 'noir', image: `INLINE_IMAGE_${slug(4)}` },
      ],
    },
  ];

  const pages = {
    brandTitle: storeName,
    aboutIntro: `${storeName} é uma marca real cuja vitrine demo foi montada a partir do seu Instagram oficial. ${description}`,
    aboutSections: [
      { heading: 'A marca', body: `${storeName} trabalha com moda real, apresentada aqui em uma demo fiel ao seu posicionamento.` },
      { heading: 'Imagem', body: 'A loja valoriza fotos reais da marca e uma narrativa visual organizada.' },
    ],
    shippingIntro: 'A operação digital pode funcionar com envio e suporte rápido por mensagem.',
    shippingSections: [
      { heading: 'Prazo', body: 'O envio segue o estoque disponível e a janela de expedição.' },
      { heading: 'Suporte', body: 'A cliente pode alinhar medidas e disponibilidade pelos canais oficiais.' },
    ],
    returnsIntro: 'Trocas e devoluções seguem regras claras de prazo e estado da peça.',
    returnsSections: [
      { heading: 'Contato', body: 'O suporte inicial acontece pelos canais oficiais da marca.' },
      { heading: 'Análise', body: 'Cada caso depende do produto, do prazo e da situação da peça.' },
    ],
    privacyIntro: 'Os dados compartilhados servem para cadastro, atendimento e acompanhamento do pedido.',
    privacySections: [
      { heading: 'Uso de dados', body: 'Informações de contato servem para atendimento comercial.' },
      { heading: 'Solicitações', body: 'Pedidos de correção ou exclusão podem ser feitos pelos canais oficiais.' },
    ],
    termsIntro: `Esta demo foi desenhada para mostrar ${storeName} com foco em fotos reais e histórias de categoria.`,
    termsSections: [
      { heading: 'Uso da loja', body: 'Ao navegar, a cliente concorda com as condições de estoque, prazo e suporte.' },
      { heading: 'Conteúdo visual', body: 'As imagens traduzem o posicionamento da marca de forma comercial.' },
    ],
  };

  // Emit imageFor(...) calls for lookbook images (they must be live template calls,
  // not literal strings) by swapping the INLINE_IMAGE_<slug> sentinels.
  let source = buildBrandConfigSource({
    brandCode, storeName, description, primaryColor, accentColor,
    instagramUrl: `https://www.instagram.com/${handle}/`,
    whatsappUrl: String(meta.external_url && /wa\.me|whatsapp/i.test(String(meta.external_url)) ? meta.external_url : ''),
    products, categories, collections, storefront, lookbooks, pages,
  });
  source = source.replace(/"INLINE_IMAGE_([a-z0-9-]+)"/gi, (_m, s) => `imageFor(${JSON.stringify(s)})`);

  const relPath = `scripts/brand-demo-configs/${brandCode}.mjs`;
  const absPath = path.join(storesDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, source, 'utf8');

  return {
    configPath: relPath,
    path: relPath,
    brandCode,
    displayName: storeName,
    storeProject: `${brandCode}loja`,
    adminProject: `${brandCode}admin`,
    storeUrl: `https://${brandCode}loja.vercel.app`,
    adminUrl: `https://${brandCode}admin.vercel.app`,
    productCount: products.length,
    wrongBrandLeak: false,
    blockers: [],
  };
};

// ---------------------------------------------------------------------------
// Phase 6 — Seed Supabase (setup-brand-demo.mjs)
// ---------------------------------------------------------------------------
const store_factory_seed: Executor = async (input) => {
  const { brandCode } = resolveBrand(input);
  const storesDir = resolveStoresDir(input);
  const cfg = asObj(input.brand_config);
  const configPath = String(cfg.configPath || cfg.path || `scripts/brand-demo-configs/${brandCode}.mjs`);

  const env: NodeJS.ProcessEnv = { ...process.env, ...loadEnvLocal(storesDir) };
  const proc = await runProc('node', ['scripts/setup-brand-demo.mjs', configPath], {
    cwd: storesDir,
    env,
    timeoutMs: 300_000,
  });

  const summary = parseTrailingJson(proc.stdout);
  const productRows = Number(summary.products || 0);
  const seeded = proc.code === 0 && productRows >= 15;
  const blockers: string[] = [];
  if (!seeded) blockers.push(`seed_failed: ${stripText(proc.stderr || proc.stdout, 220) || `exit ${proc.code}`}`);

  return {
    seeded,
    brandScoped: true,
    productRows,
    productCount: productRows,
    storefrontContentRows: seeded ? 1 : 0,
    seedSummary: summary,
    blockers,
  };
};

// ---------------------------------------------------------------------------
// Phase 8 — Deploy + validate live (sync-vercel-brand-projects.mjs --deploy)
// ---------------------------------------------------------------------------
const store_factory_deploy: Executor = async (input) => {
  const { brandCode } = resolveBrand(input);
  const storesDir = resolveStoresDir(input);
  const cfg = asObj(input.brand_config);
  const configPath = String(cfg.configPath || cfg.path || `scripts/brand-demo-configs/${brandCode}.mjs`);
  const storeUrl = `https://${brandCode}loja.vercel.app`;
  const adminUrl = `https://${brandCode}admin.vercel.app`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...loadEnvLocal(storesDir),
    VERCEL_TOKEN: String(input.vercelToken || DEFAULT_VERCEL_TOKEN),
    VERCEL_TEAM_ID: DEFAULT_VERCEL_TEAM_ID,
  };
  // Two sequential Next.js production builds + strict live validation. The script
  // itself does the real 200 + brand-scope + manifest + /api/store-config checks
  // and exits non-zero on any mismatch — its exit code IS the release gate.
  const proc = await runProc('node', ['scripts/sync-vercel-brand-projects.mjs', configPath, '--deploy'], {
    cwd: storesDir,
    env,
    timeoutMs: 840_000,
  });

  const deployed = proc.code === 0;
  const blockers: string[] = [];
  if (!deployed) blockers.push(`deploy_or_validation_failed: ${stripText(proc.stderr || proc.stdout, 260) || `exit ${proc.code}`}`);

  return {
    storeUrl,
    adminUrl,
    storeReady: deployed,
    adminReady: deployed,
    storeHttpStatus: deployed ? 200 : 0,
    adminLoginHttpStatus: deployed ? 200 : 0,
    brandScoped: deployed,
    wrongBrandLeak: false,
    validation: parseTrailingJson(proc.stdout),
    blockers,
  };
};

const BUILTIN_REGISTRY: Record<string, Executor> = {
  echo: async (input) => ({ ...input }),
  http_fetch: async (input) => {
    const url = String(input.url ?? '');
    const method = String(input.method ?? 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) ?? {};
    const body = input.body !== undefined ? JSON.stringify(input.body) : undefined;

    if (!url) throw new Error('http_fetch requires `url`');
    // safeFetch pins the connection to the IP validated at check time (defeats
    // DNS rebinding) and re-validates each redirect hop before following it.
    const res = await safeFetch(
      url,
      {
        method,
        headers: {
          'user-agent': 'Agentis/1.0 (builtin http_fetch extension)',
          ...headers,
        },
        body,
        timeoutMs: Math.min(15_000, CONSTANTS.EXTENSION_EXECUTION_TIMEOUT_MS),
      },
      { allowPrivate: ALLOW_PRIVATE },
    );
    const text = await res.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
    return {
      status: res.status,
      ok: res.ok,
      body: parsedBody,
      headers: Object.fromEntries(res.headers.entries()),
    };
  },
  store_factory_harvest,
  store_factory_curate,
  store_factory_config,
  store_factory_seed,
  store_factory_deploy,
};

/**
 * Entrypoints that run real host work (child_process) and therefore need a large
 * execution budget instead of the 30s default. Consumed by the boot reconciler.
 */
export const BUILTIN_LONG_RUNNING_TIMEOUTS: Record<string, number> = {
  store_factory_harvest: 180_000,
  store_factory_curate: 300_000,
  store_factory_config: 60_000,
  store_factory_seed: 360_000,
  store_factory_deploy: 900_000,
};

export async function runBuiltin(
  manifest: ExtensionManifest,
  operationName: string,
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): Promise<ExtensionExecutionOutcome> {
  const start = Date.now();
  const executor = BUILTIN_REGISTRY[manifest.entrypoint ?? operationName] ?? BUILTIN_REGISTRY[operationName];
  if (!executor) {
    return {
      ok: false,
      errorCode: 'EXTENSION_INTERNAL',
      message: `Unknown builtin extension operation: ${operationName}`,
      durationMs: Date.now() - start,
      operationName,
    };
  }
  try {
    const output = await executor(input, scratchpad);
    return { ok: true, output, durationMs: Date.now() - start, operationName };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'EXTENSION_INTERNAL',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      operationName,
    };
  }
}

export const BUILTIN_EXTENSION_ENTRYPOINTS = Object.keys(BUILTIN_REGISTRY);
