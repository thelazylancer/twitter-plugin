// Local fork: community-dev unlocks every Pro gate. Store builds keep the paywall.
(function (root) {
  'use strict';
  const channel = 'community-dev';
  root.__XVM_BUILD_CHANNEL__ = channel;
  root.__xvmBuildChannel = channel;
  root.__xvmIsCommunityDevBuild = channel === 'community-dev';
})(typeof globalThis !== 'undefined' ? globalThis : window);
