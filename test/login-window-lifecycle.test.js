/**
 * 登录窗的生命周期（P0-4）
 *
 * 复现的缺陷：切换平台时 `loginWindow.close()` 之后**立刻**建新窗，
 * 而旧窗的 'closed' 回调要等到后面的 tick 才跑。旧代码在回调里无条件
 * `loginWindow = null; loginPlatform = null;` —— 于是旧窗的收尾把**新窗**引用抹掉了：
 *   · 再点一次「登录」→ 以为没有窗口 → 又开一个（重复开窗，监听器一起泄漏）
 *   · loginPlatform 丢失 → 依赖它的登录/退出流程找不到当前平台
 *
 * 这类问题读源码是看不出来的（两处代码各自都「对」），必须真的跑一遍开窗/关窗时序。
 * 所以这里用**假 electron** 加载 main.js：假窗口的 'closed' 刻意延后一个 tick 发出，
 * 与真实 Electron 的时序一致；测试再断言模块级引用到底指向哪个窗口。
 *
 * 跑法：node test/login-window-lifecycle.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 假 electron ------------------------------ */

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super();
    this._win = win;
    this._url = 'about:blank';
    this._destroyed = false;
    this._loading = false;
    this.windowOpenHandler = null;
  }
  setWindowOpenHandler(fn) {
    this.windowOpenHandler = fn;
    return { action: 'deny' };
  }
  isDestroyed() {
    return this._destroyed || this._win.isDestroyed();
  }
  isLoading() {
    return this._loading;
  }
  getURL() {
    return this._url;
  }
  async executeJavaScript() {
    return null;
  }
  send() {}
  isCrashed() {
    return false;
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options || {};
    /** 标题里带着平台名，方便断言「当前引用指向哪个平台的窗口」 */
    this.title = this.options.title || '';
    this.destroyed = false;
    this.focusCount = 0;
    this.loaded = [];
    this.webContents = new FakeWebContents(this);
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  setTitle(t) {
    this.title = String(t || '');
  }
  focus() {
    this.focusCount++;
  }
  /**
   * 真实 Electron 里 close() 只是「请求关闭」，'closed' 事件在后面的 tick 才发出。
   * 这个延迟正是 P0-4 的成因，假窗口必须如实模拟，否则测试永远是绿的。
   */
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents._destroyed = true;
    setTimeout(() => this.emit('closed'), 0);
  }
  destroy() {
    this.close();
  }
  loadURL(url) {
    this.loaded.push(url);
    this.webContents._url = url;
    return Promise.resolve();
  }
  static getAllWindows() {
    return FakeBrowserWindow.instances.filter((w) => !w.isDestroyed());
  }
}
FakeBrowserWindow.instances = [];

/** 每个分区一份会话；cookies 是 EventEmitter（登录窗会挂/摘 'changed' 监听） */
const sessions = new Map();
function fakeSession(partition) {
  if (!sessions.has(partition)) {
    const cookies = new EventEmitter();
    cookies.get = async () => [];
    cookies.set = async () => {};
    cookies.remove = async () => {};
    cookies.flushStore = async () => {};
    sessions.set(partition, { partition, cookies });
  }
  return sessions.get(partition);
}

const userData = path.join(os.tmpdir(), `sd-login-lifecycle-${process.pid}`);

const fakeElectron = {
  app: {
    commandLine: { appendSwitch() {} },
    on() {},
    whenReady: () => new Promise(() => {}), // 永不 resolve：不跑真正的启动流程
    getPath: () => userData,
    quit() {},
    getAppMetrics: () => [],
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { on() {}, handle() {}, removeHandler() {} },
  dialog: {},
  session: { fromPartition: (p) => fakeSession(p) },
  shell: {},
  safeStorage: {},
  clipboard: {},
  webContents: { getAllWebContents: () => [] },
};

/**
 * 在加载 main.js 之前替换 'electron' 的解析结果。
 * （main.js 顶层就 `require('electron')` 并注册全局护栏，晚一步就来不及了）
 */
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const main = require('../src/main/main.js');
Module._load = originalLoad;

const api = main && main.__test__;
assert.ok(
  api && typeof api.createLoginWindow === 'function',
  'main.js 需要导出 __test__（登录窗生命周期只能在真实时序下验证）'
);

const state = () => api.loginState();
const liveWins = () => FakeBrowserWindow.instances.filter((w) => !w.isDestroyed());

/* -------------------------------- 用例 -------------------------------- */

section('基本开窗');

t('开登录窗后引用指向它，并记下平台', () => {
  api.createLoginWindow('weibo');
  const st = state();
  assert.ok(st.loginWindow, '应记录当前登录窗');
  assert.strictEqual(st.loginPlatform, 'weibo');
  assert.ok(st.loginWindow.title.includes('微博'), `实际标题：${st.loginWindow.title}`);
});

/**
 * 登录窗是一个没有地址栏的裸 BrowserWindow：用户在里面输账号时看不到自己在哪个站点。
 * 标题是唯一能常驻显示网址的地方，所以它必须带域名，且不能被页面自带的 title 覆盖。
 */
t('登录窗标题带当前网站域名，且页面标题覆盖不了它', () => {
  const win = state().loginWindow;
  assert.ok(/weibo\.com/.test(win.title), `标题必须带域名：${win.title}`);
  assert.ok(win.title.includes('微博'), '平台名也要在，两者缺一不可');

  // 页面自己发 page-title-updated（真实 Electron 里这会改写标题栏）
  let prevented = false;
  win.emit('page-title-updated', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.ok(prevented, '必须 preventDefault，否则一加载完标题就变回「微博登录」');
  assert.ok(/weibo\.com/.test(win.title), '标题应保持带域名');
});

t('同平台重复点击只是聚焦，不会开第二个窗口', () => {
  const before = FakeBrowserWindow.instances.length;
  api.createLoginWindow('weibo');
  assert.strictEqual(FakeBrowserWindow.instances.length, before, '同平台不该新建窗口');
  assert.strictEqual(state().loginWindow.focusCount, 1, '应聚焦已有窗口');
});

section('切换平台（P0-4 的核心）');

t('切平台后旧窗迟到的 closed 不会把新窗引用清空', async () => {
  const weiboWin = state().loginWindow;
  api.createLoginWindow('xhs');
  const xhsWin = state().loginWindow;

  assert.notStrictEqual(xhsWin, weiboWin, '应已换成小红书窗口');
  assert.strictEqual(state().loginPlatform, 'xhs');

  // 等旧窗的 'closed' 回调跑完（正是这里会把引用抹掉）
  await sleep(30);

  assert.strictEqual(
    state().loginWindow,
    xhsWin,
    '旧窗的 closed 回调不能清掉新窗引用（否则会重复开窗、loginPlatform 丢失）'
  );
  assert.strictEqual(state().loginPlatform, 'xhs', 'loginPlatform 也不能被旧窗抹掉');
  assert.strictEqual(xhsWin.isDestroyed(), false, '新窗不该被牵连关闭');
});

t('切平台后引用正确，再点同平台仍然只聚焦（不会开出第三个窗口）', async () => {
  const before = FakeBrowserWindow.instances.length;
  api.createLoginWindow('xhs');
  await sleep(30);
  assert.strictEqual(
    FakeBrowserWindow.instances.length,
    before,
    `引用没丢就不该重复开窗，实际新增了 ${FakeBrowserWindow.instances.length - before} 个`
  );
  assert.strictEqual(state().loginWindow.focusCount >= 1, true);
});

t('旧窗的收尾动作照常执行：Cookie 监听被摘掉（不泄漏）', async () => {
  const weiboSession = fakeSession('persist:weibo');
  assert.strictEqual(
    weiboSession.cookies.listenerCount('changed'),
    0,
    '旧窗关闭后必须摘掉它挂在分区上的 changed 监听'
  );
});

t('loginUrls 按平台分开存，切平台不会清掉另一个平台的地址', async () => {
  // 旧窗（微博）迟到的导航事件写的是自己的键，新平台清空的是自己的键
  const weiboWin = FakeBrowserWindow.instances.find((w) => w.title.includes('微博'));
  weiboWin.webContents.emit('did-navigate', {}, 'https://weibo.com/login?ok=1');
  assert.strictEqual(state().loginUrls.weibo, 'https://weibo.com/login?ok=1');

  api.createLoginWindow('douyin');
  await sleep(30);

  assert.strictEqual(
    state().loginUrls.weibo,
    'https://weibo.com/login?ok=1',
    '切到抖音不该清掉微博的地址缓存'
  );
  assert.strictEqual(state().loginUrls.douyin, '', '新平台自己的地址应先清空（避免展示上次的旧地址）');
});

section('关闭当窗');

t('关闭当前登录窗后引用被清空（正常收尾不能坏掉）', async () => {
  const win = state().loginWindow;
  win.close();
  await sleep(30);
  assert.strictEqual(state().loginWindow, null);
  assert.strictEqual(state().loginPlatform, null);
});

t('关窗后可以重新开一个干净的窗口', async () => {
  api.createLoginWindow('weibo');
  assert.ok(state().loginWindow);
  assert.strictEqual(state().loginPlatform, 'weibo');
  assert.strictEqual(liveWins().length, 1, '同一时刻只应存在一个登录窗');
});

t('登录窗按平台使用各自的分区（凭据不会串台）', () => {
  const win = state().loginWindow;
  assert.strictEqual(win.options.webPreferences.partition, 'persist:weibo');
});

/* -------------------------------- 运行 -------------------------------- */

(async function run() {
  try {
    fs.mkdirSync(userData, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n${fn}`);
      continue;
    }
    try {
      await fn();
      pass++;
      console.log('  \u2713 ' + name);
    } catch (e) {
      fail++;
      failed.push(name);
      console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
    }
  }
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (failed.length) {
    console.log('失败用例：');
    for (const f of failed) console.log('  · ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
