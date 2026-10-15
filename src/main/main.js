/**
 * 主进程
 *
 * 设计原则：主进程本身不认识任何平台细节，所有平台相关行为都通过
 * `registry` 里的适配器完成。三个平台在以下维度完全独立：
 *   1. 登录态：各自独立的 Electron 持久化分区（persist:weibo / xhs / douyin）
 *   2. 登录窗：各平台的登录地址与成功判定 Cookie 各不相同
 *   3. 设置：每个平台各存一份（保存目录、目标输入、全部选项互不影响）
 *   4. 采集方式：微博直连接口；小红书/抖音走浏览器内采集
 */
const { app, BrowserWindow, ipcMain, dialog, session, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fsp = require('fs/promises');
const fs = require('fs');

const registry = require('./platforms/registry');
const { TaskRunner } = require('./core/runner');
const { sessionFetch, withCookie } = require('./core/net');
const { findFFmpeg, ffmpegVersion } = require('./core/ffmpeg');
const { joinCookies, latestExpiry, parseCookieString, AuthStore, gatherAuthCookies, removeAuthCookies } = require('./cookies');
const { LoginState, fingerprint } = require('./login-state');
const { hasProbe, collectScript, decision: loginDecision, createLoginGate } = require('./login-probe');
const { attachUrlGuards, installGlobalUrlGuard, pickAllowedSite } = require('./url-guard');
const { installProcessGuard } = require('./process-guard');
const { parseSingleUrl, parseInputList, describeSingle } = require('./url-parse');

/**
 * 全局兜底护栏 —— 必须在**任何窗口创建之前**注册，所以放在模块顶层而不是 whenReady 里。
 *
 * 为什么不能只靠各窗口自己挂：本轮两次「那个 bytedance 对话框又出现了」
 * 都是因为**漏了一条路**（第一次是 iframe 回调签名写错成了死代码，
 * 第二次是服务端 302 跳转没人管）。靠人记得给每个窗口挂护栏，漏一次就等于没有。
 * 注册在这里，则任何 webContents（主窗、登录窗、采集窗、将来的新窗口、
 * 甚至 Chromium 自己开出来的窗口）都自带一层底：非 http(s) 一律不许交给操作系统。
 */
installGlobalUrlGuard(app, { log: (m) => console.log('[guard]', m) });

/**
 * 进程级兜底 —— 让「未捕获异常」变成一行日志，而不是挡在用户面前的崩溃模态框。
 *
 * 用户截图里那个「A JavaScript error occurred in the main process」就是 Electron
 * 默认处理器弹的。我们注册自己的 uncaughtException 监听器后，Electron 会因为
 * 「已有自定义处理器」而主动让位（详见 src/main/process-guard.js 的注释）。
 *
 * 这是**最后一道防线**，不是替代修 bug：本轮真正的原因（护栏回调抛异常 +
 * emit 在窗口销毁后仍往 webContents 发消息）都单独修了。这一层保证的是
 * 「还有没修到的地方时，用户也不会被一个他看不懂的模态框拦住」。
 */
installProcessGuard({
  // 落盘到 userData/crash.log：用户上报「卡住/崩溃」时，一行就够定位
  writeLog: (text) => {
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'crash.log'), text + '\n', 'utf8');
    } catch {
      /* 磁盘不可写就算了，不能因为写日志再抛一次 */
    }
  },
  // 同时推到界面上，用户能看到「出了什么问题、日志在哪」，而不是一脸茫然
  onFatal: (info) => {
    emit({
      type: 'log',
      message: `程序内部出现异常，已忽略并继续（详情见 crash.log）：${info.message}`,
    });
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上「最大化/全屏后偶现空白、界面像卡住」的已知诱因。
 *
 * Chromium 在 Windows 会做原生窗口遮挡检测（CalculateNativeWinOcclusion）：
 * 判断窗口被完全覆盖时就**停止渲染**。这个判定在部分显卡驱动/多显示器/远程桌面组合下会误判，
 * 于是窗口恢复或最大化时没有任何一帧被画出来 —— 用户看到的就是空白屏，
 * 而且因为渲染循环停着，点哪儿都像没反应。
 *
 * 关掉这个特性只是让被遮挡的窗口继续渲染（代价是被完全盖住时多一点 CPU），
 * 对这类工具面板完全可以接受。
 * 必须在 app ready 之前调用。
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/*
 * 关于内存调优的记录（别凭直觉加开关）：
 *
 * 试过 `--enable-low-end-device-mode`（本意是缩小光栅缓存/线程池）。实测是**负优化**：
 *   内存中位数 399MB → 413MB（Browser 92→101MB），窗口可见 386ms → 432ms。
 * 原因是该档位额外开启了若干降级路径，对「静态工具面板」这种场景没有收益。
 * 结论：内存这块不去动 Chromium 的档位开关，老老实实从应用自身找浪费
 * （日志 DOM 上限、常驻动画），并用 test/measure-perf.js 量数字验证。
 */

let mainWindow = null;
let loginWindow = null;
let loginPlatform = null;
let runner = null;
let runnerPlatform = null;
let settingsPath = '';
let authStore = null;
let loginState = null;
/** 登录窗当前地址，供界面展示与复制 */
const loginUrls = {};

/**
 * 启动/内存观测点。
 *
 * 用 `process.uptime()` 而不是自己记 t0 —— 它从进程真正启动算起，
 * 把 Electron 自身的初始化也算进去，才是用户体感到的「双击到出画面」。
 * 内存用 `app.getAppMetrics()`（Electron 官方口径，覆盖 GPU/渲染/工具进程），
 * 不依赖外部工具去枚举进程 —— 换台机器也能复现。
 */
const perfMarks = { visibleMs: null, loadedMs: null };

function memorySnapshot() {
  const list = app.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    mb: Math.round((m.memory?.workingSetSize || 0) / 1024),
  }));
  return {
    totalMB: list.reduce((s, x) => s + x.mb, 0),
    processes: list,
  };
}

const DEFAULT_SETTINGS = { activePlatform: registry.DEFAULT_PLATFORM, ffmpegPath: '', platforms: {} };

function defaultPlatformSettings(id) {
  const p = registry.get(id);
  return p ? { ...p.defaultOptions } : {};
}

/** 读取设置，并把每个平台的默认值补齐（新增选项后老配置也能用） */
async function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch {
    raw = {};
  }
  const out = { ...DEFAULT_SETTINGS, ...raw, platforms: {} };
  if (!registry.get(out.activePlatform)) out.activePlatform = registry.DEFAULT_PLATFORM;
  for (const p of registry.list) {
    out.platforms[p.id] = { ...defaultPlatformSettings(p.id), ...(raw.platforms?.[p.id] || {}) };
  }
  return out;
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = {
    ...cur,
    activePlatform: patch.activePlatform || cur.activePlatform,
    ffmpegPath: patch.ffmpegPath !== undefined ? patch.ffmpegPath : cur.ffmpegPath,
    platforms: { ...cur.platforms },
  };
  if (patch.platform && patch.options) {
    next.platforms[patch.platform] = { ...next.platforms[patch.platform], ...patch.options };
  }
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 向主界面推送一条事件 —— 全应用唯一的出口，所以这里必须**绝对不抛**。
 *
 * 用户截图里那个崩溃框的第一行栈就是这里：
 *   Error: Object has been destroyed
 *     at l.emit (…\src\main\main.js)
 *     at … windowOpenHandler …
 * 也就是「登录页在关窗过程中又调了一次 window.open」，回调链一路走到这里，
 * 而目标窗口已经不在了。
 *
 * 之前只判了 `mainWindow.isDestroyed()`，不够，有两种漏网状态：
 *   ① 窗口对象还活着，但它底下的 webContents 已经先被销毁 ——
 *      此时 `isDestroyed()` 仍是 false，`send()` 直接抛。
 *   ② 判断与发送之间隔着原生对象的销毁（事件回调里的时序不可控）。
 * 所以这里把「窗口 → webContents」两级都查一遍，外面再套一层 try/catch。
 *
 * 方向选择：丢一条日志 vs 弹一个盖住界面的崩溃模态框 —— 前者显然可接受。
 * 真正该修的地方（护栏回调、窗口生命周期）另修，这一层只是保证不再有模态框。
 */
function emit(event) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // ⚠️ 访问 `win.webContents` 本身就可能抛：「窗口已销毁」时这个 getter
    //    直接抛 `Error: Object has been destroyed`（crash-guard.test.js 的矩阵实测），
    //    所以它必须在 try 里面，不能放在判断条件里。
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    // 渲染进程刚崩掉时窗口与 webContents 都还「活着」，但渲染帧已经没了，
    // 此时 send 会打印「Error sending from webFrameMain: Render frame was disposed」。
    // 弹窗是刷屏级噪声（一次滚动能刷几十行），顺手挡掉。
    if (wc.isCrashed && wc.isCrashed()) return;
    wc.send('task:event', event);
  } catch (err) {
    console.warn('[main] 事件下发失败（窗口可能正在销毁）：', err && err.message);
  }
}

/* ----------------------------- 登录态与凭证 ----------------------------- */

function normalizePlatform(id) {
  return registry.get(id) ? id : registry.DEFAULT_PLATFORM;
}

/**
 * 各平台独立的登录态查询：只读该平台自己的分区。
 *
 * 判定不是「关键 Cookie 存在」，而是「本应用亲眼见它产生或变化过」——
 * 因为 ttwid / web_session 这类 Cookie 匿名访问站点时就会写入，
 * 只看存在会把访客误判为已登录（并在开登录窗时立刻自动关闭，表现为闪退）。
 *
 * 读取范围覆盖该平台所有相关域（siteURL + 登录页 + cookieDomains）：
 * 微博的 SUB 可能是 host-only 的 passport.weibo.com，只查 siteURL 会漏掉，
 * 表现为「登录成功但一直显示未登录」。
 */
async function authStatus(platform) {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  const cookies = await gatherAuthCookies(ses, p);
  // trustKeyCookie（微博）的平台：关键 Cookie 不会匿名下发，存在即真登录；
  // 首次遇到时由 verifyOrTrust 就地补记指纹，避免「明明已登录却显示未登录」。
  const v = await loginState.verifyOrTrust(p.id, cookies, p.loginMarks, !!p.trustKeyCookie);
  return {
    platform: p.id,
    loggedIn: v.loggedIn,
    marks: v.marks,
    detail: v.detail,
    expire: latestExpiry(cookies),
    cookieCount: cookies.length,
    cookieHint: p.loginMarks.join(' / '),
    /** 界面提示用：这些是匿名也会有的 Cookie，不代表登录 */
    weakSeen: cookies.filter((c) => c.value && (p.weakMarks || []).includes(c.name)).map((c) => c.name),
    siteURL: p.siteURL,
    loginURL: p.loginURL,
    loginWindowURL: loginUrls[p.id] || '',
  };
}

/**
 * 构造平台运行上下文。
 * injectCookieIntoFetch 的平台（微博）：把该分区的 Cookie 注入 fetch，接口直连。
 * 其余平台：不需要 Cookie 注入（下载 CDN 只需要 Referer），采集走浏览器。
 *
 * 分支依据是能力位而不是平台 id —— 加平台时不必回来改这里。
 *
 * ⚠️ fetch 一律用 `sessionFetch(ses)`（Chromium 网络栈），**不要用 globalThis.fetch**。
 * Node 的 fetch 无视系统代理、没有 IPv6 回退、也不共享分区会话 ——
 * 用户第 15 轮「采集能成功、下载全片 fetch failed」就是这个原因（详见 core/net.js）。
 */
async function buildContext(platform) {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  const cookies = await ses.cookies.get({ url: p.siteURL });
  let cookie = joinCookies(cookies);

  const ctx = { partition: p.partition, session: ses, cookie, fetchImpl: sessionFetch(ses) };

  if (p.injectCookieIntoFetch) {
    if (!cookie && authStore) {
      const saved = await authStore.load();
      if (saved?.value) cookie = saved.value;
    }
    // 兜底：接口用的 Cookie 头只认 weibo.com 域，但登录成功那一刻关键 Cookie
    // 有可能只落在 host-only 的 passport 主机上。若直接放行，用户会看到
    // 「界面显示已登录、点开始却说未取到 Cookie」这种自相矛盾的提示。
    // 这里把所有相关域里读到的关键 Cookie 补进请求头（顺带修好直接抓接口）。
    if (!p.loginMarks.some((m) => String(cookie || '').includes(`${m}=`))) {
      const marks = (await gatherAuthCookies(ses, p)).filter(
        (c) => c.value && p.loginMarks.includes(c.name)
      );
      if (marks.length) {
        const extra = marks.map((c) => `${c.name}=${c.value}`).join('; ');
        cookie = cookie ? `${cookie}; ${extra}` : extra;
      }
    }
    ctx.cookie = cookie;
    // 每次调用现取 cookie（登录态刷新后不必重建 fetch 实现）
    ctx.fetchImpl = withCookie(sessionFetch(ses), () => ctx.cookie);
  }
  return ctx;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 900,
    minHeight: 680,
    title: '社交平台作品下载器',
    backgroundColor: '#f6f7f9',
    // 先不显示：等首帧渲染好再 show。
    // 否则窗口会先亮出一个纯背景色的空壳，用户看到的就是「打开时闪一下白屏」——
    // 最大化/全屏时若正赶上重排，这一帧空白会更明显。
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => {
    perfMarks.visibleMs = Math.round(process.uptime() * 1000);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  // 兜底：理论上 ready-to-show 一定会来，万一页面出错也不能让窗口永远不出现
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 3000);
  const html = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(html).catch((e) => console.error('[main] 页面加载失败：', e));
  // 主窗口只承载本地界面，任何时候都不该导航到别处，也不该开新窗口。
  // 一旦漏挂，界面里的任意一个链接就可能把带自定义协议的地址交给操作系统。
  const selfUrl = pathToFileURL(html);
  attachUrlGuards(mainWindow.webContents, {
    log: (m) => console.log('[main]', m),
    // 只允许停留在自己的页面（含锚点跳转），其余一律拦掉
    allowNavigate: (url) => url === selfUrl.href || url.startsWith(`${selfUrl.href}#`),
  });
  mainWindow.webContents.on('did-finish-load', () => {
    perfMarks.loadedMs = Math.round(process.uptime() * 1000);
    console.log('[smoke] renderer ready');
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) =>
    console.error('[main] 渲染进程异常退出：', details.reason)
  );
  mainWindow.on('closed', () => (mainWindow = null));

  if (SMOKE_OUT) attachSmoke();
}

/**
 * 打开指定平台的登录窗（切平台时先关掉旧窗，避免混淆）
 *
 * 「登录成功」的判定分两条路，绝不能混：
 *
 *  A. 有页面探针的平台（小红书 / 抖音）
 *     它们的「关键 Cookie」访客访问就会下发，凭证存在或变化都不足以证明登录。
 *     唯一可信依据是页面自己的登录态，所以开窗后持续轮询页面探针，
 *     只有探针命中才关窗。这也顺带解决了「用户已登录但 Cookie 值没变」的情况。
 *     还要再分一层：**开窗时就已经登录**（用户没退出过，多半是想换账号）
 *     绝不自动关窗；只有「开窗后才变成登录」才认定是他刚完成登录。
 *
 *  B. 没有探针的平台（微博）
 *     SUB 只有真登录才有，凭证值发生变化即可认定登录成功。
 *
 * 早期版本对 A 类平台只看 Cookie 存在，于是点一下「登录」，匿名 Cookie 一秒后出现，
 * 窗口立刻自动关闭 —— 用户看到的就是「点登录闪退」。
 *
 * 其余关键点（都是踩过坑之后加的）：
 *  2. 接管 window.open：登录流程里常有弹窗/新标签页，不接管会开出无样式的空白窗。
 *  3. 监听渲染进程崩溃与加载失败并明确告知，避免又出现「闪退但不知道为什么」。
 *  4. 把当前地址实时回传主界面，方便用户复制。
 */
function createLoginWindow(platform) {
  const p = registry.get(normalizePlatform(platform));
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginPlatform === p.id) {
      loginWindow.focus();
      return;
    }
    loginWindow.close();
  }
  loginPlatform = p.id;
  loginUrls[p.id] = '';

  loginWindow = new BrowserWindow({
    width: 1060,
    height: 800,
    title: `登录 ${p.name}`,
    parent: mainWindow,
    webPreferences: { partition: p.partition, contextIsolation: true, nodeIntegration: false },
  });

  const ses = session.fromPartition(p.partition);
  const win = loginWindow;
  const probeScript = hasProbe(p.id) ? collectScript(p.id) : null;
  const log = (message) => emit({ type: 'log', platform: p.id, message });

  let confirmed = false;
  let lastProbe = { loggedIn: false, detail: '尚未检测' };
  let pollTimer = null;
  let pollBusy = false;
  /** 「开窗即已登录」与「本次刚登录」要区别对待，状态机放在 login-probe 里便于单测 */
  const gate = createLoginGate();

  /** 记录关键 Cookie 的指纹，之后 authStatus 用它验证「同一份凭证仍在」 */
  async function remember() {
    try {
      const cookies = await gatherAuthCookies(ses, p);
      for (const name of p.loginMarks) {
        for (const c of cookies.filter((x) => x.name === name && x.value)) {
          await loginState.record(p.id, name, c.value);
        }
      }
      return cookies;
    } catch {
      /* 记录失败不影响登录流程本身 */
      return [];
    }
  }

  async function markLoggedIn(detail) {
    if (confirmed) return;
    confirmed = true;
    stopPoll();
    await remember();
    emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}登录成功` });
    log(`登录校验通过：${detail}。登录窗口即将自动关闭`);
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.close();
    }, 1200);
  }

  /** 读一次页面登录态（页面正在跳转时会失败，属正常，下次轮询继续） */
  async function probeOnce() {
    if (!probeScript || confirmed) return lastProbe;
    const wc = liveWC();
    if (!wc) return lastProbe;
    // 页面正在跳转，这一轮不下结论（保留上一轮结果），等下一次轮询
    try {
      if (wc.isLoading()) return lastProbe;
    } catch {
      return lastProbe;
    }
    try {
      const snap = await wc.executeJavaScript(probeScript);
      lastProbe = loginDecision(p.id, snap);
    } catch (err) {
      lastProbe = { loggedIn: false, detail: `页面状态读取失败：${err.message}` };
    }
    return lastProbe;
  }

  /**
   * 根据探针结果决定下一步。
   *
   * 这里必须区分两种「页面已登录」：
   *   开窗时就已经登录（用户没退出过）—— 他多半是想换账号，**绝不能自动关窗**，
   *                                      否则又是一次「刚点开就没了」的体感
   *   开窗后才变成登录        —— 他刚完成登录，记录指纹并关窗
   * 判断逻辑封装在 createLoginGate() 里（可离线单测）。
   */
  async function reactToProbe(r) {
    const action = gate.next(r);
    if (action === 'wait') return;

    if (action === 'already-logged-in') {
      // 页面确实是登录态，指纹照记，保证登录状态查询正确
      await remember();
      emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}已是登录状态` });
      log(
        `当前已是${p.name}登录状态（${r.detail}）。如需切换账号，请在页面内操作后手动关闭本窗口，凭证会自动保存。`
      );
      return;
    }

    await markLoggedIn(r.detail);
  }

  function startPoll() {
    if (!probeScript || pollTimer) return;
    // 轮询而不是「等 Cookie 变化」：即使用户本次登录没有换发 Cookie 值，
    // 只要页面变成已登录态就一定能被捕获。
    pollTimer = setInterval(async () => {
      if (pollBusy || confirmed) return;
      pollBusy = true;
      try {
        await reactToProbe(await probeOnce());
      } finally {
        pollBusy = false;
      }
    }, 1200);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * B 路：没有页面探针的平台（微博），凭证值变化即登录成功。
   * 有探针的平台直接跳过 —— 否则匿名 Cookie 首次出现就会误判。
   *
   * 注意 `confirmed` 只用来「不再重复提示、不再重复关窗」，
   * **不能**用来阻止继续记录指纹：微博 SSO 会先后下发多份 SUB，
   * 早先版本一旦确认登录就把后续变化全部 return 掉，
   * 结果指纹停在中间那份、与最终生效的那份不一致 —— 用户看到的就是
   * 「登录成功了，界面却一直显示未登录」。
   */
  const onChanged = async (event, cookie, cause, removed) => {
    if (probeScript || removed || !cookie?.value) return;
    try {
      const r = await loginState.detectChange(p.id, cookie, p.loginMarks);
      if (!r.changed) return;
      if (confirmed) return; // 已经处理过登录：只同步指纹，不重复提示
      await markLoggedIn(`凭证 ${r.name} 已更新`);
    } catch {
      /* 记录失败不影响登录流程 */
    }
  };
  ses.cookies.on('changed', onChanged);

  const reportUrl = (url) => {
    if (!url || url === 'about:blank') return;
    loginUrls[p.id] = url;
    emit({ type: 'login-url', platform: p.id, url });
  };

  let startScheduled = false;
  win.webContents.on('did-navigate', (_e, url) => reportUrl(url));
  win.webContents.on('did-navigate-in-page', (_e, url) => reportUrl(url));
  win.webContents.on('did-finish-load', () => {
    try {
      reportUrl(win.webContents.getURL());
    } catch {
      /* 窗口可能已销毁 */
    }
    // 在途导航结束了，如果页面之前请求过「在当前窗口打开某地址」，现在可以安全地开了
    flushPendingOpen();
    if (startScheduled) return;
    startScheduled = true;
    // 等页面脚本跑起来再开始轮询。立刻探一次是为了尽早识别「开窗前就已登录」——
    // 那种情形不能自动关窗（用户多半是想换账号），所以必须走 reactToProbe 统一判断。
    setTimeout(async () => {
      if (!win || win.isDestroyed() || confirmed) return;
      await reactToProbe(await probeOnce());
      startPoll();
    }, 1500);
  });

  // 登录流程里常有弹窗/新标签页，不接管会开出无样式的空白窗，所以在同一个窗口里打开。
  // 但**只能开 http(s)**：抖音/微博的登录页都带「打开 App」深链（bytedance:// 等），
  // 无条件 loadURL 会让 Chromium 把自定义协议交给操作系统，
  // Windows 立刻弹出「获取打开此 'bytedance' 链接的应用」——用户截图里那个对话框。
  //
  // 另外「直接 loadURL」还有一个隐蔽的坏处 —— 用户报的「登录界面卡住」很可能就是它：
  // 登录本身就是一连串 302（passport → sso → 主站），页面还在跳转时如果被我们
  // 抢先 loadURL，在途的那次跳转会被中断，于是页面永远停在中间态。
  // 所以这里改成「排队」：窗口忙就先记下来，等它自己跳完（did-finish-load）再决定。
  let pendingOpen = null;
  let pendingTimer = null;

  /**
   * 取可用的 webContents；窗口或渲染进程任一已销毁都返回 null。
   *
   * 为什么要有这个包装：用户截图里的崩溃框就是从下面这条链抛出来的 ——
   *   windowOpenHandler → onWebOpen → log → emit → 「Object has been destroyed」
   * 事后复盘发现「窗口还在（isDestroyed() === false）、但它的 webContents 已经没了」
   * 是一个真实可达的状态（登录窗是主窗的子窗口，主窗被销毁时子窗口会跟着走，
   * 而页面脚本仍可能在那几十毫秒里调一次 window.open）。
   * 单查窗口不够，必须两级都查，而且访问 `win.webContents` 本身也要防抛。
   */
  function liveWC() {
    try {
      if (!win || win.isDestroyed()) return null;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return null;
      return wc;
    } catch {
      return null;
    }
  }

  function flushPendingOpen() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (!pendingOpen) return;
    const wc = liveWC();
    if (!wc) {
      pendingOpen = null;
      return;
    }
    // ① 页面正在跳转：绝不抢方向盘，等在途导航结束
    if (wc.isLoading()) return;
    const url = pendingOpen;
    // ② 已经在同一个地址上就不重复加载（SSO 页面常重复 open 同一个地址）
    let cur = '';
    try {
      cur = wc.getURL();
    } catch {
      /* webContents 刚好在这一刻销毁，交给下面的 try 兜住 */
    }
    pendingOpen = null;
    if (cur === url) return;
    log(`登录窗口内打开新页面：${url}`);
    try {
      win.loadURL(url).catch(() => {});
    } catch (err) {
      // loadURL 在窗口销毁时会**同步**抛错（.catch 捕不到），必须自己兜
      console.warn('[main] 登录窗口内打开新页面失败：', err && err.message);
    }
  }

  function scheduleOpen(url) {
    const wc = liveWC();
    if (!wc) return;
    pendingOpen = url; // 后到的覆盖先到的：用户真正想去的是最后一个
    if (pendingTimer) clearTimeout(pendingTimer);
    // 窗口闲着就立刻开；忙着就交给 did-finish-load 触发，这里只做一个兜底超时
    let busy = true;
    try {
      busy = wc.isLoading();
    } catch {
      busy = false;
    }
    if (!busy) flushPendingOpen();
    else pendingTimer = setTimeout(flushPendingOpen, 4000);
  }

  attachUrlGuards(win.webContents, {
    log,
    notifyWebOpen: false, // 上面的 flushPendingOpen 会在真正打开时记一条，避免重复
    onWebOpen: scheduleOpen,
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    stopPoll();
    log(`登录窗口页面异常退出（${details.reason}，code=${details.exitCode}）。请重新点击「登录${p.name}」`);
    emit({ type: 'login-crashed', platform: p.id, reason: details.reason });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是主动中断，属正常
    log(`登录页面加载失败（${code} ${desc}）：${url}`);
  });

  /**
   * 关窗后重新同步一次登录状态。
   *
   * 这里**必须先验证再上报**：用户完全可能什么都没做就把窗口关了。
   * 若无条件上报「已同步」，界面会先亮起已登录、再被随后的查询打回未登录，
   * 观感上就是「状态乱跳」。验证不通过就老实说未登录。
   */
  async function resync() {
    try {
      await remember();
      const st = await authStatus(p.id);
      if (st.loggedIn) {
        emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}登录状态已同步` });
      } else {
        emit({ type: 'auth', platform: p.id, loggedIn: false, message: st.detail });
        log(`${p.name}登录窗口已关闭：${st.detail}`);
      }
    } catch {
      /* 同步失败不影响已写入的指纹 */
    }
  }

  win.on('closed', () => {
    stopPoll();
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingOpen = null;
    ses.cookies.removeListener('changed', onChanged);
    loginWindow = null;
    loginPlatform = null;
    const wasLoggedIn = lastProbe.loggedIn;
    const alreadyConfirmed = confirmed;
    emit({ type: 'login-closed', platform: p.id });

    if (probeScript) {
      // 有探针的平台：只有「关窗前页面仍是登录态」才补记指纹。
      // 开窗时就已登录的情形在开窗时记过，这里重记是为了覆盖「用户换了账号」。
      if (wasLoggedIn && !alreadyConfirmed) resync();
      return;
    }

    // 没有探针的平台（微博）：以「关窗那一刻的真实凭证状态」为准重新同步一次。
    // 这是「登录成功却仍显示未登录」的兜底 —— 登录流程可能在我们记录之后又换发了凭证
    // （微博 SSO 会先后下发多份 SUB），也可能把凭证放到了另一个域下的 passport 主机上。
    // 窗口关闭时用户刚走完登录流程，此刻重新采一遍再验证，才是最终答案。
    resync();
  });

  win.loadURL(p.loginURL).catch((err) => {
    log(`打开登录页面失败：${err.message}`);
  });
}


/* ------------------- 注入脚本截获的数据转发给当前任务 ------------------- */
ipcMain.on('harvest:data', (e, payload) => {
  try {
    runner?.ingest(payload?.url, payload?.data);
  } catch {
    /* 忽略 */
  }
});

/**
 * 采集窗自报「响应白名单用的是哪一档判定」。
 *
 * 为什么要在界面上说出来：「该截哪个响应」的判定函数是**穿过 IPC 参数**送进
 * preload 的（沙箱 preload 不能 require 相对文件，见 src/preload/harvest-match.js）。
 * 一旦这条线断了，preload 会退化成「全截」—— 那正是「下载主页却把『喜欢』
 * 一起下下来」的形态，而且日志上看不出任何异常。所以这里主动把它讲出来。
 */
ipcMain.on('harvest:match-mode', (e, mode) => {
  try {
    if (mode === 'injected') return;
    runner?.log?.(
      mode === 'coarse'
        ? '⚠️ 响应白名单只有粗筛（精确判定未送达），可能多采到点赞/推荐内容'
        : '⚠️ 响应白名单未送达，已退化为「全部响应都采」'
    );
  } catch {
    /* 忽略 */
  }
});

/* --------------------------------- IPC --------------------------------- */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  defaultPlatform: registry.DEFAULT_PLATFORM,
  platforms: registry.all(),
}));

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (e, patch) => saveSettings(patch || {}));

/**
 * 判定输入框里粘的是「博主主页」「单个作品」还是「一批作品链接」。
 *
 * 为什么要走主进程而不是界面里自己写正则：
 *   判定逻辑必须与「真正决定走哪条流程」的那一份**是同一份代码**
 *   （runner 里用的也是 url-parse）。界面自己再写一套，两边迟早会跑偏 ——
 *   那时用户看到的提示与实际发生的事对不上，是最难查的一类 bug。
 *
 * 返回 `mode`：
 *   empty    没输入
 *   profile  不是作品链接（按原来的博主主页流程处理）
 *   single   一条作品链接
 *   batch    多行作品链接
 */
ipcMain.handle('input:inspect', (e, payload) => {
  const platform = normalizePlatform(payload?.platform);
  const cur = registry.get(platform);
  const curName = cur ? cur.name : '';
  const list = parseInputList(payload?.input);

  if (!list.lines) return { mode: 'empty' };

  const nameOf = (id) => {
    const p = id ? registry.get(id) : null;
    return p ? p.name : id || '';
  };

  // 单行 —— 保持与原行为完全一致
  if (list.lines === 1) {
    const r = list.targets[0];
    if (!r) return { mode: 'profile', currentName: curName };
    return {
      mode: 'single',
      platform: r.platform || '',
      platformName: nameOf(r.platform),
      itemId: r.itemId || '',
      shortLink: !!r.shortLink,
      mismatch: !!r.platform && r.platform !== platform,
      currentName: curName,
      text: describeSingle(r, nameOf(r.platform)),
    };
  }

  // 多行 —— 批量。只统计**属于当前平台**的条数：混着别家平台的链接时，
  // 界面要说清楚「会下几个、会跳过几条」，而不是给一个含糊的总数。
  const total = list.targets.length;
  const mine = list.targets.filter((t) => !t.platform || t.platform === platform);
  const alien = total - mine.length;
  // 去重后的平台 id 与名字：界面在「全部属于另一家」时据此给一个一键切换的按钮
  const ownerIds = [...new Set(list.targets.map((t) => t.platform).filter(Boolean))];
  const owners = ownerIds.map((id) => nameOf(id)).join('、');

  return {
    mode: 'batch',
    total,
    count: mine.length,
    alienCount: alien,
    ignoredCount: list.ignored.length,
    hasShortLink: list.targets.some((t) => t.shortLink),
    mismatch: mine.length === 0,
    otherPlatforms: alien ? owners : '',
    otherPlatformIds: alien ? ownerIds : [],
    currentName: curName,
  };
});

ipcMain.handle('auth:status', (e, platform) => authStatus(platform));
ipcMain.handle('auth:openLogin', (e, platform) => {
  createLoginWindow(platform);
  return true;
});

/** 手动粘贴 Cookie（仅微博支持；小红书/抖音的签名依赖页面环境，粘 Cookie 也无法直连） */
ipcMain.handle('auth:setCookie', async (e, platform, str) => {
  const p = registry.get(normalizePlatform(platform));
  if (!p.supportsManualCookie) throw new Error(`${p.name}不支持手动粘贴 Cookie，请用登录窗口扫码登录`);
  const pairs = parseCookieString(str);
  if (!pairs.length) throw new Error('没能解析出有效的 Cookie，请检查粘贴内容');
  const ses = session.fromPartition(p.partition);
  for (const item of pairs) {
    for (const domain of p.cookieDomains) {
      // 写入地址必须落在目标域内，否则 Electron 会拒绝这条 domain cookie
      // （早先固定用 siteURL，于是 .sina.com.cn 那一条永远写不进去）。
      const host = String(domain).replace(/^\./, '');
      await ses.cookies
        .set({
          url: `https://${host}/`,
          name: item.name,
          value: item.value,
          domain,
          path: '/',
          secure: true,
          httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        })
        .catch(() => {});
    }
  }
  if (authStore) await authStore.save(joinCookies(pairs));
  // 手动粘贴的 Cookie 视为「用户主动提供」，直接记录指纹，免去再走一次登录窗
  for (const item of pairs) {
    if (p.loginMarks.includes(item.name)) await loginState.record(p.id, item.name, item.value);
  }
  return authStatus(p.id);
});

ipcMain.handle('auth:logout', async (e, platform) => {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  // 必须覆盖全部相关域：微博的 SUB 可能同时存在 .weibo.com 与 passport.weibo.com，
  // 只清主站会留下 passport 域那份，重新打开站点时又会被重新拼进 Cookie 头。
  await removeAuthCookies(ses, p);
  // 清掉已验证记录，否则下次访问站点时匿名 Cookie 会被误判为仍处于登录态
  await loginState.clear(p.id);
  loginUrls[p.id] = '';
  if (p.supportsManualCookie) await authStore?.clear();
  return authStatus(p.id);
});

/** 复制文本到系统剪贴板（file:// 下 navigator.clipboard 不可靠，统一走主进程） */
ipcMain.handle('clipboard:write', (e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

/**
 * 用系统默认浏览器打开平台官网。
 *
 * 双重校验：先按平台 id 取 registry 里登记的地址，再过一次协议白名单。
 * `shell.openExternal` 走的是操作系统协议分发 —— 传 `file://` 会打开本地文件、
 * 传 `ms-settings:` 会拉起系统设置，所以绝不能把未经校验的字符串直接交给它。
 */
ipcMain.handle('shell:openSite', async (e, platform) => {
  const p = registry.get(normalizePlatform(platform));
  const target = pickAllowedSite(p?.siteURL, registry.list.map((x) => x.siteURL));
  if (!target) return false;
  await shell.openExternal(target);
  return true;
});

/** 登录窗当前地址（供界面展示与复制） */
ipcMain.handle('login:url', (e, platform) => loginUrls[normalizePlatform(platform)] || '');

ipcMain.handle('dir:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择保存目录',
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('ffmpeg:check', async () => {
  const bin = await findFFmpeg((await loadSettings()).ffmpegPath);
  if (!bin) return { ok: false };
  let version = 'unknown';
  try {
    version = await ffmpegVersion(bin);
  } catch {
    /* 版本拿不到不影响可用性 */
  }
  return { ok: true, path: bin, version };
});

ipcMain.handle('task:start', async (e, payload) => {
  if (runner) return { error: `已有任务在运行（${runnerPlatform}）` };
  const platform = normalizePlatform(payload?.platform);
  const p = registry.get(platform);
  const settings = await loadSettings();
  const ps = settings.platforms[platform] || {};

  const st = await authStatus(platform);
  if (!st.loggedIn) {
    return { error: `尚未登录${p.name}：请先点击「登录${p.name}」完成扫码` };
  }

  const ctx = await buildContext(platform);
  // 接口直连型平台必须真有 Cookie 才能抓到数据
  if (p.injectCookieIntoFetch && !ctx.cookie) {
    return { error: `${p.name}登录态异常：未取到 Cookie，请重新登录` };
  }

  const options = { ...ps, ...(payload.options || {}) };
  runner = new TaskRunner({
    adapter: p,
    ctx,
    emit,
    getSettings: () => options,
  });
  runnerPlatform = platform;
  try {
    const result = await runner.run({
      input: payload.input,
      outDir: payload.outDir || ps.outDir,
      options,
    });
    return { ok: true, platform, result };
  } catch (err) {
    return { error: err.message };
  } finally {
    runner = null;
    runnerPlatform = null;
  }
});

ipcMain.handle('task:stop', () => {
  runner?.stop();
  return true;
});

ipcMain.handle('shell:open', (e, dir) => {
  if (dir && fs.existsSync(dir)) shell.openPath(dir);
  return true;
});

/**
 * 导出日志到用户指定的文件。
 *
 * 为什么必须由主进程落盘而不是渲染层自己下载：渲染层是本地页面、没有 node 权限，
 * 也没有任何办法弹出一个「保存到…」的原生对话框。而且用户上报问题时最需要的是
 * **一份完整的文本**（不是截图），所以这里直接把整段日志写成 .txt。
 *
 * 注意 dialog.showSaveDialog 不能带一个已销毁的窗口当父窗口（会抛），
 * 所以先判存活再决定用哪种调用方式。
 */
ipcMain.handle('log:export', async (e, text) => {
  const content = String(text || '');
  if (!content.trim()) return { error: '当前没有日志可导出' };

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(
    now.getMinutes()
  )}${p2(now.getSeconds())}`;

  let defaultPath = `社交平台作品下载器_日志_${stamp}.txt`;
  try {
    defaultPath = path.join(app.getPath('downloads'), defaultPath);
  } catch {
    /* 取不到「下载」目录就用纯文件名，对话框会退回上次的位置 */
  }

  const opts = {
    title: '导出日志',
    defaultPath,
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts);

  if (canceled || !filePath) return { canceled: true };
  try {
    await fsp.writeFile(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { error: `写入失败：${err.message}` };
  }
});

/* ------------------------------- 冒烟探针 ------------------------------- */
// 仅用于 test/smoke.js：启动后自检一次渲染层，把结果写文件再退出
const SMOKE_OUT = (process.argv.find((a) => a.startsWith('--smoke-out=')) || '').split('=')[1];
const smokeErrors = [];

/**
 * 允许把 userData 指到临时目录（自动化测试用）。
 *
 * 不这么做的话，冒烟测试会读到本机真实分区：开发机上只要登录过小红书/抖音，
 * 「未登录时应显示未登录」这条断言就会失败 —— 那是环境问题，不是缺陷。
 * 必须在 whenReady 之前调用，否则各 session 分区已经建好，改不动了。
 */
const USER_DATA_DIR = (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').split('=')[1];
if (USER_DATA_DIR) {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    app.setPath('userData', USER_DATA_DIR);
  } catch {
    /* 设置失败则退回默认目录，不影响正常启动 */
  }
}

function attachSmoke() {
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) smokeErrors.push(`[console:${level}] ${message}`);
  });
  mainWindow.webContents.once('did-finish-load', async () => {
    await sleep(1800);
    let probe = {};
    try {
      probe = await mainWindow.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const tabs = [...document.querySelectorAll('.tab')];
        // 逐个点一遍选项卡，确认三平台面板都能正常切换。
        // 切换涉及 IPC 往返，必须等异步流程落定后再读状态。
        const seen = [];
        for (const t of tabs) {
          t.click();
          await sleep(450);
          seen.push({
            platform: t.dataset.platform,
            active: t.classList.contains('active'),
            options: document.querySelectorAll('#options .chk, #options .num').length,
            optionKeys: [...document.querySelectorAll('#options [data-key]')].map((x) => x.dataset.key),
            placeholder: document.getElementById('inputUid')?.placeholder,
            authText: document.getElementById('authText')?.textContent,
            badges: document.querySelectorAll('#platformBadges .badge').length,
            // 三个「登录后可见/可复制」的网址
            linkRows: document.querySelectorAll('#links .link-row').length,
            siteUrl: document.getElementById('siteUrl')?.dataset.url || '',
            loginUrl: document.getElementById('loginUrlState')?.dataset.url || '',
            copyBtns: ['btnCopySite', 'btnCopyLogin', 'btnCopyTarget', 'btnOpenSite'].filter(
              (id) => !!document.getElementById(id)
            ).length,
          });
        }
        return {
          hasApi: typeof window.api,
          tabs: tabs.length,
          platforms: seen,
          ffmpeg: document.getElementById('ffmpegState')?.textContent,
          // 性能护栏的运行时验证：动画门槛与日志上限必须真的生效（不只是写法对）
          perf: (() => {
            const bar = document.getElementById('bar');
            const box = document.getElementById('log');
            const idleAnim = getComputedStyle(bar).animationName;
            document.body.classList.add('running');
            const runningAnim = getComputedStyle(bar).animationName;
            document.body.classList.remove('running');
            const logBefore = box.childElementCount;
            for (let i = 0; i < 1200; i++) window.log('压力测试日志 ' + i);
            return {
              idleAnim,
              runningAnim,
              logBefore,
              logAfter: box.childElementCount,
            };
          })(),
          // 本轮两项界面需求的运行时验证：
          //   ① 下载进度必须「实时」—— 不能等到一个文件下完才动一格
          //   ② 日志栏的导出按钮必须真的在，且导出的是全量文本
          ui: (() => {
            const ui = window.__ui;
            if (!ui) return { ok: false };
            ui.state.platform = 'xhs';
            ui.state.stats = { total: 4, done: 0, skip: 0, fail: 0, item: 2 };
            ui.state.inflight.clear();
            ui.renderStats();
            const barIdle = document.getElementById('bar').style.width;
            const minisIdle = document.getElementById('minis').classList.contains('on');

            // 两个文件同时在传：一个总长已知、一个未知（少数 CDN 不给 content-length）
            ui.handleEvent({ type: 'dl', event: 'progress', file: 'C:\\\\out\\\\a\\\\img01.jpg',
              written: 50, total: 100, stats: { done: 0, skipped: 0, failed: 0, bytes: 512, remaining: 2 } });
            ui.handleEvent({ type: 'dl', event: 'progress', file: 'C:\\\\out\\\\a\\\\video.mp4',
              written: 4096, total: null, stats: { done: 0, skipped: 0, failed: 0, bytes: 512, remaining: 2 } });

            const barLive = document.getElementById('bar').style.width;
            const minisOn = document.getElementById('minis').classList.contains('on');
            const minisLive = document.querySelectorAll('#minis .mini').length;
            const pctText = document.querySelector('#minis .mini .pct')?.textContent || '';
            const nameText = document.querySelector('#minis .mini .name')?.textContent || '';

            // 一个成功、一个失败 → 细条逐条收起，主条继续前进
            ui.handleEvent({ type: 'dl', event: 'done', file: 'C:\\\\out\\\\a\\\\img01.jpg',
              size: 100, stats: { done: 1, skipped: 0, failed: 0, bytes: 1024, remaining: 1 } });
            ui.handleEvent({ type: 'dl', event: 'fail', file: 'C:\\\\out\\\\a\\\\bad.jpg', error: '连接被拒绝（ECONNREFUSED）',
              stats: { done: 1, skipped: 0, failed: 1, bytes: 1024, remaining: 1 } });
            const statsAfterFail = { ...ui.state.stats };
            const minisAfterFail = document.querySelectorAll('#minis .mini').length;

            const logText = ui.exportLogText();
            const head = logText.split('\\n').slice(0, 4);

            ui.handleEvent({ type: 'dl', event: 'done', file: 'C:\\\\out\\\\a\\\\video.mp4',
              size: 10, stats: { done: 2, skipped: 0, failed: 1, bytes: 3000, remaining: 0 } });

            return {
              ok: true,
              barIdle,
              barLive,
              barAfterAll: document.getElementById('bar').style.width,
              minisIdle,
              minisOn,
              minisLive,
              minisAfterFail,
              minisAfterAll: document.querySelectorAll('#minis .mini').length,
              pctText,
              nameText,
              statsAfterFail,
              logButtons: ['btnExportLog', 'btnCopyLog', 'btnClearLog'].filter((id) => !!document.getElementById(id)).length,
              logCountText: document.getElementById('logCount').textContent,
              head,
              logHasStress: /压力测试日志 1199/.test(logText),
              logHasFail: /下载失败：bad.jpg 连接被拒绝/.test(logText),
              logLines: logText.split('\\n').length,
            };
          })(),
        };
      })()`);
    } catch (err) {
      smokeErrors.push('probe failed: ' + err.message);
    }
    await fsp.writeFile(
      SMOKE_OUT,
      JSON.stringify(
        { probe, errors: smokeErrors, perf: { ...perfMarks }, memory: memorySnapshot() },
        null,
        2
      ),
      'utf8'
    );
    app.quit();
  });
}

/* ------------------------------- 启动 --------------------------------- */

app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  authStore = new AuthStore(app.getPath('userData'), safeStorage);
  loginState = new LoginState(path.join(app.getPath('userData'), 'login-state.json'));

  // 恢复上次保存的手动 Cookie（微博专用兜底：session 丢失时仍能直连接口）
  const saved = await authStore.load();
  if (saved?.value) {
    const p = registry.get('weibo');
    const ses = session.fromPartition(p.partition);
    for (const item of parseCookieString(saved.value)) {
      await ses.cookies
        .set({
          url: p.siteURL,
          name: item.name,
          value: item.value,
          domain: '.weibo.com',
          path: '/',
          secure: true,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        })
        .catch(() => {});
    }
  }

  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
