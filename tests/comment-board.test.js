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

// Pull the pure helpers out of the monolith and run them for real.
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

// The scoring block is a run of top-level function declarations plus a few
// constants. Slice from the first constant to the end of cbStatusScore and run
// the whole thing, so the tests see the shipped weights and half-lives.
function loadScoring() {
  const start = contentJs.indexOf('const CB_FEED_HALF_LIFE_HOURS');
  const endMarker = 'function cbStatusScore(entry) {';
  const endStart = contentJs.indexOf(endMarker);
  expect(start, 'scoring block should exist').toBeGreaterThan(-1);
  expect(endStart, 'cbStatusScore should exist').toBeGreaterThan(-1);
  let depth = 0;
  let end = endStart;
  for (let i = contentJs.indexOf('{', endStart); i < contentJs.length; i += 1) {
    if (contentJs[i] === '{') depth += 1;
    else if (contentJs[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const src = contentJs.slice(start, end);
  const ctx = {};
  vm.runInNewContext(
    `${src}; this.cbFeedScore = cbFeedScore; this.cbStatusScore = cbStatusScore;`
    + ' this.cbFollowRatio = cbFollowRatio; this.cbRecency = cbRecency;',
    ctx,
  );
  return ctx;
}

describe('comment board scope', () => {
  it('ranks every mounted tweet, not just replies', () => {
    // The feed side of the panel is "which post drew the most replies", so a
    // top-level post is a candidate exactly like a reply is. Filtering on
    // inReplyToStatusId was a misreading of the requirement.
    expect(contentJs).not.toContain('function isCommentData(');
    expect(contentJs).not.toContain('if (!isCommentData(data)) continue;');
    expect(contentJs).toContain('if (!data) continue;');
  });

  it('uses the same candidate set as the leaderboard', () => {
    expect(contentJs).toContain('if (isLeaderboardArticleHidden(article)) continue;');
    expect(contentJs).toContain('if (promotedTweetIds.has(id) || isPromotedArticle(article)) continue;');
  });

  it('drops yourself and people you already follow on a status page', () => {
    // In a thread the panel is a list of people to act on; a row you cannot
    // follow is a wasted slot.
    expect(contentJs).toContain('if (selfHandle && author && author === selfHandle) continue;');
    expect(contentJs).toContain('if (relation?.following === true) continue;');
  });

  it('switches scoring by page type', () => {
    expect(contentJs).toContain('function isCommentBoardStatusPage()');
    expect(contentJs).toContain("entry.score = statusPage ? cbStatusScore(entry) : cbFeedScore(entry);");
  });

  it('reads blue membership through the shared resolver', () => {
    // The 未关注 chip and this panel must never disagree about who is a
    // member, so both go through unfollowedApi().isBlueMember.
    expect(contentJs).toContain('unfollowedApi().isBlueMember(relation, blueVerifiedFromDom(article))');
    expect(contentJs).toContain("const blue = entry.blueVerified === true ? 1 : 0;");
  });
});

describe('comment ranking', () => {
  // Pull the real scoring helpers out of content.js rather than reimplementing
  // them here, so the weights and the decay curve are exercised as shipped.
  const ctx = loadScoring();
  const { cbFeedScore, cbStatusScore, cbFollowRatio, cbRecency } = ctx;
  const hoursAgo = (h) => Date.now() - h * 3_600_000;

  describe('feed / search', () => {
    it('puts a busy fresh post above an older post with more replies', () => {
      // The whole point on the feed is "where is the crowd right now". A
      // 3-day-old post with 500 replies is a dead room.
      const fresh = cbFeedScore({ replies: 80, createdAtMs: hoursAgo(2) });
      const stale = cbFeedScore({ replies: 500, createdAtMs: hoursAgo(72) });
      expect(fresh).toBeGreaterThan(stale);
    });

    it('puts a busier post above a quieter one of the same age', () => {
      const busy = cbFeedScore({ replies: 50, createdAtMs: hoursAgo(1) });
      const quiet = cbFeedScore({ replies: 5, createdAtMs: hoursAgo(1) });
      expect(busy).toBeGreaterThan(quiet);
    });

    it('scores an unknown timestamp at zero rather than assuming it is fresh', () => {
      expect(cbFeedScore({ replies: 500, createdAtMs: 0 })).toBe(0);
    });

    it('halves the score every six hours', () => {
      const now = cbRecency(hoursAgo(0), 6);
      const six = cbRecency(hoursAgo(6), 6);
      expect(now).toBeCloseTo(1, 5);
      expect(six).toBeCloseTo(0.5, 5);
    });
  });

  describe('status page', () => {
    it('ranks someone who already follows you above a bigger account who does not', () => {
      // followedBy is the only certain follow-back, so it carries the most
      // weight — even against a much friendlier ratio.
      const followsMe = cbStatusScore({
        followedBy: true, followingCount: 300, followers: 5000, createdAtMs: hoursAgo(1),
      });
      const stranger = cbStatusScore({
        followedBy: false, followingCount: 4000, followers: 800, createdAtMs: hoursAgo(1),
      });
      expect(followsMe).toBeGreaterThan(stranger);
    });

    it('lets no combination of the other signals outrank "follows you"', () => {
      // The weight is above the sum of the other three, so this is structural
      // rather than a lucky set of inputs.
      const followsMeWorstCase = cbStatusScore({
        followedBy: true, followingCount: 0, followers: 1_000_000,
        blueVerified: false, createdAtMs: hoursAgo(200),
      });
      const strangerBestCase = cbStatusScore({
        followedBy: false, followingCount: 1_000_000, followers: 100,
        blueVerified: true, createdAtMs: hoursAgo(0),
      });
      expect(followsMeWorstCase).toBeGreaterThan(strangerBestCase);
    });

    it('prefers a high following/followers ratio over a large follower count', () => {
      // 5k following / 800 followers beats 200 following / 100k followers:
      // the first follows liberally, the second almost never follows back.
      const liberal = cbStatusScore({
        followedBy: false, followingCount: 5000, followers: 800, createdAtMs: hoursAgo(1),
      });
      const celebrity = cbStatusScore({
        followedBy: false, followingCount: 200, followers: 100_000, createdAtMs: hoursAgo(1),
      });
      expect(liberal).toBeGreaterThan(celebrity);
    });

    it('prefers a recent reply over an old one, all else equal', () => {
      const base = { followedBy: false, followingCount: 1000, followers: 1000 };
      const recent = cbStatusScore({ ...base, createdAtMs: hoursAgo(1) });
      const old = cbStatusScore({ ...base, createdAtMs: hoursAgo(48) });
      expect(recent).toBeGreaterThan(old);
    });

    it('prefers a blue member over a non-member, all else equal', () => {
      // Paid accounts are active users rather than lurkers, so membership is
      // its own weighted term.
      const base = { followedBy: false, followingCount: 1000, followers: 1000, createdAtMs: hoursAgo(1) };
      const blue = cbStatusScore({ ...base, blueVerified: true });
      const plain = cbStatusScore({ ...base, blueVerified: false });
      expect(blue).toBeGreaterThan(plain);
    });

    it('does not award the blue term when membership is unknown', () => {
      // null means "X never told us"; it must score the same as a confirmed
      // non-member rather than earning a free boost.
      const base = { followedBy: false, followingCount: 1000, followers: 1000, createdAtMs: hoursAgo(1) };
      expect(cbStatusScore({ ...base, blueVerified: null }))
        .toBe(cbStatusScore({ ...base, blueVerified: false }));
    });

    it('floors the ratio denominator so a zero-follower account cannot win outright', () => {
      // Without the floor this would be Infinity.
      expect(cbFollowRatio(1000, 0)).toBe(1);
      expect(cbFollowRatio(1000, 100)).toBe(1);
      expect(cbFollowRatio(100, 1000)).toBeCloseTo(0.02, 5);
    });

    it('scores an unknown ratio as zero, not as a perfect one', () => {
      expect(cbFollowRatio(-1, -1)).toBe(0);
      expect(cbFollowRatio(undefined, 500)).toBe(0);
    });
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
