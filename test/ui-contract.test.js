/**
 * 界面契约（纯 Node：静态断言 + 渲染层行为断言）
 *
 * ui-tokens.test.js 守的是「数值从哪来」，这份守的是「改样式不能改坏行为」。
 * 每一条背后都是一次真实事故或一条真实缺陷：
 *
 *   · `[hidden]` 兜底 —— 作者样式里的 display:flex 会盖过浏览器默认，
 *     少了它「该消失的按钮留在原地」，而且**不报错**；
 *   · `.livebar .meta` 必须 display:inline —— app.js 用 " · " 文本节点做分隔，
 *     一改成 flex 分隔符就被丢弃，界面上出现「70%29%」；
 *   · 状态类（.running/.active/.busy/.on/…）—— app.js 靠它们表达状态，
 *     CSS 里少一条规则就是「状态变了但界面没变」；
 *   · 响应式断点 / reduced-motion —— 改版前只有 2 个断点且 899~640 之间是空白，
 *     平板宽度下右栏被挤成 300px 而正文只剩 380px；
 *   · 弹窗三个出口 + 焦点归还 —— 只绑「取消」时键盘用户出不去。
 *
 * 跑法：node test/ui-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./lib/renderer-harness');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const STYLE = path.join(RENDERER, 'style.css');
const HTML = path.join(RENDERER, 'index.html');
const APPJS = path.join(RENDERER, 'app.js');

const styleSrc = fs.readFileSync(STYLE, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');
const appSrc = fs.readFileSync(APPJS, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const style = stripComments(styleSrc);

let pass = 0;
let fail = 0;
const failed = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** 取某个选择器规则块的内容（锚到行首，避免 .mode-tip .btn 命中 .btn） */
function block(sel) {
  const m = new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm').exec(style);
  if (!m) return null;
  return style.slice(m.index, style.indexOf('}', m.index));
}

/* ============================ 静态：显隐契约 ============================ */

section('显隐：[hidden] 必须真的生效');

t('全局 [hidden] 兜底存在且带 !important', () => {
  const b = block('[hidden]');
  assert.ok(b, '缺少全局 [hidden] 规则（display:flex 的作者样式会盖过浏览器默认）');
  assert.ok(/display:\s*none/.test(b), '[hidden] 必须是 display:none');
  assert.ok(/!important/.test(b), '必须带 !important，否则压不住后面的 display:flex');
});

t('.mode-tip / .grid > [hidden] 两处局部兜底都还在', () => {
  assert.ok(
    /\.mode-tip\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(style),
    '.mode-tip[hidden] 兜底丢了：识别提示条该隐藏时会留在原地'
  );
  assert.ok(
    /\.grid\s*>\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(style),
    '.grid > [hidden] 兜底丢了：被作用域隐藏的选项会继续显示并可点'
  );
});

section('状态类：app.js 用到的每一个都有样式');

/**
 * app.js 里 classList 操作过的类 -> 至少一条 CSS 规则。
 * 少一条就是「状态变了但界面没变」，而且不会报错。
 */
const STATE_CLASSES = [
  'running', 'active', 'busy', 'on', 'warn', 'ok', 'bad',
  'has-err', 'has-warn', 'show', 'empty',
];

t('app.js 切换的状态类在 style.css 里都有对应规则', () => {
  const missing = STATE_CLASSES.filter((c) => !new RegExp(`\\.${c}[\\s,:.).]`).test(style));
  assert.deepStrictEqual(missing, [], `缺少样式定义的状态类：${missing.join(', ')}`);
});

t('日志级别类（.t/.err/.warn/.ok/.log-cut/.log-empty）都有规则', () => {
  const missing = ['.log .t', '.log .err', '.log .warn', '.log .ok', '.log-cut', '.log-empty']
    .filter((s) => !style.includes(s));
  assert.deepStrictEqual(missing, [], `缺少样式：${missing.join(', ')}`);
});

t('body.running 的相位点与进度条流光都还在', () => {
  assert.ok(/body\.running\s+\.phase/.test(style), '运行态相位点样式丢了');
  assert.ok(/body\.running\s+\.bar/.test(style), '运行态进度条流光丢了');
});

section('布局缺陷回归');

t('.livebar .meta 必须是 display:inline（flex 会吞掉 " · " 文本节点）', () => {
  const b = block('.livebar .meta');
  assert.ok(b, '找不到 .livebar .meta 规则');
  assert.ok(
    /display:\s*inline\s*;/.test(b),
    '改成 flex 后 app.js 插入的 " · " 文本节点会被丢弃，界面出现「70%29%」'
  );
});

t('.side 有高度上限且可滚动（右栏比视口高时底部按钮点不到）', () => {
  const b = block('.side');
  assert.ok(b, '找不到 .side 规则');
  assert.ok(/max-height:/.test(b), '.side 缺 max-height：内容超过视口时被 sticky 钉住带不出来');
  assert.ok(/overflow-y:\s*auto/.test(b), '.side 缺 overflow-y:auto：超出部分无法滚动');
});

t('.mini 三段都是可伸缩宽度（固定宽会在窄栏挤出横向滚动条）', () => {
  const name = block('.mini .name');
  const pct = block('.mini .pct');
  assert.ok(name && pct, '找不到 .mini 的行内规则');
  assert.ok(/flex:\s*0\s+1/.test(name), '.mini .name 应可压缩（flex: 0 1 …）');
  assert.ok(/max-width:/.test(pct), '.mini .pct 需要上限，否则长文案把 track 挤没');
  assert.ok(/text-overflow:\s*ellipsis/.test(pct), '.mini .pct 需要省略号收尾');
  assert.ok(
    /min-width:\s*(var\(--sp-|\d)/.test(block('.mini .track')),
    '.mini .track 需要保底宽度，否则被两端挤成 0 后进度条消失'
  );
});

section('响应式');

t('四个断点都在（1079 / 899 / 699 / 559）', () => {
  for (const bp of [1079, 899, 699, 559]) {
    assert.ok(
      new RegExp(`@media\\s*\\(max-width:\\s*${bp}px\\)`).test(style),
      `缺少 ${bp}px 断点`
    );
  }
});

t('899px 以下收成单栏，并解除右栏粘性', () => {
  const i = style.indexOf('@media (max-width: 899px)');
  assert.ok(i >= 0, '缺少 899px 断点');
  const body = style.slice(i, style.indexOf('\n}', i));
  assert.ok(/grid-template-columns:\s*1fr/.test(body), '899 以下应改成单栏');
  assert.ok(/\.side\s*\{[^}]*position:\s*static/.test(body), '单栏时右栏不该继续 sticky');
});

t('prefers-reduced-motion 覆盖伪元素与动画迭代', () => {
  const i = style.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(i >= 0, '缺少 prefers-reduced-motion 处理');
  const body = style.slice(i, style.indexOf('\n}', i));
  assert.ok(/animation-duration/.test(body), '未压掉动画时长');
  assert.ok(/animation-iteration-count/.test(body), '未停止动画循环（扫光/脉冲会一直跑）');
  assert.ok(/::before/.test(body) && /::after/.test(body), '伪元素上的动画也要压掉');
});

section('焦点与无障碍');

t('焦点统一走 outline（box-shadow 环会被 overflow:hidden 裁掉）', () => {
  const b = block(':focus-visible');
  assert.ok(b, '缺少 :focus-visible 规则');
  assert.ok(/outline:\s*var\(--focus-width\)\s+solid\s+var\(--focus-color\)/.test(b), '焦点环应为 outline');
  assert.ok(/outline-offset/.test(b), '需要 outline-offset，否则贴边看不清');
});

t('鼠标点击不留焦点环（:focus:not(:focus-visible) 复位）', () => {
  assert.ok(/:focus:not\(:focus-visible\)/.test(style), '点击按钮后会残留一圈蓝边');
});

t('index.html 不写行内 style（样式一律走 CSS，避免绕过令牌）', () => {
  assert.ok(!/\sstyle=/.test(htmlSrc), 'index.html 里出现了行内 style，令牌体系失效');
});

t('弹窗是 role=dialog + aria-modal，且有关闭按钮', () => {
  assert.ok(/id="cookieModal"[^>]*role="dialog"/.test(htmlSrc), '弹窗缺 role=dialog');
  assert.ok(/aria-modal="true"/.test(htmlSrc), '弹窗缺 aria-modal');
  assert.ok(/id="btnCookieClose"/.test(htmlSrc), '弹窗缺右上角关闭按钮');
  assert.ok(
    /id="btnCookieClose"[^>]*aria-label="[^"]+"/.test(htmlSrc),
    '纯图标按钮必须有 aria-label，否则读屏软件只报「按钮」'
  );
});

t('日志区可键盘聚焦（可滚动容器必须有 tabindex）', () => {
  assert.ok(/id="log"[^>]*tabindex="0"/.test(htmlSrc), '#log 缺 tabindex="0"，键盘用户翻不了日志');
});

t('启动失败横幅是 role=alert（出现时立刻播报）', () => {
  assert.ok(/id="bootError"[^>]*role="alert"/.test(htmlSrc), '#bootError 缺 role="alert"');
});

t('app.js：Toast 只保留一个计时器（连发时不互相收掉）', () => {
  assert.ok(/clearTimeout\(toastTimer\)/.test(appSrc), 'toast 应在重新计时前 clearTimeout');
});

/* ============================ 行为：弹窗可达性 ============================ */

section('行为：Cookie 弹窗的三个出口');

async function openModal() {
  const h = createHarness();
  await tick(30);
  h.el('authText').focus(); // 模拟「焦点在触发元素上」
  h.el('authText').fire('click');
  return h;
}

t('打开弹窗：show 类生效，焦点落在输入框', async () => {
  const h = await openModal();
  assert.ok(h.el('cookieModal').classList.contains('show'), '点击登录态文字应打开弹窗');
  assert.strictEqual(h.activeEl(), h.el('cookieText'), '打开后焦点应进入输入框（可直接粘贴）');
});

t('Esc 能关闭弹窗，且焦点还给打开它的元素', async () => {
  const h = await openModal();
  h.fireDoc('keydown', { key: 'Escape' });
  assert.ok(!h.el('cookieModal').classList.contains('show'), 'Esc 未关闭弹窗');
  assert.strictEqual(h.activeEl(), h.el('authText'), '关闭后焦点应回到触发元素，不能掉回 body');
});

t('右上角 × 能关闭弹窗', async () => {
  const h = await openModal();
  h.el('btnCookieClose').fire('click');
  assert.ok(!h.el('cookieModal').classList.contains('show'), '× 按钮未关闭弹窗');
});

t('「取消」与 × 走同一个 close（焦点归还逻辑不重复实现）', async () => {
  const h = await openModal();
  h.el('btnCookieCancel').fire('click');
  assert.ok(!h.el('cookieModal').classList.contains('show'), '取消按钮未关闭弹窗');
  assert.strictEqual(h.activeEl(), h.el('authText'), '取消也要归还焦点');
});

t('Tab 到最后一个可聚焦元素后回到第一个（焦点不跑出弹窗）', async () => {
  const h = await openModal();
  const modal = h.el('cookieModal');
  const items = modal.querySelectorAll('button, textarea');
  assert.ok(items.length >= 2, '弹窗内应有多个可聚焦元素');
  items[items.length - 1].focus();
  modal.fire('keydown', { key: 'Tab' });
  assert.strictEqual(h.activeEl(), items[0], 'Tab 应从最后一个绕回第一个');
});

t('弹窗关闭后 Esc 不再有副作用（已关闭时是 no-op）', async () => {
  const h = await openModal();
  h.el('btnCookieClose').fire('click');
  const before = h.activeEl();
  h.fireDoc('keydown', { key: 'Escape' });
  assert.strictEqual(h.activeEl(), before, '弹窗已关闭时 Esc 不该再动焦点');
});

section('布局重排：当前网站 chip / 目标地址槽位 / 选项分组');

t('.site-chip 是一枚可压缩的真控件（等宽域名、单行省略、28px 高）', () => {
  assert.ok(/\.site-chip\s*\{/.test(style), 'style.css 必须定义 .site-chip');
  const block = style.slice(style.indexOf('.site-chip {'));
  const chunk = block.slice(0, block.indexOf('}'));
  assert.ok(/font:\s*var\(--fs-11\)\s+var\(--mono\)/.test(chunk), '域名要用等宽字体，和平台名区分开');
  assert.ok(/text-overflow:\s*ellipsis/.test(chunk), '域名过长必须省略，不能把登录按钮挤出去');
  assert.ok(/min-width:\s*0/.test(chunk), 'flex 子项没有 min-width:0 就压不下去');
  assert.ok(/height:\s*var\(--ctrl-sm\)/.test(chunk), '控件高度必须取 --ctrl-* 档位');
  // 域名徽章靠 ::before 画地球图标：它是「地址」而不是普通文字
  assert.ok(/\.site-chip::before\s*\{/.test(style), '.site-chip 需要有地球图标伪元素');
});

t('.target-inline 与 .paste-hint 共处一个槽位，且都允许收缩', () => {
  assert.ok(/\.target-slot\s*\{/.test(style), '需要 .target-slot 承载二选一的两个状态');
  const slot = style.slice(style.indexOf('.target-slot {'));
  assert.ok(/min-width:\s*0/.test(slot.slice(0, slot.indexOf('}'))), '.target-slot 必须可收缩');
  const ti = style.slice(style.indexOf('.ti-url {'));
  const chunk = ti.slice(0, ti.indexOf('}'));
  assert.ok(/min-width:\s*0/.test(chunk) && /text-overflow:\s*ellipsis/.test(chunk), '.ti-url 必须省略而不是撑破动作行');
});

t('.grid-sub 用虚线把「下什么」与「抓多少」分开，且首项不留多余分隔线', () => {
  assert.ok(/\.grid-sub\s*\{/.test(style), '数字分组标题需要 .grid-sub');
  const gs = style.slice(style.indexOf('.grid-sub {'));
  assert.ok(/border-top:\s*1px dashed/.test(gs.slice(0, gs.indexOf('}'))), '分组标题要靠虚线建立分隔');
  assert.ok(
    /\.grid\s*>\s*\.grid-sub:first-child\s*\{/.test(style),
    '若分组标题就是列表第一项，必须去掉那条虚线（否则卡片顶部凭空多一条线）'
  );
});

t('index.html 里「博主主页」链接行只出现在输入区，右栏不再重复', () => {
  const tidy = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
  assert.strictEqual(
    (tidy.match(/id="targetUrl"/g) || []).length,
    1,
    '#targetUrl 只能有一处（重复即两份真相，右栏那份永远不刷新）'
  );
  const composer = tidy.slice(tidy.indexOf('class="card composer"'), tidy.indexOf('class="card task"'));
  assert.ok(composer.includes('id="targetUrl"'), '目标地址必须落在输入卡片内');
  const aside = tidy.slice(tidy.indexOf('<aside'));
  assert.ok(!aside.includes('id="targetUrl"'), '右栏不应再出现目标地址行');
});

section('示例地址：必须完整可见，不许省略');

/** 取某条规则块的正则（从选择器到第一个右花括号） */
const ruleOf = (sel) => {
  const re = new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
  const m = re.exec(style);
  if (!m) return '';
  return style.slice(m.index, style.indexOf('}', m.index));
};

t('三种输入的示例地址不再省略（换行可以，截断不行）', () => {
  const block = ruleOf('.kind .k-eg');
  assert.ok(block, 'style.css 必须有 .kind .k-eg');
  assert.ok(!/text-overflow/.test(block), '示例地址不能再用 text-overflow 省略');
  assert.ok(!/white-space:\s*nowrap/.test(block), 'nowrap 会把地址挤出可视区（或逼出横向滚动）');
  assert.ok(
    /white-space:\s*normal/.test(block) && /overflow-wrap:\s*anywhere/.test(block),
    '必须允许在任意位置换行：极窄屏宁可多占一行，也不许截断地址'
  );
});

t('示例区是三行清单，不是三枚并排 chip（并排时每枚只有 1/3 宽）', () => {
  const kinds = ruleOf('.input-kinds');
  assert.ok(kinds, 'style.css 必须有 .input-kinds');
  assert.ok(
    !/repeat\(3/.test(kinds),
    '.input-kinds 不能是 3 列：804px 卡片下每列约 260px，而抖音示例地址约 340px，必然被截断'
  );
  const kind = ruleOf('.kind');
  assert.ok(/display:\s*flex/.test(kind), '.kind 应是「标签 + 示例」的横向一行');
  assert.ok(!/height:\s*var\(--ctrl-sm\)/.test(kind), '清单行不该套控件高度，否则长地址换行会被裁掉');
});

t('右栏官网 / 登录页地址独占一行，动作按钮留在第一行', () => {
  const row = ruleOf('.link-row');
  assert.ok(/display:\s*grid/.test(row), '.link-row 应是两行网格');
  const url = ruleOf('.link-url');
  assert.ok(/grid-column:\s*1\s*\/\s*-1/.test(url), '地址必须跨满整行，否则只有 128px 可用');
  assert.ok(!/text-overflow/.test(url), '官网 / 登录页地址同样不许省略');
  assert.ok(/overflow-wrap:\s*anywhere/.test(url), '超长登录页地址要能换行');
  // 按钮与地址不能在同一行抢宽度：结构上必须分开
  const tidy = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/class="link-actions"/.test(tidy), '按钮需要 .link-actions 包裹，才能固定在标签那一行');
  const firstRow = tidy.slice(tidy.indexOf('class="link-row"'), tidy.indexOf('class="link-row"') + 400);
  assert.ok(
    firstRow.indexOf('link-actions') < firstRow.indexOf('link-url'),
    '.link-actions 必须排在 .link-url 之前，网格才会把它放进第一行'
  );
});

/* ============================== 执行 ============================== */

(async () => {
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n── ${fn} ──`);
      continue;
    }
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail++;
      failed.push(name);
      console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
})();
