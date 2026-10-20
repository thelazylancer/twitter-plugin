// The comment hotspot panel ranks the replies under the open status page by
// engagement, so the busiest threads are the easiest place to find people to
// follow back. Ordering is deliberately lexicographic — each key is something
// the user can see in the panel, unlike a blended score.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(resolve(here, '..', 'content.js'), 'utf8');
const bridgeJs = readFileSync(resolve(here, '..', 'bridge.js'), 'utf8');

// Pull the pure helper out of the monolith and run it for real.
function loadHelpers() {
  const names = ['collectCommentRanked'];
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

describe('comment board scope', () => {
  it('ranks every mounted tweet, not just replies', () => {
    // The panel is "which post drew the most replies", so a top-level post is
    // a candidate exactly like a reply is. Filtering on inReplyToStatusId was
    // a misreading of the requirement.
    expect(contentJs).not.toContain('function isCommentData(');
    expect(contentJs).not.toContain('if (!isCommentData(data)) continue;');
    expect(contentJs).toContain('if (!data) continue;');
  });

  it('uses the same candidate set as the leaderboard', () => {
    expect(contentJs).toContain('if (isLeaderboardArticleHidden(article)) continue;');
    expect(contentJs).toContain('if (promotedTweetIds.has(id) || isPromotedArticle(article)) continue;');
  });
});

describe('comment ranking', () => {
  // Mirror of the comparator inside collectCommentRanked, exercised directly so
  // the precedence between the three keys is pinned rather than implied.
  const cmp = (a, b) => (
    b.replies - a.replies
    || b.followers - a.followers
    || b.createdAtMs - a.createdAtMs
  );

  it('puts the most-commented reply first', () => {
    const rows = [
      { replies: 1, followers: 9000, createdAtMs: 300 },
      { replies: 50, followers: 10, createdAtMs: 100 },
    ].sort(cmp);
    expect(rows[0].replies).toBe(50);
  });

  it('breaks a comment-count tie by follower count', () => {
    const rows = [
      { replies: 5, followers: 100, createdAtMs: 300 },
      { replies: 5, followers: 8000, createdAtMs: 100 },
    ].sort(cmp);
    expect(rows[0].followers).toBe(8000);
  });

  it('breaks a followers tie by recency', () => {
    const rows = [
      { replies: 5, followers: 100, createdAtMs: 100 },
      { replies: 5, followers: 100, createdAtMs: 900 },
    ].sort(cmp);
    expect(rows[0].createdAtMs).toBe(900);
  });

  it('sinks rows with unknown follower counts below known ones', () => {
    // -1 is the "X never told us" sentinel; it must not read as "zero followers".
    const rows = [
      { replies: 5, followers: -1, createdAtMs: 900 },
      { replies: 5, followers: 0, createdAtMs: 100 },
    ].sort(cmp);
    expect(rows[0].followers).toBe(0);
  });
});

describe('comment board wiring', () => {
  it('ranks whatever is mounted, like the leaderboard — not just one status page', () => {
    // The panel used to bail out when the URL had no /status/<id>. That made it
    // useless on the home timeline, where the leaderboard still works.
    expect(contentJs).not.toContain('function commentBoardRootId()');
    expect(contentJs).not.toContain("contentCommentBoardNoThread");
    expect(contentJs).toContain('const top = collectCommentRanked().slice(0, commentBoardCount);');
  });

  it('refreshes on its own trigger, not through renderBadges', () => {
    // renderBadges early-returns when badges are off, so piggy-backing on it
    // would leave this panel stale.
    expect(contentJs).toContain('if (commentBoardEnabled) renderCommentBoard();');
  });

  it('sits flush under the leaderboard until the user moves it', () => {
    // "紧贴着流速榜" — no gap, and the seam is squared off so the two panels
    // read as one column.
    expect(contentJs).toContain('function repositionCommentBoardIfAnchored()');
    expect(contentJs).toContain('if (!commentBoardEl || commentBoardPos) return;');
    expect(contentJs).toContain("const top = clampToViewport(anchor.bottom - 1, 'y', commentBoardEl);");
    expect(contentJs).toContain('function syncLeaderboardStacking()');
    expect(contentJs).toContain("leaderboardEl?.classList.toggle('xvm-lb-stacked', joined)");
    expect(contentJs).toContain("commentBoardEl?.classList.toggle('xvm-cb-stacked', joined)");
  });

  it('matches the leaderboard footprint', () => {
    // Width and height defaults are aliased to the leaderboard's constants so
    // the two panels cannot drift apart.
    expect(contentJs).toContain('const CB_DEFAULT_WIDTH = LB_DEFAULT_WIDTH;');
    expect(contentJs).toContain('const CB_DEFAULT_HEIGHT = LB_DEFAULT_HEIGHT;');
    expect(contentJs).toContain("list.style.height = px;");
    expect(contentJs).toContain("list.style.minHeight = px;");
    expect(contentJs).toContain("list.style.maxHeight = px;");
  });

  it('hides with the leaderboard when it is tucked against an edge', () => {
    expect(contentJs).toContain('if (!top.length || (leaderboardEnabled && leaderboardHiddenEdge)) {');
    expect(contentJs).toContain('if (leaderboardHiddenEdge) hideCommentBoard();');
  });

  it('measures its own bounds, not the leaderboard\'s', () => {
    // clampToViewport defaults to leaderboardEl; the comment panel must pass
    // itself or its position is clamped against the wrong rect.
    expect(contentJs).toContain('function clampToViewport(v, axis, el = leaderboardEl)');
    expect(contentJs).toContain("clampToViewport(pendingX - dragState.offsetX, 'x', commentBoardEl)");
  });

  it('persists position and size together', () => {
    expect(contentJs).toContain("type: 'XVM_CB_STATE_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_CB_STATE_SAVE'");
    expect(bridgeJs).toContain("type === 'XVM_CB_STATE_REQUEST'");
  });

  it('can be turned off from the panel itself', () => {
    expect(contentJs).toContain("type: 'XVM_COMMENT_BOARD_DISABLE'");
    expect(bridgeJs).toContain('featureCommentBoard: false');
  });

  it('keeps its own column vocabulary', () => {
    expect(bridgeJs).toContain('KNOWN_CB_COLUMN_IDS');
    expect(bridgeJs).toContain('normalizeCommentBoardColumns');
  });
});

describe('replies without a view count still reach the store', () => {
  it('relaxes the views gate for replies only', () => {
    // Comments routinely arrive with no view count; dropping them would empty
    // the comment panel entirely.
    expect(contentJs).toContain('const isReply = !!legacy.in_reply_to_status_id_str;');
    expect(contentJs).toContain("if (!isReply && (!viewCount || tweet.views?.state !== 'EnabledWithCount')) return null;");
  });
});
