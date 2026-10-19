/**
 * 任务与采集 IPC
 *
 * 两条 handle（开始/停止）+ 两条 on（采集数据回传）。
 *
 * `on` 那两条为什么用 `send` 而不是 `invoke`：注入脚本每秒可能回传几十条，
 * 渲染层不需要（也不该等）主进程给回执；而且这条链路一旦变慢会直接拖住页面。
 *
 * 注意：`harvest:*` 是**采集窗**发给主进程的，不是主界面 —— 采集窗也是本应用的
 * 一个 BrowserWindow，跑在自己的 preload 下，所以通道名同样是全局的。
 */
const registry = require('../../platforms/registry');
const { TaskRunner } = require('../../core/runner');
const { loadSettings } = require('../settings');
const { normalizePlatform, authStatus, buildContext } = require('../auth');

const HANDLE_CHANNELS = ['task:start', 'task:stop'];
const ON_CHANNELS = ['harvest:data', 'harvest:match-mode'];

/**
 * 开一个任务。同一时刻只允许一个 —— `ctx.runner` 非空即拒绝。
 *
 * 返回约定：成功 `{ ok:true, platform, result }`；业务性失败 `{ error }`。
 * 不抛异常是刻意的：`invoke` 抛出去在渲染层会变成一坨栈信息，
 * 而这里每一种失败都有给用户看的中文说明。
 */
async function startTask(ctx, payload) {
  if (ctx.runner) return { error: `已有任务在运行（${ctx.runnerPlatform}）` };
  const platform = normalizePlatform(payload?.platform);
  const p = registry.get(platform);
  const settings = await loadSettings(ctx);
  const ps = settings.platforms[platform] || {};

  const st = await authStatus(ctx, platform);
  if (!st.loggedIn) {
    return { error: `尚未登录${p.name}：请先点击「登录${p.name}」完成扫码` };
  }

  const taskCtx = await buildContext(ctx, platform);
  // 接口直连型平台必须真有 Cookie 才能抓到数据
  if (p.injectCookieIntoFetch && !taskCtx.cookie) {
    return { error: `${p.name}登录态异常：未取到 Cookie，请重新登录` };
  }

  const options = { ...ps, ...(payload.options || {}) };
  ctx.runner = new TaskRunner({
    adapter: p,
    ctx: taskCtx,
    emit: ctx.emit,
    getSettings: () => options,
  });
  ctx.runnerPlatform = platform;
  try {
    const result = await ctx.runner.run({
      input: payload.input,
      outDir: payload.outDir || ps.outDir,
      options,
    });
    return { ok: true, platform, result };
  } catch (err) {
    return { error: err.message };
  } finally {
    // 无论成功/失败/被停止，引用都必须放掉：否则「已有任务在运行」会永远为真
    ctx.runner = null;
    ctx.runnerPlatform = null;
  }
}

function register(reg, ctx) {
  reg.handle('task:start', (e, payload) => startTask(ctx, payload));

  reg.handle('task:stop', () => {
    ctx.runner?.stop();
    return true;
  });

  /* ------------------- 注入脚本截获的数据转发给当前任务 ------------------- */
  reg.on('harvest:data', (e, payload) => {
    try {
      ctx.runner?.ingest(payload?.url, payload?.data);
    } catch {
      /* 忽略：采集数据坏一条不能把整个任务带崩 */
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
  reg.on('harvest:match-mode', (e, mode) => {
    try {
      if (mode === 'injected') return;
      ctx.runner?.log?.(
        mode === 'coarse'
          ? '⚠️ 响应白名单只有粗筛（精确判定未送达），可能多采到点赞/推荐内容'
          : '⚠️ 响应白名单未送达，已退化为「全部响应都采」'
      );
    } catch {
      /* 忽略 */
    }
  });
}

module.exports = { register, startTask, HANDLE_CHANNELS, ON_CHANNELS };
