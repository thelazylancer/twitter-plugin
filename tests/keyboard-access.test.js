// Rows in the leaderboard and comment board are mouse targets; the popup tab
// strip is a real tablist. Both must work with Tab / arrow keys, and the row
// activator must survive the two-second re-render that replaces the nodes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const contentJs = readFileSync(resolve(repo, 'content.js'), 'utf8');
const styles = readFileSync(resolve(repo, 'styles.css'), 'utf8');
const dashboard = readFileSync(resolve(repo, 'popup-dashboard.js'), 'utf8');

describe('panel rows', () => {
  it('makes leaderboard and comment rows keyboard buttons', () => {
    expect(contentJs).toMatch(/xvm-lb-item xvm-lb-\$\{tier\}[\s\S]*?role="button" tabindex="0" aria-label="\$\{lbEscapeHtml\(label\)\}"/);
    expect(contentJs).toMatch(/xvm-lb-item xvm-cb-item[\s\S]*?role="button" tabindex="0" aria-label="\$\{lbEscapeHtml\(label\)\}"/);
  });

  it('activates a focused row with Enter or Space', () => {
    expect(contentJs.match(/ev\.key !== 'Enter' && ev\.key !== ' '/g)).toHaveLength(2);
    expect(contentJs).toContain('jumpToLeaderboardTweet(li.dataset.id, li);');
    expect(contentJs).toContain('activateCommentBoardRow(li);');
  });

  it('restores focus after a live re-render', () => {
    expect(contentJs).toContain('list.contains(document.activeElement)');
    expect(contentJs).toContain('focus({ preventScroll: true })');
    expect(contentJs).toContain('CSS.escape(focusedId)');
  });

  it('shows a visible focus ring in both themes', () => {
    expect(styles).toContain('.xvm-lb-item:focus-visible {');
    expect(styles).toContain('outline: 2px solid #bf5a2a;');
    expect(styles).toContain('.xvm-lb[data-theme="dark"] .xvm-lb-item:focus-visible {');
    expect(styles).toContain('outline-color: #22d3ee;');
  });
});

describe('popup tablist', () => {
  it('uses a roving tabindex instead of putting every tab in the Tab order', () => {
    expect(dashboard).toContain('btn.tabIndex = active ? 0 : -1;');
  });

  it('links tabs and panels for screen readers', () => {
    expect(dashboard).toContain('btn.setAttribute(\'aria-controls\', `tabpanel-${btn.dataset.tab}`);');
    expect(dashboard).toContain('panel.setAttribute(\'aria-labelledby\', btn.id);');
  });

  it('moves with Left / Right and jumps with Home / End', () => {
    expect(dashboard).toContain("const steps = { ArrowRight: 1, ArrowLeft: -1 };");
    expect(dashboard).toContain("ev.key !== 'Home' && ev.key !== 'End'");
    expect(dashboard).toContain('(current + steps[ev.key] + visible.length) % visible.length');
    expect(dashboard).toContain('btn.offsetParent !== null');
  });
});
