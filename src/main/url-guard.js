/**
 * URL 协议白名单
 *
 * 为什么必须有这个模块 —— 用户实际看到的故障：
 *   抖音页面里有「打开抖音客户端」这类深链（`bytedance://` / `snssdk1128://`）。
 *   早期版本在 setWindowOpenHandler 里无条件 `win.loadURL(url)`，
 *   一旦页面请求打开这种自定义协议，Chromium 就把请求交给操作系统，
 *   Windows 立刻弹出「获取打开此 'bytedance' 链接的应用」——
 *   用户截图里那个对话框就是这么来的。
 *
 * 同一个坑还有两种形态：
 *   1. 页面直接 `location.href = 'bytedance://...'`（不走 window.open）
 *   2. `shell.openExternal(任意字符串)` —— 它调用的是操作系统的协议分发，
 *      传 `file://` 会打开本地文件，传 `ms-settings:` 会拉起系统设置
 *
 * 所以一切「要把 URL 交出去」的地方都必须先过这里。
 */

/** 视为「网页地址」的协议：只有这两个能安全地交给浏览器或加载到窗口里 */
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/** 允许窗口自身导航到的协议（除网页外，还有本地页面与空白页） */
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'blob:', 'data:']);

function parse(input) {
  try {
    return new URL(String(input || ''));
  } catch {
    return null; // 相对路径、空串、乱码一律视为不可信
  }
}

/** 是否是可直接打开/加载的网页地址（http/https） */
function isWebUrl(input) {
  const u = parse(input);
  return !!u && WEB_PROTOCOLS.has(u.protocol);
}

/** 允许窗口导航：网页 + 本地页面 + 空白页 */
function isNavigableUrl(input) {
  const u = parse(input);
  return !!u && NAVIGABLE_PROTOCOLS.has(u.protocol);
}

/**
 * 返回规范化的网页地址，非 http(s) 一律返回 null。
 * 归一化（而不是原样返回）能顺手把 `https://a.com` 与 `https://a.com/` 统一起来。
 */
function webUrlOrNull(input) {
  const u = parse(input);
  if (!u || !WEB_PROTOCOLS.has(u.protocol)) return null;
  return u.toString();
}

/**
 * 只允许打开白名单里的站点。
 * 用「解析后比较 hostname」而不是字符串前缀 ——
 * `startsWith('https://a.com')` 会放行 `https://a.com.evil.com`。
 * @param {string} input    待打开的地址
 * @param {string[]} allowed 允许的站点（各平台的 siteURL）
 */
function pickAllowedSite(input, allowed) {
  const target = parse(input);
  if (!target || !WEB_PROTOCOLS.has(target.protocol)) return null;
  for (const item of allowed || []) {
    const a = parse(item);
    if (a && a.hostname === target.hostname && WEB_PROTOCOLS.has(a.protocol)) {
      return a.toString(); // 用白名单里的地址，而不是用户/平台传入的那份
    }
  }
  return null;
}

/** 一句话描述被拦下的原因，用于日志 */
function describeBlocked(input) {
  const u = parse(input);
  if (!u) return '无法解析的地址';
  // 自定义协议：真正会把请求交给操作系统的那一类，必须点名协议
  if (!WEB_PROTOCOLS.has(u.protocol)) return `${u.protocol.replace(':', '')}:// 协议`;
  // 网页地址却被拦：只可能是「不在白名单里」（例如主窗试图跳到外站）
  return `${u.hostname}（不在白名单内）`;
}

/**
 * 重复日志合并器。
 *
 * 真实症状（用户 2026-10-15 的抖音日志）：一次登录里刷出 46 条一模一样的
 * `已拦截子框架导航到 bytedance:// 协议`。抖音页面会持续尝试唤起 App 深链，
 * 拦一次打一行 —— 而界面日志区只保留最近 400 行，
 * 于是真正有用的「采集到几个作品 / 哪个文件失败」全被这些噪声挤了出去，
 * 用户拿着日志来问问题时，关键行已经不在界面上了。
 *
 * 规则刻意做成**确定性**的（不依赖时间窗口），既好推理也好单测：
 *   · 第一次出现：立刻原样输出 —— 关键信息绝不被推迟
 *   · 之后每累计 step 次**重复**，输出一条带累计次数的汇总
 *   · 不足 step 的余数不再单独记录（那正是要被压掉的噪声）
 *
 * @param {object} [opts]
 * @param {number} [opts.step=20] 每累计多少次重复打一条汇总
 * @param {(msg:string)=>void} [opts.log]
 */
function createRepeatCoalescer({ step = 20, log = () => {} } = {}) {
  const state = new Map(); // key -> { text, count, pending }
  return {
    /** @param {string} key 去重键（同一目标用同一个键） @param {string} text 日志原文 */
    push(key, text) {
      let st = state.get(key);
      if (!st) {
        st = { text, count: 0, pending: 0 };
        state.set(key, st);
      }
      st.count++;
      if (st.count === 1) {
        log(text);
        return;
      }
      st.pending++;
      if (st.pending >= step) {
        log(`${text}（同一目标已累计拦截 ${st.count} 次，重复的不再逐条记录）`);
        st.pending = 0;
      }
    },
    /** 供测试与收尾查询 */
    countOf(key) {
      const st = state.get(key);
      return st ? st.count : 0;
    },
  };
}

/**
 * 调「外面传进来的回调」时，**绝不允许异常穿透**。
 *
 * 这不是防御性编程洁癖，是本轮用户截图里那个崩溃框的直接元凶：
 *   栈是 `emit ← onWebOpen ← windowOpenHandler`，
 *   也就是「护栏在 windowOpenHandler 里回调业务代码，业务代码抛了」。
 *   Electron 的事件派发（dispatchToFrameListeners）没有任何 try/catch，
 *   异常会一路上升成主进程的 uncaughtException，Electron 默认就弹一个
 *   盖住界面的原生模态框 —— 用户看到「软件卡死」。
 *
 * 所以结论是：**护栏自己的回调必须是异常安全的**。
 * 拦不住一个 URL 是小事，让整个界面被一个模态框挡住是大事。
 */
function safeCall(fn, arg, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn(arg);
  } catch {
    return fallback;
  }
}

/**
 * 已经挂过户的 webContents → 它的可变配置。
 *
 * 为什么用 WeakMap 而不是「每调一次就再注册一套处理器」：
 *   本轮加了「全局兜底」（installGlobalUrlGuard 会给每个新建 webContents 先挂一套默认护栏），
 *   而各窗口随后还要按自己的需要**升级**行为（登录窗要接管弹窗、主窗要锁死自身页面）。
 *   如果两次就是两套处理器，日志会重复、allowNavigate 会互相打架。
 *   所以这里把「处理器」只注册一次，「行为」放在这个可覆盖的槽位里。
 */
const guardSlots = new WeakMap();

/**
 * 给一个窗口挂上「协议白名单」护栏。
 *
 * 项目里有三个窗口（主窗 / 登录窗 / 采集窗），共同点是：任何「把 URL 交出去」的动作
 * （页面开新窗口、顶层导航、iframe 导航、服务端跳转）都必须先过白名单。
 * 抽成函数而不是各处复制，是因为**漏挂任何一个窗口，那个窗口就能把任意协议交给操作系统**。
 *
 * 重复调用同一个 webContents 不会重复注册处理器，只会**升级配置**（见上面 guardSlots 注释）。
 *
 * @param {object} webContents Electron webContents
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]          拦截日志
 * @param {(url:string)=>boolean} [opts.allowNavigate] 放行判定（默认 isNavigableUrl）
 * @param {(url:string)=>void} [opts.onWebOpen]    页面请求打开 http(s) 时的处理（默认仅记录）
 * @param {boolean} [opts.notifyWebOpen=true]      http(s) 弹窗是否也记日志
 *                                                 （采集窗会被页面频繁弹窗，关掉以免刷屏）
 * @returns {boolean} 本次是否真正注册了处理器（false = 只是升级了已有配置）
 */
function attachUrlGuards(webContents, opts = {}) {
  const existing = guardSlots.get(webContents);
  if (existing) {
    Object.assign(existing, opts); // 升级行为，不重注册
    return false;
  }

  // 槽位里只放「行为」，处理器始终读取最新的槽位 —— 于是升级无需重注册
  const slot = { ...opts };
  guardSlots.set(webContents, slot);

  const log = (m) => {
    safeCall(slot.log, m);
  };
  const allowNavigate = (url) => {
    // 自定义判定抛异常时退回文档化的默认判定，而不是一刀切拒绝 ——
    // 拒绝会让页面直接停摆，比放行一个普通网页更糟。
    if (typeof slot.allowNavigate !== 'function') return isNavigableUrl(url);
    const r = safeCall(slot.allowNavigate, url, null);
    return typeof r === 'boolean' ? r : isNavigableUrl(url);
  };
  const notifyWebOpen = () => slot.notifyWebOpen !== false;
  /**
   * 拦截日志走合并器：同一个目标反复被拦（抖音/小红书的 App 深链是重灾区）
   * 只逐条记第一次 + 每 20 次一条汇总，避免把真正的信息挤出日志窗口。
   * 每个 webContents 一份，互不影响。
   */
  const blocked = createRepeatCoalescer({ step: 20, log });

  // 1) window.open / target=_blank —— 这是 bytedance:// 深链最常见的入口
  //
  //    不管来自主框架还是 iframe，都会走到这里（setWindowOpenHandler 是 webContents 级的）。
  webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      if (typeof slot.onWebOpen === 'function') {
        if (notifyWebOpen()) log(`页面请求打开新窗口，已在当前窗口内打开：${url}`);
        safeCall(slot.onWebOpen, url);
      } else if (notifyWebOpen()) {
        log(`页面请求打开新窗口（已拦截）：${url}`);
      }
    } else {
      blocked.push(url, `已拦截非网页链接：${describeBlocked(url)}`);
    }
    return { action: 'deny' };
  });

  /** 取消一次可取消的导航（details 可能不是真 Event，先确认有这个方法） */
  const cancel = (details) => {
    if (details && typeof details.preventDefault === 'function') details.preventDefault();
  };

  // 2) 顶层导航（location.href = 'bytedance://...'、表单提交、meta refresh 走这条路）
  //
  // 签名注意：`will-navigate` 的回调是 `(details, url, ...)`，
  // 其中第 2 个参数起在 Electron 28 已经被标记为 @deprecated 但仍会传入。
  // 这里优先用 `details.url`，回落旧参数，避免将来 Electron 删掉旧参数时静默失效。
  webContents.on('will-navigate', (details, url) => {
    const target = (details && details.url) || url;
    if (!target) return;
    if (allowNavigate(target)) return;
    cancel(details);
    blocked.push(target, `已拦截导航到 ${describeBlocked(target)}`);
  });

  // 3) 子框架导航：顶层那层拦不到 iframe 里的自定义协议跳转
  //
  // ⚠️ 这里踩过一个「静默死代码」的大坑，务必看清签名：
  //   electron.d.ts:13246
  //     on(event: 'will-frame-navigate',
  //        listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
  //   —— 回调**只有 1 个参数**，`url` / `isMainFrame` 全都在这个 details 对象里。
  //
  //   早期写成 `(e, details)` 想当然地照抄 `will-navigate` 的两参形态，
  //   结果 `details` 恒为 `undefined`，第一行 `if (!details) return` 直接短路 ——
  //   整个处理器**从未执行过一次**。表面上「挂了护栏」，实际 iframe 里的
  //   `bytedance://` 深链照样交给操作系统弹「获取打开此 'bytedance' 链接的应用」。
  //
  //   教训：这种「形参位置写错」的 bug 用假对象（`{ emit('will-frame-navigate', e, {…}) }`）
  //   写的单测永远测不出来，因为假对象按你写的错签名回放。
  //   所以 url-guard-frame.test.js 里用的是**真实 Electron + 真实 iframe**。
  //
  //   另外实测确认：`will-frame-navigate` 也会**为主框架**触发。
  //   这里仍让主框架提前 return（交给 will-navigate），是为了避免同一次导航打两条日志。
  webContents.on('will-frame-navigate', (details) => {
    if (!details || !details.url) return;
    if (details.isMainFrame) return; // 主框架已由上面的 will-navigate 负责，避免重复日志
    if (allowNavigate(details.url)) return;
    cancel(details);
    blocked.push(details.url, `已拦截子框架导航到 ${describeBlocked(details.url)}`);
  });

  // 4) 服务端跳转（302/303 → bytedance:// 这类）
  //
  //    这是本轮排查里发现的**第四个漏洞**，前三个（window.open / 顶层导航 / iframe）都堵上之后
  //    仍然可能从这里漏出去：页面先正常导航到一个 https 地址（will-navigate 放行），
  //    服务端再回一个 302 指向自定义协议 —— will-navigate 不会再为「跳转后的地址」触发，
  //    但 will-redirect 会，而且它是可取消的。
  //
  //    注意这里**不能**跳过主框架：跳转后的地址只有 will-redirect 这一次机会能拦。
  webContents.on('will-redirect', (details, url) => {
    const target = (details && details.url) || url;
    if (!target) return;
    if (allowNavigate(target)) return;
    cancel(details); // 文档：preventDefault 会取消整次导航，而不只是这次跳转
    blocked.push(target, `已拦截服务端跳转到 ${describeBlocked(target)}`);
  });

  return true;
}

/**
 * 全局兜底：给**每一个** webContents 都挂上默认护栏（含已存在的）。
 *
 * 为什么要它 —— 本轮两次「同一个对话框又出现了」的根因都是**漏了一条路**：
 * 第一次是漏了 iframe（签名写错成了死代码），第二次是漏了服务端跳转。
 * 逐个窗口去挂是靠人记性，记漏一次就等于没有护栏。
 * 挂在 app 的 `web-contents-created` 上，则任何窗口（包括将来新加的、
 * 甚至 Chromium 自己开出来的）都自带一层「绝不把非 http(s) 交给操作系统」的底。
 *
 * ⚠️ 实测教训：**只监听 web-contents-created 是不够的**。
 *   protocol-leak.test.js 的 `global` 那一轮就是这么漏的 ——
 *   如果调用发生在某个窗口创建之后，那个窗口永远等不到事件，于是完全没有护栏。
 *   所以这里额外遍历一次已存在的 webContents，让调用顺序不再影响结果。
 *   （真实事件顺序不可控：这条事件也可能在别的模块里已经被触发过。）
 *
 * 各窗口随后仍可调用 attachUrlGuards 覆盖行为（登录窗接管弹窗、主窗锁死自身页面）。
 *
 * @param {object} app Electron app
 * @param {object} [opts] 同 attachUrlGuards；通常只传 log
 * @returns {number} 真正新挂上的 webContents 数量
 */
function installGlobalUrlGuard(app, opts = {}) {
  const apply = (webContents) => {
    try {
      return attachUrlGuards(webContents, { notifyWebOpen: false, ...opts });
    } catch {
      // 某些非常规 webContents（如 devtools）不接受 setWindowOpenHandler，忽略即可
      return false;
    }
  };

  app.on('web-contents-created', (_event, webContents) => apply(webContents));

  // 补挂「注册之前就已经存在」的那些 —— 顺序不敏感
  let swept = 0;
  try {
    // 延迟 require：本模块的纯函数部分要能在没有 Electron 的环境下被单测
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents() || []) {
      if (apply(wc)) swept++;
    }
  } catch {
    /* 纯 Node 环境（单测）下没有 electron.webContents，忽略 */
  }
  return swept;
}

module.exports = {
  isWebUrl,
  isNavigableUrl,
  webUrlOrNull,
  pickAllowedSite,
  describeBlocked,
  attachUrlGuards,
  installGlobalUrlGuard,
  createRepeatCoalescer,
  WEB_PROTOCOLS,
  NAVIGABLE_PROTOCOLS,
};
