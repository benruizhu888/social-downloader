#!/usr/bin/env node
/**
 * 体检一条链接：它会走哪条流程、界面会怎么提示、开跑会不会被拦。
 *
 * 为什么要有这个工具：用户最常问的三句话是「这条链接怎么下不了」「为什么提示我改链接」
 * 「到底该粘什么」。以前只能靠猜——现在把主进程真实用的那份判定（url-parse 的
 * parseInputList / classifyDouyinUrl / 各适配器的 inspectInput）原样跑一遍，
 * 输出就是界面与日志里会出现的那几句话，**一字不差**。
 *
 * 用法：
 *   node tools/inspect-input.js "https://www.douyin.com/jingxuan/search/爱心代码?type=general"
 *   node tools/inspect-input.js "https://www.douyin.com/user/MS4wLjABAAAAxxxx"
 *
 * 三平台适配器在模块顶层就 require('electron')，纯 Node 里加载不了注册表，
 * 所以这里注入最小桩（与 test/platform-contract.test.js 同一手法，只加载期够用）。
 */

const Module = require('module');
const { parseInputList, parseSingleUrl, classifyDouyinUrl, extractUrl } = require('../src/main/url-parse');

function withElectronStub(fn) {
  const orig = Module._resolveFilename;
  const stub = require.resolve('../test/lib/electron-stub');
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stub;
    return orig.call(this, request, ...rest);
  };
  try {
    return fn();
  } finally {
    Module._resolveFilename = orig;
  }
}

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('用法：node tools/inspect-input.js "<粘贴的链接>"');
  process.exit(2);
}

const registry = withElectronStub(() => require('../src/main/platforms/registry'));

/** 与主进程 input:inspect 一样：逐个问适配器「这条输入有没有问题」 */
function inputProblemOf(text) {
  for (const p of registry.list) {
    if (typeof p.inspectInput !== 'function') continue;
    try {
      const r = p.inspectInput(text);
      if (r && r.problem) return { platform: p.id, problem: r.problem };
    } catch {
      /* 适配器自己的判断出错不能影响体检 */
    }
  }
  return null;
}

const url = extractUrl(input);
console.log(`输入：${input}`);
console.log(`抠出的 URL：${url || '（没抠出来 —— 不含受支持站点的地址）'}`);

if (url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./i, '');
  const trimmed = host.replace(/^www\./i, '');
  if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(trimmed)) {
    const c = classifyDouyinUrl(u);
    console.log(`抖音形状判定：${c.kind}${c.id ? `（作品 id=${c.id}）` : ''}`);
  } else {
    console.log('非抖音地址（本工具只展开抖音的形状判定）');
  }
}

const list = parseInputList(input);
console.log(`\n识别结果：非空行 ${list.lines} 行，作品链接 ${list.targets.length} 条，跳过 ${list.ignored.length} 行`);
for (const x of list.ignored) console.log(`  跳过：${x.reason} —— ${x.line.slice(0, 70)}`);

const single = list.targets[0] || (list.lines === 1 ? parseSingleUrl(input) : null);
if (single) {
  console.log(
    single.shortLink
      ? '→ 走【作品链接流程】：短链，开始时先联网展开，再只下这一条'
      : `→ 走【作品链接流程】：${single.platform} 单作品 id=${single.itemId}\n   打开地址：${single.url}`
  );
} else {
  const bad = inputProblemOf(input);
  if (bad) {
    console.log(`→ 主进程会判成 invalid（${bad.platform} 适配器给出说明）：`);
    console.log(`   界面提示条 ⚠️ ${bad.problem}`);
    console.log('   开跑：在开浏览器之前就拦下（不会白等 20~40 秒）');
  } else {
    console.log('→ 走【博主主页流程】（认不出，按老路子处理）');
  }
}

console.log('\n保存位置：');
console.log('  博主主页  {保存目录}/douyin_<sec_uid>/<日期>_<标题>_<作品id>/');
console.log('  单条/多条 {保存目录}/douyin_<作品id>/  或  douyin_batch/<日期>_<标题>_<作品id>/');
