/**
 * 登录态与平台运行上下文
 *
 * 平台差异全部收敛在 platforms/*.js 里，这里只处理「跨平台共用的三件事」：
 * 登录态判定、接口用的运行上下文、以及手动 Cookie 的恢复与退出。
 */
const { session } = require('electron');

const registry = require('../platforms/registry');
const { sessionFetch, withCookie } = require('../core/net');
const { joinCookies, latestExpiry, parseCookieString, gatherAuthCookies, removeAuthCookies } = require('../cookies');
const { addWarning } = require('./context');

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
async function authStatus(ctx, platform) {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  const cookies = await gatherAuthCookies(ses, p);
  // trustKeyCookie（微博）的平台：关键 Cookie 不会匿名下发，存在即真登录；
  // 首次遇到时由 verifyOrTrust 就地补记指纹，避免「明明已登录却显示未登录」。
  const v = await ctx.loginState.verifyOrTrust(p.id, cookies, p.loginMarks, !!p.trustKeyCookie);
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
    loginWindowURL: ctx.loginUrls[p.id] || '',
  };
}

/** 小包装：保持 auth.js 与 cookies.js 的依赖只有一处，便于以后替换实现 */

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
async function buildContext(ctx, platform) {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  const cookies = await ses.cookies.get({ url: p.siteURL });
  let cookie = joinCookies(cookies);

  const out = { partition: p.partition, session: ses, cookie, fetchImpl: sessionFetch(ses) };

  if (p.injectCookieIntoFetch) {
    if (!cookie && ctx.authStore) {
      const saved = await ctx.authStore.load();
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
    out.cookie = cookie;
    // 每次调用现取 cookie（登录态刷新后不必重建 fetch 实现）
    out.fetchImpl = withCookie(sessionFetch(ses), () => out.cookie);
  }
  return out;
}

/**
 * 恢复上次保存的手动 Cookie（微博专用兜底：session 丢失时仍能直连接口）。
 * 必须在 whenReady 之后调用（session 分区此时才可用）。
 *
 * 本轮修正（P1-10）：早先只往 `.weibo.com` 写一份，而且每次写入都用
 * `.catch(() => {})` 把失败**静默吞掉**。后果是：微博的登录态依赖 `SUB` 同时存在于
 * `.weibo.com` / `.weibo.cn` / `.sina.com.cn` 三处，只写一处时「恢复 Cookie」看起来做了，
 * 实际仍然被判未登录，而日志里一片安静。
 * 现在遍历平台声明的**全部** `cookieDomains` 逐个写，并统计失败数 —— 失败会进
 * `ctx.warnings`，由 `app:info` 带回界面，用户能看到「有 N 条没能写入」。
 */
async function restoreSavedCookie(ctx) {
  if (!ctx.authStore) return { written: 0, failed: 0 };
  const saved = await ctx.authStore.load();
  if (!saved?.value) return { written: 0, failed: 0 };
  const p = registry.get('weibo');
  const ses = session.fromPartition(p.partition);
  const pairs = parseCookieString(saved.value);
  let written = 0;
  let failed = 0;
  for (const item of pairs) {
    for (const domain of p.cookieDomains) {
      // 写入地址必须落在目标域内，否则 Electron 会拒绝这条 domain cookie
      const host = String(domain).replace(/^\./, '');
      try {
        await ses.cookies.set({
          url: `https://${host}/`,
          name: item.name,
          value: item.value,
          domain,
          path: '/',
          secure: true,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        });
        written++;
      } catch {
        // 单条失败不影响其余域，但必须计数 —— 静默吞掉会让「恢复失败」无从查起
        failed++;
      }
    }
  }
  if (failed) {
    addWarning(
      ctx,
      `恢复手动 Cookie 时有 ${failed} 条没能写入（成功 ${written} 条），微博可能仍显示未登录；` +
        '如果确实没登录，请重新粘贴一次 Cookie'
    );
  }
  return { written, failed };
}

/** 退出登录：清 Cookie（全部相关域）+ 清已验证指纹，否则匿名 Cookie 会被误判为仍登录 */
async function logout(ctx, platform) {
  const p = registry.get(normalizePlatform(platform));
  const ses = session.fromPartition(p.partition);
  // 必须覆盖全部相关域：微博的 SUB 可能同时存在 .weibo.com 与 passport.weibo.com，
  // 只清主站会留下 passport 域那份，重新打开站点时又会被重新拼进 Cookie 头。
  await removeAuthCookies(ses, p);
  // 清掉已验证记录，否则下次访问站点时匿名 Cookie 会被误判为仍处于登录态
  await ctx.loginState.clear(p.id);
  ctx.loginUrls[p.id] = '';
  if (p.supportsManualCookie) await ctx.authStore?.clear();
  return authStatus(ctx, p.id);
}

module.exports = { normalizePlatform, authStatus, buildContext, restoreSavedCookie, logout };
