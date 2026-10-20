// A follow click changes the page, not the payload. X flips its own button
// optimistically and never re-sends the tweet payload the relation store was
// built from, so anything that reads `following` out of the store alone keeps
// reporting the state from page load. These tests pin the two halves of the
// fix: the button is now the live source, and the things drawn from it are
// allowed to be redrawn.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(resolve(here, '..', 'content.js'), 'utf8');

// Slice whole function declarations out of the monolith by brace matching, so
// the button reader is exercised as shipped rather than reimplemented here.
function loadFunctions(names) {
  const ctx = {};
  for (const name of names) {
    const start = contentJs.indexOf(`function ${name}(`);
    expect(start, `${name} should exist`).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
      if (contentJs[i] === '{') depth += 1;
      else if (contentJs[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    vm.runInNewContext(`${contentJs.slice(start, end)}; this.${name} = ${name};`, ctx);
  }
  return ctx;
}

const { followSignalFromButtons, isFollowToggleNode } = loadFunctions([
  'ownArticleNodes', 'followSignalFromButtons', 'isFollowToggleNode',
]);

// Just enough DOM for ownArticleNodes: it queries, then keeps only the nodes
// whose closest() is this article — the filter that is supposed to exclude a
// quoted tweet's button.
function articleOf(...buttons) {
  const article = { querySelectorAll: () => buttons };
  buttons.forEach((btn) => { btn.closest = () => article; });
  return article;
}

function buttonOf(testid, label) {
  return {
    getAttribute: (name) => {
      if (name === 'data-testid') return testid;
      if (name === 'aria-label') return label;
      return null;
    },
    textContent: label,
  };
}

describe('follow state is read live off the button', () => {
  it('reports the state the button is showing now', () => {
    expect(followSignalFromButtons(articleOf(buttonOf('44196397-follow', 'Follow @ann')), 'ann')).toBe(false);
    expect(followSignalFromButtons(articleOf(buttonOf('44196397-unfollow', 'Following @ann')), 'ann')).toBe(true);
  });

  it('does not read "-unfollow" as a follow button', () => {
    // "unfollow".endsWith("-follow") is false, but the reverse mistake would
    // make every Following button read as not-following.
    expect(followSignalFromButtons(articleOf(buttonOf('44196397-unfollow', '')), 'ann')).toBe(true);
  });

  it('ignores a quoted tweet\'s button, which belongs to someone else', () => {
    // The quoted author's Follow button renders inside this article. Trusting
    // it would report "not following" for the article's own author — a person
    // the user may well already follow.
    const quoted = buttonOf('999-follow', 'Follow @bob');
    expect(followSignalFromButtons(articleOf(quoted), 'ann')).toBeNull();
  });

  it('falls back to the label when the testid is one it does not know', () => {
    // X has changed these testids before; the label is the durable signal.
    expect(followSignalFromButtons(articleOf(buttonOf('', '关注 @ann')), 'ann')).toBe(false);
    expect(followSignalFromButtons(articleOf(buttonOf('', '正在关注 @ann')), 'ann')).toBe(true);
  });

  it('returns null rather than guessing when there is no button', () => {
    // Your own tweets have no follow button. null means "the payload decides",
    // which is the old behaviour and the right one when nothing changed.
    expect(followSignalFromButtons(articleOf(), 'ann')).toBeNull();
  });

  it('lets the button outrank the cached payload', () => {
    // The regression: gating the button behind `merged.following === null` meant
    // the cached `false` from page load always won, so a click was invisible.
    expect(contentJs).toContain('const buttonFollowing = followSignalFromButtons(article, handle);');
    expect(contentJs).toContain('following: buttonFollowing !== null');
    expect(contentJs).not.toContain('if (merged.following === null && buttonFollowing !== null)');
  });
});

describe('a follow click is allowed to change what is drawn', () => {
  it('recognises the click that toggles a follow', () => {
    expect(isFollowToggleNode(buttonOf('44196397-follow', 'Follow @ann'))).toBe(true);
    expect(isFollowToggleNode(buttonOf('44196397-unfollow', 'Following @ann'))).toBe(true);
    // The caret menu carries no testid, only a label.
    expect(isFollowToggleNode(buttonOf('', 'Unfollow @ann'))).toBe(true);
    // And a button that has nothing to do with following is left alone.
    expect(isFollowToggleNode(buttonOf('like', 'Like'))).toBe(false);
    expect(isFollowToggleNode(buttonOf('', 'Share'))).toBe(false);
  });

  it('takes the 未关注 chip back off once the reason for it is gone', () => {
    // paintUnfollowed could only ever add the chip: the no-label branch stamped
    // the article and returned, so 未关注 outlived the follow that invalidated
    // it.
    expect(contentJs).toContain("ownArticleNodes(article, '.xvm-unfollowed').forEach((node) => node.remove());");
  });

  it('repaints on the click instead of waiting for the periodic tick', () => {
    expect(contentJs).toContain('function scheduleFollowRepaint()');
    expect(contentJs).toContain('function repaintFollowState()');
    expect(contentJs).toContain("document.querySelectorAll('article[data-xvm-unfollowed-stamped]')");
    expect(contentJs).toContain('if (commentBoardEnabled) renderCommentBoard();');
  });

  it('repaints again after the round-trip, not only after the optimistic flip', () => {
    // Repainting only early is worse than not repainting: the stale value gets
    // stamped back on and every later pass skips the article.
    expect(contentJs).toContain('setTimeout(repaintFollowState, 900)');
  });

  it('drops the comment board row once the person is followed', () => {
    // No new rule needed — the status-page filter already excludes people you
    // follow. It only looked inert because `following` never changed.
    expect(contentJs).toContain('if (relation?.following === true) continue;');
  });
});
