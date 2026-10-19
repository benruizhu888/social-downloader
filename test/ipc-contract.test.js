/**
 * IPC 契约（纯 Node）
 *
 * 拆分主进程时最容易出的事故是「通道悄悄少了一条」：`ipcRenderer.invoke` 发出去
 * 没有人接，渲染层拿到的是 `Error: No handler registered for 'xxx'` —— 而这类问题
 * 在真机上的表现往往是「某个按钮点了没反应」，事后追查成本极高。
 *
 * 这里用三组断言把它钉死：
 *   ① **零丢失**：拆分前主进程注册的 19 条通道，必须一条不多一条不少地还在；
 *   ② **两侧对齐**：preload 里每次 `invoke`/`send` 都必须在主进程有对端；
 *   ③ **不漂移**：每个 ipc 模块自己声明的通道清单，必须与它真正注册的一致；
 *      同一通道被注册两次（含 handle/on 混着来）必须当场抛错。
 *
 * 跑法：node test/ipc-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/* --------------------------- 假 electron --------------------------- */
/**
 * 只为了能 `require` 主进程模块（它们顶层会解构 electron）。
 * 这里的所有函数都不会被调用 —— 本文件只关心「注册了哪些通道」。
 */
const fakeElectron = {
  app: {
    getVersion: () => '0.0.0',
    getPath: () => process.cwd(),
    whenReady: () => new Promise(() => {}),
    on() {},
    getAppMetrics: () => [],
    commandLine: { appendSwitch() {} },
  },
  ipcMain: { handle() {}, on() {} },
  dialog: {},
  clipboard: {},
  shell: {},
  session: { fromPartition: () => ({ cookies: { get: async () => [], set: async () => {} } }) },
  BrowserWindow: class FakeBrowserWindow {},
  safeStorage: {},
  contextBridge: {},
  ipcRenderer: {},
};

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return realLoad.call(this, request, parent, isMain);
};

const ipc = require('../src/main/app/ipc');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

/* ------------------------------ 读取源码 ------------------------------ */

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
const HARVEST = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'harvest-preload.js'), 'utf8');

/** 从源码里抠出所有 `ipcRenderer.invoke('x')` 的通道名（去重排序） */
function invokesIn(src) {
  return [...new Set([...src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]))].sort();
}

/** 从源码里抠出所有 `ipcRenderer.send('x')` 的通道名（去重排序） */
function sendsIn(src) {
  return [...new Set([...src.matchAll(/ipcRenderer\.send\(\s*'([^']+)'/g)].map((m) => m[1]))].sort();
}

/** 从源码里抠出所有 `ipcRenderer.on('x')` 的通道名（去重排序） */
function listensIn(src) {
  return [...new Set([...src.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((m) => m[1]))].sort();
}

/**
 * 造一个记账用的假 ipcMain：记录每次注册，不执行任何逻辑。
 * @returns {{handle:Function,on:Function,handles:string[],ons:string[]}}
 */
function fakeIpcMain() {
  const handles = [];
  const ons = [];
  return {
    handles,
    ons,
    handle(channel) {
      handles.push(channel);
    },
    on(channel) {
      ons.push(channel);
    },
  };
}

/**
 * 真的跑一遍 registerAll（用假 ipcMain），拿到「实际注册了什么」。
 * ctx 用空对象即可 —— 处理函数不会在本文件里被调用。
 */
function registeredChannels() {
  const fake = fakeIpcMain();
  const reg = ipc.registerAll({}, { ipcMain: fake });
  return {
    handle: fake.handles.slice().sort(),
    on: fake.ons.slice().sort(),
    reported: reg.channels(),
  };
}

/* -------------------------------- 用例 -------------------------------- */

section('拆分零丢失');

/**
 * 拆分前 `main.js` 注册的完整通道清单（逐条手抄自拆分前的代码，作为基线）。
 * 这份清单**刻意写死**：它守的是「重构不改行为」，而不是「跟着实现一起改」。
 */
const BASELINE_HANDLE = [
  'app:info',
  'auth:logout',
  'auth:openLogin',
  'auth:setCookie',
  'auth:status',
  'clipboard:write',
  'dir:choose',
  'ffmpeg:check',
  'input:inspect',
  'log:export',
  'login:url',
  'settings:get',
  'settings:set',
  'shell:open',
  'shell:openSite',
  'task:start',
  'task:stop',
];
const BASELINE_ON = ['harvest:data', 'harvest:match-mode'];

t('handle 通道与拆分前完全一致（17 条，一条不多一条不少）', () => {
  const got = registeredChannels();
  assert.deepStrictEqual(got.handle, BASELINE_HANDLE);
});

t('on 通道与拆分前完全一致（2 条）', () => {
  const got = registeredChannels();
  assert.deepStrictEqual(got.on, BASELINE_ON);
});

t('清单导出与实际注册一致（IPC_CHANNELS 不是另抄的一份）', () => {
  const got = registeredChannels();
  assert.deepStrictEqual(ipc.IPC_CHANNELS.handle, got.handle);
  assert.deepStrictEqual(ipc.IPC_CHANNELS.on, got.on);
});

t('ALL_CHANNELS 覆盖两个方向且无重复', () => {
  assert.deepStrictEqual(ipc.ALL_CHANNELS, [...BASELINE_HANDLE, ...BASELINE_ON].sort());
  assert.strictEqual(new Set(ipc.ALL_CHANNELS).size, ipc.ALL_CHANNELS.length);
});

section('两侧对齐');

t('主界面 preload 每一次 invoke 都有主进程 handler', () => {
  const used = invokesIn(PRELOAD);
  assert.ok(used.length >= 10, '用例前提：preload 里应当有一批 invoke');
  const missing = used.filter((c) => !ipc.IPC_CHANNELS.handle.includes(c));
  assert.deepStrictEqual(missing, [], `这些通道没有人接：${missing.join(', ')}`);
});

t('采集窗 preload 每一次 send 都有主进程 listener', () => {
  const used = sendsIn(HARVEST);
  assert.ok(used.length >= 1, '用例前提：采集 preload 会 send 数据');
  const missing = used.filter((c) => !ipc.IPC_CHANNELS.on.includes(c));
  assert.deepStrictEqual(missing, [], `这些通道没有人接：${missing.join(', ')}`);
});

t('主进程没有渲染层从来不用的 handle 通道（防拼错名字）', () => {
  const used = invokesIn(PRELOAD);
  const extra = ipc.IPC_CHANNELS.handle.filter((c) => !used.includes(c));
  assert.deepStrictEqual(extra, [], `这些通道没人调用，多半是名字写错了：${extra.join(', ')}`);
});

t('主进程推给界面的 task:event 在 preload 里确实被订阅', () => {
  const emitted = listensIn(PRELOAD);
  assert.ok(
    emitted.includes('task:event'),
    `preload 应订阅 task:event，实际订阅：${emitted.join(', ') || '（无）'}`
  );
});

section('模块自报清单不漂移');

/** 逐个模块单独跑一遍 register，比对「声明的」与「注册的」 */
const MODULE_FILES = ['app-info', 'settings', 'input', 'auth', 'task'];

t('每个 ipc 模块的 HANDLE_CHANNELS 与 register 实际注册一一对应', () => {
  for (const name of MODULE_FILES) {
    const mod = require(`../src/main/app/ipc/${name}`);
    const fake = fakeIpcMain();
    const reg = ipc.createRegistrar(fake);
    mod.register(reg, {});
    assert.deepStrictEqual(
      fake.handles.slice().sort(),
      (mod.HANDLE_CHANNELS || []).slice().sort(),
      `${name}.js 声明的 handle 清单与实际注册不一致`
    );
  }
});

t('每个 ipc 模块的 ON_CHANNELS 与 register 实际注册一一对应', () => {
  for (const name of MODULE_FILES) {
    const mod = require(`../src/main/app/ipc/${name}`);
    const fake = fakeIpcMain();
    const reg = ipc.createRegistrar(fake);
    mod.register(reg, {});
    assert.deepStrictEqual(
      fake.ons.slice().sort(),
      (mod.ON_CHANNELS || []).slice().sort(),
      `${name}.js 声明的 on 清单与实际注册不一致`
    );
  }
});

t('五个模块自己的通道互不重叠（重叠就说明该拆的更细或该合并）', () => {
  const seen = new Map();
  for (const name of MODULE_FILES) {
    const mod = require(`../src/main/app/ipc/${name}`);
    const all = [...(mod.HANDLE_CHANNELS || []), ...(mod.ON_CHANNELS || [])];
    for (const ch of all) {
      assert.strictEqual(seen.has(ch), false, `通道 ${ch} 同时出现在 ${seen.get(ch)} 与 ${name}`);
      seen.set(ch, name);
    }
  }
});

section('重复注册必须当场抛');

t('同一通道注册两次（都是 handle）会抛，而不是静默覆盖', () => {
  const reg = ipc.createRegistrar(fakeIpcMain());
  reg.handle('demo:dup', () => {});
  assert.throws(() => reg.handle('demo:dup', () => {}), /重复注册/);
});

t('同一通道先 handle 后 on 也会抛（两种语义不能并存）', () => {
  const reg = ipc.createRegistrar(fakeIpcMain());
  reg.handle('demo:mixed', () => {});
  assert.throws(() => reg.on('demo:mixed', () => {}), /重复注册/);
});

t('registerAll 跑第二遍会抛（防止 ready 被触发两次就静默覆盖）', () => {
  /**
   * 假 ipcMain **完全模仿 Electron**：同名通道静默覆盖、从不抛错
   * （这正是真实的危险所在）。所以「跑第二遍」时，唯一可能拦住它的就是包装层。
   */
  const fake = fakeIpcMain();
  ipc.registerAll({}, { ipcMain: fake });
  assert.throws(() => ipc.registerAll({}, { ipcMain: fake }), /重复注册/);
  // 附证：Electron 那一层确实已经吃进了重复的通道名
  assert.strictEqual(fake.handles.length, BASELINE_HANDLE.length);
  assert.ok(
    fake.handles.filter((c) => c === 'app:info').length >= 1,
    '假 ipcMain 应确实收到过 app:info'
  );
});

t('createRegistrar 返回的 channels() 带类型，便于排查', () => {
  const reg = ipc.createRegistrar(fakeIpcMain());
  reg.handle('b:x', () => {});
  reg.on('a:y', () => {});
  assert.deepStrictEqual(reg.channels(), [
    { channel: 'a:y', kind: 'on' },
    { channel: 'b:x', kind: 'handle' },
  ]);
});

/* ------------------------------- 跑测试 ------------------------------- */

console.log('[IPC 契约]');
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

// 恢复真实 require，避免影响同进程内后续文件（本文件独立运行，这里只是好习惯）
Module._load = realLoad;
