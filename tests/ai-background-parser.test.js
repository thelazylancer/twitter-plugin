import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const backgroundJs = readFileSync(resolve(repo, 'background.js'), 'utf8');

function loadBackgroundDebug(fetchImpl = async () => ({ ok: true, json: async () => ({}) })) {
  const context = {
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        sync: { get: async () => ({}) },
        local: { get: async () => ({}) },
      },
    },
    fetch: fetchImpl,
    URL,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(backgroundJs, context);
  return context;
}

describe('AI background comment parser', () => {
  it('sanitizes incompatible control and Unicode code units before rendering the AI prompt', () => {
    const { renderPrompt } = loadBackgroundDebug();

    const prompt = renderPrompt('\uFEFFCafe\u0301\u0000\n\t正文\u000B\uD800', '[推文内容]', 1);

    expect(prompt).toContain('Café\n\t正文\uFFFD');
    const english = renderPrompt('This post is in English.', '为该推文生成3条评论', 3, { replyLanguage: 'post' });
    expect(english).toContain('Write every reply in English only');
    const breakfast = renderPrompt('早上好朋友们\n\n吃个扬州早茶 https://pic.x.com/vrvEmSMCvmhttps://pic.x.com/vrvEmSMCvmhttps://pic.x.com/vrvEmSMCvmhttps://pic.x.com/vrvEmSMCvm', 'Write 3 replies', 3, { replyLanguage: 'post' });
    expect(breakfast).toContain('每条回复必须使用中文');
    const chineseWithLink = renderPrompt('大家觉得这个怎么样 https://example.com/a/very/long/english/path', 'Write 3 replies', 3, { replyLanguage: 'post' });
    expect(chineseWithLink).toContain('每条回复必须使用中文');
    const forced = renderPrompt('This post is in English.', '为该推文生成3条评论', 3, { replyLanguage: 'zh' });
    expect(forced).toContain('每条回复必须使用中文');
    expect(prompt).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF]/);
  });

  it('reads the post language, not the Chinese \u5173\u6CE8\u72B6\u6001 note appended to it', () => {
    const { renderPrompt } = loadBackgroundDebug();
    const note = '\u3010\u5173\u6CE8\u72B6\u6001\u3011\u4F60\u548C@ann\u662F\u4E92\u76F8\u5173\u6CE8';

    expect(renderPrompt(`\u65E5\u672C\u8A9E\u306E\u30C6\u30B9\u30C8\u3002\n\n${note}`, '[\u63A8\u6587\u5185\u5BB9]', 3, { replyLanguage: 'post' }))
      .toContain('\u5404\u8FD4\u4FE1\u306F\u65E5\u672C\u8A9E\u306E\u307F\u3067\u66F8\u304F\u3053\u3068');
    expect(renderPrompt(`Ship it.\n\n${note}`, '[\u63A8\u6587\u5185\u5BB9]', 3, { replyLanguage: 'post' }))
      .toContain('Write every reply in English only');
    const authorContext = `\u3010\u4E3B\u8D34\u3011\nToday I shipped a thing.\n\n\u3010\u5F53\u524D\u8BC4\u8BBA\u3011\n@ann\uFF1ANice work!\n\n${note}`;
    expect(renderPrompt(authorContext, '[\u63A8\u6587\u5185\u5BB9]', 3, { replyLanguage: 'post' }))
      .toContain('Write every reply in English only');
  });

  it('splits a single code block that contains multiple line-based candidates', () => {
    const { extractComments } = loadBackgroundDebug();
    const raw = '```\n这个兔子看着就很好聊\n她是不是也愣了一下\n你俩座位连一起，缘分啊\n兔子是她的吉祥物吗\n一会儿问问是不是自己缝的\n这兔子表情有点嚣张\n感觉她也是个有趣的人\n起飞前先酝酿一下话题\n兔子耳朵这么长，能聊很久\n说不定她会主动跟你讲兔子的故事\n```';

    expect(extractComments(raw, 10)).toEqual([
      '这个兔子看着就很好聊',
      '她是不是也愣了一下',
      '你俩座位连一起，缘分啊',
      '兔子是她的吉祥物吗',
      '一会儿问问是不是自己缝的',
      '这兔子表情有点嚣张',
      '感觉她也是个有趣的人',
      '起飞前先酝酿一下话题',
      '兔子耳朵这么长，能聊很久',
      '说不定她会主动跟你讲兔子的故事',
    ]);
  });

  it('streams OpenAI-compatible chunks and emits parsed progress', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"```\\n这个兔子看着就很好聊\\n她是不是也愣了一下\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你俩座位连一起，缘分啊\\n兔子是她的吉祥物吗\\n一会儿问问是不是自己缝的\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"这兔子表情有点嚣张\\n感觉她也是个有趣的人\\n起飞前先酝酿一下话题\\n兔子耳朵这么长，能聊很久\\n说不定她会主动跟你讲兔子的故事\\n```"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const context = loadBackgroundDebug(async () => ({ ok: true, body: stream }));
    const progress = [];

    const comments = await context.generateWithOpenAICompatible({
      provider: 'openai-compatible',
      platform: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      replyCount: 10,
      apiKey: 'test-key',
    }, {
      tweetText: 'tweet',
      promptTemplate: '[推文内容]',
    }, (items) => progress.push(items));

    expect(comments).toHaveLength(10);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toHaveLength(10);
  });
});
