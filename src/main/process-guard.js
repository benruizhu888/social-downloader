/**
 * 主进程「最后一道防线」：不让任何未捕获异常变成用户面前的崩溃对话框。
 *
 * 用户截图里的那个框长这样：
 *   ┌ A JavaScript error occurred in the main process ────────────┐
 *   │ Uncaught Exception:                                          │
 *   │ Error: Object has been destroyed                             │
 *   │     at l.emit (…\resources\app.asar\src\main\main.js:1:6118) │
 *   │     at … windowOpenHandler …                                 │
 *   └──────────────────────────────────────────────────────────────┘
 * 它是 Electron 的**默认行为**：内置的 uncaughtException 处理器调用
 * dialog.showErrorBox 弹一个原生模态框。那个框会盖住我们的界面，
 * 用户唯一的出路是点「确定」，而他的体感就是「软件卡住了/崩溃了」。
 *
 * 为什么这一层必须存在，而不是「把 bug 修了就完事」：
 *   修 bug 是必须的（本轮就修了 emit 与护栏回调），但主进程里能抛异常的地方
 *   是**开放集合** —— 页面事件、定时器、第三方代码、将来新加的模块……
 *   只要有一处漏了，用户看到的就是同一个崩溃框。
 *   把「异常 → 日志」这条路先铺好，则任何漏网之鱼都只是少一条日志，
 *   而不是把用户挡在一个他无法理解的模态框外面。
 *
 * ⚠️ 关键机制（不是想当然，是 Electron 源码里的判断条件）：
 *   Electron 的默认处理器一进来就检查
 *       if (process.listenerCount('uncaughtException') > 1) return;
 *   也就是说 —— **只要我们自己注册了一个 uncaughtException 监听器**，
 *   它就主动让位，不再弹框。所以这里注册即生效，不需要（也没有）
 *   别的开关。crash-guard.test.js 里对这一条做了真实 Electron 的 A/B 验证：
 *   不注册时 dialog.showErrorBox 会被调用，注册后不会被调用。
 */

/** 把一个异常整理成一行可读、可上报的文本 */
function describeFatal(kind, err) {
  const when = new Date().toISOString();
  let detail;
  if (err instanceof Error) {
    detail = err.stack || `${err.name}: ${err.message}`;
  } else if (err && typeof err === 'object') {
    try {
      detail = JSON.stringify(err);
    } catch {
      detail = String(err);
    }
  } else {
    detail = String(err);
  }
  return `[${when}] ${kind}: ${detail}`;
}

/**
 * 安装兜底处理器。
 *
 * @param {object}   [opts]
 * @param {Function} [opts.onFatal]   (info) => void  额外通知（例如推到界面上）
 *                                    info = { kind, message, text }
 * @param {Function} [opts.writeLog]  (text) => void  落盘（建议写 userData/crash.log）
 * @param {Function} [opts.log]       (text) => void  控制台输出，默认 console.error
 * @returns {Function} 卸载函数（测试用；生产不调用）
 */
function installProcessGuard({ onFatal, writeLog, log } = {}) {
  const emitLog = typeof log === 'function' ? log : (t) => console.error(t);

  // 每次调用都重新读一遍 opts，保证「先安装、后补配置」也能生效
  const handle = (kind, err) => {
    const text = describeFatal(kind, err);
    // 三段各自 try/catch：兜底逻辑本身再抛异常，就真的没救了
    try {
      emitLog(text);
    } catch {
      /* 忽略 */
    }
    try {
      if (typeof writeLog === 'function') writeLog(text);
    } catch {
      /* 磁盘不可写等情况，忽略 */
    }
    try {
      if (typeof onFatal === 'function') {
        onFatal({
          kind,
          message: err instanceof Error ? err.message : String(err),
          text,
        });
      }
    } catch {
      /* 忽略 */
    }
  };

  const onUncaught = (err) => handle('uncaughtException', err);
  const onRejection = (reason) => handle('unhandledRejection', reason);

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return function uninstall() {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}

module.exports = { installProcessGuard, describeFatal };
