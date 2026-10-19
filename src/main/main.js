/**
 * 主进程 —— 只做装配
 *
 * 设计原则：主进程本身不认识任何平台细节，所有平台相关行为都通过
 * `registry` 里的适配器完成。三个平台在登录态（独立分区）、登录窗、
 * 设置、采集方式四个维度上完全独立。
 *
 * 具体功能已拆到 `app/` 下，这里只保留三件「必须最早、必须唯一」的事：
 *   ① 全局护栏与进程兜底（必须早于任何窗口）；
 *   ② 启动参数解析与 userData 覆盖（必须早于 app ready）；
 *   ③ whenReady 后的装配顺序（建状态 → 恢复 Cookie → 注册 IPC → 建窗口）。
 *
 * 跨模块可变状态**只放 ctx**（见 app/context.js）—— 这样「登录窗引用被谁清空」
 * 这类问题有一个确定的答案，不用满仓库找模块级变量。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, safeStorage } = require('electron');

const { AuthStore } = require('./cookies');
const { LoginState } = require('./login-state');
const { installGlobalUrlGuard } = require('./url-guard');
const { installProcessGuard } = require('./process-guard');

const { createContext } = require('./app/context');
const { createMainWindow, parseWindowSize } = require('./app/windows');
const { createLoginWindow } = require('./app/login-window');
const { restoreSavedCookie } = require('./app/auth');
const { registerAll } = require('./app/ipc');

/**
 * 全局兜底护栏 —— 必须在**任何窗口创建之前**注册，所以放在模块顶层而非 whenReady 里。
 * 靠人记得给每个窗口挂护栏，漏一次就等于没有（本轮两次 bytedance 对话框都是漏了一条路）。
 * 注册在这里则任何 webContents（主窗/登录窗/采集窗/新窗口）都自带一层底：非 http(s) 不许交给系统。
 */
installGlobalUrlGuard(app, { log: (m) => console.log('[guard]', m) });

/**
 * 进程级兜底 —— 让「未捕获异常」变成一行日志，而不是挡在用户面前的崩溃模态框。
 * 注册自己的 uncaughtException 监听器后，Electron 会因为「已有自定义处理器」主动让位
 * （详见 src/main/process-guard.js）。这是**最后一道防线**，不是替代修 bug。
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
    ctx.emit({ type: 'log', message: `程序内部出现异常，已忽略并继续（详情见 crash.log）：${info.message}` });
  },
});

/**
 * Windows 上「最大化/全屏后偶现空白、界面像卡住」的已知诱因：Chromium 的原生窗口遮挡检测
 * （CalculateNativeWinOcclusion）在部分显卡驱动/多显示器/远程桌面组合下会误判，于是恢复或
 * 最大化时没有任何一帧被画出来，渲染循环停着，点哪儿都像没反应。关掉它只是让被遮挡的窗口
 * 继续渲染（代价是被完全盖住时多一点 CPU），对这类工具面板完全可以接受。必须在 ready 之前调用。
 *
 * 内存调优的记录（别凭直觉加开关）：试过 `--enable-low-end-device-mode` 实测是**负优化**，
 * 内存中位数 399MB → 413MB、窗口可见 386ms → 432ms（该档位额外开了若干降级路径）。结论：
 * 不动 Chromium 档位开关，从应用自身找浪费（日志 DOM 上限、常驻动画），用 measure-perf.js 验证。
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * 启动参数解析（三种，都只给自动化用）：
 *   --smoke-out=<path>     冒烟探针：自检一次界面，把结论写成 JSON 后退出
 *   --user-data-dir=<path> 把 userData 指到临时目录（否则冒烟会读到本机真实登录态）
 *   --window-size=WxH      覆盖窗口尺寸（三档视口验收用）
 *
 * userData 覆盖必须在 whenReady 之前：晚一步各 session 分区就已建好，改不动了。
 */
const smokeOut = (process.argv.find((a) => a.startsWith('--smoke-out=')) || '').split('=')[1] || '';
const userDataDir = (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').split('=')[1] || '';
const windowSize = parseWindowSize(process.argv);
if (userDataDir) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    app.setPath('userData', userDataDir);
  } catch {
    /* 设置失败则退回默认目录，不影响正常启动 */
  }
}

/**
 * 运行上下文：**唯一的**跨模块可变状态容器。在 ready 之前建好，是因为
 * `installProcessGuard` 的 onFatal 用得到 `ctx.emit`（进程级异常可能更早发生）。
 */
const ctx = createContext({ args: { smokeOut, userDataDir, windowSize } });

/* ------------------------------- 启动 -------------------------------- */

app.whenReady().then(async () => {
  // 三份落盘状态：设置、手动 Cookie、登录指纹。路径都基于最终生效的 userData。
  ctx.settingsPath = path.join(app.getPath('userData'), 'settings.json');
  ctx.authStore = new AuthStore(app.getPath('userData'), safeStorage);
  ctx.loginState = new LoginState(path.join(app.getPath('userData'), 'login-state.json'));

  // 恢复上次保存的手动 Cookie（微博专用兜底：session 丢失时仍能直连接口）
  await restoreSavedCookie(ctx);

  // IPC 必须在建窗口之前注册：渲染层加载完立刻会 invoke app:info，
  // 晚一行就是「界面空白 + 控制台 no handler registered」。
  registerAll(ctx);

  createMainWindow(ctx);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(ctx);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 测试钩子（只给纯 Node 单测用，Electron 启动不读 module.exports）。
 *
 * 登录窗的引用是 **ctx 上的状态**，行为完全取决于「谁在什么时候清空它」，
 * 光靠读源码做静态断言证明不了「切平台后引用还在」——必须真的跑一遍开窗/关窗时序。
 * test/login-window-lifecycle.test.js 用假 electron 加载本文件，靠这里观察 ctx。
 */
module.exports = {
  __test__: {
    createLoginWindow: (platform) => createLoginWindow(ctx, platform),
    /** 当前登录窗状态快照（避免测试直接摸 ctx） */
    loginState: () => ({
      loginWindow: ctx.loginWindow,
      loginPlatform: ctx.loginPlatform,
      loginUrls: ctx.loginUrls,
    }),
  },
};
