// The velocity list used to draw its tier and view marks with emoji. They
// rendered differently on every platform and ignored the row's ink; the panel
// now uses the same authored SVG vocabulary as the comment board.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const contentJs = readFileSync(resolve(repo, 'content.js'), 'utf8');
const styles = readFileSync(resolve(repo, 'styles.css'), 'utf8');
// The velocity badge on each tweet is a different surface: it is a compact
// text chip drawn from CSS `content`, so it keeps its single-glyph prefix.
const leaderboard = contentJs.slice(
  contentJs.indexOf('const LB_COLUMN_RENDERERS'),
  contentJs.indexOf('// === Comment hotspot panel ==='),
);
const badge = contentJs.slice(
  contentJs.indexOf('const { velocity, score } = computeScore(data);'),
  contentJs.indexOf('renderBookmarkTimelineBadges();'),
);
const locales = ['en', 'zh_CN', 'ja'];
const messages = Object.fromEntries(locales.map((locale) => [
  locale,
  JSON.parse(readFileSync(resolve(repo, `_locales/${locale}/messages.json`), 'utf8')),
]));

describe('leaderboard marks', () => {
  it('draws every tier and view mark instead of typing an emoji', () => {
    expect(leaderboard).toContain('XVM_UI_ICONS.flame');
    expect(leaderboard).toContain('XVM_UI_ICONS.trend');
    expect(leaderboard).toContain('XVM_UI_ICONS.sprout');
    expect(leaderboard).toContain('XVM_UI_ICONS.eye');
    for (const emoji of ['\\u{1F525}', '\\u{1F680}', '\\u{1F331}', '\\u{1F441}']) {
      expect(leaderboard, `${emoji} should be gone from the leaderboard`).not.toContain(emoji);
    }
  });

  it('leaves the compact badge prefix as text', () => {
    expect(badge).toContain("badge.dataset.prefix = prefix;");
    expect(badge).toContain('\\u{1F525}');
  });

  it('sizes the marks and lets each row colour them', () => {
    expect(styles).toContain('.xvm-lb-icon svg { width: 12px; height: 12px; }');
    expect(styles).toContain('.xvm-lb-red .xvm-lb-icon { color: #c23c1c; }');
    expect(styles).toContain('.xvm-lb[data-theme="dark"] .xvm-lb-red .xvm-lb-icon { color: #ff6b4a; }');
  });
});

describe('locale parity', () => {
  it('declares every English key in Chinese and Japanese', () => {
    const english = Object.keys(messages.en);
    for (const locale of ['zh_CN', 'ja']) {
      const missing = english.filter((key) => !(key in messages[locale]));
      expect(missing, `${locale} is missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
