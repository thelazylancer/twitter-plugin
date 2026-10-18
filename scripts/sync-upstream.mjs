#!/usr/bin/env node
// Keep the upstream link alive on fresh clones. .git/config is not versioned,
// so the `upstream` remote disappears the moment the repo is cloned elsewhere.
// This script re-adds it, fetches, and reports what landed upstream since the
// last merge.
//
// Usage:
//   node scripts/sync-upstream.mjs          # check only
//   node scripts/sync-upstream.mjs --merge  # fetch, then merge into HEAD

import { execFileSync } from 'node:child_process';

const UPSTREAM_URL = 'https://github.com/Icy-Cat/x-viral-monitor.git';
const UPSTREAM_NAME = 'upstream';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function gitQuiet(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function ensureUpstreamRemote() {
  const existing = gitQuiet(['remote', 'get-url', UPSTREAM_NAME]);
  if (existing === UPSTREAM_URL) {
    console.log(`[upstream] remote already configured: ${UPSTREAM_URL}`);
    return;
  }
  if (existing) {
    console.log(`[upstream] updating remote url: ${existing} -> ${UPSTREAM_URL}`);
    git(['remote', 'set-url', UPSTREAM_NAME, UPSTREAM_URL]);
    return;
  }
  console.log(`[upstream] adding remote: ${UPSTREAM_URL}`);
  git(['remote', 'add', UPSTREAM_NAME, UPSTREAM_URL]);
}

function main() {
  const merge = process.argv.includes('--merge');

  ensureUpstreamRemote();

  console.log(`[upstream] fetching ${UPSTREAM_NAME}...`);
  git(['fetch', UPSTREAM_NAME, '--prune']);

  const upstreamRef = `${UPSTREAM_NAME}/main`;
  const mergeBase = gitQuiet(['merge-base', 'HEAD', upstreamRef]);
  if (!mergeBase) {
    console.error(`[upstream] no common ancestor with ${upstreamRef}.`);
    process.exit(1);
  }

  const incoming = gitQuiet(['log', '--oneline', `HEAD..${upstreamRef}`]);
  const local = gitQuiet(['log', '--oneline', `${upstreamRef}..HEAD`]);

  console.log(`\n[upstream] fork point: ${mergeBase.slice(0, 7)} ${git(['log', '-1', '--format=%s', mergeBase])}`);
  console.log(`[upstream] local-only commits: ${local ? local.split('\n').length : 0}`);

  if (!incoming) {
    console.log('[upstream] up to date — nothing new upstream.');
    return;
  }

  const count = incoming.split('\n').length;
  console.log(`[upstream] ${count} new upstream commit(s):\n`);
  console.log(incoming.split('\n').map((l) => `  ${l}`).join('\n'));

  if (!merge) {
    console.log('\n[upstream] dry run. Re-run with --merge to merge into the current branch.');
    console.log(`[upstream] merge conflicts are likely in: manifest.json, _locales/, background.js, lib/grok-reply.js, content.js, bridge.js, src/premium/`);
    return;
  }

  console.log(`\n[upstream] merging ${upstreamRef} into ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}...`);
  try {
    git(['merge', upstreamRef, '--no-edit'], { stdio: 'inherit' });
  } catch {
    console.error('\n[upstream] merge stopped. Resolve conflicts, then run:');
    console.error('  node ./node_modules/vitest/vitest.mjs run');
    console.error('  npm run build:dist');
    process.exit(1);
  }

  console.log('\n[upstream] merge done. Now verify:');
  console.log('  node ./node_modules/vitest/vitest.mjs run');
  console.log('  npm run build:dist');
}

main();
