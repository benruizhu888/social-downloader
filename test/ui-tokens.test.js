/**
 * 设计令牌约束（纯 Node，静态分析 + 对比度实测）
 *
 * 这份测试守的是「改版之后不会再退化回去」。改版前 style.css 里散着 42 个 hex
 * 颜色、13 档字号、7 种控件高度，同类控件彼此差 2~4px，改一处要满文件搜一遍同类值；
 * 而且其中若干颜色是**不合格的**（--faint 只有 2.61:1、控件边框 1.42:1、
 * 焦点环 1.35:1、小红书品牌色上的白字 3.76:1）。
 *
 * 断言四件事：
 *   ① style.css 里不允许再出现任何颜色字面量 —— 所有颜色必须来自 tokens.css；
 *   ② style.css 引用的每一个 var(--x) 都在 tokens.css 里有定义（拼错即失效为 initial）；
 *   ③ tokens.css 里不允许留「没人用的死令牌」（残留令牌会诱导后人继续用它）；
 *   ④ 关键配色的对比度按 WCAG 2.1 实测：正文 ≥4.5:1，控件边框 / 焦点环 ≥3:1。
 *
 * 跑法：node test/ui-tokens.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const TOKENS = path.join(RENDERER, 'tokens.css');
const STYLE = path.join(RENDERER, 'style.css');
const HTML = path.join(RENDERER, 'index.html');

const tokensSrc = fs.readFileSync(TOKENS, 'utf8');
const styleSrc = fs.readFileSync(STYLE, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');

let pass = 0;
let fail = 0;
const failed = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

/* ------------------------------ 小工具 ------------------------------ */

/** 去掉 CSS 注释（注释里为了说明出处会写旧色值，不能算作代码里的字面量） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 解析 tokens.css 的 :root 块，得到 name -> value（value 未解析 var()） */
function parseTokens(src) {
  const body = stripComments(src);
  const root = body.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(root, 'tokens.css 里找不到 :root 块');
  const out = new Map();
  for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const tokens = parseTokens(tokensSrc);

/** 解析 var() 引用，最多解 3 层（够用；再多说明令牌该拍平了） */
function resolveToken(name, depth = 0) {
  const v = tokens.get(name);
  if (v === undefined) return undefined;
  const m = v.match(/^var\((--[\w-]+)\)$/);
  if (m && depth < 3) return resolveToken(m[1], depth + 1);
  return v;
}

/** style.css 里引用到的所有令牌名 */
function referencedTokens(src) {
  return new Set([...stripComments(src).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
}

/* ------------------------------ 对比度 ------------------------------ */

const srgb = (c) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

function parseHex(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const luminance = (rgb) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);

/** WCAG 2.1 相对对比度（1 ~ 21） */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取一个令牌的颜色；不是纯 hex（例如 rgba 遮罩）就返回 null，由调用方跳过 */
function colorOf(name) {
  return parseHex(resolveToken(name));
}

/* ============================== 断言 ============================== */

section('颜色字面量');

t('style.css 里不得出现 hex 颜色（一律走 tokens.css）', () => {
  const hits = [...stripComments(styleSrc).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(
    (m) => m[0]
  );
  assert.deepStrictEqual(
    hits,
    [],
    `发现硬编码颜色：${hits.join(', ')}（应改成 var(--c-*)）`
  );
});

t('style.css 里不得出现 rgb()/rgba()/hsl() 字面量', () => {
  const hits = [
    ...stripComments(styleSrc).matchAll(/\b(?:rgba?|hsla?)\(/g),
  ].map((m) => m[0]);
  assert.deepStrictEqual(hits, [], `发现硬编码颜色函数：${hits.join(' ')}`);
});

t('style.css 里不得出现颜色关键字（white/black/red 等）', () => {
  const body = stripComments(styleSrc).toLowerCase();
  const banned = ['white', 'black', 'red', 'blue', 'green', 'gray', 'grey'];
  // 负向先行断言排除 white-space 这类同前缀的属性（否则每条 nowrap 都会被判成白色）
  const hits = banned.filter((w) => new RegExp(`[:\\s(]${w}(?![-\\w])`).test(body));
  assert.deepStrictEqual(hits, [], `发现颜色关键字：${hits.join(', ')}`);
});

t('index.html 先加载 tokens.css，再加载 style.css', () => {
  const i1 = htmlSrc.indexOf('href="tokens.css"');
  const i2 = htmlSrc.indexOf('href="style.css"');
  assert.ok(i1 >= 0, 'index.html 没有引入 tokens.css');
  assert.ok(i2 >= 0, 'index.html 没有引入 style.css');
  assert.ok(i1 < i2, 'tokens.css 必须在 style.css 之前加载，否则 var() 全部失效');
});

section('令牌引用完整性');

/**
 * 允许在**选择器内部**声明的自定义属性。
 *
 * `--ripple` 必须局部声明：涟漪颜色取决于所在按钮是浅底还是墨黑主按钮，
 * 只能在 .btn / .btn.primary 上分别覆盖。这类属性不在 tokens.css 里，
 * 但每一处 var() 引用都必须带兜底值，否则在没声明过的元素上会得到 initial（透明）。
 */
const LOCAL_CUSTOM_PROPS = new Set(['--ripple']);

t('style.css 引用的每个令牌都在 tokens.css 里有定义', () => {
  const used = referencedTokens(styleSrc);
  const missing = [...used].filter((n) => !tokens.has(n) && !LOCAL_CUSTOM_PROPS.has(n));
  assert.deepStrictEqual(
    missing,
    [],
    `引用了未定义的令牌：${missing.join(', ')}（var() 会静默失效为 initial）`
  );
});

t('局部自定义属性（--ripple）的每一处引用都带兜底值', () => {
  const body = stripComments(styleSrc);
  const refs = [...body.matchAll(/var\((--ripple)\s*([,)])/g)];
  assert.ok(refs.length > 0, '找不到 --ripple 的引用（是不是改名了？同步改这里）');
  const noFallback = refs.filter((m) => m[2] === ')');
  assert.deepStrictEqual(
    noFallback.map((m) => m[0]),
    [],
    '--ripple 在没声明过的元素上会是 initial，必须写成 var(--ripple, var(--c-ripple))'
  );
});

t('tokens.css 里不留死令牌（定义了但没人用）', () => {
  const used = referencedTokens(styleSrc);
  // 字体族是对外契约（app.js 与 index.html 共享同一套字体观感），不靠 style.css 引用
  const allow = new Set(['--font', '--mono']);
  const dead = [...tokens.keys()].filter((n) => !used.has(n) && !allow.has(n));
  assert.deepStrictEqual(dead, [], `未被使用的令牌：${dead.join(', ')}`);
});

t('tokens.css 里每个 var() 引用都能解到具体值（不解出链的悬空引用）', () => {
  const dangling = [...tokens.keys()].filter((n) => resolveToken(n) === undefined);
  assert.deepStrictEqual(dangling, [], `悬空令牌：${dangling.join(', ')}`);
});

section('控件高度');

t('四类控件高度都取自 --ctrl-* 令牌（不再散落 34/30/26 这类零碎值）', () => {
  const body = stripComments(styleSrc);
  const need = [
    ['.btn', '--ctrl-md'],
    ['.btn.sm', '--ctrl-sm'],
    ['.btn.xs', '--ctrl-xs'],
    ['.btn.primary', '--ctrl-lg'],
    ['.tab', '--ctrl-md'],
    ['.seg-item', '--ctrl-xs'],
  ];
  for (const [sel, token] of need) {
    // 必须锚到行首：`.mode-tip .btn {` 也含有 `.btn {`，不锚会取到错误的规则块
    // replace 已经把 . 转义成 \.，前面不要再补反斜杠（否则变成匹配字面反斜杠）
    const m = new RegExp(`^${sel.replace(/\./g, '\\.')}\\s*\\{`, 'm').exec(body);
    assert.ok(m, `找不到规则块：${sel}`);
    const i = m.index;
    const block = body.slice(i, body.indexOf('}', i));
    assert.ok(
      new RegExp(`height:\\s*var\\(${token}\\)`).test(block),
      `${sel} 的高度应为 var(${token})，实际：${(block.match(/height:\s*[^;]+/) || ['?'])[0]}`
    );
  }
});

t('控件高度取值都在 WCAG 2.2 的 24px 最小可点区域之上', () => {
  for (const n of ['--ctrl-xs', '--ctrl-sm', '--ctrl-md', '--ctrl-lg']) {
    const px = Number(String(resolveToken(n)).replace('px', ''));
    assert.ok(px >= 24, `${n} = ${px}px，小于 24px 最小可点区域`);
  }
});

section('对比度 · 正文（≥4.5:1）');

const TEXT_PAIRS = [
  ['--c-ink', '--c-surface'],
  ['--c-ink', '--c-canvas'],
  ['--c-ink-2', '--c-surface'],
  ['--c-ink-2', '--c-canvas'],
  ['--c-ink-2', '--c-surface-log'],
  ['--c-ink-3', '--c-surface'],
  ['--c-ink-3', '--c-canvas'],
  ['--c-ink-3', '--c-surface-2'],
  ['--c-ink-3', '--c-surface-3'],
  ['--c-ink-4', '--c-surface'],
  ['--c-ink-4', '--c-canvas'],
  ['--c-ink-4', '--c-surface-log'],
  ['--c-accent', '--c-surface'],
  ['--c-accent-strong', '--c-surface'],
  ['--c-accent-strong', '--c-accent-soft'],
  ['--c-ok', '--c-surface'],
  ['--c-ok', '--c-surface-log'],
  ['--c-ok-strong', '--c-ok-soft'],
  ['--c-warn', '--c-surface'],
  ['--c-warn-strong', '--c-warn-soft'],
  ['--c-danger', '--c-surface'],
  ['--c-danger', '--c-danger-soft'],
  ['--c-danger-strong', '--c-danger-soft'],
  ['--c-danger-ink', '--c-danger-soft'],
  ['--c-on-dark', '--c-neutral-900'],
  ['--c-on-dark', '--c-neutral-800'],
  ['--c-on-dark', '--c-ink'],
  ['--c-on-dark', '--c-plat-weibo'],
  ['--c-on-dark', '--c-plat-xhs'],
  ['--c-on-dark', '--c-plat-douyin'],
  ['--c-on-dark', '--c-plat-idle'],
];

t('所有正文/语义配色对白底、浅底、深底的对比度 ≥ 4.5:1', () => {
  const bad = [];
  for (const [fg, bg] of TEXT_PAIRS) {
    const a = colorOf(fg);
    const b = colorOf(bg);
    if (!a || !b) continue; // rgba 类令牌不参与实测
    const r = contrast(a, b);
    if (r < 4.5) bad.push(`${fg} / ${bg} = ${r.toFixed(2)}:1`);
  }
  assert.deepStrictEqual(bad, [], `对比度不足 4.5:1：\n  ${bad.join('\n  ')}`);
});

section('对比度 · 非文本（≥3:1）');

const NON_TEXT_PAIRS = [
  ['--c-border-ctl', '--c-surface'],
  ['--c-border-ctl-strong', '--c-surface'],
  ['--focus-color', '--c-surface'],
  ['--focus-color', '--c-canvas'],
];

t('控件边框与焦点环对底色的对比度 ≥ 3:1（WCAG 1.4.11）', () => {
  const bad = [];
  for (const [fg, bg] of NON_TEXT_PAIRS) {
    const a = colorOf(fg);
    const b = colorOf(bg);
    if (!a || !b) continue;
    const r = contrast(a, b);
    if (r < 3) bad.push(`${fg} / ${bg} = ${r.toFixed(2)}:1`);
  }
  assert.deepStrictEqual(bad, [], `对比度不足 3:1：\n  ${bad.join('\n  ')}`);
});

section('回归：改版前的四个不合格值不许回来');

t('--faint 时代的 2.61:1 灰不许回来（--c-ink-4 必须 ≥4.5:1）', () => {
  const r = contrast(colorOf('--c-ink-4'), colorOf('--c-canvas'));
  assert.ok(r >= 4.5, `--c-ink-4 对 canvas 只有 ${r.toFixed(2)}:1`);
});

t('输入框/按钮边框不许回到 1.42:1 的 #d8dde5', () => {
  assert.notStrictEqual(resolveToken('--c-border-ctl'), '#d8dde5');
  const r = contrast(colorOf('--c-border-ctl'), colorOf('--c-surface'));
  assert.ok(r >= 3, `边框对比度 ${r.toFixed(2)}:1`);
});

t('小红书品牌色上的白字不许回到 3.76:1', () => {
  const r = contrast(colorOf('--c-on-dark'), colorOf('--c-plat-xhs'));
  assert.ok(r >= 4.5, `--c-plat-xhs 上白字只有 ${r.toFixed(2)}:1`);
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
      console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
})();
