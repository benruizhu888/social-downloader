/**
 * 应用级 IPC：版本信息、目录选择、ffmpeg 探测、剪贴板、外链、日志导出、登录窗地址
 *
 * 这一组都是「跟业务无关、但界面每个角落都要用」的能力，所以单独一个文件。
 * 共同点：**都必须过一层校验再交给系统**（openExternal / openPath / writeFile），
 * 主进程手里握着的是操作系统句柄，把未校验的字符串递出去等于把整台机器交出去。
 */
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { app, dialog, clipboard, shell } = require('electron');

const registry = require('../../platforms/registry');
const { findFFmpeg, ffmpegVersion } = require('../../core/ffmpeg');
const { pickAllowedSite } = require('../../url-guard');
const { loadSettings } = require('../settings');
const { normalizePlatform } = require('../auth');

const HANDLE_CHANNELS = [
  'app:info',
  'clipboard:write',
  'dir:choose',
  'ffmpeg:check',
  'log:export',
  'login:url',
  'shell:open',
  'shell:openSite',
];
const ON_CHANNELS = [];

/**
 * 取「可以作为对话框父窗口」的主窗口：销毁过的不能传，会抛。
 *
 * @param {object} ctx
 * @returns {object|null}
 */
function liveMainWindow(ctx) {
  const win = ctx.mainWindow;
  return win && !win.isDestroyed() ? win : null;
}

/**
 * 注册本组通道。
 *
 * @param {object} reg createRegistrar 产物
 * @param {object} ctx
 */
function register(reg, ctx) {
  reg.handle('app:info', () => ({
    version: app.getVersion(),
    defaultPlatform: registry.DEFAULT_PLATFORM,
    platforms: registry.all(),
    /**
     * 启动期降级说明（P1-10 / P1-11）：设置文件损坏、手动 Cookie 没能写进某些域…
     *
     * 为什么随 app:info 一起回给渲染层，而不是单独开一条事件：
     *   渲染层启动的第一件事就是 invoke('app:info')，此时它**已经**装好日志与事件监听，
     *   拿到返回值就能立刻按 warn 级别回放；换成事件的话，还要保证「事件先于订阅」
     *   这种时序，而这正是本项目反复踩过的坑（登录窗、启动横幅都是同类问题）。
     */
    warnings: Array.isArray(ctx.warnings) ? ctx.warnings.slice() : [],
  }));

  /* ---------------------------- 选择保存目录 ---------------------------- */
  reg.handle('dir:choose', async () => {
    const parent = liveMainWindow(ctx);
    const opts = { properties: ['openDirectory', 'createDirectory'], title: '选择保存目录' };
    // showOpenDialog 的两种签名：带父窗口（模态）与不带。父窗口已销毁时必须走后者。
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  /* ---------------------------- ffmpeg 探测 ---------------------------- */
  reg.handle('ffmpeg:check', async () => {
    const bin = await findFFmpeg((await loadSettings(ctx)).ffmpegPath);
    if (!bin) return { ok: false };
    let version = 'unknown';
    try {
      version = await ffmpegVersion(bin);
    } catch {
      /* 版本拿不到不影响可用性 */
    }
    return { ok: true, path: bin, version };
  });

  /* ------------------------------ 剪贴板 ------------------------------ */
  // file:// 下 navigator.clipboard 不可靠（需要安全上下文），统一走主进程
  reg.handle('clipboard:write', (e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  /* ------------------------------ 外链 ------------------------------ */
  /**
   * 用系统默认浏览器打开平台官网。
   *
   * 双重校验：先按平台 id 取 registry 里登记的地址，再过一次协议白名单。
   * `shell.openExternal` 走的是操作系统协议分发 —— 传 `file://` 会打开本地文件、
   * 传 `ms-settings:` 会拉起系统设置，所以绝不能把未经校验的字符串直接交给它。
   */
  reg.handle('shell:openSite', async (e, platform) => {
    const p = registry.get(normalizePlatform(platform));
    const target = pickAllowedSite(p?.siteURL, registry.list.map((x) => x.siteURL));
    if (!target) return false;
    await shell.openExternal(target);
    return true;
  });

  /** 在文件管理器里打开保存目录（目录不存在时什么都不做，返回 true 保持界面幂等） */
  reg.handle('shell:open', (e, dir) => {
    if (dir && fs.existsSync(dir)) shell.openPath(dir);
    return true;
  });

  /* ---------------------------- 登录窗地址 ---------------------------- */
  reg.handle('login:url', (e, platform) => ctx.loginUrls[normalizePlatform(platform)] || '');

  /* ---------------------------- 导出日志 ---------------------------- */
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
  reg.handle('log:export', async (e, text) => {
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
    const parent = liveMainWindow(ctx);
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
}

module.exports = { register, HANDLE_CHANNELS, ON_CHANNELS };
