/**
 * 冒烟探针（仅测试用，正常运行完全不参与）
 *
 * 作用：`--smoke-out=<path>` 启动后，等界面首帧 + 异步流程落定，用
 * `executeJavaScript` 在渲染层里真的点一遍、读一遍 DOM，把结论写成 JSON 再退出。
 * 为什么不用单元测试代替：这一层的价值恰恰在于「真的起了一个 Electron、真的加载了
 * 自己的 preload、真的走了 IPC」，替身测不出 contextBridge 断开、CSP 拦脚本、
 * **tokens.css 没被打进 asar（所有 var() 静默失效）**这类问题。
 *
 * 本轮重写（K 批）的三件事：
 *   ① **读 DOM 之前必须等两帧**。渲染层所有写 DOM 的操作都是 rAF 合批的
 *      （进度、统计、日志、细进度条），探针同步读只能读到上一帧的旧值 ——
 *      上一版探针就是这么得出「barLive=0%、minisLive=0、日志 1201 条却只有 1 个节点」
 *      这种**假失败**的。两帧是最小的稳定等待（合批回调自己还会再排一次）。
 *   ② **把断言写进探针**。errors 以前只收「控制台报错」，界面是真坏了还是探针读早了
 *      看不出来。现在 checks 里每一条都有名字与实测值，失败直接进 errors ——
 *      冒烟才是验收门槛，而不是「生成一份要人肉看的 JSON」。
 *   ③ **新增布局与令牌的运行时校验**：横向溢出、右栏可滚动、断点是否真的切换、
 *      以及「tokens.css 有没有真的生效」（--c-accent / 按钮高度 / 边框色实测）。
 *
 * 截图：写 JSON 之前存一张 `<smoke-out 去扩展名>.png`。截图失败只警告、不进 errors
 * （capturePage 在无 GPU / 远程桌面 / 窗口被完全遮挡时本来就可能失败）。
 *
 * 场景：`--smoke-scene=<name>` 决定「这一跑把界面摆成什么状态再截图」，取值：
 *   idle      什么都不驱动，截一张干净首屏（默认平台、空输入、未开始、空态日志）
 *   progress  沿用上面那整套驱动（进度条、并发细条、失败明细、日志输出）
 *   modal     打开手动 Cookie 弹窗（微博专有能力）
 *   logs      日志区：先证明级别筛选真的会缩窄结果，再留「全部 + 关键字高亮」的状态截图
 *
 * ⚠️ 默认值必须是 `progress`：五档视口冒烟已经在用这套驱动当验收门槛，
 *    改默认值等于悄悄换掉它们的验收内容 —— 而且谁都不会收到提醒。
 */
const path = require('path');
const fsp = require('fs/promises');
const { app } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 内存快照（Electron 官方口径，覆盖 browser/gpu/renderer/utility 全部进程）。
 *
 * 不依赖外部工具去枚举进程 —— 换台机器也能复现；单位统一成 MB，避免报告里
 * 一会儿 KB 一会儿字节。
 *
 * @returns {{totalMB:number, processes:Array<{type:string,pid:number,mb:number}>}}
 */
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

/**
 * 截图路径：与 JSON 同目录、同主名，只把扩展名换成 `.png`。
 *
 * 用 `path.parse` 而不是字符串 replace：smoke-out 的目录名里带点（`C:\a.b\smoke.json`）
 * 时，一个草率的正则会把目录也一起截断。
 *
 * @param {string} smokeOut
 * @returns {string}
 */
function pngPathOf(smokeOut) {
  const parsed = path.parse(smokeOut);
  if (!parsed.ext) return `${smokeOut}.png`;
  return path.join(parsed.dir, `${parsed.name}.png`);
}

/** 允许的截图场景（顺序即上面文件头的说明顺序） */
const SMOKE_SCENES = ['idle', 'progress', 'modal', 'logs'];
const DEFAULT_SCENE = 'progress';

/**
 * 解析 `--smoke-scene=<name>`。
 *
 * 认不出来时**回退到默认场景并打警告**，而不是退出：把界面稳稳跑完、生成一份 JSON
 * 好过让整批截图任务死在第 3 张上；至于是不是想要的场景，JSON 的 `scene` 字段会如实记录。
 *
 * @param {string[]} argv 通常是 process.argv
 * @returns {string} 场景名，只能是 SMOKE_SCENES 之一
 */
function parseSmokeScene(argv) {
  const raw = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--smoke-scene='));
  const name = raw ? raw.slice('--smoke-scene='.length).trim() : '';
  if (!name) return DEFAULT_SCENE;
  if (!SMOKE_SCENES.includes(name)) {
    console.warn(`[smoke] 未知场景 "${name}"，已回退到 "${DEFAULT_SCENE}"（可用：${SMOKE_SCENES.join(' / ')}）`);
    return DEFAULT_SCENE;
  }
  return name;
}

function attachSmoke(ctx) {
  const smokeOut = ctx.args && ctx.args.smokeOut;
  if (!smokeOut) return;
  /** 本轮要摆出的界面状态（默认 progress —— 见文件头注释） */
  const scene = (ctx.args && ctx.args.smokeScene) || parseSmokeScene(process.argv);
  /** 本轮「功能坏了」的证据；截图失败不算（见文件头注释） */
  const smokeErrors = [];
  ctx.mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) smokeErrors.push(`[console:${level}] ${message}`);
  });
  ctx.mainWindow.webContents.once('did-finish-load', async () => {
    await sleep(1800);
    let probe = {};
    try {
      probe = await ctx.mainWindow.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        /** 等一帧；合批回调里还会再排一帧，所以调用处统一等两次 */
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        const frames = async (n = 2) => { for (let i = 0; i < n; i++) await raf(); };

        const checks = [];
        const check = (name, ok, actual) => { checks.push({ name, ok: !!ok, actual }); };

        const SCENE = ${JSON.stringify(scene)};
        const viewport = {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          dpr: window.devicePixelRatio,
        };

        /* ---------- 0. 只读快照 ----------
           任何场景都先取一遍，**且不改动任何状态**：它是判断「首屏干净」的依据，
           一旦这里为了截图去点按钮，idle 场景就再也拍不到干净的首屏了。 */
        const de0 = document.documentElement;
        const snap = {
          platform: window.__ui ? window.__ui.state.platform : '',
          inputValue: document.getElementById('inputUid') ? document.getElementById('inputUid').value : '',
          logRows: document.querySelectorAll('#log > div:not(.log-empty):not(.log-cut)').length,
          logEmptyShown: !!document.querySelector('#log .log-empty'),
          running: document.body.classList.contains('running'),
          tabs: document.querySelectorAll('.tab').length,
          options: document.querySelectorAll('#options [data-key]').length,
          overflow: de0.scrollWidth - de0.clientWidth,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim(),
          ffmpeg: document.getElementById('ffmpegState') ? document.getElementById('ffmpegState').textContent : '',
        };
        check('window.__ui 存在（渲染层对外契约）', !!window.__ui, !!window.__ui);
        check('tokens.css 已加载（--c-accent = #2e5bff）', snap.accent === '#2e5bff', snap.accent);
        check('三个选项卡都渲染出来了', snap.tabs === 3, snap.tabs);
        check('没有横向溢出（截图里就能一眼看出来）', snap.overflow <= 1, snap.overflow);
        check('ffmpeg 状态不是空的', !!snap.ffmpeg, snap.ffmpeg);

        /* ---------- 0.1 场景摄像机 ----------
           每个场景自带驱动函数、自带 checks，互不污染：progress 那套会写 1200 条压力日志、
           切三次平台、推进进度条，modal / logs 一旦让它先跑一遍就再也拍不到要的状态。 */

        /** 手动 Cookie 弹窗：只对支持手动粘贴的平台（微博）开放 */
        const driveModal = async () => {
          const tab = [...document.querySelectorAll('.tab')].find((t) => t.dataset.platform === 'weibo');
          if (tab) { tab.click(); await sleep(450); await frames(); }
          const auth = document.getElementById('authText');
          const supported = !!auth && !auth.disabled;
          if (auth) auth.click();
          await sleep(300);
          await frames();
          const root = document.getElementById('cookieModal');
          const ta = document.getElementById('cookieText');
          // 只填与 index.html placeholder 一致的占位串 —— 截图里绝不允许出现真实 Cookie
          if (ta) ta.value = 'SUB=xxx; SUBP=xxx; SSOLoginState=xxx';
          await frames();
          const boxEl = root ? root.querySelector('.modal-box') : null;
          const rect = boxEl ? boxEl.getBoundingClientRect() : null;
          return {
            supported,
            shown: !!root && root.classList.contains('show'),
            platform: window.__ui ? window.__ui.state.platform : '',
            titleText: document.getElementById('cookieTitle') ? document.getElementById('cookieTitle').textContent : '',
            textareaValue: ta ? ta.value : '',
            boxSize: rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : '',
            actions: ['btnCookieCancel', 'btnCookieSave', 'btnCookieClose'].filter((id) => !!document.getElementById(id)).length,
          };
        };

        /** 日志区：清掉历史 → 写一组有代表性的行 → 验级别筛选 → 留「全部 + 关键字高亮」的状态 */
        const driveLogs = async () => {
          const clearBtn = document.getElementById('btnClearLog');
          if (clearBtn) { clearBtn.click(); await frames(); }
          const rows = () => document.querySelectorAll('#log > div:not(.log-empty):not(.log-cut)').length;
          // 示例日志：路径与 id 全是一眼假值；级别多数显式给，便于分级计数可信
          const lines = [
            ['任务开始（博主主页）：https://www.xiaohongshu.com/user/profile/EXAMPLE0000000000000000', ''],
            ['博主 UID：EXAMPLE0000000000000000', ''],
            ['下载开始：共 12 个作品，并发 4', ''],
            ['下载中：img01.jpg（1/12）', ''],
            ['下载完成：img01.jpg 已保存到 D:\\\\out\\\\weibo_EXAMPLE\\\\01\\\\img01.jpg', 'ok'],
            ['下载跳过：img02.jpg 本地已存在', 'warn'],
            ['下载失败：img03.jpg 连接被拒绝（ECONNREFUSED）', 'err'],
            ['采集失败：页面没有返回作品数据（多半是登录态过期）', 'err'],
            ['ffmpeg 不可用，已跳过转换（原文件已保留）', 'warn'],
            ['下载任务完成：新增 10，跳过 1，失败 1', 'ok'],
            ['日志已导出：D:\\\\out\\\\run.log', 'ok'],
          ];
          for (const pair of lines) window.__ui.log(pair[0], pair[1]);
          await frames(3);
          const rowsAll = rows();

          // 级别筛选：先证明它真的会缩窄结果（随即切回「全部」，截图要展示完整日志区）
          window.__ui.setLogFilter('err');
          await frames(3);
          const rowsErr = rows();
          window.__ui.setLogFilter('all');
          await frames(3);

          // 关键字高亮（logSearch 有 160ms 防抖，见 app.js）
          const el = document.getElementById('logSearch');
          el.value = '下载';
          el.dispatchEvent(new Event('input'));
          await sleep(400);
          await frames(3);
          /**
           * 把日志卡滚到视口中间再截图。
           * 1427×900 下日志卡从第 570px 才开始，不滚动只能拍到标题栏和半行日志 ——
           * 而「日志区」这张图的意义就在于展示级别筛选、检索框和高亮效果。
           * 只影响截图取景，不改任何状态，前面的断言都已经跑完了。
           */
          const logCard = document.querySelector('.logs');
          if (logCard && logCard.scrollIntoView) logCard.scrollIntoView({ block: 'center' });
          await frames(3);
          return {
            rowsAll,
            rowsErr,
            rowsAfter: rows(),
            marksAfter: document.querySelectorAll('#log mark').length,
            query: el.value,
            filter: window.__ui ? window.__ui.state.logFilter : '',
            counts: ['cntAll', 'cntInfo', 'cntOk', 'cntWarn', 'cntErr'].map((id) => {
              const n = document.getElementById(id);
              return n ? n.textContent : '';
            }),
          };
        };

        if (SCENE === 'idle') {
          check('首屏没有在跑任务', snap.running === false, snap.running);
          check('首屏输入框为空', snap.inputValue === '', snap.inputValue);
          check('首屏日志区是空态，不是上一轮的残留', snap.logEmptyShown, snap.logEmptyShown);
          check('首屏已渲染出选项（默认平台）', snap.options > 0, snap.options);
          return { scene: SCENE, hasApi: typeof window.api, viewport, snap, checks };
        }

        if (SCENE === 'modal') {
          const modal = await driveModal();
          check('手动 Cookie 只有微博支持（本场景就在微博页上）', modal.supported, modal.supported);
          check('Cookie 弹窗真的打开了', modal.shown, modal.shown);
          check('弹窗里填的是占位串（不是真实 Cookie）', modal.textareaValue.indexOf('xxx') >= 0, modal.textareaValue);
          check('弹窗三个出口都在（取消 / 保存 / 关闭）', modal.actions === 3, modal.actions);
          return { scene: SCENE, hasApi: typeof window.api, viewport, snap, modal, checks };
        }

        if (SCENE === 'logs') {
          const logs = await driveLogs();
          check('清掉历史后日志重新写进来了', logs.rowsAll > 0, logs.rowsAll);
          check('级别筛选到「错误」后行数变少', logs.rowsErr > 0 && logs.rowsErr < logs.rowsAll, logs.rowsErr + ' / ' + logs.rowsAll);
          check('切回「全部」后行数恢复', logs.rowsAfter >= logs.rowsErr, logs.rowsAfter + ' >= ' + logs.rowsErr);
          check('关键字命中被 <mark> 高亮', logs.marksAfter > 0, logs.marksAfter);
          /**
           * 等「日志已清空」那条 toast 自己消失再截图。
           * driveLogs 开头点了「清空」，toast 会正好压在日志工具栏中间（关键字输入框）上，
           * 截图里就是一条黑块盖住搜索框。断言不受影响，但那张图没法放进 README。
           * 轮询而不是写死时长：toast 的展示时长在渲染层（app.js 的 2600ms），
           * 这里写死会在改了那个值时悄悄失效。
           */
          const toastEl = document.getElementById('toast');
          for (let i = 0; i < 25 && toastEl && toastEl.classList.contains('show'); i++) await sleep(200);
          return { scene: SCENE, hasApi: typeof window.api, viewport, snap, logs, checks };
        }

        /* ---------- 2. 设计令牌是否真的生效 ----------
           tokens.css 只要没被打包进去，所有 var() 都会静默失效：
           背景变透明、按钮变浏览器默认样式、圆角归零 —— 而单元测试一条都不会红。 */
        const rootCS = getComputedStyle(document.documentElement);
        const loginCS = getComputedStyle(document.getElementById('btnLogin'));
        // 边框色用「停止」按钮量：它初始是 disabled，:hover:not(:disabled) 不会命中 ——
        // 用登录按钮量时，真实光标恰好悬在上面就会读到 hover 态的 --c-border-ctl-strong
        const stopCS = getComputedStyle(document.getElementById('btnStop'));
        const cardCS = getComputedStyle(document.querySelector('.card'));
        const tokens = {
          accent: rootCS.getPropertyValue('--c-accent').trim(),
          ink: rootCS.getPropertyValue('--c-ink').trim(),
          ctrlMd: rootCS.getPropertyValue('--ctrl-md').trim(),
          btnHeight: loginCS.height,
          btnBorder: stopCS.borderTopColor,
          btnRadius: loginCS.borderTopLeftRadius,
          cardRadius: cardCS.borderTopLeftRadius,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
        check('tokens.css 已加载（--c-accent = #2e5bff）', tokens.accent === '#2e5bff', tokens.accent);
        check('按钮高度取自 --ctrl-sm（28px）', tokens.btnHeight === '28px', tokens.btnHeight);
        check(
          '控件边框取自 --c-border-ctl（rgb(134,143,157)）',
          tokens.btnBorder === 'rgb(134, 143, 157)',
          tokens.btnBorder
        );
        check('卡片圆角取自 --r-2xl（18px）', tokens.cardRadius === '18px', tokens.cardRadius);
        check('body 背景不是透明（--c-canvas 生效）', tokens.bodyBg !== 'rgba(0, 0, 0, 0)', tokens.bodyBg);

        /* ---------- 3. 三个平台逐个切一遍 ---------- */
        const tabs = [...document.querySelectorAll('.tab')];
        const seen = [];
        for (const t of tabs) {
          t.click();
          await sleep(450);
          await frames();
          seen.push({
            platform: t.dataset.platform,
            active: t.classList.contains('active'),
            options: document.querySelectorAll('#options .chk, #options .num').length,
            optionKeys: [...document.querySelectorAll('#options [data-key]')].map((x) => x.dataset.key),
            placeholder: document.getElementById('inputUid')?.placeholder,
            authText: document.getElementById('authText')?.textContent,
            badges: document.querySelectorAll('#platformBadges .badge').length,
            linkRows: document.querySelectorAll('#links .link-row').length,
            siteUrl: document.getElementById('siteUrl')?.dataset.url || '',
            loginUrl: document.getElementById('loginUrlState')?.dataset.url || '',
            copyBtns: ['btnCopySite', 'btnCopyLogin', 'btnCopyTarget', 'btnOpenSite'].filter(
              (id) => !!document.getElementById(id)
            ).length,
          });
        }
        check('三个平台选项卡都在', tabs.length === 3, tabs.length);
        check(
          '每个平台切换后都渲染出选项',
          seen.every((s) => s.options > 0),
          seen.map((s) => s.options).join('/')
        );
        check(
          '每个平台都有官网与登录页地址',
          seen.every((s) => s.siteUrl && s.loginUrl),
          seen.map((s) => s.siteUrl).join(' | ')
        );

        /* ---------- 4. 布局：横向溢出与右栏可滚动 ---------- */
        const de = document.documentElement;
        const side = document.querySelector('.side');
        const sideCS = getComputedStyle(side);
        const layout = {
          gridCols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
          docScrollWidth: de.scrollWidth,
          docClientWidth: de.clientWidth,
          sideMaxH: sideCS.maxHeight,
          sideOverflowY: sideCS.overflowY,
          sideClientH: side.clientHeight,
          sideScrollH: side.scrollHeight,
        };
        check(
          '没有横向溢出（并行的百分比段不再把容器撑破）',
          layout.docScrollWidth <= layout.docClientWidth + 1,
          layout.docScrollWidth + ' vs ' + layout.docClientWidth
        );
        // 单栏断点（≤899px）下右栏本就回归普通文档流，此时不该再要求 max-height。
        // 用 indexOf(' ') 而不是正则：这段字符串在 Node 的模板字面量里，\s 会被吃掉成 s。
        layout.singleColumn = layout.gridCols.trim().indexOf(' ') < 0;
        check(
          '右栏有高度上限且可滚动（内容超高时底部按钮够得着）',
          layout.singleColumn
            ? sideCS.position === 'static'
            : sideCS.overflowY === 'auto' && layout.sideMaxH !== 'none',
          (layout.singleColumn ? '单栏 ' : '双栏 ') + sideCS.overflowY + ' / ' + layout.sideMaxH
        );

        /* ---------- 5. 性能护栏：动画门槛 + 日志 DOM 上限 ---------- */
        const bar = document.getElementById('bar');
        const box = document.getElementById('log');
        const idleAnim = getComputedStyle(bar).animationName;
        document.body.classList.add('running');
        const runningAnim = getComputedStyle(bar).animationName;
        document.body.classList.remove('running');

        const logBefore = box.childElementCount;
        for (let i = 0; i < 1200; i++) window.log('压力测试日志 ' + i);
        await frames(3);
        const logAfter = box.childElementCount;
        const logCountText = document.getElementById('logCount').textContent;

        check('空转时不跑流光动画', idleAnim === 'none', idleAnim);
        check('运行态才跑流光动画', runningAnim === 'flow', runningAnim);
        check('日志确实渲染进了 DOM', logAfter > logBefore, logBefore + ' → ' + logAfter);
        check(
          '日志 DOM 被裁到上限附近（≤ 401 个节点）',
          logAfter <= 401,
          logAfter
        );

        /* ---------- 6. 进度：实时推进 + 并发细条 ---------- */
        const ui = window.__ui;
        const uiOut = { ok: false };
        if (ui) {
          ui.state.platform = 'xhs';
          ui.state.stats = { total: 4, done: 0, skip: 0, fail: 0, item: 2 };
          ui.state.inflight.clear();
          ui.renderStats();
          await frames();
          const barIdle = document.getElementById('bar').style.width;
          const minisIdle = document.getElementById('minis').classList.contains('on');

          // 两个文件同时在传：一个总长已知、一个未知（少数 CDN 不给 content-length）
          ui.handleEvent({ type: 'dl', event: 'progress', file: 'C:\\\\out\\\\a\\\\img01.jpg',
            written: 50, total: 100, stats: { done: 0, skipped: 0, failed: 0, bytes: 512, remaining: 2 } });
          ui.handleEvent({ type: 'dl', event: 'progress', file: 'C:\\\\out\\\\a\\\\video.mp4',
            written: 4096, total: null, stats: { done: 0, skipped: 0, failed: 0, bytes: 512, remaining: 2 } });
          await frames();

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
          await frames();
          const statsAfterFail = { ...ui.state.stats };
          const minisAfterFail = document.querySelectorAll('#minis .mini').length;
          const failBoxShown = !document.getElementById('failBox').hidden;

          const logText = ui.exportLogText();
          const head = logText.split('\\n').slice(0, 4);

          ui.handleEvent({ type: 'dl', event: 'done', file: 'C:\\\\out\\\\a\\\\video.mp4',
            size: 10, stats: { done: 2, skipped: 0, failed: 1, bytes: 3000, remaining: 0 } });
          await frames();

          Object.assign(uiOut, {
            ok: true,
            barIdle, barLive,
            barAfterAll: document.getElementById('bar').style.width,
            minisIdle, minisOn, minisLive, minisAfterFail,
            minisAfterAll: document.querySelectorAll('#minis .mini').length,
            pctText, nameText, statsAfterFail, failBoxShown,
            logButtons: ['btnExportLog', 'btnCopyLog', 'btnClearLog'].filter((id) => !!document.getElementById(id)).length,
            logCountText,
            head,
            logHasStress: /压力测试日志 1199/.test(logText),
            logHasFail: /下载失败：bad.jpg 连接被拒绝/.test(logText),
            logLines: logText.split('\\n').length,
          });

          check('进度条在传输中真的动了（不是 0%）', barLive !== '0%' && barLive !== '', barLive);
          check('并发细进度条渲染出来', minisLive > 0, minisLive);
          check('细条上有百分比/字节文案', /%/.test(pctText), pctText);
          check('失败后出现失败明细', failBoxShown, failBoxShown);
          check('导出的是全量日志（含第 1199 条压力日志）', uiOut.logHasStress, uiOut.logHasStress);
          check('导出含失败明细', uiOut.logHasFail, uiOut.logHasFail);
        } else {
          check('window.__ui 存在（渲染层对外契约）', false, 'undefined');
        }

        return {
          scene: SCENE,
          hasApi: typeof window.api,
          tabs: tabs.length,
          // 视口：三档验收靠它证明「真的换了尺寸」，而不是只看截图猜。
          // 用展开写而不是简写：探针 JSON 的字段名必须字面可搜 ——
          // architecture.test.js 会 grep "viewport: {" 来守住这个字段不被误删。
          viewport: { ...viewport },
          platforms: seen,
          ffmpeg: document.getElementById('ffmpegState')?.textContent,
          tokens,
          layout,
          perf: { idleAnim, runningAnim, logBefore, logAfter, logCountText },
          ui: uiOut,
          checks,
        };
      })()`);
    } catch (err) {
      smokeErrors.push('probe failed: ' + err.message);
    }

    // 断言结果并入 errors：冒烟要能自己判「过没过」，而不是生成一份要人肉看的 JSON
    for (const c of probe.checks || []) {
      if (!c.ok) smokeErrors.push(`[check] ${c.name} —— 实测：${c.actual}`);
    }

    /**
     * 视觉验收：截一张图存到「JSON 同名 .png」。
     *
     * 截图失败只警告、**不**进 smokeErrors：errors 是「功能坏了」的判据，
     * 而 capturePage 在无 GPU / 远程桌面 / 窗口被完全遮挡时本来就可能失败，
     * 那种情况不该把整轮验收判成失败（JSON 仍要落盘，视口字段也仍然可信）。
     */
    try {
      const image = await ctx.mainWindow.webContents.capturePage();
      await fsp.writeFile(pngPathOf(smokeOut), image.toPNG());
    } catch (err) {
      console.warn('[smoke] 截图失败（不影响 JSON）：', err && err.message);
    }

    await fsp.writeFile(
      smokeOut,
      JSON.stringify(
        { probe, errors: smokeErrors, perf: { ...ctx.perfMarks }, memory: memorySnapshot() },
        null,
        2
      ),
      'utf8'
    );
    app.quit();
  });
}

module.exports = { attachSmoke, memorySnapshot, pngPathOf, parseSmokeScene, SMOKE_SCENES, DEFAULT_SCENE };
