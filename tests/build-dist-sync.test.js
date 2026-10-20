// Byte-level contract: every file dist/ ships must exactly match the
// source tree. Defends against the v1.7.0 ship-blocker bug class
// where `npm run build:dist` either silently skipped a file or copied
// a stale version, producing the 'UI renders the raw i18n key
// "contentLbHotOnly"' symptom because dist/bridge.js lagged behind
// source.
//
// dist/ is gitignored, so a fresh clone (and CI) never has one. The
// byte-comparison tests therefore only run when dist/ exists — run
// `npm run build:dist` first if you want them. The build-configuration
// tests below always run, because they read the scripts, not the output.
// Skipped tests are visible in vitest's output, so a missing dist/ is
// never silently mistaken for a verified build.

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const dist = resolve(repo, 'dist');
const distBuilt = existsSync(dist);
const buildScript = readFileSync(resolve(repo, 'scripts/build-dist.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'));
const releaseWorkflow = readFileSync(resolve(repo, '.github/workflows/release.yml'), 'utf8');
const GENERATED_DIST_FILES = new Set(['src/build-channel.js']);
const DIST_EXCLUDED_FILES = new Set(['src/premium/content-filter/rules.json']);

// Same canonical 11 items the build script ships. Read from the build
// script itself so adding a file to ITEMS automatically gets covered.
function readItems() {
  const m = buildScript.match(/ITEMS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function listFilesRec(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const st = statSync(root);
  if (st.isFile()) return [root];
  for (const name of readdirSync(root)) {
    out.push(...listFilesRec(join(root, name)));
  }
  return out;
}

describe('#45 build:dist byte-level sync (Codex P0 fix follow-up)', () => {
  it.skipIf(!distBuilt)('every ITEMS entry has matching byte content under dist/', () => {
    const items = readItems();
    expect(items.length, 'build-dist.mjs ITEMS must declare at least one entry').toBeGreaterThan(0);
    const stale = [];
    for (const item of items) {
      const srcPath = resolve(repo, item);
      const dstPath = resolve(dist, item);
      if (!existsSync(srcPath)) continue; // source removed; build skips
      if (!existsSync(dstPath)) {
        stale.push(`${item} (missing in dist/)`);
        continue;
      }
      const srcSt = statSync(srcPath);
      if (srcSt.isFile()) {
        const srcBuf = readFileSync(srcPath);
        const dstBuf = readFileSync(dstPath);
        if (Buffer.compare(srcBuf, dstBuf) !== 0) {
          stale.push(`${item} (content differs)`);
        }
        continue;
      }
      // Directory: walk every file under it and compare 1:1.
      const srcFiles = listFilesRec(srcPath);
      for (const sf of srcFiles) {
        const rel = relative(srcPath, sf);
        const itemRel = `${item}/${rel}`.replaceAll('\\', '/');
        if (GENERATED_DIST_FILES.has(itemRel)) continue;
        if (DIST_EXCLUDED_FILES.has(itemRel)) continue;
        const df = join(dstPath, rel);
        if (!existsSync(df)) { stale.push(`${item}/${rel} (missing in dist/)`); continue; }
        const srcBuf = readFileSync(sf);
        const dstBuf = readFileSync(df);
        if (Buffer.compare(srcBuf, dstBuf) !== 0) {
          stale.push(`${item}/${rel} (content differs)`);
        }
      }
    }
    expect(stale,
      `dist/ is out of sync with source. Run \`npm run build:dist\` to refresh.\nStale entries:\n${stale.map((s) => '  - ' + s).join('\n')}`
    ).toEqual([]);
  });

  it('build script supports explicit store and community-dev channels', () => {
    expect(buildScript).toContain("new Set(['store', 'community-dev'])");
    expect(buildScript).toContain("const channel = readChannel(process.argv.slice(2))");
    expect(buildScript).toContain("writeFileSync(resolve(dist, 'src/build-channel.js'), channelMarker(channel))");
    expect(buildScript).toContain("root.__xvmIsCommunityDevBuild = channel === 'community-dev'");
  });

  it.skipIf(!distBuilt)('dist build-channel marker declares an explicit supported channel', () => {
    const markerPath = resolve(dist, 'src/build-channel.js');
    expect(existsSync(markerPath), 'dist/src/build-channel.js must exist').toBe(true);
    const marker = readFileSync(markerPath, 'utf8');
    expect(marker).toMatch(/const channel = ['"](store|community-dev)['"]/);
    expect(marker).toContain("root.__xvmIsCommunityDevBuild = channel === 'community-dev'");
  });

  it('package scripts expose store and community release builds', () => {
    expect(packageJson.scripts['build:dist']).toContain('--channel store');
    expect(packageJson.scripts['build:store']).toContain('--channel store');
    expect(packageJson.scripts['build:community']).toContain('--channel community-dev');
    expect(packageJson.scripts['package:store']).toContain('--channel store');
    expect(packageJson.scripts['package:community']).toContain('--channel community-dev');
  });

  it('GitHub release uploads only the community-dev dist package', () => {
    expect(releaseWorkflow).toContain('npm run build:community');
    expect(releaseWorkflow).toContain('x-viral-monitor-${{ github.ref_name }}-community-dev.zip');
    expect(releaseWorkflow).toContain('Local Pro features are enabled by default');
    expect(releaseWorkflow).not.toContain('manifest.json content.js bridge.js');
  });
});
