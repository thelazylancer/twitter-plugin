import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const contentJs = read('content.js');
const backgroundJs = read('background.js');

// Pull `describeFollowRelation` out of the content.js monolith and give it a
// stubbed relationForComment, so the wording can be exercised for real instead
// of asserted as a source substring.
function loadDescribe(relation) {
  const start = contentJs.indexOf('function describeFollowRelation(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
    if (contentJs[i] === '{') depth += 1;
    else if (contentJs[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const src = `${contentJs.slice(start, end)}; globalThis.describe = describeFollowRelation;`;
  const sandbox = { relationForComment: () => relation };
  vm.runInNewContext(src, sandbox);
  return sandbox.describe;
}

describe('follow relation reaches the AI context', () => {
  it('names a mutual follow', () => {
    const describe = loadDescribe({ following: true, followedBy: true, screenName: 'ann' });
    expect(describe({}, '@ann')).toBe('【关注状态】你和@ann是互相关注');
  });

  it('spells out each one-way case', () => {
    expect(loadDescribe({ following: true, followedBy: false, screenName: 'ann' })({}, '@ann'))
      .toBe('【关注状态】你已经关注了@ann，对方还没有关注你');
    expect(loadDescribe({ following: false, followedBy: true, screenName: 'ann' })({}, '@ann'))
      .toBe('【关注状态】@ann关注了你，你还没有关注对方');
    expect(loadDescribe({ following: false, followedBy: false, screenName: 'ann' })({}, '@ann'))
      .toBe('【关注状态】你和@ann互不关注');
  });

  it('falls back to the one direction X actually reported', () => {
    expect(loadDescribe({ following: true, followedBy: null, screenName: 'ann' })({}, '@ann'))
      .toBe('【关注状态】你已经关注了@ann');
    expect(loadDescribe({ following: false, followedBy: null, screenName: 'ann' })({}, '@ann'))
      .toBe('【关注状态】你还没有关注@ann');
  });

  it('states the status only, with no tone coaching', () => {
    const combos = [true, false, null];
    for (const following of combos) {
      for (const followedBy of combos) {
        const note = loadDescribe({ following, followedBy, screenName: 'ann' })({}, '@ann');
        expect(note).not.toMatch(/语气|装熟/);
      }
    }
  });

  it('stays silent when the direction is unknown, and never invents a handle', () => {
    expect(loadDescribe({ following: null, followedBy: true, screenName: 'ann' })({}, '@ann')).toBe('');
    expect(loadDescribe({ following: true, followedBy: true, screenName: 'ann' })(null)).toBe('');
    // No handle anywhere: a generic 对方, never a fabricated @name.
    expect(loadDescribe({ following: true, followedBy: true })({})).toBe('【关注状态】你和对方是互相关注');
    expect(loadDescribe({ following: false, followedBy: null })({})).toBe('【关注状态】你还没有关注对方');
    expect(loadDescribe({ following: true, followedBy: true, screenName: 'ann' })({}, '@bob'))
      .toBe('【关注状态】你和@bob是互相关注');
  });

  it('keeps every note on one line, which the language detectors rely on', () => {
    const combos = [true, false, null];
    for (const following of combos) {
      for (const followedBy of combos) {
        for (const screenName of ['ann', '']) {
          const note = loadDescribe({ following, followedBy, screenName })({}, '');
          expect(note).not.toContain('\n');
        }
      }
    }
  });
});

describe('follow relation wiring', () => {
  it('reads the followed_by side of the relationship', () => {
    expect(contentJs).toContain('perspective.followed_by ?? userLegacy.followed_by ?? user.followed_by');
    expect(contentJs).toContain('followedBy: booleanOrNull(byId?.followedBy ?? byHandle?.followedBy ?? fiber?.followedBy)');
    expect(contentJs).toContain('followedBy: base.followedBy === true || base.followedBy === false ? base.followedBy : extra.followedBy');
  });

  it('carries the note into both reply contexts', () => {
    expect(contentJs).toContain('const relationNote = describeFollowRelation(commentArticle, who);');
    expect(contentJs).toContain('const relationNote = describeFollowRelation(article);');
    expect(contentJs).toContain('if (relationNote) tweetText = `${tweetText}\\n\\n${relationNote}`;');
  });

  it('blocks 邀关 once the account is already followed', () => {
    expect(contentJs).toContain('if (article && relationForComment(article).following === true) {');
    expect(contentJs).toContain("showGrokErrorToast(i18n('contentAiInviteFollowedToast'))");
  });

  it('strips the note before language detection', () => {
    expect(backgroundJs).toContain('.replace(/【关注状态】[^\\n]*/g, \' \')');
  });
});
