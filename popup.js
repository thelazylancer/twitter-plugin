const LANGUAGE_KEY = 'language';
const SUPPORTED_LANGUAGE_IDS = ['auto', 'zh_CN', 'en', 'ja'];
const LANGUAGE_LABELS = {
  auto: 'Auto / 跟随系统',
  zh_CN: '中文',
  en: 'English',
  ja: '日本語',
};
const LANGUAGE_TOGGLE_TEXT = {
  zh_CN: '中',
  en: 'EN',
  ja: '日',
};

function normalizeLanguage(raw) {
  return SUPPORTED_LANGUAGE_IDS.includes(raw) ? raw : 'auto';
}

function getBrowserLocaleId() {
  try {
    const ui = chrome?.i18n?.getUILanguage?.() || navigator.language || '';
    const lower = ui.toLowerCase();
    if (lower.startsWith('zh')) return 'zh_CN';
    if (lower.startsWith('ja')) return 'ja';
  } catch (_) {}
  return 'en';
}

function getEffectiveLanguageId(pref = normalizeLanguage(localStorage.getItem(LANGUAGE_KEY))) {
  return pref === 'auto' ? getBrowserLocaleId() : normalizeLanguage(pref);
}

function normalizeSubstitutions(substitutions) {
  if (substitutions == null) return [];
  return Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];
}

function formatLocaleMessage(entry, substitutions) {
  if (!entry?.message) return '';
  const subs = normalizeSubstitutions(substitutions);
  let message = String(entry.message).replace(/\$\$/g, '\u0000');
  const placeholders = entry.placeholders || {};
  for (const [name, meta] of Object.entries(placeholders)) {
    const match = String(meta?.content || '').match(/^\$(\d+)$/);
    const value = match ? (subs[Number(match[1]) - 1] ?? '') : String(meta?.content || '');
    message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
  }
  message = message.replace(/\$(\d+)/g, (_, n) => subs[Number(n) - 1] ?? '');
  return message.replace(/\u0000/g, '$');
}

function loadLocaleBundleSync(languageId) {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', chrome.runtime.getURL(`_locales/${languageId}/messages.json`), false);
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) return JSON.parse(xhr.responseText);
  } catch (_) {}
  return null;
}

const initialLanguagePref = normalizeLanguage(localStorage.getItem(LANGUAGE_KEY));
const initialLanguageId = getEffectiveLanguageId(initialLanguagePref);
const overrideMessages = initialLanguagePref === 'auto' ? null : loadLocaleBundleSync(initialLanguageId);
const nativeGetMessage = chrome?.i18n?.getMessage?.bind(chrome.i18n);

if (overrideMessages && nativeGetMessage) {
  try {
    chrome.i18n.getMessage = (key, substitutions) => {
      const formatted = formatLocaleMessage(overrideMessages[key], substitutions);
      return formatted || nativeGetMessage(key, substitutions);
    };
  } catch (_) {}
}

const GROK_DEFAULTS_BY_LANGUAGE = {
  zh_CN: {
    promptTemplates: [
      { id: 'default', name: '默认评论', prompt: '{推文内容}\n\n{关注状态}\n\n为我生成针对这条推文的3条评论。\n\n要求：\n- 每条评论只包含可直接发布的评论正文\n- 用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
      { id: 'short-cn', name: '中文短评', prompt: '{推文内容}\n\n{关注状态}\n\n为该推文生成3条自然、简短、像真人回复的中文评论。\n\n要求：\n- 每条评论只包含可直接发布的评论正文\n- 用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
      { id: 'sharp', name: '犀利观点', prompt: '{推文内容}\n\n{关注状态}\n\n为该推文生成3条有观点、有信息密度的评论。\n\n要求：\n- 不人身攻击\n- 每条评论只包含可直接发布的评论正文\n- 用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
      { id: 'tieba-laoge', name: '贴吧老哥', prompt: '{推文内容}\n\n{关注状态}\n\n用贴吧老哥的语气为该推文生成3条评论。\n\n要求：\n- 整体阴阳怪气，但不带脏字、不人身攻击\n- 保持口语感，不要装文艺、不要写得像新闻评论\n- 每条评论控制在 30 字以内，简短精悍\n- 每条评论只包含可直接发布的评论正文，用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
      { id: 'point-by-point', name: '针对性回应', prompt: '{推文内容}\n\n{关注状态}\n\n为该推文生成3条评论。\n\n要求：\n- 每条都针对推文里的一个具体观点、论据或例子回应（赞同/质疑/补充），不要笼统夸奖\n- 语气自然像真人\n- 每条评论只包含可直接发布的评论正文，用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
      { id: 'deep-dive', name: '深度回应', prompt: '{推文内容}\n\n{关注状态}\n\n挑出这条推文里最值得讨论的3-5个点，围绕这些点生成3条有信息密度的评论（延伸思考、反例、或个人经验）。\n\n要求：\n- 每条评论只包含可直接发布的评论正文，用代码块包裹\n- 关注状态只用来判断该用什么分寸，不要把它写进回复里' },
    ],
  },
  en: {
    promptTemplates: [
      { id: 'default', name: 'Natural replies', prompt: '{推文内容}\n\n{关注状态}\n\nWrite 3 natural English replies to this X post.\n\nRequirements:\n- Sound like real X replies, not marketing copy or a formal article comment\n- Each reply should make one clear point: agree, add context, ask a sharp question, or offer a mild counterpoint\n- Avoid generic praise, outrage bait, personal attacks, and hashtags\n- Keep each reply concise, roughly 8-28 words\n- Output only ready-to-post reply text, each inside its own code block\n- Use the follow status only to calibrate tone; never mention it in the reply' },
      { id: 'sharp', name: 'Sharp but fair', prompt: '{推文内容}\n\n{关注状态}\n\nWrite 3 English replies to this X post with a sharper point of view.\n\nRequirements:\n- Be specific, thoughtful, and concise\n- You may challenge assumptions, add a counterexample, or clarify the tradeoff\n- Stay fair; no insults, no dunking, no culture-war bait\n- Keep each reply around 12-35 words\n- Output only ready-to-post reply text, each inside its own code block\n- Use the follow status only to calibrate tone; never mention it in the reply' },
      { id: 'casual-en', name: 'Casual short replies', prompt: '{推文内容}\n\n{关注状态}\n\nWrite 3 casual English replies for this X post.\n\nRequirements:\n- Conversational and human, like a normal user replying on X\n- Short, direct, and not over-polished\n- Avoid cringe slang, hashtags, and corporate tone\n- Keep each reply under 25 words\n- Output only ready-to-post reply text, each inside its own code block\n- Use the follow status only to calibrate tone; never mention it in the reply' },
      { id: 'point-by-point', name: 'Point-by-point', prompt: '{推文内容}\n\n{关注状态}\n\nWrite 3 English replies to this X post.\n\nRequirements:\n- Each reply responds to one specific claim, argument, example, or conclusion from the post\n- Mix agreement, critique, added context, and follow-up questions\n- Avoid vague praise like “great insights”\n- Keep each reply specific and ready to post\n- Output only the reply text, each inside its own code block\n- Use the follow status only to calibrate tone; never mention it in the reply' },
      { id: 'deep-dive', name: 'Deeper discussion', prompt: '{推文内容}\n\n{关注状态}\n\nIdentify 3-5 discussion-worthy points in this X post and write 3 English replies.\n\nRequirements:\n- Each reply focuses on one concrete point\n- Add a useful extension, counterexample, practical constraint, or personal-experience angle\n- Sound natural, not like a summary\n- Output only ready-to-post reply text, each inside its own code block\n- Use the follow status only to calibrate tone; never mention it in the reply' },
    ],
  },
  ja: {
    promptTemplates: [
      { id: 'default', name: '自然な返信', prompt: '{推文内容}\n\n{关注状态}\n\nこの X 投稿に対する自然な日本語返信を 3 件作成してください。\n\n条件：\n- 実際の X の返信らしく、宣伝文や記事コメントのようにしない\n- 各返信は、共感・補足・軽い疑問・別視点のいずれかを 1 つだけ扱う\n- 空っぽな称賛、過度な煽り、個人攻撃は避ける\n- 1 件あたり 15〜45 字程度\n- そのまま投稿できる本文だけを、各返信ごとにコードブロックで出力する\n- フォロー状態は距離感の判断にだけ使い、返信本文には書かない' },
      { id: 'sharp', name: '鋭めだが丁寧', prompt: '{推文内容}\n\n{关注状态}\n\nこの X 投稿に対する日本語返信を 3 件作成してください。少し鋭い視点で、ただし丁寧に。\n\n条件：\n- 前提への疑問、反例、補足、論点整理のいずれかを入れる\n- 皮肉、人格攻撃、決めつけは避ける\n- 1 件あたり 20〜55 字程度\n- そのまま投稿できる本文だけを、各返信ごとにコードブロックで出力する\n- フォロー状態は距離感の判断にだけ使い、返信本文には書かない' },
      { id: 'casual-ja', name: '短めの口語返信', prompt: '{推文内容}\n\n{关注状态}\n\nこの X 投稿に対する短い日本語返信を 3 件作成してください。\n\n条件：\n- 口語的で自然、AI っぽいことをしない\n- くだけすぎず、普通のユーザーの返信に見える文体\n- 1 件あたり 10〜30 字程度\n- そのまま投稿できる本文だけを、各返信ごとにコードブロックで出力する\n- フォロー状態は距離感の判断にだけ使い、返信本文には書かない' },
      { id: 'point-by-point', name: '論点への返信', prompt: '{推文内容}\n\n{关注状态}\n\nこの X 投稿への日本語の返信を 3 件作成してください。\n\n条件：\n- 各返信は投稿中の具体的な主張、根拠、例、結論のどれかに反応する\n- 賛同、疑問、補足、追加の問いをバランスよく混ぜる\n- 「勉強になりました」のような抽象的な感想だけにしない\n- 1 件あたり 30〜80 字程度\n- そのまま投稿できる本文だけを、各返信ごとにコードブロックで出力する\n- フォロー状態は距離感の判断にだけ使い、返信本文には書かない' },
      { id: 'deep-dive', name: '深めの議論', prompt: '{推文内容}\n\n{关注状态}\n\nこの X 投稿から議論すべきポイントを 3〜5 個選び、日本語の返信を 3 件作成してください。\n\n条件：\n- 各返信は 1 つの具体的な論点に絞る\n- 追加視点、反例、現実的な制約、個人的な経験の角度を入れる\n- 要約のようにせず、自然な返信文にする\n- そのまま投稿できる本文だけを、各返信ごとにコードブロックで出力する\n- フォロー状態は距離感の判断にだけ使い、返信本文には書かない' },
    ],
  },
};

function getLocalizedGrokDefaults(languageId = initialLanguageId) {
  const lang = GROK_DEFAULTS_BY_LANGUAGE[languageId] ? languageId : 'en';
  const defs = GROK_DEFAULTS_BY_LANGUAGE[lang];
  return {
    grokCommentPrompt: defs.promptTemplates[0].prompt,
    grokPromptTemplates: defs.promptTemplates.map((tpl) => ({ ...tpl })),
    grokSelectedPromptId: defs.promptTemplates[0].id,
  };
}

const LOCALIZED_GROK_DEFAULTS = getLocalizedGrokDefaults(initialLanguageId);
function isUnmodifiedBundledGrokTemplateSet(templates, key) {
  if (!Array.isArray(templates) || templates.length === 0) return true;
  for (const defs of Object.values(GROK_DEFAULTS_BY_LANGUAGE)) {
    const bundled = defs[key] || [];
    if (templates.length !== bundled.length) continue;
    const matches = templates.every((tpl, idx) => (
      String(tpl?.id || '') === bundled[idx].id
      && String(tpl?.name || '') === bundled[idx].name
      && String(tpl?.prompt || '') === bundled[idx].prompt
    ));
    if (matches) return true;
  }
  return false;
}

const DEFAULT_THRESHOLDS = { trending: 1000, viral: 10000 };
const DEFAULT_COLUMNS = [
  { id: 'rank',     visible: true  },
  { id: 'icon',     visible: true  },
  { id: 'handle',   visible: false },
  { id: 'preview',  visible: true  },
  { id: 'views',    visible: true  },
  { id: 'velocity', visible: true  },
];
const COLUMN_LABEL_KEYS = {
  rank: 'popupColRank',
  icon: 'popupColIcon',
  handle: 'popupColHandle',
  preview: 'popupColPreview',
  views: 'popupColViews',
  velocity: 'popupColVelocity',
};
const KNOWN_COLUMN_IDS = DEFAULT_COLUMNS.map((c) => c.id);
// Comment hotspot panel: separate column vocabulary from the leaderboard's,
// since it ranks replies by engagement and author reach rather than velocity.
const DEFAULT_CB_COLUMNS = [
  { id: 'rank',      visible: true },
  { id: 'handle',    visible: true },
  { id: 'preview',   visible: true },
  { id: 'replies',   visible: true },
  { id: 'followers', visible: true },
  { id: 'relation',  visible: true },
];
const DEFAULT_FEATURES = {
  featureVelocityBadges: false,
  featureVelocityLeaderboard: false,
  featureCopyAsMarkdown: false,
  featureStarChart: false,
  featureBookmarkFolders: false,
  showBookmarkCount: false,
  leaderboardEdgeHideEnabled: true,
  badgeStyle: 'pill-solid',
  leaderboardCount: 10,
  leaderboardColumns: DEFAULT_COLUMNS,
  featureCommentBoard: false,
  commentBoardCount: 10,
  commentBoardColumns: DEFAULT_CB_COLUMNS,
  grokCommentPrompt: LOCALIZED_GROK_DEFAULTS.grokCommentPrompt,
  grokPromptTemplates: LOCALIZED_GROK_DEFAULTS.grokPromptTemplates,
  grokSelectedPromptId: LOCALIZED_GROK_DEFAULTS.grokSelectedPromptId,
  grokEnterToReply: false,
  authorReplyPrompt: '',
  inviteFollowPrompt: '',
  aiProvider: 'openai-compatible',
  aiOpenAIPlatform: 'openai',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  aiReplyCount: 3,
  aiLanguage: 'auto',
  replyLanguage: 'post',
  language: initialLanguagePref,
  freshnessEnabled: true,
  freshnessHotMinutes: 5,
  freshnessFreshMinutes: 10,
  freshnessWarmMinutes: 30,
  freshnessHotColor: '#f4212e',
  freshnessFreshColor: '#1d9bf0',
  freshnessWarmColor: '#f7b928',
  unfollowedEnabled: true,
  unfollowedBlueOnly: true,
};
const STORAGE_DEFAULTS = { ...DEFAULT_THRESHOLDS, ...DEFAULT_FEATURES };
const AI_PLATFORM_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  kimi: { label: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.ai/v1', model: 'moonshot-v1-8k' },
  qwen: { label: 'Qwen / DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow: { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Pro/zai-org/GLM-4.7' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'local-model', local: true },
  ollamaOpenAI: { label: 'Ollama (OpenAI compatible)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', local: true },
};

// Apply chrome.i18n translations to any element marked with data-i18n.
// Falls back to the hardcoded English text in the HTML if a key is missing.
function t(key, substitutions) {
  try {
    return chrome.i18n.getMessage(key, substitutions) || '';
  } catch (e) {
    return '';
  }
}
document.querySelectorAll('[data-i18n]').forEach((el) => {
  const msg = t(el.dataset.i18n);
  if (msg) el.textContent = msg;
});
document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
  const msg = t(el.dataset.i18nPlaceholder);
  if (msg) el.placeholder = msg;
});

function tr(key, substitutions) {
  return t(key, substitutions) || key;
}

const customSelectState = new WeakMap();

function initCustomSelect(input) {
  if (!input || customSelectState.has(input)) return customSelectState.get(input);
  const root = input.closest('.xvm-select');
  if (!root) return null;
  const trigger = root.querySelector('.xvm-select-trigger');
  const valueEl = root.querySelector('.xvm-select-value');
  const menu = root.querySelector('.xvm-select-menu');
  if (!trigger || !valueEl || !menu) return null;

  const state = { root, trigger, valueEl, menu, options: [] };
  customSelectState.set(input, state);

  const menuId = `${input.id || 'xvm-select'}-listbox`;
  menu.id = menuId;
  trigger.setAttribute('aria-controls', menuId);

  trigger.addEventListener('click', () => {
    if (root.dataset.open === '1') {
      closeCustomSelect(input);
    } else {
      openCustomSelect(input);
    }
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openCustomSelect(input);
      focusSelectedCustomSelectOption(input);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('.xvm-select-option')];
    const current = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCustomSelect(input);
      trigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[Math.min(current + 1, buttons.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[Math.max(current - 1, 0)]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.activeElement?.click?.();
    }
  });

  if (!document.__xvmCustomSelectOutside) {
    document.__xvmCustomSelectOutside = true;
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.xvm-select[data-open="1"]').forEach((openRoot) => {
        if (!openRoot.contains(e.target)) closeCustomSelect(openRoot.querySelector('input[type="hidden"]'));
      });
    });
  }

  return state;
}

function closeCustomSelect(input) {
  const state = customSelectState.get(input);
  if (!state) return;
  state.root.dataset.open = '0';
  state.trigger.setAttribute('aria-expanded', 'false');
}

function openCustomSelect(input) {
  const state = initCustomSelect(input);
  if (!state) return;
  document.querySelectorAll('.xvm-select[data-open="1"]').forEach((openRoot) => {
    const openInput = openRoot.querySelector('input[type="hidden"]');
    if (openInput !== input) closeCustomSelect(openInput);
  });
  state.root.dataset.open = '1';
  state.trigger.setAttribute('aria-expanded', 'true');
}

function focusSelectedCustomSelectOption(input) {
  const state = customSelectState.get(input);
  if (!state) return;
  const selected = state.menu.querySelector('.xvm-select-option[aria-selected="true"]')
    || state.menu.querySelector('.xvm-select-option');
  selected?.focus();
}

function setCustomSelectValue(input, value, opts = {}) {
  const state = initCustomSelect(input);
  if (!state) {
    if (input) input.value = value;
    return;
  }
  const next = String(value ?? '');
  input.value = next;
  const active = state.options.find((item) => item.value === next) || state.options[0];
  state.valueEl.textContent = active?.label || '';
  state.menu.querySelectorAll('.xvm-select-option').forEach((btn) => {
    const selected = btn.dataset.value === next;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (opts.dispatch) input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setCustomSelectOptions(input, options, selectedValue = input?.value) {
  const state = initCustomSelect(input);
  if (!state) return;
  state.options = options.map((item) => ({
    value: String(item.value),
    label: String(item.label),
  }));
  state.menu.innerHTML = '';
  state.options.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xvm-select-option';
    btn.setAttribute('role', 'option');
    btn.dataset.value = item.value;
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      setCustomSelectValue(input, item.value, { dispatch: true });
      closeCustomSelect(input);
      state.trigger.focus();
    });
    state.menu.appendChild(btn);
  });
  const hasSelected = state.options.some((item) => item.value === String(selectedValue ?? ''));
  setCustomSelectValue(input, hasSelected ? selectedValue : state.options[0]?.value || '');
}

function normalizeColumns(raw) {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.id !== 'string' || !KNOWN_COLUMN_IDS.includes(c.id)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, visible: !!c.visible });
  }
  for (const def of DEFAULT_COLUMNS) {
    if (!seen.has(def.id)) out.push({ ...def });
  }
  return out;
}

const form = document.getElementById('settings-form');
const trendingInput = document.getElementById('trending');
const viralInput = document.getElementById('viral');
const resetBtn = document.getElementById('reset');
const statusEl = document.getElementById('status');
const leaderboardToggle = document.getElementById('feat-leaderboard');
const leaderboardEdgeHideToggle = document.getElementById('lb-edge-hide');
const copyMdToggle = document.getElementById('feat-copy-md');
const starChartToggle = document.getElementById('feat-starchart');
const bookmarkFolderToggle = document.getElementById('feat-bookmark-folders');
const bookmarkCountToggle = document.getElementById('feat-bookmark-count');
const leaderboardCountInput = document.getElementById('lb-count');
const commentBoardToggle = document.getElementById('feat-comment-board');
const commentBoardCountInput = document.getElementById('cb-count');
const badgeStyleSelect = document.getElementById('badge-style');
const languageSelect = document.getElementById('language-select');
const languageToggle = document.getElementById('language-toggle');
const colListEl = document.getElementById('lb-col-list');
const grokTemplateChips = document.getElementById('grok-template-select');
const grokTemplateNameInput = document.getElementById('grok-template-name');
const grokPromptInput = document.getElementById('grok-prompt');
const grokPromptResetBtn = document.getElementById('grok-prompt-reset');
const grokTplStatus = document.getElementById('grok-tpl-status');
const grokEnterReplyToggle = document.getElementById('grok-enter-reply');
const authorReplyPromptInput = document.getElementById('author-reply-prompt');
const authorReplyResetBtn = document.getElementById('author-reply-reset');
const authorReplyStatus = document.getElementById('author-reply-status');
const inviteFollowPromptInput = document.getElementById('invite-follow-prompt');
const inviteFollowResetBtn = document.getElementById('invite-follow-reset');
const inviteFollowStatus = document.getElementById('invite-follow-status');
const INVITE_FOLLOW_DEFAULT = `{推文内容}

{作者}
{关注状态}

你要在对方的推文下留一条回复，邀请对方和你互相关注。要求：
- 先接住这条推文的一个具体内容（观点、经历或细节）
- 再自然提出邀请互相互关：不要写成商务邀约
- 以小女子的身份去评论(不需要小女人人称)，一定要用网络用语，评论有梗
- 生成3条候选，每条控制在20个字左右
- 不要夸夸其谈，不要提粉丝数、流量、合作，不要用 emoji 堆砌
- 关注状态只用来判断该用什么分寸，不要把它写进回复里
- 跟这条推文使用的语言走
- 只输出可直接发布的回复正文，用代码块包裹。`;
const AUTHOR_REPLY_DEFAULT = `{主贴}

{当前评论}

{关注状态}

{数据}

你是主贴的作者，正在回复下面那条当前评论。主贴是你已经公开说过的话，当前评论是别人留在这条主贴下面、你现在要回的那一条。

请生成3条可直接发送的回复。要求：
- 先看当前评论在问、补充还是反驳主贴里的哪一点，只回应这一点
- 回答必须和主贴对得上：评论问到主贴里的说法，就用主贴里的立场来答，不要另起一套
- 不要复述整条主贴，不要夸自己的主贴，不要写成路人在评论别人的帖子
- 关注状态只用来判断该用什么分寸，不要把它写进回复里
- 语气像本人回评：简短、口语、不端着。有问题就答，有补充就补一句，有感谢就短谢
- 跟当前评论使用的语言走
- 每条只包含可直接发布的回复正文，用代码块包裹。`;
const freshnessHotMinutesInput = document.getElementById('freshness-hot-minutes');
const freshnessHotColorInput = document.getElementById('freshness-hot-color');
const freshnessFreshMinutesInput = document.getElementById('freshness-fresh-minutes');
const freshnessWarmMinutesInput = document.getElementById('freshness-warm-minutes');
const freshnessFreshColorInput = document.getElementById('freshness-fresh-color');
const freshnessWarmColorInput = document.getElementById('freshness-warm-color');
const unfollowedToggle = document.getElementById('feat-unfollowed');
const unfollowedBlueToggle = document.getElementById('feat-unfollowed-blue');
const aiProviderSelect = document.getElementById('ai-provider');
const aiProviderOptions = [...document.querySelectorAll('[data-ai-provider-option]')];
const aiPlatformSelect = document.getElementById('ai-platform');
const aiBaseUrlInput = document.getElementById('ai-base-url');
const aiModelInput = document.getElementById('ai-model');
const aiReplyCountInput = document.getElementById('ai-reply-count');
const replyLanguageSelect = document.getElementById('reply-language');
const aiApiKeyInput = document.getElementById('ai-api-key');
const aiConnectionGrid = document.getElementById('ai-connection-grid');
const aiProviderHint = document.getElementById('ai-provider-hint');
const aiProviderSaveBtn = document.getElementById('ai-provider-save');
const aiTestConnectionBtn = document.getElementById('ai-test-connection');
const aiTestStatus = document.getElementById('ai-test-status');

setCustomSelectOptions(badgeStyleSelect, [
  { value: 'pill-solid', label: tr('badgeStylePillSolid') || 'Pill solid' },
  { value: 'inline-classic', label: tr('badgeStyleInlineClassic') || 'Inline classic' },
], 'pill-solid');

setCustomSelectOptions(languageSelect, [
  { value: 'auto', label: tr('languageAuto') || LANGUAGE_LABELS.auto },
  { value: 'zh_CN', label: tr('languageZh') || LANGUAGE_LABELS.zh_CN },
  { value: 'en', label: tr('languageEn') || LANGUAGE_LABELS.en },
  { value: 'ja', label: tr('languageJa') || LANGUAGE_LABELS.ja },
], initialLanguagePref);

setCustomSelectOptions(aiPlatformSelect, Object.entries(AI_PLATFORM_PRESETS).map(([value, preset]) => ({
  value,
  label: preset.label,
})), DEFAULT_FEATURES.aiOpenAIPlatform);

function getLanguageDisplayName(language) {
  const normalized = normalizeLanguage(language);
  const key = normalized === 'auto' ? 'languageAuto'
    : normalized === 'zh_CN' ? 'languageZh'
    : normalized === 'ja' ? 'languageJa'
    : 'languageEn';
  return tr(key) || LANGUAGE_LABELS[normalized] || LANGUAGE_LABELS.auto;
}

function updateLanguageToggle(language) {
  if (!languageToggle) return;
  const normalized = normalizeLanguage(language);
  const label = getLanguageDisplayName(normalized);
  const effective = getEffectiveLanguageId(normalized);
  languageToggle.querySelector('.language-toggle-text').textContent = LANGUAGE_TOGGLE_TEXT[effective] || LANGUAGE_TOGGLE_TEXT.en;
  languageToggle.dataset.languagePref = normalized;
  languageToggle.title = `${tr('languageLabel')}: ${label}`;
  languageToggle.setAttribute('aria-label', `${tr('languageLabel')}: ${label}`);
}

function buildLanguageStoragePatch(language) {
  const normalized = normalizeLanguage(language);
  const effective = getEffectiveLanguageId(normalized);
  const next = { language: normalized };
  if (isUnmodifiedBundledGrokTemplateSet(grokTemplatesState, 'promptTemplates')) {
    const defs = getLocalizedGrokDefaults(effective);
    next.grokCommentPrompt = defs.grokCommentPrompt;
    next.grokPromptTemplates = defs.grokPromptTemplates;
    next.grokSelectedPromptId = defs.grokSelectedPromptId;
  }
  return next;
}

function applyLanguageChange(language) {
  const normalized = normalizeLanguage(language);
  updateLanguageToggle(normalized);
  setCustomSelectValue(languageSelect, normalized);
  try { localStorage.setItem(LANGUAGE_KEY, normalized); } catch (_) {}
  chrome.storage.sync.set(buildLanguageStoragePatch(normalized), () => {
    location.reload();
  });
}
updateLanguageToggle(initialLanguagePref);

let columnsState = normalizeColumns(null);
let grokTemplatesState = DEFAULT_FEATURES.grokPromptTemplates.map((tpl) => ({ ...tpl }));
let grokSelectedTemplateId = DEFAULT_FEATURES.grokSelectedPromptId;

function normalizeAiProvider(raw) {
  return ['ollama', 'openai-compatible'].includes(raw) ? raw : DEFAULT_FEATURES.aiProvider;
}

function normalizeAiPlatform(raw) {
  return AI_PLATFORM_PRESETS[raw] ? raw : DEFAULT_FEATURES.aiOpenAIPlatform;
}

function normalizeAiReplyCount(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_FEATURES.aiReplyCount;
  return Math.max(1, Math.min(20, n));
}

function setAiProviderValue(value, opts = {}) {
  const next = normalizeAiProvider(value);
  if (aiProviderSelect) aiProviderSelect.value = next;
  aiProviderOptions.forEach((btn) => {
    const selected = btn.dataset.aiProviderOption === next;
    btn.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
  if (opts.dispatch) aiProviderSelect?.dispatchEvent(new Event('change', { bubbles: true }));
}

function setFieldVisible(input, visible) {
  const field = input?.closest?.('label.field');
  if (field) field.hidden = !visible;
}

function setAiTestStatus(message = '', state = '') {
  if (!aiTestStatus) return;
  aiTestStatus.textContent = message;
  aiTestStatus.dataset.state = state;
}

function applyAiPlatformPreset(platform, overwrite = true) {
  const preset = AI_PLATFORM_PRESETS[normalizeAiPlatform(platform)];
  if (!preset) return;
  if (overwrite || !aiBaseUrlInput.value.trim()) aiBaseUrlInput.value = preset.baseUrl;
  if (overwrite || !aiModelInput.value.trim()) aiModelInput.value = preset.model;
}

function updateAiProviderFields() {
  const provider = normalizeAiProvider(aiProviderSelect?.value);
  const isOllama = provider === 'ollama';
  const isOpenAI = provider === 'openai-compatible';
  const platform = normalizeAiPlatform(aiPlatformSelect?.value);
  const preset = AI_PLATFORM_PRESETS[platform];

  setAiProviderValue(provider);
  if (aiConnectionGrid) aiConnectionGrid.hidden = false;
  setFieldVisible(aiPlatformSelect, isOpenAI);
  setFieldVisible(aiBaseUrlInput, true);
  setFieldVisible(aiModelInput, true);
  setFieldVisible(aiApiKeyInput, isOpenAI && !preset?.local);
  if (aiTestConnectionBtn) {
    aiTestConnectionBtn.textContent = tr('aiTestConnection') || 'Test connection';
  }
  if (aiProviderHint) {
    aiProviderHint.hidden = false;
    aiProviderHint.textContent = isOllama
      ? (tr('aiProviderHintOllama') || 'Ollama runs locally. Make sure Ollama is running and the model has been downloaded.')
      : (tr('aiProviderHintCloud') || 'Cloud providers send tweet text and reply context to the selected AI service.');
  }
}

function buildAiSyncPatch() {
  const provider = normalizeAiProvider(aiProviderSelect?.value);
  const platform = normalizeAiPlatform(aiPlatformSelect?.value);
  const preset = AI_PLATFORM_PRESETS[platform];
  const baseUrl = (aiBaseUrlInput?.value || '').trim()
    || (provider === 'ollama' ? 'http://localhost:11434' : preset.baseUrl);
  const model = (aiModelInput?.value || '').trim()
    || (provider === 'ollama' ? 'llama3.1' : preset.model);
  return {
    aiProvider: provider,
    aiOpenAIPlatform: platform,
    aiBaseUrl: baseUrl,
    aiModel: model,
    aiReplyCount: normalizeAiReplyCount(aiReplyCountInput?.value),
    aiLanguage: 'auto',
    replyLanguage: ['post', 'zh', 'en', 'ja'].includes(replyLanguageSelect?.value) ? replyLanguageSelect.value : 'post',
  };
}

replyLanguageSelect?.addEventListener('change', () => saveAiProviderSettings(() => flash('回复语言已保存')));

function saveAiProviderSettings(callback) {
  const syncPatch = buildAiSyncPatch();
  chrome.storage.sync.set(syncPatch, () => {
    chrome.storage.local.set({ xvmAiApiKey: (aiApiKeyInput?.value || '').trim() }, () => {
      if (typeof callback === 'function') callback();
    });
  });
}

function normalizeCount(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

function normalize(raw) {
  const trending = parseInt(raw?.trending, 10);
  const viral = parseInt(raw?.viral, 10);
  const next = {
    trending: Number.isFinite(trending) && trending > 0 ? trending : DEFAULT_THRESHOLDS.trending,
    viral: Number.isFinite(viral) && viral > 0 ? viral : DEFAULT_THRESHOLDS.viral,
  };
  if (next.viral <= next.trending) next.viral = next.trending + 1;
  return next;
}

function normalizeGrokTemplates(raw, legacyPrompt) {
  const source = Array.isArray(raw) && raw.length
    ? raw
    : [{ id: 'default', name: tr('grokDefaultTemplateName'), prompt: legacyPrompt || DEFAULT_FEATURES.grokCommentPrompt }];
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const prompt = String(item?.prompt || '').trim();
    if (!prompt) continue;
    const id = String(item?.id || `tpl-${out.length + 1}`).trim() || `tpl-${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item?.name || tr('grokCustomTemplateName', [String(out.length + 1)])).trim() || tr('grokCustomTemplateName', [String(out.length + 1)]),
      prompt,
    });
  }
  return out.length ? out : DEFAULT_FEATURES.grokPromptTemplates.map((tpl) => ({ ...tpl }));
}

function fmtNum(n) { return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : n.toString(); }

function updateRangeLabels(v) {
  document.getElementById('range-green').textContent = `< ${fmtNum(v.trending)}/h`;
  document.getElementById('range-orange').textContent = `${fmtNum(v.trending)} ~ ${fmtNum(v.viral)}/h`;
  document.getElementById('range-red').textContent = `≥ ${fmtNum(v.viral)}/h`;
}

function flash(msg) {
  statusEl.textContent = msg;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

const buttonRestoreTimers = new WeakMap();

function showButtonSaved(button) {
  if (!button) return;
  const originalLabel = button.dataset.defaultLabel || button.textContent || tr('btnSave') || 'Save';
  button.dataset.defaultLabel = originalLabel;
  const existing = buttonRestoreTimers.get(button);
  if (existing) clearTimeout(existing);
  button.textContent = tr('btnSaved') || tr('flashSaved') || 'Saved';
  button.disabled = true;
  const timer = setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || tr('btnSave') || 'Save';
    button.disabled = false;
    buttonRestoreTimers.delete(button);
  }, 1500);
  buttonRestoreTimers.set(button, timer);
}

function fill(v) {
  trendingInput.value = v.trending;
  viralInput.value = v.viral;
  updateRangeLabels(v);
}

chrome.storage.sync.get(STORAGE_DEFAULTS, (items) => {
  try {
  const freshnessToggleEl = document.getElementById('feat-freshness');
  const freshnessHotMinutesEl = document.getElementById('freshness-hot-minutes');
  const freshnessHotColorEl = document.getElementById('freshness-hot-color');
  const freshnessFreshMinutesEl = document.getElementById('freshness-fresh-minutes');
  const freshnessWarmMinutesEl = document.getElementById('freshness-warm-minutes');
  const freshnessFreshColorEl = document.getElementById('freshness-fresh-color');
  const freshnessWarmColorEl = document.getElementById('freshness-warm-color');
  const unfollowedToggleEl = document.getElementById('feat-unfollowed');
  const unfollowedBlueToggleEl = document.getElementById('feat-unfollowed-blue');
  fill(normalize(items));
  leaderboardToggle.checked = !!items.featureVelocityLeaderboard;
  leaderboardEdgeHideToggle.checked = items.leaderboardEdgeHideEnabled !== false;
  copyMdToggle.checked = items.featureCopyAsMarkdown !== false;
  starChartToggle.checked = items.featureStarChart !== false;
  if (bookmarkFolderToggle) bookmarkFolderToggle.checked = !!items.featureBookmarkFolders;
  bookmarkCountToggle.checked = items.showBookmarkCount !== false;
  leaderboardCountInput.value = normalizeCount(items.leaderboardCount);
  if (commentBoardToggle) commentBoardToggle.checked = !!items.featureCommentBoard;
  if (commentBoardCountInput) commentBoardCountInput.value = normalizeCount(items.commentBoardCount);
  setCustomSelectValue(badgeStyleSelect, items.badgeStyle === 'inline-classic' ? 'inline-classic' : 'pill-solid');
  const storedLanguage = normalizeLanguage(items.language || initialLanguagePref);
  if (storedLanguage !== initialLanguagePref) {
    try { localStorage.setItem(LANGUAGE_KEY, storedLanguage); } catch (_) {}
    location.reload();
    return;
  }
  setCustomSelectValue(languageSelect, storedLanguage);
  updateLanguageToggle(storedLanguage);
  grokTemplatesState = normalizeGrokTemplates(items.grokPromptTemplates, items.grokCommentPrompt);
  grokSelectedTemplateId = items.grokSelectedPromptId || grokTemplatesState[0]?.id || 'default';
  if (!grokTemplatesState.some((tpl) => tpl.id === grokSelectedTemplateId)) {
    grokSelectedTemplateId = grokTemplatesState[0]?.id || 'default';
  }
  if (grokEnterReplyToggle) grokEnterReplyToggle.checked = items.grokEnterToReply === true;
  if (authorReplyPromptInput) authorReplyPromptInput.value = String(items.authorReplyPrompt || '').trim() || AUTHOR_REPLY_DEFAULT;
  if (inviteFollowPromptInput) inviteFollowPromptInput.value = String(items.inviteFollowPrompt || '').trim() || INVITE_FOLLOW_DEFAULT;
  setAiProviderValue(normalizeAiProvider(items.aiProvider));
  setCustomSelectValue(aiPlatformSelect, normalizeAiPlatform(items.aiOpenAIPlatform));
  if (aiBaseUrlInput) aiBaseUrlInput.value = items.aiBaseUrl || AI_PLATFORM_PRESETS[normalizeAiPlatform(items.aiOpenAIPlatform)].baseUrl;
  if (aiModelInput) aiModelInput.value = items.aiModel || AI_PLATFORM_PRESETS[normalizeAiPlatform(items.aiOpenAIPlatform)].model;
  if (aiReplyCountInput) aiReplyCountInput.value = normalizeAiReplyCount(items.aiReplyCount);
  if (replyLanguageSelect) {
    replyLanguageSelect.value = ['post', 'zh', 'en', 'ja'].includes(items.replyLanguage) ? items.replyLanguage : 'post';
  }
  if (freshnessToggleEl) freshnessToggleEl.checked = items.freshnessEnabled !== false;
  if (freshnessHotMinutesEl) freshnessHotMinutesEl.value = items.freshnessHotMinutes || 5;
  if (freshnessHotColorEl) freshnessHotColorEl.value = items.freshnessHotColor || '#f4212e';
  if (freshnessFreshMinutesEl) freshnessFreshMinutesEl.value = items.freshnessFreshMinutes || 10;
  if (freshnessWarmMinutesEl) freshnessWarmMinutesEl.value = items.freshnessWarmMinutes || 30;
  if (freshnessFreshColorEl) freshnessFreshColorEl.value = items.freshnessFreshColor || '#1d9bf0';
  if (freshnessWarmColorEl) freshnessWarmColorEl.value = items.freshnessWarmColor || '#f7b928';
  if (unfollowedToggleEl) unfollowedToggleEl.checked = items.unfollowedEnabled !== false;
  if (unfollowedBlueToggleEl) unfollowedBlueToggleEl.checked = items.unfollowedBlueOnly !== false;
  chrome.storage.local.get({ xvmAiApiKey: '' }, (localItems) => {
    if (aiApiKeyInput) aiApiKeyInput.value = localItems.xvmAiApiKey || '';
    updateAiProviderFields();
  });
  renderGrokTemplateEditor();
  columnsState = normalizeColumns(items.leaderboardColumns);
  renderColList();
  } catch (err) {
    if (statusEl) statusEl.textContent = err?.message || '设置读取失败';
  }
});

function renderGrokTemplateEditor() {
  if (!grokTemplateChips || !grokPromptInput || !grokTemplateNameInput) return;
  const active = grokTemplatesState.find((tpl) => tpl.id === grokSelectedTemplateId) || grokTemplatesState[0];
  if (active) grokSelectedTemplateId = active.id;
  grokTemplateChips.innerHTML = '';
  grokTemplatesState.forEach((tpl) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tpl-chip';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(tpl.id === grokSelectedTemplateId));
    chip.dataset.templateId = tpl.id;
    const label = document.createElement('span');
    label.className = 'tpl-chip-label';
    label.textContent = tpl.name;
    chip.appendChild(label);
    // Delete lives on the chip itself: the thing you remove is the thing you point at.
    if (grokTemplatesState.length > 1) {
      const del = document.createElement('span');
      del.className = 'tpl-chip-del';
      del.textContent = '×';
      del.title = tr('btnDelete');
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        flushGrokTemplateEdits();
        grokTemplatesState = grokTemplatesState.filter((t) => t.id !== tpl.id);
        if (grokSelectedTemplateId === tpl.id) grokSelectedTemplateId = grokTemplatesState[0]?.id || 'default';
        renderGrokTemplateEditor();
        persistGrokTemplates();
      });
      chip.appendChild(del);
    }
    chip.addEventListener('click', () => {
      if (tpl.id === grokSelectedTemplateId) return;
      flushGrokTemplateEdits();
      grokSelectedTemplateId = tpl.id;
      renderGrokTemplateEditor();
      persistGrokTemplates();
    });
    grokTemplateChips.appendChild(chip);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tpl-chip tpl-chip-add';
  add.textContent = '+';
  add.title = tr('btnAdd');
  add.addEventListener('click', () => {
    flushGrokTemplateEdits();
    const id = `custom-${Date.now()}`;
    grokTemplatesState.push({
      id,
      name: tr('grokCustomTemplateName', [String(grokTemplatesState.length + 1)]),
      prompt: DEFAULT_FEATURES.grokCommentPrompt,
    });
    grokSelectedTemplateId = id;
    renderGrokTemplateEditor();
    persistGrokTemplates();
    grokTemplateNameInput.focus();
    grokTemplateNameInput.select();
  });
  grokTemplateChips.appendChild(add);
  if (active) {
    grokTemplateNameInput.value = active.name;
    grokPromptInput.value = active.prompt;
  }
}

// Edits are written straight into state, then debounced to storage — no Save
// button to forget, and switching templates can't silently drop a draft.
let grokTemplateSaveTimer = null;

function flushGrokTemplateEdits() {
  const active = grokTemplatesState.find((tpl) => tpl.id === grokSelectedTemplateId);
  if (!active || !grokPromptInput || !grokTemplateNameInput) return;
  const fallbackName = tr('grokCustomTemplateName', [String(grokTemplatesState.indexOf(active) + 1 || 1)]);
  active.name = (grokTemplateNameInput.value || '').trim() || active.name || fallbackName;
  active.prompt = (grokPromptInput.value || '').trim() || DEFAULT_FEATURES.grokCommentPrompt;
}

function scheduleGrokTemplateSave() {
  clearTimeout(grokTemplateSaveTimer);
  grokTemplateSaveTimer = setTimeout(() => {
    flushGrokTemplateEdits();
    const chip = grokTemplateChips?.querySelector(`.tpl-chip[data-template-id="${grokSelectedTemplateId}"] .tpl-chip-label`);
    const active = grokTemplatesState.find((tpl) => tpl.id === grokSelectedTemplateId);
    if (chip && active) chip.textContent = active.name;
    persistGrokTemplates();
  }, 400);
}

function showGrokTemplateSaved() {
  if (!grokTplStatus) return;
  grokTplStatus.dataset.on = '1';
  clearTimeout(showGrokTemplateSaved._t);
  showGrokTemplateSaved._t = setTimeout(() => { delete grokTplStatus.dataset.on; }, 1400);
}

function showAuthorReplySaved() {
  if (!authorReplyStatus) return;
  authorReplyStatus.dataset.on = '1';
  clearTimeout(showAuthorReplySaved._t);
  showAuthorReplySaved._t = setTimeout(() => { delete authorReplyStatus.dataset.on; }, 1400);
}

function persistAuthorReplyPrompt(prompt) {
  chrome.storage.sync.set({ authorReplyPrompt: String(prompt || '').trim() }, showAuthorReplySaved);
}

function showInviteFollowSaved() {
  if (!inviteFollowStatus) return;
  inviteFollowStatus.dataset.on = '1';
  clearTimeout(showInviteFollowSaved._t);
  showInviteFollowSaved._t = setTimeout(() => { delete inviteFollowStatus.dataset.on; }, 1400);
}

authorReplyPromptInput?.addEventListener('input', () => {
  clearTimeout(persistAuthorReplyPrompt._t);
  persistAuthorReplyPrompt._t = setTimeout(() => persistAuthorReplyPrompt(authorReplyPromptInput.value), 400);
});
authorReplyResetBtn?.addEventListener('click', () => {
  if (authorReplyPromptInput) authorReplyPromptInput.value = AUTHOR_REPLY_DEFAULT;
  persistAuthorReplyPrompt('');
});

function persistInviteFollowPrompt(prompt) {
  chrome.storage.sync.set({ inviteFollowPrompt: String(prompt || '').trim() }, showInviteFollowSaved);
}

inviteFollowPromptInput?.addEventListener('input', () => {
  clearTimeout(persistInviteFollowPrompt._t);
  persistInviteFollowPrompt._t = setTimeout(() => persistInviteFollowPrompt(inviteFollowPromptInput.value), 400);
});
inviteFollowResetBtn?.addEventListener('click', () => {
  if (inviteFollowPromptInput) inviteFollowPromptInput.value = INVITE_FOLLOW_DEFAULT;
  persistInviteFollowPrompt('');
});

function persistGrokTemplates(messageKey = '') {
  const active = grokTemplatesState.find((tpl) => tpl.id === grokSelectedTemplateId) || grokTemplatesState[0];
  chrome.storage.sync.set({
    grokCommentPrompt: active?.prompt || DEFAULT_FEATURES.grokCommentPrompt,
    grokPromptTemplates: grokTemplatesState,
    grokSelectedPromptId: active?.id || 'default',
  }, () => {
    if (messageKey) flash(tr(messageKey));
    else showGrokTemplateSaved();
  });
}

function renderColList() {
  colListEl.innerHTML = '';
  columnsState.forEach((col, idx) => {
    const li = document.createElement('li');
    li.className = 'col-item' + (col.visible ? '' : ' col-hidden');
    li.draggable = true;
    li.dataset.idx = String(idx);
    li.dataset.id = col.id;
    li.innerHTML = `
      <span class="col-grip">⋮⋮</span>
      <input type="checkbox" ${col.visible ? 'checked' : ''}>
      <span class="col-name">${COLUMN_LABEL_KEYS[col.id] ? tr(COLUMN_LABEL_KEYS[col.id]) : col.id}</span>
    `;
    const checkbox = li.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      columnsState[idx].visible = checkbox.checked;
      li.classList.toggle('col-hidden', !checkbox.checked);
      persistColumns();
    });
    colListEl.appendChild(li);
  });
}

let draggingIdx = -1;
colListEl.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.col-item');
  if (!li) return;
  draggingIdx = Number(li.dataset.idx);
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Firefox requires data to be set to initiate drag
  e.dataTransfer.setData('text/plain', li.dataset.id);
});
colListEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const li = e.target.closest('.col-item');
  if (!li) return;
  colListEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  li.classList.add('drag-over');
});
colListEl.addEventListener('dragleave', (e) => {
  const li = e.target.closest('.col-item');
  if (li) li.classList.remove('drag-over');
});
colListEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const li = e.target.closest('.col-item');
  if (!li || draggingIdx < 0) return;
  const targetIdx = Number(li.dataset.idx);
  if (targetIdx === draggingIdx) return;
  const [moved] = columnsState.splice(draggingIdx, 1);
  columnsState.splice(targetIdx, 0, moved);
  draggingIdx = -1;
  renderColList();
  persistColumns();
});
colListEl.addEventListener('dragend', () => {
  draggingIdx = -1;
  colListEl.querySelectorAll('.dragging,.drag-over').forEach((el) => {
    el.classList.remove('dragging');
    el.classList.remove('drag-over');
  });
});

function persistColumns() {
  chrome.storage.sync.set({ leaderboardColumns: columnsState }, () => flash(tr('flashColumnsSaved')));
}

function saveFreshnessSettings() {
  const hot = Number.parseInt(freshnessHotMinutesInput?.value, 10);
  const fresh = Number.parseInt(freshnessFreshMinutesInput?.value, 10);
  const warm = Number.parseInt(freshnessWarmMinutesInput?.value, 10);
  chrome.storage.sync.set({
    freshnessEnabled: document.getElementById('feat-freshness')?.checked !== false,
    freshnessHotMinutes: Number.isFinite(hot) && hot >= 1 ? hot : 5,
    freshnessFreshMinutes: Number.isFinite(fresh) && fresh >= 1 ? fresh : 10,
    freshnessWarmMinutes: Number.isFinite(warm) && warm >= 1 ? warm : 30,
    freshnessHotColor: freshnessHotColorInput?.value || '#f4212e',
    freshnessFreshColor: freshnessFreshColorInput?.value || '#1d9bf0',
    freshnessWarmColor: freshnessWarmColorInput?.value || '#f7b928',
  }, () => flash(tr('flashFreshnessSaved') || '新鲜度设置已保存'));
}

document.getElementById('feat-freshness')?.addEventListener('change', saveFreshnessSettings);
freshnessHotMinutesInput?.addEventListener('change', saveFreshnessSettings);
freshnessHotColorInput?.addEventListener('change', saveFreshnessSettings);
freshnessFreshMinutesInput?.addEventListener('change', saveFreshnessSettings);
freshnessWarmMinutesInput?.addEventListener('change', saveFreshnessSettings);
freshnessFreshColorInput?.addEventListener('change', saveFreshnessSettings);
freshnessWarmColorInput?.addEventListener('change', saveFreshnessSettings);
function saveUnfollowedSettings() {
  chrome.storage.sync.set({
    unfollowedEnabled: unfollowedToggle ? unfollowedToggle.checked : true,
    unfollowedBlueOnly: unfollowedBlueToggle ? unfollowedBlueToggle.checked : true,
  }, () => flash('未关注标记已保存'));
}
unfollowedToggle?.addEventListener('change', saveUnfollowedSettings);
unfollowedBlueToggle?.addEventListener('change', saveUnfollowedSettings);

leaderboardToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ featureVelocityLeaderboard: leaderboardToggle.checked }, () => {
    flash(tr(leaderboardToggle.checked ? 'flashLeaderboardOn' : 'flashLeaderboardOff'));
  });
});

leaderboardEdgeHideToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ leaderboardEdgeHideEnabled: leaderboardEdgeHideToggle.checked }, () => {
    flash(tr(leaderboardEdgeHideToggle.checked ? 'flashLeaderboardEdgeHideOn' : 'flashLeaderboardEdgeHideOff'));
  });
});

commentBoardToggle?.addEventListener('change', () => {
  chrome.storage.sync.set({ featureCommentBoard: commentBoardToggle.checked }, () => {
    flash(tr(commentBoardToggle.checked ? 'flashCommentBoardOn' : 'flashCommentBoardOff'));
  });
});

commentBoardCountInput?.addEventListener('change', () => {
  const n = normalizeCount(commentBoardCountInput.value);
  commentBoardCountInput.value = n;
  chrome.storage.sync.set({ commentBoardCount: n }, () => flash(tr('flashCommentBoardCountSaved', [String(n)])));
});

copyMdToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ featureCopyAsMarkdown: copyMdToggle.checked }, () => {
    flash(tr(copyMdToggle.checked ? 'flashCopyMdOn' : 'flashCopyMdOff'));
  });
});

starChartToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ featureStarChart: starChartToggle.checked }, () => {
    flash(tr(starChartToggle.checked ? 'flashStarChartOn' : 'flashStarChartOff'));
  });
});

bookmarkFolderToggle?.addEventListener('change', () => {
  chrome.storage.sync.set({ featureBookmarkFolders: bookmarkFolderToggle.checked }, () => {
    flash(tr(bookmarkFolderToggle.checked ? 'flashBookmarkFoldersOn' : 'flashBookmarkFoldersOff'));
  });
});

bookmarkCountToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ showBookmarkCount: bookmarkCountToggle.checked }, () => {
    flash(tr(bookmarkCountToggle.checked ? 'flashBookmarkCountOn' : 'flashBookmarkCountOff'));
  });
});

grokEnterReplyToggle?.addEventListener('change', () => {
  chrome.storage.sync.set({ grokEnterToReply: grokEnterReplyToggle.checked }, () => {
    flash(tr(grokEnterReplyToggle.checked ? 'flashGrokEnterReplyOn' : 'flashGrokEnterReplyOff'));
  });
});

aiProviderOptions.forEach((btn) => {
  btn.addEventListener('click', () => {
    setAiProviderValue(btn.dataset.aiProviderOption, { dispatch: true });
  });
  btn.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const current = aiProviderOptions.indexOf(btn);
    const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    const next = aiProviderOptions[(current + step + aiProviderOptions.length) % aiProviderOptions.length];
    next?.focus();
    next?.click();
  });
});

aiProviderSelect?.addEventListener('change', () => {
  if (aiProviderSelect.value === 'ollama') {
    if (aiBaseUrlInput) aiBaseUrlInput.value = 'http://localhost:11434';
    if (aiModelInput) aiModelInput.value = 'llama3.1';
  } else if (aiProviderSelect.value === 'openai-compatible') {
    applyAiPlatformPreset(aiPlatformSelect?.value, true);
  }
  updateAiProviderFields();
  setAiTestStatus('');
});

aiPlatformSelect?.addEventListener('change', () => {
  applyAiPlatformPreset(aiPlatformSelect.value, true);
  updateAiProviderFields();
  setAiTestStatus('');
});

aiProviderSaveBtn?.addEventListener('click', () => {
  aiProviderSaveBtn.disabled = true;
  saveAiProviderSettings(() => {
    updateAiProviderFields();
    flash(tr('flashAiProviderSaved') || 'AI provider settings saved');
    showButtonSaved(aiProviderSaveBtn);
  });
});

aiTestConnectionBtn?.addEventListener('click', () => {
  setAiTestStatus(tr('aiTestRunning') || 'Testing connection...');
  aiTestConnectionBtn.disabled = true;
  saveAiProviderSettings(() => {
    chrome.runtime.sendMessage({ type: 'XVM_AI_TEST_CONNECTION' }, (res) => {
      aiTestConnectionBtn.disabled = false;
      if (chrome.runtime.lastError) {
        setAiTestStatus(chrome.runtime.lastError.message || 'Connection test failed', 'error');
        return;
      }
      if (res?.ok) {
        setAiTestStatus(res.message || (tr('aiTestOk') || 'Connection test passed'), 'ok');
      } else {
        setAiTestStatus(res?.error || (tr('aiTestFailed') || 'Connection test failed'), 'error');
      }
    });
  });
});

grokTemplateNameInput?.addEventListener('input', scheduleGrokTemplateSave);
grokPromptInput?.addEventListener('input', scheduleGrokTemplateSave);
// The popup can be dismissed mid-debounce; commit pending edits on the way out.
const commitGrokTemplateEdits = () => { clearTimeout(grokTemplateSaveTimer); flushGrokTemplateEdits(); persistGrokTemplates(); };
window.addEventListener('blur', commitGrokTemplateEdits);
window.addEventListener('pagehide', commitGrokTemplateEdits);

grokPromptResetBtn?.addEventListener('click', () => {
  clearTimeout(grokTemplateSaveTimer);
  grokTemplatesState = DEFAULT_FEATURES.grokPromptTemplates.map((tpl) => ({ ...tpl }));
  grokSelectedTemplateId = DEFAULT_FEATURES.grokSelectedPromptId;
  renderGrokTemplateEditor();
  persistGrokTemplates('flashGrokPromptReset');
});

leaderboardCountInput.addEventListener('change', () => {
  const n = normalizeCount(leaderboardCountInput.value);
  leaderboardCountInput.value = n;
  chrome.storage.sync.set({ leaderboardCount: n }, () => flash(tr('flashShowingTop', [String(n)])));
});

badgeStyleSelect.addEventListener('change', () => {
  const style = badgeStyleSelect.value === 'inline-classic' ? 'inline-classic' : 'pill-solid';
  chrome.storage.sync.set({ badgeStyle: style }, () => flash(tr('flashBadgeStyleSaved')));
});

languageSelect?.addEventListener('change', () => {
  applyLanguageChange(languageSelect.value);
});

languageToggle?.addEventListener('click', () => {
  const current = normalizeLanguage(languageSelect?.value || initialLanguagePref);
  const idx = SUPPORTED_LANGUAGE_IDS.indexOf(current);
  const next = SUPPORTED_LANGUAGE_IDS[(Math.max(idx, 0) + 1) % SUPPORTED_LANGUAGE_IDS.length];
  applyLanguageChange(next);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = normalize({ trending: trendingInput.value, viral: viralInput.value });
  const style = badgeStyleSelect.value === 'inline-classic' ? 'inline-classic' : 'pill-solid';
  fill(v);
  chrome.storage.sync.set({ ...v, badgeStyle: style }, () => flash(tr('flashSaved')));
});

resetBtn.addEventListener('click', () => {
  fill(DEFAULT_THRESHOLDS);
  setCustomSelectValue(badgeStyleSelect, 'pill-solid');
  chrome.storage.sync.set({ ...DEFAULT_THRESHOLDS, badgeStyle: 'pill-solid' }, () => flash(tr('flashReset')));
});

// #45 dev3 add-on: leaderboard "reset position" button. Clears the three
// persisted dimensions (pos / width / height) so the panel returns to its
// default on the next page load. Simple version — user must refresh; the
// live-reset path goes through bridge → content.js and is queued as a
// follow-up task in #dev.
const lbResetBtn = document.getElementById('lb-reset-pos');
const lbResetMsg = document.getElementById('lb-reset-msg');
lbResetBtn?.addEventListener('click', () => {
  chrome.storage.local.remove(
    ['xvmLeaderboardPos', 'xvmLeaderboardWidth', 'xvmLeaderboardHeight'],
    () => {
      if (!lbResetMsg) return;
      lbResetMsg.textContent = tr('featureLeaderboardResetDone');
      setTimeout(() => { lbResetMsg.textContent = ''; }, 2500);
    }
  );
});

// Footer version: read from manifest so it never drifts from the actual
// shipped build.
const versionEl = document.getElementById('popup-version');
if (versionEl) {
  try { versionEl.textContent = chrome.runtime.getManifest().version; } catch (_) {}
}
