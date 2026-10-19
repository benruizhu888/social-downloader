/**
 * 主进程运行上下文（ctx）
 *
 * 为什么要有这一层：拆分前 `main.js` 里有一堆**模块级可变状态**
 * （mainWindow / loginWindow / loginPlatform / loginUrls / runner / settingsPath …）。
 * 一旦把这些功能拆进多个文件，状态就必须有个明确的归属，否则要么各自持有一份
 * （两边不同步，登录窗引用丢失那类 bug 会成倍出现），要么靠循环 require 互相拿 ——
 * 后者在 Electron 里表现为「有时能启动、有时某个模块拿到的是半成品」。
 *
 * 所以约定：
 *   · 所有跨模块共享的可变状态**只放在 ctx 上**；
 *   · 需要状态与 `emit` 的模块，第一个参数一律是 ctx；
 *   · 纯函数（不碰状态）照旧直接导出，不进 ctx。
 */

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
function emitToMain(ctx, event) {
  try {
    const win = ctx.mainWindow;
    if (!win || win.isDestroyed()) return;
    // ⚠️ 访问 `win.webContents` 本身就可能抛：「窗口已销毁」时这个 getter
    //    直接抛 `Error: Object has been destroyed`（crash-guard.test.js 的矩阵实测），
    //    所以它必须在 try 里面，不能放在判断条件里。
    const wc = win.webContents;
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

/**
 * 建一个空的运行上下文。
 *
 * 注意 `args` 是**进程启动参数**的解析结果（冒烟输出路径、窗口尺寸、userData 覆盖），
 * 在 app ready 之前就要用，所以由 main.js 在模块顶层解析好再传进来。
 */
function createContext({ args = {} } = {}) {
  const ctx = {
    /** 启动参数：{ smokeOut, userDataDir, windowSize } */
    args,

    /** 主窗口（唯一） */
    mainWindow: null,

    /* ---- 登录窗：三个字段必须一起看，谁在什么时候清空是有讲究的（见 login-window.js） ---- */
    loginWindow: null,
    loginPlatform: null,
    /** 登录窗当前地址，按平台 id 分开存，供界面展示与复制 */
    loginUrls: {},

    /* ---- 当前任务（同一时刻只允许一个） ---- */
    runner: null,
    runnerPlatform: null,

    /* ---- 落盘状态 ---- */
    settingsPath: '',
    authStore: null,
    loginState: null,

    /**
     * 启动/内存观测点。
     *
     * 用 `process.uptime()` 而不是自己记 t0 —— 它从进程真正启动算起，
     * 把 Electron 自身的初始化也算进去，才是用户体感到的「双击到出画面」。
     * 内存用 `app.getAppMetrics()`（Electron 官方口径，覆盖 GPU/渲染/工具进程），
     * 不依赖外部工具去枚举进程 —— 换台机器也能复现。
     */
    perfMarks: { visibleMs: null, loadedMs: null },

    /**
     * 启动期的「降级说明」（P1-10 / P1-11）。
     *
     * 为什么要收集而不是各自 `console.warn`：
     *   这两类事（设置文件损坏、手动 Cookie 没能写进某些域）都不是致命错误，
     *   程序照常能用 —— 但用户的体验是「我的设置怎么没了」「怎么又是未登录」。
     *   只打到 stdout 等于没说：用户在界面上看不见，上报问题时也带不出来。
     *   统一收到这里，由 `app:info` 带回渲染层，启动后以 warn 级别回放。
     */
    warnings: [],
  };

  /** 事件出口（实现见上，单独抽出来是为了让 ctx 的字段表保持干净） */
  ctx.emit = (event) => emitToMain(ctx, event);
  return ctx;
}

/**
 * 记一条启动期降级说明（去重）。
 *
 * 去重是必要的：`loadSettings` 在一次任务里会被调很多次（每次 task:start、
 * 每次 ffmpeg:check 都读一遍），同一句「设置文件已损坏」会堆出几十条。
 *
 * @param {object} ctx
 * @param {string} message
 */
function addWarning(ctx, message) {
  if (!ctx || !message) return;
  if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
  if (ctx.warnings.includes(message)) return;
  ctx.warnings.push(message);
  console.warn('[main]', message);
}

module.exports = { createContext, emitToMain, addWarning };
