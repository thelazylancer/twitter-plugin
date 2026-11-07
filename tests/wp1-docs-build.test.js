// WP1 自测：文档与构建配置修复的静态契约 + 用 node:vm 真执行 build-dist.mjs
// 里的 readChannel / channelMarker。只读，不构建、不写 dist/、不装依赖。
//
// 说明（总指挥官裁决）：scripts/build-dist.mjs 的 readChannel 缺省值保持
// 'store' 不变、channelMarker 注释文字也不改。真正面向用户的错位由 README
// 开发段改用 build:community 解决。本文件因此把「缺省 = store」作为现状
// 快照锁定，而不是期望 community-dev。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const skill = readFileSync(resolve(repo, '.claude/skills/release/SKILL.md'), 'utf8');
const readme = readFileSync(resolve(repo, 'README.md'), 'utf8');
const readmeEn = readFileSync(resolve(repo, 'README.en.md'), 'utf8');
const changelog = readFileSync(resolve(repo, 'CHANGELOG.md'), 'utf8');
const buildScript = readFileSync(resolve(repo, 'scripts/build-dist.mjs'), 'utf8');

// 从真实源码里切出 CHANNELS 常量与两个纯函数，塞进 vm 真执行（不 import 模块，
// 因为顶层 main() 会动 dist/）。切片范围：const CHANNELS → function distFilter。
function loadBuildHelpers() {
  const chStart = buildScript.indexOf('const CHANNELS');
  const readStart = buildScript.indexOf('function readChannel(');
  const markerStart = buildScript.indexOf('function channelMarker(');
  const filterStart = buildScript.indexOf('function distFilter(');
  expect(chStart, 'CHANNELS 常量必须存在').toBeGreaterThanOrEqual(0);
  expect(readStart, 'readChannel 必须存在').toBeGreaterThanOrEqual(0);
  expect(markerStart, 'channelMarker 必须存在').toBeGreaterThanOrEqual(0);
  expect(filterStart, 'distFilter 必须存在').toBeGreaterThanOrEqual(0);

  const chLine = buildScript.slice(chStart, buildScript.indexOf('\n', chStart));
  const readFn = buildScript.slice(readStart, markerStart);
  const markerFn = buildScript.slice(markerStart, filterStart);
  const snippet = [
    chLine,
    readFn,
    markerFn,
    'this.readChannel = readChannel; this.channelMarker = channelMarker; this.CHANNELS = CHANNELS;',
  ].join('\n');

  const ctx = {};
  runInNewContext(snippet, ctx);
  return ctx;
}

describe('WP1.1 release skill 重写为本 fork 真实流程', () => {
  it('正面：描述 community-dev / GitHub Release / 两条真实打包命令', () => {
    expect(skill).toContain('community-dev');
    expect(skill).toContain('GitHub Release');
    expect(skill).toContain('build:community');
    expect(skill).toContain('package:community');
    expect(skill).toContain('scripts/package-zip.mjs');
    expect(skill).toContain('dist/');
    expect(skill).toContain('release/');
    expect(skill).toContain('.gitignore');
  });

  it('frontmatter 保留全部调用契约触发词', () => {
    for (const trigger of ['/release', '发版', '打包发布', '打包', 'bump version', '更新版本']) {
      expect(skill, `触发词 ${trigger} 不能丢`).toContain(trigger);
    }
  });

  it('负面：删除上游商店版残留（Compress-Archive / 商店上传 / 错误文件清单）', () => {
    expect(skill).not.toContain('Compress-Archive');
    expect(skill).not.toContain('上传 Chrome Web Store');
    expect(skill).not.toContain('Chrome Web Store upload');
    // 旧 skill 那份手工文件清单的特征行，不应再出现
    expect(skill).not.toMatch(/Compress-Archive -Path/);
    expect(skill).not.toMatch(/userscript\/x-viral-monitor\.user\.js/);
    // 明确写出「不上架商店」的正确否定陈述
    expect(skill).toContain('不上架 Chrome Web Store / Edge');
  });

  it('负面：git push 只允许出现在「不要做」的否定语境（精确逐行断言）', () => {
    const pushLines = skill.split('\n').filter((l) => l.includes('git push'));
    // 文档必须明确劝阻，而不是靠「一个字都不提」来通过
    expect(pushLines.length, '应明确写出不要 git push').toBeGreaterThan(0);
    for (const line of pushLines) {
      expect(line, `git push 只能出现在否定语境: ${line}`).toMatch(
        /不要|do not|不会|不执行|不要替|Do not/i,
      );
    }
    // 不得出现「运行 git push」这类肯定式指令
    expect(skill).not.toMatch(/Run\s+`?git push/i);
    expect(skill).not.toMatch(/运行\s+`?git push/);
  });
});

describe('WP1.2 README 过时描述修正', () => {
  it('README.md 不再描述 600 字阈值 / 文章模板组 / 双份模板存储', () => {
    expect(readme).not.toContain('≥600 字走文章模板组');
    expect(readme).not.toContain('文章模板**分开存储');
    expect(readme).not.toContain('推文 / 文章自动判定');
  });

  it('README.md 描述当前真实行为：单一模板列表 + articleMd + 多语言数量', () => {
    expect(readme).toContain('单一模板列表');
    expect(readme).toContain('articleMd');
    expect(readme).toContain('中文 6');
    expect(readme).toContain('各 5');
    expect(readme).toContain('{推文内容}'); // 占位符的正确描述保留
  });

  it('README.md 开发段改用 build:community，sync:rules 指向 bootstrap-rules.json', () => {
    expect(readme).toContain('build:community');
    expect(readme).toContain('bootstrap-rules.json');
    expect(readme).not.toContain('npm run sync:rules     # 只同步 rules.json → rules.js');
    expect(readme).not.toContain('改完源码运行 `npm run build:dist` 后到扩展页面点');
  });

  it('README.md :167 的正确陈述仍保留，且与改后的 :265 不矛盾', () => {
    expect(readme).toContain('`npm run build:dist` 构建的是 store 渠道（保留 Pro 闸门），仅用于和上游保持一致，这个 fork 不上架');
    expect(readme).toContain('日常开发请用 `build:community`');
  });

  it('README.en.md :41 不再含过时的 "rules.json -> rules.js only"', () => {
    expect(readmeEn).not.toContain('rules.json -> rules.js only');
    expect(readmeEn).toContain('bootstrap-rules.json');
  });
});

describe('WP1.3 CHANGELOG 补齐 fork 变更', () => {
  // 只取 [Unreleased] 段（到下一个 ## [ 版本标题为止）
  const unreleased = changelog.slice(
    changelog.indexOf('## [Unreleased]'),
    changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1),
  );

  it('[Unreleased] 含 Fork changes 小节与版本号 1.18.18', () => {
    expect(unreleased).toContain('Fork changes (since v1.18.17)');
    expect(unreleased).toContain('1.18.18');
    expect(unreleased).toContain('b1b896d');
  });

  it('[Unreleased] 覆盖各主题（命名上下文槽位 / 互惠榜 / 热点面板 / 性能 / 构建文档）', () => {
    expect(unreleased).toMatch(/命名上下文槽位|命名.*槽位|named context slot/);
    expect(unreleased).toMatch(/\{作者\}/);
    expect(unreleased).toMatch(/\{关注状态\}/);
    expect(unreleased).toContain('互惠榜');
    expect(unreleased).toContain('回复热点');
    expect(unreleased).toContain('蓝 V 权重');
    expect(unreleased).toContain('2 秒 tick');
    expect(unreleased).toContain('community-dev');
    expect(unreleased).toContain('1.18.18');
  });

  it('[Unreleased] Internal 据实记录本次重构（不再保留中性占位）', () => {
    // 交付前 WP-A 留的是「见本次重构」中性占位，意图是防止编造未落盘的改动；
    // 重构全部落盘后应由总指挥官据实化，本断言随之从「中性」收紧为「据实」。
    expect(unreleased).not.toContain('见本次重构');
    expect(unreleased).toContain('src/ai-defaults.data.json');
    expect(unreleased).toContain('scripts/sync-ai-defaults.mjs');
    expect(unreleased).toContain('lib/scroll-restore-guard.js');
    expect(unreleased).toContain('lib/bounded-store.js');
    expect(unreleased).toContain('功能不变');
    expect(unreleased).toContain('77 项');
  });
});

describe('WP1.4 build-dist.mjs 渠道解析（现状快照 + 边界，缺省保持 store）', () => {
  const { readChannel, channelMarker, CHANNELS } = loadBuildHelpers();

  it('CHANNELS 集合恰好是 store / community-dev', () => {
    // node:vm 是独立 realm，instanceof Set 跨 realm 会 false；用 tag 判定。
    expect(Object.prototype.toString.call(CHANNELS)).toBe('[object Set]');
    expect(CHANNELS.has('store')).toBe(true);
    expect(CHANNELS.has('community-dev')).toBe(true);
    expect(CHANNELS.size).toBe(2);
  });

  it('正常路径：显式 channel 与缺省值（现状 = store）', () => {
    expect(readChannel([])).toBe('store');
    expect(readChannel(['--channel', 'store'])).toBe('store');
    expect(readChannel(['--channel', 'community-dev'])).toBe('community-dev');
    // 多余参数不影响解析
    expect(readChannel(['--other', 'x', '--channel', 'community-dev'])).toBe('community-dev');
  });

  it('边界 / 非法输入：至少 2 个用例抛错', () => {
    expect(() => readChannel(['--channel', 'bogus'])).toThrow();
    expect(() => readChannel(['--channel'])).toThrow(); // 缺值
    expect(() => readChannel(['--channel', ''])).toThrow(); // 空值
    expect(() => readChannel(['--channel', 'STORE'])).toThrow(); // 大小写敏感
    expect(() => readChannel(['--channel', 'community_dev'])).toThrow(); // 近似但非法
  });

  it('channelMarker 输出与传入 channel 一致，且含测试锁定的两行字面串', () => {
    const dev = channelMarker('community-dev');
    expect(dev).toContain("const channel = 'community-dev'");
    expect(dev).toContain("root.__xvmIsCommunityDevBuild = channel === 'community-dev'");
    expect(dev).toContain('__XVM_BUILD_CHANNEL__');

    const store = channelMarker('store');
    expect(store).toContain("const channel = 'store'");
    expect(store).toContain("root.__xvmIsCommunityDevBuild = channel === 'community-dev'");
  });

  it('回归护栏：build-dist-sync.test.js 锁定的 4 个字面串一个都不少', () => {
    expect(buildScript).toContain("new Set(['store', 'community-dev'])");
    expect(buildScript).toContain('const channel = readChannel(process.argv.slice(2))');
    expect(buildScript).toContain("writeFileSync(resolve(dist, 'src/build-channel.js'), channelMarker(channel))");
    expect(buildScript).toContain("root.__xvmIsCommunityDevBuild = channel === 'community-dev'");
    // 本工作包按裁决未改缺省值 / channelMarker 注释，记录现状
    expect(buildScript).toContain("const raw = idx >= 0 ? argv[idx + 1] : 'store'");
    expect(buildScript).toContain('Source defaults to store.');
  });
});
