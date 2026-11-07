#!/usr/bin/env node
// Build-time generator: the single authoritative AI-defaults dataset lives in
// src/ai-defaults.data.json. This script inlines that same data into the four
// consumer files, each inside a // --- ai-defaults:generated:start/end --- block.
//
// Why inline blocks instead of a runtime global:
//   * popup.js runs in the extension page realm, bridge.js in the ISOLATED
//     content-script world, content.js in the MAIN world, and background.js in
//     its own service-worker realm. They do not share a window/globalThis.
//   * popup.html's <script src> list is pinned by tests to exactly 10 entries,
//     so a shared <script> cannot be added there.
//   * background.js is loaded whole into a bare vm (tests/ai-background-parser)
//     with no extra globals, so it must keep a pure self-contained literal.
//
// The generated region is a JS object literal (single-quoted strings, bare
// identifier keys), NOT JSON.stringify output: several tests text-scan the
// source for `id: 'short-cn', name: '中文短评'` and for single-quoted
// DEFAULT_GROK_COMMENT_PROMPT, and the baseline test evaluates these constant
// declarations with node:vm. Runtime newlines (U+000A) are re-escaped to the
// two-character source sequence \n so the generated prompt is byte-identical
// to the original.
//
// Usage: node scripts/sync-ai-defaults.mjs
// Idempotent: running twice produces byte-identical files.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = resolve(root, 'src/ai-defaults.data.json');
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));

const START = '// --- ai-defaults:generated:start ---';
const END = '// --- ai-defaults:generated:end ---';

// --- JS literal serializer -------------------------------------------------
// Emits a classic-script-compatible object literal: bare identifier keys,
// single-quoted strings, escaped backslash/quote/control characters.
function quoteString(value) {
  let out = "'";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    switch (code) {
      case 0x5c: out += '\\\\'; break;
      case 0x27: out += "\\'"; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0b: out += '\\v'; break;
      case 0x00: out += '\\0'; break;
      // U+2028 / U+2029 are JS line terminators; escape so generated source
      // stays valid however these strings are later embedded.
      case 0x2028: out += '\\u2028'; break;
      case 0x2029: out += '\\u2029'; break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
    }
  }
  return `${out}'`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function key(name) {
  return IDENT.test(name) ? name : quoteString(name);
}

// `refs` lets content.js keep the bare DEFAULT_GROK_COMMENT_PROMPT identifier
// for the first template instead of expanding it (matches the shipped source
// and the baseline test's `prelude` evaluation).
function resolveRef(value, refs) {
  if (refs && typeof value === 'string' && Object.hasOwn(refs, value)) return refs[value];
  return null;
}

function isLeaf(value) {
  if (Array.isArray(value)) return value.every((v) => v === null || typeof v !== 'object');
  if (value && typeof value === 'object') {
    return Object.values(value).every((v) => v === null || typeof v !== 'object');
  }
  return true;
}

// Pretty JS literal: containers are multi-line (2-space indent), but "leaf"
// objects/arrays (all primitive members) are rendered inline on one line. This
// keeps the generated source readable while preserving the contiguous text
// `id: 'short-cn', name: '中文短评'` that several tests scan for.
function literal(value, refs = null, indent = 0) {
  const ref = resolveRef(value, refs);
  if (ref) return ref;
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const pad = ' '.repeat(indent);
  const innerPad = ' '.repeat(indent + 2);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isLeaf(value)) {
      return `[${value.map((v) => literal(v, refs, 0)).join(', ')}]`;
    }
    const items = value.map((v) => `${innerPad}${literal(v, refs, indent + 2)},`);
    return `[\n${items.join('\n')}\n${pad}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (isLeaf(value)) {
      return `{ ${entries.map(([k, v]) => `${key(k)}: ${literal(v, refs, 0)}`).join(', ')} }`;
    }
    const lines = entries.map(([k, v]) => `${innerPad}${key(k)}: ${literal(v, refs, indent + 2)},`);
    return `{\n${lines.join('\n')}\n${pad}}`;
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

// --- data -> declaration blocks -------------------------------------------
const { templates, platforms, defaultCommentPrompt } = data;
if (defaultCommentPrompt !== templates.zh_CN[0].prompt) {
  throw new Error('defaultCommentPrompt must equal templates.zh_CN[0].prompt');
}

// content.js: the first template keeps referencing the string constant.
const contentRefs = { [defaultCommentPrompt]: 'DEFAULT_GROK_COMMENT_PROMPT' };
const contentBlock = [
  `const DEFAULT_GROK_COMMENT_PROMPT = ${quoteString(defaultCommentPrompt)};`,
  `const DEFAULT_GROK_PROMPT_TEMPLATES = ${literal(templates.zh_CN, contentRefs)};`,
].join('\n');

// popup.js / bridge.js: { zh_CN: { promptTemplates: [...] }, en: {...}, ja: {...} }
const grokDefaults = Object.fromEntries(
  Object.entries(templates).map(([lang, list]) => [lang, { promptTemplates: list }]),
);
const grokBlock = `const GROK_DEFAULTS_BY_LANGUAGE = ${literal(grokDefaults)};`;
const presetsBlock = `const AI_PLATFORM_PRESETS = ${literal(platforms)};`;
const bgPresetsBlock = `const OPENAI_COMPAT_PLATFORMS = ${literal(platforms)};`;

// --- marker-region replacement --------------------------------------------
// Each entry: file + ordered list of declarations to place between its markers.
const TARGETS = [
  { file: 'content.js', blocks: [contentBlock] },
  { file: 'popup.js', blocks: [grokBlock, presetsBlock] },
  { file: 'bridge.js', blocks: [grokBlock] },
  { file: 'background.js', blocks: [bgPresetsBlock] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRegions(src, blocks, filename) {
  const startRe = new RegExp(`^([ \\t]*)${escapeRegExp(START)}[ \\t]*$`, 'm');
  const endRe = new RegExp(`^([ \\t]*)${escapeRegExp(END)}[ \\t]*$`, 'm');
  let cursor = 0;
  let out = src;
  for (let idx = 0; idx < blocks.length; idx++) {
    const startMatch = startRe.exec(out.slice(cursor));
    if (!startMatch) {
      throw new Error(`[sync-ai-defaults] ${filename}: missing ${START} (region ${idx + 1})`);
    }
    const sAbs = cursor + startMatch.index;
    const sEndAbs = sAbs + startMatch[0].length;
    const indent = startMatch[1];
    const endMatch = endRe.exec(out.slice(sEndAbs));
    if (!endMatch) {
      throw new Error(`[sync-ai-defaults] ${filename}: missing ${END} (region ${idx + 1})`);
    }
    const eAbs = sEndAbs + endMatch.index;
    const eEndAbs = eAbs + endMatch[0].length;
    const body = blocks[idx].split('\n').map((line) => (line ? indent + line : line)).join('\n');
    const replacement = `${startMatch[0]}\n${body}\n${endMatch[0]}`;
    out = out.slice(0, sAbs) + replacement + out.slice(eEndAbs);
    cursor = sAbs + replacement.length;
  }
  return out;
}

let count = 0;
for (const { file, blocks } of TARGETS) {
  const path = resolve(root, file);
  const src = readFileSync(path, 'utf8');
  const next = replaceRegions(src, blocks, file);
  // Only write when bytes actually change (keeps mtime stable on re-runs).
  if (next !== src) {
    writeFileSync(path, next);
  }
  count += 1;
}

console.log(`[sync-ai-defaults] regenerated ${count} files`);
