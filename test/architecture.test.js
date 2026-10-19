/**
 * 架构约束（纯 Node，静态 + 少量行为断言）
 *
 * 这套断言守的是「拆分之后还有没有拆分的样子」，不是「代码长什么样」：
 *
 *   ① `main.js` 只能是装配层 —— 行数上限 + 不许直接建窗口/注册 IPC；
 *   ② 目录结构就是设计稿里的那份，少一个文件就说明有人又往 main.js 里塞；
 *   ③ 依赖图无环 —— 循环 require 在 Electron 里的表现是「有时能启动、
 *      有时某个模块拿到半成品」，靠人眼审不出来；
 *   ④ 跨模块可变状态只准放 ctx —— 任何 `app/*.js` 顶层出现 `let x = ...`
 *      都可能变成「第二个真身」，而登录窗引用丢失那类 bug 就是这么来的；
 *   ⑤ 每个相对 require 都能落到真实文件（改名后忘了改引用，这里就红）。
 *
 * 跑法：node test/architecture.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const MAIN_DIR = path.join(ROOT, 'src', 'main');
const MAIN_FILE = path.join(MAIN_DIR, 'main.js');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

/* ------------------------------ 小工具 ------------------------------ */

/** 递归收集某目录下的 .js 文件（绝对路径，排序保证输出稳定） */
function collectJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectJs(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 把 `require('./x')` 解析成真实文件路径。
 *
 * 只处理相对路径（第三方包与本文件无关）。解析不到返回 null ——
 * 「解析不到」本身就是一条独立断言，不能让后续遍历把异常抛在 DFS 里。
 *
 * @param {string} fromFile 发起 require 的文件
 * @param {string} spec     require 的字符串
 * @returns {string|null}
 */
function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js'), path.join(base, 'index.js.js')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

/** 抠出源码里所有相对 require */
function relativeRequires(src) {
  return [...src.matchAll(/require\(\s*'(\.[^']*)'\s*\)/g)].map((m) => m[1]);
}

/** 相对路径（给断言消息用，绝对路径读起来太吵） */
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ------------------------------ 用例 ------------------------------ */

section('main.js 只做装配');

t('main.js 不超过 140 行（拆分目标，防止又长回去）', () => {
  const src = fs.readFileSync(MAIN_FILE, 'utf8');
  // 与 `wc -l` 同口径：末尾换行不算一行
  const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= 140, `main.js 现在是 ${lines} 行，上限 140`);
});

t('main.js 里不直接注册 IPC（必须走 app/ipc）', () => {
  const src = fs.readFileSync(MAIN_FILE, 'utf8');
  assert.ok(!/ipcMain\.(handle|on)\s*\(/.test(src), 'main.js 不该直接调用 ipcMain.handle/on');
});

t('main.js 里不直接建窗口（必须走 app/windows、app/login-window）', () => {
  const src = fs.readFileSync(MAIN_FILE, 'utf8');
  assert.ok(!/new BrowserWindow\s*\(/.test(src), 'main.js 不该 new BrowserWindow');
});

t('main.js 里不出现业务实现细节（下载/采集/转换）', () => {
  const src = fs.readFileSync(MAIN_FILE, 'utf8');
  for (const bad of ['TaskRunner', 'convertToMOV', 'harvest', 'getReader']) {
    assert.ok(!src.includes(bad), `main.js 里出现了业务实现细节：${bad}`);
  }
});

t('main.js 仍然负责三件必须最早的事（护栏 / 参数 / 装配顺序）', () => {
  const src = fs.readFileSync(MAIN_FILE, 'utf8');
  assert.ok(/installGlobalUrlGuard\s*\(/.test(src), '全局 URL 护栏必须在 main.js 顶层注册');
  assert.ok(/installProcessGuard\s*\(/.test(src), '进程兜底必须在 main.js 顶层注册');
  assert.ok(/app\.commandLine\.appendSwitch/.test(src), '窗口遮挡检测的开关必须在 ready 之前关掉');
  assert.ok(/--smoke-out=/.test(src) && /--user-data-dir=/.test(src), '启动参数必须在这里解析');
  // 装配顺序：注册 IPC 必须在建主窗之前（否则渲染层 invoke 会拿到 no handler）
  const ipcAt = src.indexOf('registerAll(ctx)');
  const winAt = src.indexOf('createMainWindow(ctx)');
  assert.ok(ipcAt > 0 && winAt > 0, 'main.js 必须显式调用 registerAll 与 createMainWindow');
  assert.ok(ipcAt < winAt, '必须先注册 IPC 再建窗口');
});

section('目录结构');

const REQUIRED = [
  'src/main/app/context.js',
  'src/main/app/windows.js',
  'src/main/app/login-window.js',
  'src/main/app/settings.js',
  'src/main/app/auth.js',
  'src/main/app/smoke.js',
  'src/main/app/ipc/index.js',
  'src/main/app/ipc/app-info.js',
  'src/main/app/ipc/settings.js',
  'src/main/app/ipc/input.js',
  'src/main/app/ipc/auth.js',
  'src/main/app/ipc/task.js',
];

t('设计稿要求的 12 个文件都存在', () => {
  const missing = REQUIRED.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepStrictEqual(missing, [], `缺少：${missing.join(', ')}`);
});

t('每个 app 模块都有导出（空文件不算拆分完成）', () => {
  for (const p of REQUIRED) {
    const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.ok(/module\.exports\s*=/.test(src), `${p} 没有 module.exports`);
    assert.ok(src.split('\n').length > 8, `${p} 太短了，看起来不是一次真正的搬移`);
  }
});

t('app 目录下没有游离文件（新增文件必须登记进本测试）', () => {
  const actual = collectJs(path.join(MAIN_DIR, 'app')).map(rel).sort();
  assert.deepStrictEqual(actual, REQUIRED.slice().sort(), 'app/ 下的文件清单与设计稿不一致');
});

section('依赖图');

/** 全树依赖图：文件 -> 已解析的相对依赖 */
const GRAPH = new Map();
for (const file of collectJs(MAIN_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  GRAPH.set(
    file,
    relativeRequires(src).map((spec) => ({ spec, resolved: resolveRequire(file, spec) }))
  );
}

t('每个相对 require 都能解析到真实文件', () => {
  const broken = [];
  for (const [file, deps] of GRAPH) {
    for (const d of deps) if (!d.resolved) broken.push(`${rel(file)} → ${d.spec}`);
  }
  assert.deepStrictEqual(broken, [], `这些 require 指向不存在的文件：\n  ${broken.join('\n  ')}`);
});

t('主进程依赖图无环', () => {
  const color = new Map(); // 0 未访问 / 1 在栈上 / 2 完成
  const stack = [];
  const cycles = [];

  const visit = (file) => {
    color.set(file, 1);
    stack.push(file);
    for (const d of GRAPH.get(file) || []) {
      const next = d.resolved;
      if (!next || !GRAPH.has(next)) continue;
      const c = color.get(next) || 0;
      if (c === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].map(rel).join(' → '));
      else if (c === 0) visit(next);
    }
    stack.pop();
    color.set(file, 2);
  };

  for (const file of GRAPH.keys()) if (!color.get(file)) visit(file);
  assert.deepStrictEqual(cycles, [], `存在循环依赖：\n  ${cycles.join('\n  ')}`);
});

t('主进程不 require 渲染层文件（分层不能反过来）', () => {
  const bad = [];
  for (const [file, deps] of GRAPH) {
    for (const d of deps) if (d.resolved && d.resolved.includes(`${path.sep}renderer${path.sep}`)) {
      bad.push(`${rel(file)} → ${d.spec}`);
    }
  }
  assert.deepStrictEqual(bad, [], `主进程引用了渲染层：\n  ${bad.join('\n  ')}`);
});

section('状态归属');

t('app/*.js 顶层没有可变绑定（跨模块状态只能放 ctx）', () => {
  const bad = [];
  for (const file of collectJs(path.join(MAIN_DIR, 'app'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // 只认顶格声明：缩进的一定在函数里，不会跨调用残留
      if (/^(let|var)\s+[A-Za-z_$]/.test(line)) bad.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(bad, [], `这些是「第二个真身」的候选：\n  ${bad.join('\n  ')}`);
});

t('登录窗引用只存在于 ctx（login-window.js 用 ctx.loginWindow）', () => {
  const src = fs.readFileSync(path.join(MAIN_DIR, 'app', 'login-window.js'), 'utf8');
  assert.ok(/ctx\.loginWindow/.test(src), 'login-window.js 必须通过 ctx 读写登录窗引用');
  assert.ok(/ctx\.loginPlatform/.test(src), 'login-window.js 必须通过 ctx 读写登录平台');
  assert.ok(/ctx\.loginUrls/.test(src), 'login-window.js 必须通过 ctx 读写登录地址');
});

t('ctx 的字段表覆盖了拆分前的全部模块级状态', () => {
  const { createContext } = require('../src/main/app/context');
  const ctx = createContext({ args: { smokeOut: 'x.json' } });
  for (const key of [
    'args',
    'mainWindow',
    'loginWindow',
    'loginPlatform',
    'loginUrls',
    'runner',
    'runnerPlatform',
    'settingsPath',
    'authStore',
    'loginState',
    'perfMarks',
  ]) {
    assert.ok(key in ctx, `ctx 缺少字段 ${key}`);
  }
  assert.strictEqual(typeof ctx.emit, 'function', 'ctx.emit 必须是函数');
  assert.deepStrictEqual(ctx.args, { smokeOut: 'x.json' }, 'args 必须原样带进来');
  assert.strictEqual(ctx.mainWindow, null, '初始不应有主窗口');
  assert.deepStrictEqual(ctx.loginUrls, {}, 'loginUrls 必须每个 ctx 各自一份（不能共享对象）');
});

t('两个 ctx 之间不共享可变子对象（避免「改一个动两个」）', () => {
  const { createContext } = require('../src/main/app/context');
  const a = createContext({});
  const b = createContext({});
  a.loginUrls.xhs = 'https://example.com';
  a.perfMarks.visibleMs = 123;
  assert.deepStrictEqual(b.loginUrls, {}, 'loginUrls 被两个 ctx 共享了');
  assert.strictEqual(b.perfMarks.visibleMs, null, 'perfMarks 被两个 ctx 共享了');
});

t('emitToMain 在窗口销毁/半销毁时都不抛（只丢事件）', () => {
  const { emitToMain } = require('../src/main/app/context');
  const sent = [];
  // ① 没有窗口
  assert.doesNotThrow(() => emitToMain({ mainWindow: null }, { type: 'log' }));
  // ② 窗口已销毁
  assert.doesNotThrow(() =>
    emitToMain({ mainWindow: { isDestroyed: () => true, webContents: { send: () => sent.push(1) } } }, {})
  );
  // ③ 访问 webContents 本身就抛（Electron 的真实行为）
  const boom = {
    get webContents() {
      throw new Error('Object has been destroyed');
    },
    isDestroyed: () => false,
  };
  assert.doesNotThrow(() => emitToMain({ mainWindow: boom }, { type: 'log' }));
  // ④ 正常窗口：事件必须真的发出去
  const ok = emitToMain(
    { mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, e) => sent.push([c, e]) } } },
    { type: 'log', message: 'hi' }
  );
  assert.strictEqual(ok, undefined, 'emitToMain 不返回值');
  assert.deepStrictEqual(sent, [['task:event', { type: 'log', message: 'hi' }]]);
});

section('冒烟增强');

/**
 * attachSmoke 是「真跑才炸」的典型：它不参与任何静态断言，
 * 一旦内部有 TDZ（在 const 声明之前读同名变量）或写错字段，
 * 静态测试全绿、打包也成功，只有启动应用时才会崩在 unhandledRejection 里，
 * 表现是「软件能开，但冒烟永远产不出 JSON」。
 * 这里用桩把「注册阶段」真跑一遍：只要不抛，就说明初始化路径是通的。
 */
t('attachSmoke 注册阶段不抛（挡住「静态全绿、启动即崩」的 TDZ）', () => {
  const fakeElectron = { app: { getAppMetrics: () => [], whenReady: () => new Promise(() => {}), quit() {} } };
  const realLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, parent, isMain);
  };
  let smoke = null;
  try {
    smoke = require('../src/main/app/smoke.js');
  } finally {
    Module._load = realLoad;
  }

  const registered = [];
  const win = {
    webContents: {
      on: (name) => registered.push(`on:${name}`),
      once: (name) => registered.push(`once:${name}`),
    },
  };
  // 没有 smokeOut 时必须静默返回（正常启动路径，绝不能因此报错）
  assert.doesNotThrow(() => smoke.attachSmoke({ args: {}, mainWindow: win }), '无 --smoke-out 时应直接返回');
  assert.strictEqual(registered.length, 0, '无 --smoke-out 时不应注册任何监听');

  // 带 smokeOut：注册 console-message 与 did-finish-load 各一次
  assert.doesNotThrow(
    () => smoke.attachSmoke({ args: { smokeOut: 'C:\\out\\s.json', smokeScene: 'progress' }, mainWindow: win, perfMarks: {} }),
    'attachSmoke 注册阶段不应抛异常'
  );
  assert.deepStrictEqual(registered, ['on:console-message', 'once:did-finish-load']);
});

t('pngPathOf：与 JSON 同目录同主名，只换扩展名', () => {
  const fakeElectron = { app: { getAppMetrics: () => [], whenReady: () => new Promise(() => {}) } };
  const realLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, parent, isMain);
  };
  let smoke = null;
  try {
    smoke = require('../src/main/app/smoke.js');
  } finally {
    Module._load = realLoad;
  }
  assert.ok(typeof smoke.attachSmoke === 'function', 'smoke.js 必须导出 attachSmoke');
  const cases = [
    ['C:\\out\\smoke.json', 'C:\\out\\smoke.png'],
    ['C:\\out\\smoke', 'C:\\out\\smoke.png'],
    // 目录名里带点是最容易出错的一种（正则截断会把目录一起吃掉）
    ['C:\\a.b\\smoke.out.json', 'C:\\a.b\\smoke.out.png'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(smoke.pngPathOf(input), want, `pngPathOf(${input}) 不对`);
  }
});

t('探针里带了 viewport 字段，且截图失败不会写进 errors', () => {
  const src = fs.readFileSync(path.join(MAIN_DIR, 'app', 'smoke.js'), 'utf8');
  assert.ok(/viewport:\s*\{/.test(src), '探针 JSON 必须带 viewport');
  for (const key of ['innerWidth', 'innerHeight', 'devicePixelRatio']) {
    assert.ok(src.includes(key), `viewport 里必须有 ${key}`);
  }
  assert.ok(/capturePage\s*\(/.test(src), '必须调 capturePage 截图');
  assert.ok(/pngPathOf\(smokeOut\)/.test(src), '截图必须存到 <smoke-out>.png');
  // 截图那段必须是 try/catch 且 catch 里不 push 到 smokeErrors。
  // 注意从**调用处**开始切片：文件头注释里也提到了 capturePage，从那里切会切错段。
  const shot = src.slice(src.indexOf('capturePage()'));
  const catchAt = shot.indexOf('} catch');
  assert.ok(catchAt > 0, '截图必须包在 try/catch 里');
  const catchBlock = shot.slice(catchAt, catchAt + 240);
  assert.ok(!/smokeErrors\.push/.test(catchBlock), '截图失败不能算「功能坏了」，不该进 errors');
});

t('窗口尺寸解析：接受 WxH，拒绝明显笔误', () => {
  const fakeElectron = {
    BrowserWindow: class {},
    app: { getAppMetrics: () => [], whenReady: () => new Promise(() => {}) },
  };
  const realLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, parent, isMain);
  };
  let windows = null;
  try {
    windows = require('../src/main/app/windows.js');
  } finally {
    Module._load = realLoad;
  }
  assert.deepStrictEqual(windows.parseWindowSize(['--window-size=1024x768']), { width: 1024, height: 768 });
  assert.deepStrictEqual(windows.parseWindowSize(['--window-size=800×600']), { width: 800, height: 600 });
  assert.strictEqual(windows.parseWindowSize(['--window-size=12x10']), null, '明显笔误应判废');
  assert.strictEqual(windows.parseWindowSize(['--window-size=abc']), null);
  assert.strictEqual(windows.parseWindowSize([]), null, '没传就用默认值');
  // 自定义尺寸时 min 跟着放宽，否则窄视口会被夹回去（验收等于测了个假的）
  const size = windows.windowSizeOf({ args: { windowSize: { width: 700, height: 500 } } });
  assert.strictEqual(size.width, 700);
  assert.ok(size.minWidth <= 700 && size.minHeight <= 500, 'min 尺寸必须跟着放宽');
  // 没自定义时保持设计稿的默认值与原 min 限制
  const def = windows.windowSizeOf({ args: {} });
  assert.strictEqual(def.width, 1020);
  assert.strictEqual(def.height, 800);
  assert.strictEqual(def.minWidth, 900);
  assert.strictEqual(def.minHeight, 680);
});

/* ------------------------------- 跑测试 ------------------------------- */

console.log('[架构约束]');
for (const [name, fn] of tests) {
  if (name === null) {
    console.log(`\n[${fn}]`);
    continue;
  }
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failed.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('\n----------------------------------------------------');
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('\n失败详情：');
  for (const f of failed) console.log(`\n● ${f.name}\n${f.err.stack}`);
  process.exitCode = 1;
}
