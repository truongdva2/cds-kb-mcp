#!/usr/bin/env node
// cds-kb-mcp — a DATALESS MCP server for the SAP CDS knowledge base.
// Ships no view data. Points at either a local clone or a remote (public GitHub) data repo.
//
//   cds-kb-mcp --data   /path/to/cloned/cds-kb-data
//   cds-kb-mcp --remote https://raw.githubusercontent.com/<user>/cds-kb-data/main
//
// The index file is self-describing (carries its own MiniSearch options), so this server
// has zero schema coupling to how the data repo was built.

import MiniSearch from 'minisearch';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDataSource, SECTION_NAMES } from './datasource.mjs';

// ── Query-time ranking knobs (tunable independently of the index) ───────────
const SEARCH_OPTIONS = {
  boost: { name: 3, semanticDescription: 2.5, synonyms: 2, tagText: 1.5, description: 1, appComponent: 1 },
  prefix: true,
  fuzzy: 0.2,
};

// ── Module alias mapping (human-friendly → code) ────────────────────────────
// Allows AI agents to filter by natural names instead of requiring exact codes.
const MODULE_ALIASES = {
  finance: 'FI', financial: 'FI', accounting: 'FI',
  sales: 'SD', 'sales & distribution': 'SD', distribution: 'SD',
  procurement: 'MM', purchasing: 'MM', materials: 'MM', 'material management': 'MM',
  production: 'PP', manufacturing: 'PP', 'production planning': 'PP',
  controlling: 'CO', 'cost controlling': 'CO',
  'plant maintenance': 'PM', maintenance: 'PM',
  'quality management': 'QM', quality: 'QM',
  logistics: 'LE', 'logistics execution': 'LE',
  warehouse: 'LE', 'warehouse management': 'LE',
  'project management': 'PPM', project: 'PPM',
  'real estate': 'RE', realestate: 'RE',
  'supply chain': 'SCM', scm: 'SCM',
  'transportation management': 'TM', transportation: 'TM', transport: 'TM',
  crm: 'CRM', 'customer relationship': 'CRM',
  basis: 'BC', 'basis components': 'BC',
  'cross application': 'CA', cross: 'CA',
  sustainability: 'SUS',
  plm: 'PLM', 'product lifecycle': 'PLM',
  'environment health safety': 'EHS', ehs: 'EHS',
};

function resolveModule(input) {
  if (!input) return undefined;
  const lower = input.toLowerCase().trim();
  return MODULE_ALIASES[lower] || input.toUpperCase();
}

// ── State ───────────────────────────────────────────────────────────────────
const ds = resolveDataSource();
let mini;
let meta = {};
let moduleStats = {};  // { module: { count, lob } }
let taxonomyData = null;

async function loadIndex() {
  const w = await ds.loadIndexWrapper();
  if (!w || !w.minisearch || !w.options) {
    throw new Error('Index file is not in the expected self-describing format. Rebuild it in the data repo.');
  }
  mini = MiniSearch.loadJSON(w.minisearch, w.options);
  meta = { viewCount: w.viewCount, enrichedCount: w.enrichedCount, builtAt: w.builtAt };

  // Version manifest is best-effort — older data repos don't ship one.
  try {
    const v = await ds.getVersion?.();
    if (v) meta.commit = v.commit;
  } catch { /* ignore */ }

  // Build module stats by iterating stored fields directly (MiniSearch has no public allDocs API).
  const ms = JSON.parse(w.minisearch);
  const stored = ms.storedFields || {};
  const stats = {};
  for (const doc of Object.values(stored)) {
    const mod = doc.module || 'UNKNOWN';
    if (!stats[mod]) stats[mod] = { count: 0, lob: doc.lob || '', bos: new Set() };
    stats[mod].count++;
    if (doc.bo) stats[mod].bos.add(doc.bo);
  }
  // Convert sets to arrays for serialization
  for (const v of Object.values(stats)) {
    v.bos = [...v.bos].sort();
  }
  moduleStats = stats;

  taxonomyData = await ds.getTaxonomy();
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'cds-knowledge-base', version: '1.2.0' });

// ── Tool 1: search_cds ─────────────────────────────────────────────────────
server.registerTool(
  'search_cds',
  {
    title: 'Search SAP CDS views',
    description:
      'Search SAP S/4HANA released CDS views by business meaning / name / tags. ' +
      'Returns a ranked shortlist (name + path + description). ' +
      'Use this INSTEAD of grepping or reading routers, then call get_cds_view to read one. ' +
      'Optionally filter by module (FI, SD, MM... or natural names like "Finance", "Procurement"), lob, or bo.',
    inputSchema: {
      query: z.string().describe('Natural-language or keyword query, e.g. "overdue customer invoices"'),
      module: z.string().optional().describe('Module filter — code (FI, SD, MM) or name ("Finance", "Procurement")'),
      lob: z.string().optional().describe('Line-of-business filter, e.g. "Finance" (partial match)'),
      bo: z.string().optional().describe('Business object filter, e.g. "salesorder" (partial match)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
  },
  async ({ query, module, lob, bo, limit = 10 }) => {
    const resolvedModule = resolveModule(module);
    const contains = (a, b) => (a || '').toLowerCase().includes((b || '').toLowerCase());
    const facetFilter = (r) =>
      (!resolvedModule || (r.module || '').toUpperCase() === resolvedModule) &&
      (!lob || contains(r.lob, lob)) &&
      (!bo || contains(r.bo, bo));

    const results = mini.search(query, { ...SEARCH_OPTIONS, filter: facetFilter }).slice(0, limit);
    if (results.length === 0) {
      const hint = resolvedModule ? ` (module=${resolvedModule})` : '';
      return { content: [{ type: 'text', text: `No CDS views matched "${query}"${hint}. Try broader terms or remove filters.` }] };
    }
    const lines = results.map((r, i) => {
      const desc = r.semanticDescription || r.description || '';
      return `${i + 1}. **${r.name}**  [${r.appComponent || r.module || '-'}]  (score ${r.score.toFixed(1)})\n   ${desc}\n   path: ${r.path}`;
    });
    return {
      content: [{ type: 'text', text: `Top ${results.length} CDS views for "${query}":\n\n${lines.join('\n')}\n\nUse get_cds_view(name) to read the full definition, or get_cds_view(name, sections) for specific parts.` }],
    };
  },
);

// ── Tool 2: get_cds_view ────────────────────────────────────────────────────
server.registerTool(
  'get_cds_view',
  {
    title: 'Get a CDS view definition',
    description:
      'Return markdown of one CDS view by its exact name. ' +
      'By default returns ALL sections. Use the sections parameter to retrieve only what you need ' +
      '(saves tokens for large views). Available sections: metadata, fields, associations, source.',
    inputSchema: {
      name: z.string().describe('Exact view name, e.g. I_SalesDocument (case-insensitive)'),
      sections: z.array(z.enum(['metadata', 'fields', 'associations', 'source']))
        .optional()
        .describe('Which sections to return. Omit for all. Options: metadata, fields, associations, source'),
    },
  },
  async ({ name, sections }) => {
    try {
      const text = sections && sections.length > 0
        ? await ds.getViewSections(name, sections)
        : await ds.getView(name);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      // Distinguish "view does not exist" from transport/cache failure so callers know whether to retry.
      const notFound = e?.code === 'ENOENT' || /404/.test(e?.message || '');
      const msg = notFound
        ? `View "${name}" not found. Use search_cds first to get the exact name.`
        : `Failed to fetch view "${name}": ${e?.message || 'unknown error'}. The data source may be temporarily unreachable.`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  },
);

// ── Tool 3: get_taxonomy ───────────────────────────────────────────────────
server.registerTool(
  'get_taxonomy',
  {
    title: 'Get knowledge base taxonomy',
    description:
      'Returns the semantic map of the knowledge base (Lines of Business -> Business Objects -> Keywords). ' +
      'Use this to understand how data is organized before searching, or to discover valid tags for get_views_by_tag. ' +
      'Provides rich keywords and synonyms that can help formulate better search queries.',
    inputSchema: {},
  },
  async () => {
    if (taxonomyData && taxonomyData.lobs && taxonomyData.bos) {
      const lobLines = taxonomyData.lobs.map(l => `- **${l.tag}** (${l.name}) — Keywords: ${l.keywords.join(', ')}`);
      // Take a sample of top 20 BOs to avoid token bloat, or maybe just list BO counts
      const boSample = taxonomyData.bos.slice(0, 30).map(b => `  - **${b.tag}** — Keywords: ${b.keywords.join(', ')}`);
      
      const text = `SAP CDS Knowledge Base Taxonomy\n\n` +
        `## Lines of Business (${taxonomyData.lobs.length})\n${lobLines.join('\n')}\n\n` +
        `## Business Objects (${taxonomyData.bos.length} total, sample of 30)\n${boSample.join('\n')}\n\n` +
        `Use get_views_by_tag(tag) to list all views for a specific tag (e.g. "bo:salesorder").`;
      return { content: [{ type: 'text', text }] };
    }

    // Fallback if taxonomy not available
    const sorted = Object.entries(moduleStats).sort((a, b) => b[1].count - a[1].count);
    const lines = sorted.map(([mod, info]) => {
      const boList = info.bos.length > 0 ? `  BOs: ${info.bos.join(', ')}` : '';
      return `- **${mod}** (${info.count} views) — ${info.lob}${boList}`;
    });
    return {
      content: [{ type: 'text', text: `SAP Modules (${sorted.length} modules, ${meta.viewCount} total views):\n\n${lines.join('\n')}` }],
    };
  },
);

// ── Tool 4: get_views_by_tag ───────────────────────────────────────────────
server.registerTool(
  'get_views_by_tag',
  {
    title: 'Get views by tag',
    description:
      'Retrieve a paginated list of all CDS views that possess a specific tag (e.g., "bo:salesorder" or "lob:finance"). ' +
      'This is a deterministic way to browse the knowledge base when search_cds is too broad. ' +
      'Use get_taxonomy to discover available tags.',
    inputSchema: {
      tag: z.string().describe('The exact tag to filter by, e.g. "bo:salesorder"'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
    },
  },
  async ({ tag, limit = 50 }) => {
    // Parse tag type and value
    const parts = tag.split(':');
    let filterFn = () => false;
    
    if (parts.length === 2) {
      const [type, value] = [parts[0].toLowerCase(), parts[1].toLowerCase()];
      if (type === 'lob') {
        filterFn = (r) => (r.lob || '').toLowerCase() === value;
      } else if (type === 'bo') {
        filterFn = (r) => (r.bo || '').toLowerCase() === value;
      } else {
        filterFn = (r) => (r.tagText || '').toLowerCase().includes(tag.toLowerCase());
      }
    } else {
      filterFn = (r) => (r.tagText || '').toLowerCase().includes(tag.toLowerCase());
    }

    // Use MiniSearch.wildcard to return all documents that pass the filter
    const results = mini.search(MiniSearch.wildcard, { filter: filterFn }).slice(0, limit);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No views found for tag "${tag}". Use get_taxonomy to find valid tags.` }] };
    }

    const lines = results.map((r, i) => {
      const desc = r.semanticDescription || r.description || '';
      return `${i + 1}. **${r.name}**\n   ${desc}\n   path: ${r.path}`;
    });

    return {
      content: [{ type: 'text', text: `Found ${results.length} CDS views for tag "${tag}":\n\n${lines.join('\n')}` }],
    };
  },
);

// ── Tool 5: kb_info ─────────────────────────────────────────────────────────
server.registerTool(
  'kb_info',
  {
    title: 'Knowledge base info',
    description: 'Report the active data source, view count, enrichment coverage, and index build time.',
    inputSchema: {},
  },
  async () => {
    const commit = meta.commit ? meta.commit.slice(0, 8) : '(no version manifest)';
    return {
      content: [{ type: 'text', text:
        `source: ${ds.describe()}\nviews: ${meta.viewCount ?? '?'}\nenriched: ${meta.enrichedCount ?? '?'}\nmodules: ${Object.keys(moduleStats).length}\nbuiltAt: ${meta.builtAt ?? '?'}\ncommit: ${commit}` }],
    };
  },
);

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await loadIndex();
  await server.connect(new StdioServerTransport());
  console.error(`[cds-kb-mcp] ready. ${ds.describe()} | views=${meta.viewCount} enriched=${meta.enrichedCount} modules=${Object.keys(moduleStats).length}`);
}

main().catch((e) => {
  console.error('[cds-kb-mcp] fatal:', e.message);
  process.exit(1);
});
