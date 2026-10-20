import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSrc = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const zhMessages = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
// content.js resolves its copy through i18n(); stand in for the localizedStrings
// push so the extracted functions render the real shipped zh_CN text.
const i18n = (key) => zhMessages[key]?.message || key;

describe('AI error toast', () => {
  it('renders the real failure as text without sending a Grok message or interpreting HTML', () => {
    const nodes = [];
    const makeNode = () => ({ style: {}, children: [], classList: { add() {} }, append(...children) { this.children.push(...children); } });
    const document = {
      createElement: makeNode,
      body: { appendChild: (node) => nodes.push(node) },
    };
    const start = contentSrc.indexOf('function showGrokErrorToast(');
    const end = contentSrc.indexOf('function getSelectedGrokPromptTemplate()', start);
    const ctx = { document, requestAnimationFrame: (fn) => fn(), setTimeout() {}, dismissToast() {}, i18n };
    vm.runInNewContext(contentSrc.slice(start, end), ctx);
    ctx.showGrokErrorToast('<img src=x onerror=alert(1)> HTTP 429');
    expect(nodes[0].children[0].textContent).toBe('⚠ AI 生成失败');
    expect(nodes[0].children[1].textContent).toBe('<img src=x onerror=alert(1)> HTTP 429');
    expect(nodes[0].innerHTML).toBeUndefined();
  });
});
