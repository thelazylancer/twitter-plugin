// Decide how to label a commenter from relationship fields already present
// in X's loaded payload. Missing fields stay unlabeled. No network calls.
(() => {
  function formatCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n >= 10000) {
      const wan = n / 10000;
      const text = wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
      return `${text}万`;
    }
    return n.toLocaleString('zh-CN');
  }

  function unlikelyFollowBack(followers, followingCount) {
    return Number.isFinite(followers)
      && Number.isFinite(followingCount)
      && followers >= 1000
      && followers >= followingCount * 10;
  }

  function label(relation) {
    if (!relation || relation.following !== false) return null;
    const followersText = formatCount(relation.followers);
    const followingText = formatCount(relation.followingCount);
    const hard = unlikelyFollowBack(Number(relation.followers), Number(relation.followingCount));
    const text = [
      '未关注',
      hard ? '难回关' : '',
      followingText ? `关注 ${followingText}` : '',
      followersText ? `粉丝 ${followersText}` : '',
    ].filter(Boolean).join(' · ');
    return { text, hard, hasCounts: !!(followingText && followersText) };
  }

  const api = { formatCount, unlikelyFollowBack, label };
  if (typeof window !== 'undefined') window.__xvmUnfollowed = api;
  if (typeof globalThis !== 'undefined') globalThis.__xvmUnfollowed = api;
})();
