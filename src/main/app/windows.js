/**
 * 主窗口
 *
 * 只有一件事：把窗口建出来、挂上护栏、把性能打点记下来。
 * 拆出来的动机不是「文件太多」，而是窗口创建里塞了太多**必须一起改**的东西
 * （尺寸、首帧显示的时序、URL 护栏、冒烟钩子），散在 1200 行的 main.js 里
 * 谁都不敢动 —— 而「打开闪白屏」「窗口永远不出现」正是这里最容易回归的两处。
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow } = require('electron');

const { attachUrlGuards } = require('../url-guard');
const { attachSmoke } = require('./smoke');

/** 默认视口（与设计稿一致：1020×800 的最小可用宽度 900） */
const DEFAULT_SIZE = { width: 1020, height: 800 };
const MIN_SIZE = { minWidth: 900, minHeight: 680 };

/**
 * 解析 `--window-size=WxH`（也接受 `W×H` 与大小写 x）。
 *
 * 为什么需要它：三档视口（窄/中/宽）验收必须能真的换视口跑一次冒烟，
 * 否则「响应式布局在 1280 下崩了」这种事只能靠用户截图发现。
 * 解析失败一律回落到默认值 —— 启动参数写错不该让应用起不来。
 *
 * @param {string[]} argv
 * @returns {{width:number, height:number}|null}
 */
function parseWindowSize(argv = []) {
  const raw = argv.find((a) => typeof a === 'string' && a.startsWith('--window-size='));
  if (!raw) return null;
  const m = /^(\d{2,5})\s*[x×X]\s*(\d{2,5})$/.exec(raw.slice('--window-size='.length).trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 480 || height < 360) return null; // 明显是笔误（例如把 1024x768 写成 102x76）
  return { width, height };
}

/**
 * 生效的窗口尺寸：命令行覆盖 > 默认值。
 *
 * 指定了 `--window-size` 时，min 尺寸跟着一起放宽到该值 —— 否则 900×680 的最小限制
 * 会把 800×600 这类窄视口直接夹回去，验收就变成「测了个假的窄屏」。
 * 正常启动（没有该参数）时 min 尺寸保持原样，用户仍不能把窗口拖到布局崩掉。
 */
function windowSizeOf(ctx) {
  const custom = (ctx.args && ctx.args.windowSize) || parseWindowSize(process.argv);
  if (!custom) return { ...DEFAULT_SIZE, ...MIN_SIZE };
  return {
    width: custom.width,
    height: custom.height,
    minWidth: Math.min(MIN_SIZE.minWidth, custom.width),
    minHeight: Math.min(MIN_SIZE.minHeight, custom.height),
  };
}

function createMainWindow(ctx) {
  const size = windowSizeOf(ctx);
  ctx.mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    title: '社交平台作品下载器',
    backgroundColor: '#f3f4f6',
    // 先不显示：等首帧渲染好再 show。
    // 否则窗口会先亮出一个纯背景色的空壳，用户看到的就是「打开时闪一下白屏」——
    // 最大化/全屏时若正赶上重排，这一帧空白会更明显。
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const win = ctx.mainWindow;
  win.once('ready-to-show', () => {
    ctx.perfMarks.visibleMs = Math.round(process.uptime() * 1000);
    if (win && !win.isDestroyed()) win.show();
  });
  // 兜底：理论上 ready-to-show 一定会来，万一页面出错也不能让窗口永远不出现
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 3000);
  const html = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  win.loadFile(html).catch((e) => console.error('[main] 页面加载失败：', e));
  // 主窗口只承载本地界面，任何时候都不该导航到别处，也不该开新窗口。
  // 一旦漏挂，界面里的任意一个链接就可能把自定义协议的地址交给操作系统。
  const selfUrl = pathToFileURL(html);
  attachUrlGuards(win.webContents, {
    log: (m) => console.log('[main]', m),
    // 只允许停留在自己的页面（含锚点跳转），其余一律拦掉
    allowNavigate: (url) => url === selfUrl.href || url.startsWith(`${selfUrl.href}#`),
  });
  win.webContents.on('did-finish-load', () => {
    ctx.perfMarks.loadedMs = Math.round(process.uptime() * 1000);
    console.log('[smoke] renderer ready');
  });
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[main] 渲染进程异常退出：', details.reason)
  );
  win.on('closed', () => (ctx.mainWindow = null));

  if (ctx.args && ctx.args.smokeOut) attachSmoke(ctx);
  return win;
}

module.exports = { createMainWindow, parseWindowSize, windowSizeOf, DEFAULT_SIZE, MIN_SIZE };
