/**
 * Cookie 工具与凭证持久化
 *
 * 三个平台的登录态都保存在各自的 Electron 持久化分区里（persist:weibo / persist:xhs / persist:douyin），
 * 本模块只提供通用工具：拼接、解析、登录态判定，以及把 Cookie 字符串额外存一份到 userData。
 * 判定规则由各平台适配器的 loginMarks 提供，这里不做任何平台特有假设。
 */

const fsp = require('fs/promises');
const path = require('path');

function joinCookies(cookies) {
  return cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 只挑出指定名字的 Cookie（微博抓接口时只需要这几个） */
function pickNamed(cookies, names) {
  if (!names || !names.length) return cookies.filter((c) => c && c.name && c.value);
  return cookies.filter((c) => c && c.name && c.value && names.includes(c.name));
}

/** 命中任意一个关键 Cookie 即视为已登录 */
function hasAnyMark(cookies, marks) {
  if (!marks || !marks.length) return false;
  return cookies.some((c) => c && c.value && marks.includes(c.name));
}

/** 命中的关键 Cookie 名字，便于界面展示「看到什么判定为已登录」 */
function hitMarks(cookies, marks) {
  if (!marks || !marks.length) return [];
  return cookies.filter((c) => c && c.value && marks.includes(c.name)).map((c) => c.name);
}

/** 从一组 Cookie 里取一个较晚的过期时间，用于界面提示 */
function latestExpiry(cookies) {
  let best = 0;
  for (const c of cookies) {
    if (c?.expirationDate && c.expirationDate > best) best = c.expirationDate;
  }
  if (!best) return '';
  const d = new Date(best * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** 从手动粘贴的字符串解析：支持 "a=1; b=2" 或含换行的多种写法 */
function parseCookieString(str) {
  const out = [];
  if (!str) return out;
  const cleaned = String(str).replace(/^\s*cookie\s*:/i, '').replace(/\r?\n/g, '; ');
  for (const part of cleaned.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

/* --------------------------- Electron session 读写 --------------------------- */

/** 把平台声明的域名/地址归一成 cookies.get 的查询条件 */
function authQueries(platform) {
  const list = [];
  if (platform?.siteURL) list.push({ url: platform.siteURL });
  if (platform?.loginURL) list.push({ url: platform.loginURL });
  for (const d of platform?.cookieDomains || []) {
    const domain = String(d).replace(/^\./, '').trim();
    if (domain) list.push({ domain });
  }
  return list;
}

/**
 * 汇总一个平台「所有相关域」下的 Cookie（去重）。
 *
 * 为什么不能只查 siteURL —— 微博登录暴露出来的真实缺陷：
 *   `SUB` 既可能落在 `.weibo.com`，也可能是 host-only 的 `passport.weibo.com`。
 *   只查 `https://weibo.com` 会漏掉后者，于是「登录明明成功了，界面一直显示未登录」。
 *   这里把 siteURL、登录页地址、各 cookieDomains 都查一遍。
 *
 * 注意：这个结果**只用于判定登录态**。抓接口时用的 Cookie 头仍然只取 siteURL 范围内的，
 * 否则会把同一个大域下（例如 sina.com.cn）成百条无关 Cookie 一起发出去。
 *
 * @param {{cookies:{get:Function}}} ses Electron session
 * @param {object} platform 平台适配器
 */
async function gatherAuthCookies(ses, platform) {
  const queries = authQueries(platform);
  const results = await Promise.all(
    queries.map((q) => ses.cookies.get(q).catch(() => []))
  );
  const seen = new Map();
  for (const list of results) {
    for (const c of list || []) {
      if (!c || !c.name) continue;
      seen.set(`${c.domain || ''}|${c.path || '/'}|${c.name}`, c);
    }
  }
  return [...seen.values()];
}

/** 由 Cookie 自身信息推出一个可用于删除的地址 */
function urlForCookie(cookie, fallbackUrl) {
  const host = String(cookie?.domain || '').replace(/^\./, '').trim();
  if (!host) return fallbackUrl;
  const scheme = cookie.secure === false ? 'http' : 'https';
  const p = cookie.path || '/';
  return `${scheme}://${host}${p.startsWith('/') ? p : '/' + p}`;
}

/** 清掉一个平台所有相关域下的 Cookie（退出登录用） */
async function removeAuthCookies(ses, platform) {
  const cookies = await gatherAuthCookies(ses, platform);
  let removed = 0;
  for (const c of cookies) {
    const url = urlForCookie(c, platform?.siteURL);
    try {
      await ses.cookies.remove(url, c.name);
      removed++;
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return { found: cookies.length, removed };
}

class AuthStore {
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, 'auth.json');
    this.safeStorage = safeStorage; // Electron safeStorage，可能为 undefined
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data.encrypted && this.safeStorage?.isEncryptionAvailable?.()) {
        const buf = Buffer.from(data.value, 'base64');
        return { value: this.safeStorage.decryptString(buf), savedAt: data.savedAt };
      }
      return { value: data.value, savedAt: data.savedAt };
    } catch {
      return null;
    }
  }

  async save(cookieString) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    let payload = { encrypted: false, value: cookieString, savedAt: Date.now() };
    if (this.safeStorage?.isEncryptionAvailable?.()) {
      try {
        const enc = this.safeStorage.encryptString(cookieString);
        payload = { encrypted: true, value: enc.toString('base64'), savedAt: Date.now() };
      } catch {
        /* 加密失败则明文保存 */
      }
    }
    await fsp.writeFile(this.file, JSON.stringify(payload, null, 2), 'utf8');
  }

  async clear() {
    await fsp.unlink(this.file).catch(() => {});
  }
}

module.exports = {
  joinCookies,
  pickNamed,
  hasAnyMark,
  hitMarks,
  latestExpiry,
  parseCookieString,
  authQueries,
  gatherAuthCookies,
  urlForCookie,
  removeAuthCookies,
  AuthStore,
};
