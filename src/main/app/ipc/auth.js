/**
 * 登录态 IPC：查询 / 开登录窗 / 手动 Cookie / 退出登录
 *
 * 这里只做「协议层」——真正的登录态判定与 Cookie 清理在 app/auth.js，
 * 窗口行为在 app/login-window.js。分开的理由：登录流程是本应用最容易出
 * 时序 bug 的地方（旧窗 closed 回调抹掉新窗引用、扫码成功自动关窗），
 * 把「窗口」和「凭证」放在两个文件里，读代码时才分得清谁负责什么。
 */
const { session } = require('electron');

const registry = require('../../platforms/registry');
const { joinCookies, parseCookieString } = require('../../cookies');
const { normalizePlatform, authStatus, logout } = require('../auth');
const { createLoginWindow } = require('../login-window');

const HANDLE_CHANNELS = ['auth:logout', 'auth:openLogin', 'auth:setCookie', 'auth:status'];
const ON_CHANNELS = [];

function register(reg, ctx) {
  reg.handle('auth:status', (e, platform) => authStatus(ctx, platform));

  reg.handle('auth:openLogin', (e, platform) => {
    createLoginWindow(ctx, platform);
    return true;
  });

  /** 手动粘贴 Cookie（仅微博支持；小红书/抖音的签名依赖页面环境，粘 Cookie 也无法直连） */
  reg.handle('auth:setCookie', async (e, platform, str) => {
    const p = registry.get(normalizePlatform(platform));
    if (!p.supportsManualCookie) throw new Error(`${p.name}不支持手动粘贴 Cookie，请用登录窗口扫码登录`);
    const pairs = parseCookieString(str);
    if (!pairs.length) throw new Error('没能解析出有效的 Cookie，请检查粘贴内容');
    const ses = session.fromPartition(p.partition);
    for (const item of pairs) {
      for (const domain of p.cookieDomains) {
        // 写入地址必须落在目标域内，否则 Electron 会拒绝这条 domain cookie
        // （早先固定用 siteURL，于是 .sina.com.cn 那一条永远写不进去）。
        const host = String(domain).replace(/^\./, '');
        await ses.cookies
          .set({
            url: `https://${host}/`,
            name: item.name,
            value: item.value,
            domain,
            path: '/',
            secure: true,
            httpOnly: false,
            expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
          })
          .catch(() => {});
      }
    }
    if (ctx.authStore) await ctx.authStore.save(joinCookies(pairs));
    // 手动粘贴的 Cookie 视为「用户主动提供」，直接记录指纹，免去再走一次登录窗
    for (const item of pairs) {
      if (p.loginMarks.includes(item.name)) await ctx.loginState.record(p.id, item.name, item.value);
    }
    return authStatus(ctx, p.id);
  });

  reg.handle('auth:logout', (e, platform) => logout(ctx, platform));
}

module.exports = { register, HANDLE_CHANNELS, ON_CHANNELS };
