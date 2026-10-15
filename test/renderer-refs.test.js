/**
 * 渲染层「元素引用」静态检查（纯 Node）
 *
 * 抓的是这类问题：app.js 里写了 `$('inputMode')`，但 index.html 里没有 id="inputMode"
 * 的元素 —— 运行时 `$()` 返回 null，随后 `null.hidden = true` 抛异常，
 * 界面表现为「某个功能点了没反应」，而控制台在打包后的应用里根本看不到。
 * 本次改动新增了若干界面元素，正好用这个检查兜一遍。
 *
 * 排除项：`opt_${f.key}` 这类模板拼接出来的 id（由 renderOptions 动态生成，HTML 里本来就没有）。
 *
 * 跑法：node test/renderer-refs.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DIR = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// $('xxx') 形式的引用；模板字符串（含 ${）交给下一行单独处理
const refs = new Set();
for (const m of js.matchAll(/\$\(\s*'([^']*)'\s*\)/g)) {
  if (!m[1].includes('${')) refs.add(m[1]);
}
for (const m of js.matchAll(/\$\(\s*`([^`]*)`\s*\)/g)) {
  if (!m[1].includes('${')) refs.add(m[1]);
}
// 模板拼出来的前缀（如 opt_）：父级里没有对应元素属正常，只做记录
const templateRefs = [...js.matchAll(/\$\(\s*`([^`]*\$\{[^`]*)`\s*\)/g)].map((m) => m[1]);
// getElementById 也要一并检查
for (const m of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]);

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

console.log('\n[渲染层元素引用]');

t('app.js 引用的每个 id 都能在 index.html 里找到', () => {
  const missing = [...refs].filter((id) => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [], `以下 id 在 index.html 中不存在：${missing.join(', ')}`);
});

t('本次新增的三个元素都在（inputMode / targetTitle / inputModeBox 之外的回归底线）', () => {
  for (const id of ['inputMode', 'targetTitle', 'btnStart', 'inputUid']) {
    assert.ok(htmlIds.has(id), `index.html 缺少 #${id}`);
  }
});

t('app.js 里没有残留的 inputModeBox（旧命名）', () => {
  assert.ok(!js.includes('inputModeBox'), 'app.js 仍引用 inputModeBox');
});

t('CSP 未被放宽（script-src 仍是 self，无 unsafe-eval）', () => {
  const csp = (html.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
  assert.ok(/script-src 'self'/.test(csp), `script-src 应为 'self'，实际：${csp}`);
  assert.ok(!/unsafe-eval/.test(csp), 'CSP 不应包含 unsafe-eval');
});

t('单作品相关文案已接上（按钮文案与提示条同源）', () => {
  assert.ok(js.includes('setStartLabel'), 'app.js 应通过 setStartLabel 统一改按钮文案');
  assert.ok(js.includes('inspectInput'), 'app.js 应调用主进程的 input:inspect');
});

/* ------------------- 批量粘贴 / 选项隐藏 的界面底线 ------------------- */

const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');

console.log('\n[批量粘贴与选项隐藏]');

t('目标输入是 textarea（input 装不下多条链接）', () => {
  const el = (html.match(/<textarea[^>]*id="inputUid"[\s\S]*?>/) || [])[0] || '';
  assert.ok(el, 'index.html 里应有 <textarea id="inputUid">');
  assert.ok(!/id="inputUid"[^>]*\/>/.test(html), '#inputUid 不应是自闭合的 input');
});

t('隐藏不生效的选项这个能力，界面元素齐全', () => {
  for (const id of ['optionScopeTip', 'options']) {
    assert.ok(htmlIds.has(id), `index.html 缺少 #${id}`);
  }
  assert.ok(js.includes('applyOptionScope'), 'app.js 应实现 applyOptionScope');
  assert.ok(/dataset\.scope/.test(js), 'renderOptions 应把 schema 的 scope 落到 dataset 上');
});

/**
 * 这条是真正的回归闸门：.chk / .num 自带 display:flex（作者样式），
 * 会盖过浏览器默认的 [hidden]{display:none}。少了这条兜底规则，
 * el.hidden = true 对它们无效 —— 表现为「提示说隐藏了 3 个选项，
 * 可它们还在屏幕上」，且不报任何错。
 */
t('style.css 里必须有让 [hidden] 真正生效的规则', () => {
  assert.ok(
    /\.grid\s*>\s*\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(css),
    'style.css 缺少 `.grid > [hidden] { display: none }`，选项隐藏会静默失效'
  );
});

t('被隐藏的选项用 hidden 属性（不删 DOM，值才能保留并写回设置）', () => {
  assert.ok(/\.hidden\s*=\s*shouldHide/.test(js), 'applyOptionScope 应通过 .hidden 控制显隐');
  assert.ok(!/removeChild|\.remove\(\)/.test(js.slice(js.indexOf('function applyOptionScope'), js.indexOf('function applyOptionScope') + 900)),
    'applyOptionScope 不应从 DOM 移除选项，否则用户切回主页模式时设置会丢');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (templateRefs.length) {
  console.log(`（模板拼接的引用，按设计跳过：${templateRefs.length} 处）`);
}
process.exit(fail ? 1 : 0);
