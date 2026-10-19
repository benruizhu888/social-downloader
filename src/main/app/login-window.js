/**
 * 登录窗：打开 / 轮询 / 关闭的完整生命周期
 *
 * 从 main.js 原样搬出。搬移时只做了一件事：把模块级状态与 emit 换成通过 ctx 访问
 * （拆分后跨模块共享的可变状态只允许放在 ctx 上，见 app/context.js 的注释）。
 * 逻辑、日志文案、事件顺序一律未改 —— 批次 C 已经修好「旧窗的 closed 回调
 * 把新窗引用抹掉」那个坑，这里不能再动它（test/login-window-lifecycle.test.js 守着）。
 */
const { BrowserWindow, session } = require('electron');

const registry = require('../platforms/registry');
const { hasProbe, collectScript, decision: loginDecision, createLoginGate } = require('../login-probe');
const { attachUrlGuards } = require('../url-guard');
const { gatherAuthCookies } = require('../cookies');
const { normalizePlatform, authStatus } = require('./auth');

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
function createLoginWindow(ctx, platform) {
  const p = registry.get(normalizePlatform(platform));
  if (ctx.loginWindow && !ctx.loginWindow.isDestroyed()) {
    if (ctx.loginPlatform === p.id) {
      ctx.loginWindow.focus();
      return;
    }
    /**
     * 换平台：关掉旧窗即可，**不要**在这里手动把 ctx.loginWindow 置空 ——
     * close() 是异步的，新的引用马上就会被下面赋上，谁先谁后由事件循环决定。
     * 旧窗迟到的 'closed' 回调靠「自己是不是当前那个窗口」来识别（见下方处理器），
     * 所以这里只需要 close。
     */
    ctx.loginWindow.close();
  }
  ctx.loginPlatform = p.id;
  /**
   * 每个平台一份地址缓存（键是平台 id），所以这里清空只影响「本次要打开的」那个平台，
   * 不会把另一个平台刚展示出来的地址抹掉（旧窗迟到的 did-navigate 也是写自己的键）。
   */
  ctx.loginUrls[p.id] = '';

  ctx.loginWindow = new BrowserWindow({
    width: 1060,
    height: 800,
    title: `登录 ${p.name}`,
    parent: ctx.mainWindow,
    webPreferences: { partition: p.partition, contextIsolation: true, nodeIntegration: false },
  });

  const ses = session.fromPartition(p.partition);
  const win = ctx.loginWindow;
  const probeScript = hasProbe(p.id) ? collectScript(p.id) : null;
  const log = (message) => ctx.emit({ type: 'log', platform: p.id, message });

  /**
   * 登录窗口没有地址栏 —— 这是一个裸露的 BrowserWindow，用户在里面扫码/输账号时
   * **完全看不到自己正在哪个网站上**。登录流程又会在 passport / 扫码页 / 二次验证之间
   * 来回跳，页面自己的 <title> 一直在变（「微博登录」「安全验证」…），
   * 更看不出站点。所以这里接管标题，固定拼成「登录 <平台> — <域名>」，
   * 并屏蔽页面自带的标题更新。
   */
  const hostOf = (url) => {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const applyTitle = (url) => {
    const host = hostOf(url) || hostOf(p.loginURL);
    const next = host ? `登录 ${p.name} — ${host}` : `登录 ${p.name}`;
    try {
      if (win && !win.isDestroyed()) win.setTitle(next);
    } catch {
      /* 窗口可能已销毁 */
    }
  };
  // 页面标题不再覆盖我们的标题（否则一加载完就变回「微博登录」）
  win.on('page-title-updated', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });
  applyTitle(p.loginURL);

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
          await ctx.loginState.record(p.id, name, c.value);
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
    ctx.emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}登录成功` });
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
      ctx.emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}已是登录状态` });
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
      const r = await ctx.loginState.detectChange(p.id, cookie, p.loginMarks);
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
    ctx.loginUrls[p.id] = url;
    ctx.emit({ type: 'login-url', platform: p.id, url });
    // 标题跟着地址走：跳到 passport / 扫码页时，标出来的就是用户眼前那个域名
    applyTitle(url);
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
    ctx.emit({ type: 'login-crashed', platform: p.id, reason: details.reason });
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
      const st = await authStatus(ctx, p.id);
      if (st.loggedIn) {
        ctx.emit({ type: 'auth', platform: p.id, loggedIn: true, message: `${p.name}登录状态已同步` });
      } else {
        ctx.emit({ type: 'auth', platform: p.id, loggedIn: false, message: st.detail });
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
    /**
     * ⚠️ 只有「当前这个窗口仍然是全局引用的那一个」才清空引用。
     *
     * 切平台时的顺序是 `ctx.loginWindow.close()` → 立刻建新窗，而 close() 的 'closed'
     * 事件在**后面的 tick** 才到（Electron 的关窗是异步的）。早先这里无条件
     * `ctx.loginWindow = null; ctx.loginPlatform = null;`，于是旧窗的收尾把**新窗**的引用抹掉了：
     *   · 再点一次「登录」→ 以为没有窗口 → 又开一个（重复开窗，监听器一起泄漏）
     *   · ctx.loginPlatform 丢失 → 换账号/退出登录等功能找不到当前平台
     * 收尾动作（停轮询、摘 Cookie 监听、通知界面已关闭）照旧执行，只是不再动别人的状态。
     */
    if (ctx.loginWindow === win) ctx.loginWindow = null;
    if (ctx.loginPlatform === p.id) ctx.loginPlatform = null;
    const wasLoggedIn = lastProbe.loggedIn;
    const alreadyConfirmed = confirmed;
    ctx.emit({ type: 'login-closed', platform: p.id });

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
/**
 * 当前登录窗状态快照（唯一用途：给纯净 Node 单测观察全局引用）。
 *
 * 登录窗引用是模块级状态，行为完全取决于「谁在什么时候清空它」，
 * 读源码做静态断言证明不了「切平台后引用还在」—— 必须真的跑一遍时序。
 */
function loginWindowSnapshot(ctx) {
  return { loginWindow: ctx.loginWindow, loginPlatform: ctx.loginPlatform, loginUrls: ctx.loginUrls };
}

module.exports = { createLoginWindow, loginWindowSnapshot };
