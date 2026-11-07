#!/usr/bin/env node
// Zip the current channel build from ./dist into ./release for local use.
//
// Usage: node scripts/package-zip.mjs --channel store|community-dev [--target chrome|edge]
//
// This fork ships community-dev builds only through GitHub Releases; it has no
// Chrome Web Store or Edge listing and no License Worker. The `store` channel
// and the `--target edge` naming branch are kept solely for structural parity
// with upstream — their archives are byte-identical community/store builds and
// are never uploaded to a store.
//
// Both targets get the same archive; the target only names the file so two
// local builds cannot be confused on disk.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const releaseDir = resolve(root, 'release');
const CHANNELS = new Set(['store', 'community-dev']);
const TARGETS = new Set(['chrome', 'edge']);
// Keys a store rejects or that pin the extension to one listing.
const FORBIDDEN_MANIFEST_KEYS = ['key', 'update_url'];

function readChannel(argv) {
  const idx = argv.indexOf('--channel');
  const raw = idx >= 0 ? argv[idx + 1] : 'store';
  if (!CHANNELS.has(raw)) {
    throw new Error(`[package-zip] invalid --channel ${raw || '(missing)'}; expected store or community-dev`);
  }
  return raw;
}

function readTarget(argv) {
  const idx = argv.indexOf('--target');
  const raw = idx >= 0 ? argv[idx + 1] : 'chrome';
  if (!TARGETS.has(raw)) {
    throw new Error(`[package-zip] invalid --target ${raw || '(missing)'}; expected chrome or edge`);
  }
  return raw;
}

function zipName(channel, target) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  // `community-dev` is the only channel this fork actually ships. The two
  // store-side suffixes remain for upstream structural parity; nothing here
  // implies a store upload.
  const suffix = channel === 'community-dev'
    ? 'community-dev'
    : (target === 'edge' ? 'edge-addons' : 'chrome-web-store');
  return `x-viral-monitor-v${pkg.version}-${suffix}.zip`;
}

function checkManifest() {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  const found = FORBIDDEN_MANIFEST_KEYS.filter((k) => k in manifest);
  if (found.length) {
    throw new Error(`[package-zip] dist/manifest.json still has ${found.join(', ')} — a store build must not ship these`);
  }
  for (const [size, path] of Object.entries(manifest.icons || {})) {
    if (!existsSync(resolve(dist, path))) {
      throw new Error(`[package-zip] manifest icon ${size} points at missing ${path}`);
    }
  }
  return manifest;
}


// Upstream-parity guard, retained from the store-era script: it rejects an
// extension whose name/description says "Chrome" when --target edge is used.
// This fork never submits to Edge, but keeping the check costs nothing and
// prevents an accidentally mislabeled local archive.
function checkEdgeBranding(manifest) {
  const hits = [];
  const look = (where, text) => {
    if (typeof text === 'string' && /chrome/i.test(text)) hits.push(`${where}: ${text.slice(0, 80)}`);
  };
  look('manifest.name', manifest.name);
  look('manifest.description', manifest.description);
  const localesDir = resolve(dist, '_locales');
  if (existsSync(localesDir)) {
    for (const locale of readdirSync(localesDir)) {
      const file = resolve(localesDir, locale, 'messages.json');
      if (!existsSync(file)) continue;
      const msgs = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, val] of Object.entries(msgs)) {
        if (/^ext(Name|Desc|Description)$/i.test(key)) look(`_locales/${locale} ${key}`, val && val.message);
      }
    }
  }
  if (hits.length) {
    throw new Error(`[package-zip] Edge 认证不接受名称/描述里出现 "Chrome"，改掉这些再打包：\n  ${hits.join('\n  ')}`);
  }
}

function main() {
  const channel = readChannel(process.argv.slice(2));
  const target = readTarget(process.argv.slice(2));
  if (!existsSync(dist)) throw new Error('[package-zip] dist/ missing; run build first');
  const manifest = checkManifest();
  if (target === 'edge') checkEdgeBranding(manifest);
  mkdirSync(releaseDir, { recursive: true });
  const out = resolve(releaseDir, zipName(channel, target));
  if (existsSync(out)) rmSync(out, { force: true });

  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop";',
      `$items = Get-ChildItem -LiteralPath '${dist.replaceAll("'", "''")}';`,
      `Compress-Archive -Path $items.FullName -DestinationPath '${out.replaceAll("'", "''")}' -CompressionLevel Optimal`,
    ].join(' ');
    execFileSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
  } else {
    // Finder litter and editor backups are upload warnings at best and a
    // rejected review at worst.
    execFileSync('zip', ['-r', out, '.', '-x', '.DS_Store', '*/.DS_Store', '*.map', '__MACOSX/*'], {
      cwd: dist,
      stdio: 'inherit',
    });
  }
  console.log(`\n[package-zip] wrote ${out}`);
  if (target === 'edge') {
    console.log('[package-zip] `--target edge` only names the archive for upstream parity; this fork has no Edge listing or License Worker.');
  }
}

main();
