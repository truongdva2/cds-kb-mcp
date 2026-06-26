#!/usr/bin/env node
// enrich_index.mjs — Extract @EndUserText.label from CDS view DDL source
// and rebuild search_index.json with enriched semanticDescription + improved description.
//
// Usage: node enrich_index.mjs <path-to-cds-kb-data>
//
// This reads all view .md files, extracts the label annotation from DDL source,
// and updates the search index with better searchable descriptions.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dataRoot = process.argv[2];
if (!dataRoot) {
  console.error('Usage: node enrich_index.mjs <path-to-cds-kb-data>');
  process.exit(1);
}

const viewsDir = path.join(dataRoot, 'views');
const indexFile = path.join(dataRoot, 'index', 'search_index.json');

// ── Read current index & taxonomy ─────────────────────────────────────────
console.log('Reading current index and taxonomy...');
const indexData = JSON.parse(await fs.readFile(indexFile, 'utf-8'));
const ms = JSON.parse(indexData.minisearch);
const storedFields = ms.storedFields;

let taxonomy = null;
try {
  taxonomy = JSON.parse(await fs.readFile(path.join(dataRoot, 'index', 'taxonomy.json'), 'utf-8'));
  console.log('Loaded taxonomy with', Object.keys(taxonomy.tagToKeywords).length, 'tags mapped to keywords.');
} catch (e) {
  console.log('No taxonomy.json found, skipping synonym enrichment.');
}

// ── Extract @EndUserText.label from DDL source in each view file ──────────
console.log('Scanning view files for @EndUserText.label...');
const viewFiles = (await fs.readdir(viewsDir)).filter((f) => f.endsWith('.md'));

let enriched = 0;
let improved = 0;
const labelMap = new Map(); // VIEW_NAME -> label

for (const file of viewFiles) {
  const content = await fs.readFile(path.join(viewsDir, file), 'utf-8');
  const viewName = file.replace(/\.md$/i, '');

  // Extract @EndUserText.label from DDL source code section
  const match = content.match(/@EndUserText\.label\s*:\s*'([^']+)'/);
  if (match) {
    labelMap.set(viewName, match[1].trim());
  }
}

console.log(`Found @EndUserText.label in ${labelMap.size}/${viewFiles.length} views.`);

// ── Update stored fields with enriched data ───────────────────────────────
for (const [docId, doc] of Object.entries(storedFields)) {
  const name = doc.name;
  const label = labelMap.get(name);
  if (label) {
    // Set semanticDescription to the human-readable label
    doc.semanticDescription = label;

    // Also improve description if current one is just name-derived garbage
    const currentDesc = doc.description || '';
    if (currentDesc.length < 40 || !currentDesc.includes(' ')) {
      doc.description = label;
      improved++;
    }

    enriched++;
  }
}

console.log(`Enriched: ${enriched} views with semanticDescription.`);
console.log(`Improved: ${improved} views with better description.`);

// ── Now rebuild the MiniSearch index with enriched field data ──────────────
// We need to rebuild the inverted index too, because the searchable fields changed.
// Import MiniSearch to rebuild from scratch.
const MiniSearch = (await import('minisearch')).default;

const options = indexData.options;
// Ensure 'synonyms' is a searchable and stored field
if (!options.fields.includes('synonyms')) {
  options.fields.push('synonyms');
}
if (!options.storeFields.includes('synonyms')) {
  options.storeFields.push('synonyms');
}

const allDocs = Object.values(storedFields).map((doc, idx) => ({
  id: idx,
  ...doc,
  // Concatenate tags for tagText field (tags are in the frontmatter of view files)
  tagText: doc.tagText || '',
}));

// We need tagText in the index but it's not in storedFields.
// Let's extract tags from view files for the top views.
console.log('Extracting tags from view files...');
const tagMap = new Map();
for (const file of viewFiles) {
  const content = await fs.readFile(path.join(viewsDir, file), 'utf-8');
  const viewName = file.replace(/\.md$/i, '');

  // Parse YAML frontmatter tags
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const tagsMatch = fmMatch[1].match(/tags:\n((?:\s+-\s+.*\n?)*)/);
    if (tagsMatch) {
      const tags = tagsMatch[1]
        .split('\n')
        .map((l) => l.replace(/^\s+-\s+/, '').trim())
        .filter(Boolean);
      tagMap.set(viewName, tags.join(' '));
    }
  }
}

// Build fresh MiniSearch index
console.log('Rebuilding MiniSearch index...');
const mini = new MiniSearch(options);
const docs = [];
for (const [docId, doc] of Object.entries(storedFields)) {
  docs.push({
    id: parseInt(docId),
    name: doc.name,
    semanticDescription: doc.semanticDescription || '',
    description: doc.description || '',
    tagText: tagMap.get(doc.name) || '',
    appComponent: doc.appComponent || '',
    synonyms: '', // Will populate below
    // storeFields
    path: doc.path,
    module: doc.module,
    lob: doc.lob,
    bo: doc.bo,
  });
}

// Populate synonyms from taxonomy
if (taxonomy && taxonomy.tagToKeywords) {
  let synCount = 0;
  for (const doc of docs) {
    const keywords = [];
    if (doc.lob && taxonomy.tagToKeywords[`lob:${doc.lob.toLowerCase()}`]) {
      keywords.push(...taxonomy.tagToKeywords[`lob:${doc.lob.toLowerCase()}`]);
    }
    if (doc.bo && taxonomy.tagToKeywords[`bo:${doc.bo.toLowerCase()}`]) {
      keywords.push(...taxonomy.tagToKeywords[`bo:${doc.bo.toLowerCase()}`]);
    }
    if (keywords.length > 0) {
      doc.synonyms = [...new Set(keywords)].join(' ');
      synCount++;
    }
  }
  console.log(`Enriched ${synCount} views with taxonomy synonyms.`);
}

mini.addAll(docs);

// ── Write enriched index ──────────────────────────────────────────────────
const output = {
  schemaVersion: indexData.schemaVersion,
  builtAt: new Date().toISOString(),
  viewCount: docs.length,
  enrichedCount: enriched,
  options: indexData.options,
  minisearch: JSON.stringify(mini),
};

// Backup original
const backupFile = indexFile + '.bak';
try { await fs.copyFile(indexFile, backupFile); } catch { /* no backup needed */ }

await fs.writeFile(indexFile, JSON.stringify(output), 'utf-8');

const sizeKB = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(0);
console.log(`\nDone! Wrote enriched index: ${indexFile} (${sizeKB} KB)`);
console.log(`  viewCount: ${docs.length}`);
console.log(`  enrichedCount: ${enriched}`);
console.log(`  Backup: ${backupFile}`);

// ── Write version manifest ────────────────────────────────────────────────
// Small file (~200 B) that MCP clients fetch on every startup — bypasses TTL.
// If `commit` differs from what the client cached last, it knows to invalidate.
//
// Sources for `commit`:
//   1. $GITHUB_SHA (set by GitHub Actions)
//   2. `git -C <dataRoot> rev-parse HEAD` (when run locally in a checkout)
//   3. fallback to the builtAt timestamp string (still monotonic, still works)
function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync(`git -C "${dataRoot}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
  } catch {
    return `builtAt:${output.builtAt}`;
  }
}

const versionFile = path.join(dataRoot, 'index', 'version.json');
const versionManifest = {
  schemaVersion: output.schemaVersion ?? 1,
  commit: resolveCommit(),
  builtAt: output.builtAt,
  viewCount: output.viewCount,
  enrichedCount: output.enrichedCount,
};
await fs.writeFile(versionFile, JSON.stringify(versionManifest, null, 2) + '\n', 'utf-8');
console.log(`  version manifest: ${versionFile} (commit=${versionManifest.commit.slice(0, 8)})`);
