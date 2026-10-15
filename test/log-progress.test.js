/**
 * 日志分级/筛选、进度时长格式、以及「日志与实时进度」这两块界面的回归底线（纯 Node）。
 *
 * 为什么要单独一个文件：
 *   1. 日志的级别判定与筛选这两个函数**过去没有单测**，而它们决定了「出问题时能不能
 *      一眼看到错误行」—— 判错了就是「日志看着一切正常、结果不对」。
 *   2. 界面的可用性（能筛、能搜、不把用户滚回底部）靠静态断言守住：这些能力一旦
 *      被后续改动顺手删掉，功能还在但体验已退化，跑测试是唯一的提醒。
 *
 * 跑法：node test/log-progress.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const DIR = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + '\n      ' + e.message);
  }
}

/**
 * 从 app.js 里把某个函数声明的源码抠出来。
 * app.js 是给 <script src> 用的经典脚本（末尾直接 init()，顶层就操作 DOM），
 * 在纯 Node 里 require 不了 —— 所以按大括号配对取出目标函数，丢进 vm 里单测。
 * 这套做法与 single-download 那边「判定源码必须自包含、能编译成可调用函数」是同一条思路。
 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`app.js 里找不到 function ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let d = 1;
          i += 2;
          while (i < src.length && d > 0) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) break; }
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 的大括号不配对`);
}

const sandbox = {};
const api = vm.runInNewContext(
  [
    '"use strict";',
    'let state = { logFilter: "all", logQuery: "" };',
    extractFn(js, 'normalizeLevel'),
    extractFn(js, 'logVisible'),
    extractFn(js, 'fmtDuration'),
    '({ normalizeLevel, logVisible, fmtDuration, setState: (s) => { state = s; } });',
  ].join('\n'),
  sandbox
);

/* ------------------------------ 日志分级 ------------------------------ */

console.log('\n[日志分级 normalizeLevel]');

t('主进程只发 message 时，失败类消息被判成 err', () => {
  for (const m of [
    '下载失败：a.jpg HTTP 403',
    '没能读取这条微博（id=xx）：可能是链接已失效',
    'Live 转 MOV 失败：a.mov → ffmpeg 退出码 1',
    '登录窗口的页面异常退出，请重新点击「登录」再试一次',
    'ffmpeg 不可用，已跳过转换（原文件已保留）',
  ]) {
    assert.strictEqual(api.normalizeLevel(m, ''), 'err', m);
  }
});

t('「跳过 / 已排除 / 超出上限」判成 warn 而不是 err', () => {
  for (const m of [
    '已跳过 3 条其它平台的链接（当前面板是微博）',
    '已排除 12 条转发微博（其图片属于原作者）',
    '作品数 120 超过上限 60，只处理前 60 个',
  ]) {
    assert.strictEqual(api.normalizeLevel(m, ''), 'warn', m);
  }
});

t('「失败 0」这种成功收尾判成 ok，不因为句子里有「失败」就标红', () => {
  // 标红一次是「提醒」，标红十次就变成「噪音」，用户会开始忽略颜色
  assert.strictEqual(api.normalizeLevel('视频转 MOV 完成：成功 3，失败 0', ''), 'ok');
  assert.strictEqual(api.normalizeLevel('下载完成：新增 12，跳过 3，失败 0', ''), 'ok');
  // 失败数不为 0 时必须报出来
  assert.strictEqual(api.normalizeLevel('下载完成：新增 12，跳过 3，失败 2', ''), 'err');
});

t('完成/成功类判成 ok，其余为 info', () => {
  assert.strictEqual(api.normalizeLevel('视频已保存到 D:\\out', ''), 'ok');
  assert.strictEqual(api.normalizeLevel('共读取 128 条微博', ''), 'info');
  assert.strictEqual(api.normalizeLevel('博主 UID：WEIBO_UID_PLACEHOLDER', ''), 'info');
});

t('调用方显式给的 kind 优先于关键词推断', () => {
  assert.strictEqual(api.normalizeLevel('日志已导出：D:\\a.log', 'ok'), 'ok');
  assert.strictEqual(api.normalizeLevel('这条读起来像失败，但其实是信息', 'info'), 'info');
  assert.strictEqual(api.normalizeLevel('随便一句', 'err'), 'err');
});

/* ------------------------------ 日志筛选 ------------------------------ */

console.log('\n[日志筛选 logVisible]');

const E = (level, text) => ({ level, text, t: '09:00:00' });

t('级别为 all 时全部显示', () => {
  api.setState({ logFilter: 'all', logQuery: '' });
  for (const e of [E('info', 'a'), E('ok', 'b'), E('warn', 'c'), E('err', 'd')]) {
    assert.ok(api.logVisible(e), e.text);
  }
});

t('选中某个级别后只显示该级别', () => {
  api.setState({ logFilter: 'err', logQuery: '' });
  assert.ok(api.logVisible(E('err', '下载失败：x.jpg')));
  assert.ok(!api.logVisible(E('info', '下载失败：x.jpg')), '级别不符就不该显示，哪怕文本像错误');
  assert.ok(!api.logVisible(E('warn', '已跳过 3 条')));
});

t('关键字筛选大小写不敏感，且与级别是「与」关系', () => {
  api.setState({ logFilter: 'all', logQuery: 'JPG' });
  assert.ok(api.logVisible(E('info', '已跳过 a.jpg')));
  assert.ok(!api.logVisible(E('info', '已跳过 a.png')));
  api.setState({ logFilter: 'err', logQuery: 'jpg' });
  assert.ok(!api.logVisible(E('info', 'a.jpg')), '级别不匹配时关键字命中也不显示');
  assert.ok(api.logVisible(E('err', 'a.jpg 403')));
});

t('关键字为空串时不参与过滤（不是「全都过滤掉」）', () => {
  api.setState({ logFilter: 'all', logQuery: '' });
  assert.ok(api.logVisible(E('info', '任意内容')));
});

/* ------------------------------ 时长格式 ------------------------------ */

console.log('\n[已用/剩余时长 fmtDuration]');

t('分钟内是 m:ss，超过一小时是 h:mm:ss', () => {
  assert.strictEqual(api.fmtDuration(0), '0:00');
  assert.strictEqual(api.fmtDuration(9), '0:09');
  assert.strictEqual(api.fmtDuration(59), '0:59');
  assert.strictEqual(api.fmtDuration(60), '1:00');
  assert.strictEqual(api.fmtDuration(3599), '59:59');
  assert.strictEqual(api.fmtDuration(3600), '1:00:00');
  assert.strictEqual(api.fmtDuration(3661), '1:01:01');
});

t('负数 / NaN / 字符串都不会渲染出 NaN', () => {
  for (const v of [-5, NaN, undefined, null, 'abc', Infinity]) {
    assert.ok(!/NaN|Infinity/.test(api.fmtDuration(v)), `${String(v)} → ${api.fmtDuration(v)}`);
  }
  assert.strictEqual(api.fmtDuration(-5), '0:00');
});

/* --------------------------- 界面元素是否齐全 --------------------------- */

console.log('\n[日志与进度：界面元素]');

t('日志区具备「筛选 / 检索 / 跟随 / 有新日志」四件套', () => {
  for (const id of ['logFilter', 'logSearch', 'btnLogFollow', 'btnLogNew', 'log', 'logCount']) {
    assert.ok(htmlIds.has(id), `index.html 缺少 #${id}`);
  }
  for (const id of ['cntAll', 'cntInfo', 'cntOk', 'cntWarn', 'cntErr']) {
    assert.ok(htmlIds.has(id), `index.html 缺少计数徽章 #${id}`);
  }
  const levels = [...html.matchAll(/data-level="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(levels, ['all', 'info', 'ok', 'warn', 'err'], '级别按钮必须与 app.js 的 LOG_LEVELS 一致');
});

t('进度区具备「已用 / 剩余 / 速度」与失败明细', () => {
  for (const id of ['elapsedText', 'etaText', 'speedText', 'failBox', 'failList', 'failCount', 'btnCopyFail', 'btnClearFail']) {
    assert.ok(htmlIds.has(id), `index.html 缺少 #${id}`);
  }
  // 失败明细默认收起（没有失败就不该占地方）
  const box = (html.match(/<div class="failbox" id="failBox"[^>]*>/) || [])[0] || '';
  assert.ok(/\bhidden\b/.test(box), '#failBox 初始应带 hidden');
});

t('提示条里有「切换到 XX 平台并继续」按钮', () => {
  assert.ok(htmlIds.has('btnSwitchPlatform'), 'index.html 缺少 #btnSwitchPlatform');
  assert.ok(htmlIds.has('inputModeText'), '提示文案必须放进独立元素，否则按钮会被 textContent 清掉');
  assert.ok(js.includes('setSwitchButton'), 'app.js 应通过 setSwitchButton 统一控制该按钮');
  // 主进程要把「别的平台是哪个 id」带出来，界面才切得动
  assert.ok(/otherPlatformIds/.test(mainJs), 'input:inspect 应返回 otherPlatformIds');
});

/* ------------------------------ 实现方式 ------------------------------ */

console.log('\n[日志与进度：实现方式]');

t('日志渲染走 rAF 合批 + DocumentFragment，不再逐行 appendChild', () => {
  assert.ok(/requestAnimationFrame/.test(js), 'app.js 应使用 requestAnimationFrame');
  assert.ok(/createDocumentFragment/.test(js), 'app.js 应使用 DocumentFragment 批量插入');
  assert.ok(/function scheduleLogFlush/.test(js), '应存在 scheduleLogFlush');
  assert.ok(/function flushLog/.test(js), '应存在 flushLog');
});

t('进度渲染走 scheduleStats（每帧一次），高频 dl 事件不再直接 renderStats', () => {
  assert.ok(/function scheduleStats/.test(js), '应存在 scheduleStats');
  const dl = js.slice(js.indexOf("case 'dl': {"), js.indexOf("case 'convert-progress':"));
  assert.ok(/scheduleStats\(\)/.test(dl), "'dl' 分支应调用 scheduleStats");
  assert.ok(!/[^e]renderStats\(\);/.test(dl), "'dl' 分支不应直接调用 renderStats（会每事件一次强制布局）");
});

t('进度文本不再用 innerHTML 拼（XSS 面收窄）', () => {
  const start = js.indexOf('function renderStats');
  const raw = js.slice(start, js.indexOf('function addFailure'));
  // 去掉注释再判断 —— 上面那段注释里正解释着「为什么不再用 innerHTML」
  const seg = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(seg), 'renderStats 不应出现 innerHTML');
});

t('用户上滚查看日志时不会被自动拉回底部', () => {
  assert.ok(/function onLogScroll/.test(js), '应存在 onLogScroll');
  assert.ok(/state\.logFollow/.test(js), '应由 state.logFollow 决定是否自动滚到底');
  assert.ok(/'scroll'/.test(js), '应监听日志容器的 scroll 事件');
});

t('失败清单可复制，且失败的每一项都记了文件名与原因', () => {
  assert.ok(/function failuresText/.test(js), '应存在 failuresText');
  assert.ok(/function addFailure/.test(js), '应存在 addFailure');
  assert.ok(/addFailure\(ev\)/.test(js), "'dl' 的 fail 分支应调用 addFailure");
});

/* ------------------------------ 样式兜底 ------------------------------ */

console.log('\n[样式兜底]');

t('.mode-tip 声明了 display:flex，就必须有 [hidden] 兜底', () => {
  const rule = css.slice(css.indexOf('.mode-tip {'), css.indexOf('.mode-tip [hidden]') > 0 ? css.indexOf('.mode-tip [hidden]') : css.indexOf('.mode-tip {') + 600);
  assert.ok(/display\s*:\s*flex/.test(rule), '前提变了：.mode-tip 不再是 flex 布局');
  assert.ok(
    /\.mode-tip\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css),
    'style.css 缺少 `.mode-tip[hidden] { display: none !important }`，提示条该隐藏时不会隐藏'
  );
});

t('日志新增样式（筛选条 / 高亮 / 新日志按钮）已就位', () => {
  for (const sel of ['.log-tools', '.seg-item', '.log-search', '.log-new', '.log mark']) {
    assert.ok(css.includes(sel), `style.css 缺少 ${sel}`);
  }
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
