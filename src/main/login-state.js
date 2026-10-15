/**
 * 登录态验证记录
 *
 * 为什么需要这个模块 —— 实测得出的结论：
 *   微博     : SUB 只有真登录才有           → 看 Cookie 存在即可
 *   抖音     : ttwid / passport_csrf_token 在匿名访问 1.1 秒后就写入
 *   小红书   : web_session / webId / a1 在匿名访问 2.7 秒后就全部写入
 *
 * 所以「关键 Cookie 存在」根本不能证明已登录 —— 早期版本直接用它判定，
 * 结果一点「登录」按钮，匿名 Cookie 立刻出现，被误判成登录成功并自动关窗，
 * 用户看到的就是「闪退」。
 *
 * 解决办法：把「存在」升级为「我们亲眼看到它产生或变化」。
 *   1. 打开登录窗时不做任何判定，只监听 Cookie 变化
 *   2. 只有当某个关键 Cookie 的值相对已记录的值发生变化（新出现也算变化）时，
 *      才认定「这一次是用户主动登录产生的」，写入指纹并返回登录成功
 *   3. 之后 authStatus 用「Cookie 存在 && 指纹匹配」判定已登录
 *
 * 对匿名即有的 Cookie（小红书 web_session）来说，首次访问因为指纹为空所以不会误判；
 * 只有用户真的登录、服务端换发新 session 时才成立。
 *
 * 注意：对小红书 web_session 这类「匿名也会下发」的 Cookie，指纹法在**首次安装**时
 * 依然会把访客 Cookie 的第一次出现当成登录。所以主流程还叠了一层页面探针
 * （src/main/login-probe.js）：只有页面自己认为已登录时才会走到 record()。
 * 指纹在这里的职责是「登录之后别丢」，以及「换账号/失效后能回到未登录」。
 *
 * 失败方向是「宁可误报未登录」——用户会去点一次登录，而不会静默拿到错误数据。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * 记录格式版本。
 * v1 是「只看 Cookie 存在」时期的产物，那时访客 Cookie 也被写了指纹，
 * 升级后若不丢弃，老用户会一直显示「已登录」却下载不到数据。因此格式一变就整体作废。
 */
const FORMAT_VERSION = 2;

/**
 * 同一个 Cookie 名最多保留几个「已接受指纹」。
 *
 * 为什么不是只留最后一个 —— 微博登录暴露出来的真实缺陷：
 *   1. 同一个 `SUB` 会在多个域下各存一份实例（`.weibo.com` 与 host-only 的
 *      `passport.weibo.com`），取哪个实例的顺序并不稳定；
 *   2. SSO 流程会**先后下发多份** SUB（先中转值、后最终值）。
 * 只记一份就会「登录明明成功了，可状态一直显示未登录」。
 * 保留最近若干个指纹的并集，上面两种情况都能覆盖，同时换账号仍会被 detectChange 判为新值。
 */
const MAX_ACCEPTED = 6;

/** 兼容两种存储形态：v2 的单指纹字符串，以及多指纹数组 */
function normalizeAccepted(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x);
  if (typeof value === 'string' && value) return [value];
  return [];
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

class LoginState {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  async load() {
    if (this.data) return this.data;
    let parsed = null;
    try {
      parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== FORMAT_VERSION) {
      this.data = { v: FORMAT_VERSION };
    } else {
      this.data = parsed;
    }
    return this.data;
  }

  async _save() {
    this.data.v = FORMAT_VERSION;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }


  /** 取某平台已记录的指纹 { [cookieName]: string[] } */
  async recorded(platform) {
    const d = await this.load();
    return { ...(d[platform] || {}) };
  }

  /** 记录某个关键 Cookie 的指纹为「已验证」（保留最近若干个，见 MAX_ACCEPTED） */
  async record(platform, cookieName, value) {
    const d = await this.load();
    const cur = normalizeAccepted((d[platform] || {})[cookieName]);
    const fp = fingerprint(value);
    const next = [fp, ...cur.filter((x) => x !== fp)].slice(0, MAX_ACCEPTED);
    d[platform] = { ...(d[platform] || {}), [cookieName]: next };
    await this._save();
    return d[platform];
  }

  /**
   * 用当前 Cookie 集合判断是否已登录。
   *
   * 注意是「同名实例里**任意一个**命中已接受指纹即可」：
   * 微博的 SUB 在多个域下各有一份，只比对第一份会因为取值顺序不同而误判为未登录。
   *
   * @param {string} platform
   * @param {Array} cookies      当前分区的 Cookie
   * @param {string[]} marks     该平台的关键 Cookie 名
   * @returns {Promise<{loggedIn:boolean, marks:string[], detail:string}>}
   */
  async verify(platform, cookies, marks) {
    const rec = await this.recorded(platform);
    const hits = [];
    /** 关键 Cookie 在，但没被本应用目击过（或值已变）——最容易被误认为已登录的情形 */
    let unverified = false;
    for (const name of marks) {
      const list = cookies.filter((x) => x.name === name && x.value);
      if (!list.length) continue;
      const accepted = normalizeAccepted(rec[name]);
      if (list.some((c) => accepted.includes(fingerprint(c.value)))) hits.push(name);
      else unverified = true;
    }
    const loggedIn = hits.length > 0;
    return {
      loggedIn,
      marks: hits,
      detail: loggedIn
        ? `已验证：${hits.join('、')}`
        : unverified
          ? '检测到关键 Cookie，但未经过本应用登录验证（可能只是访客标识）'
          : '未登录',
    };
  }

  /**
   * 监听期判定：Cookie 发生变化且命中关键名 → 视为用户刚刚完成登录。
   *
   * 「之前见过」的值算「没变化」，因此重复上报同一个值不会反复触发登录；
   * 反过来，登录流程换发新值一定算变化 —— 这样第二份 SUB 也能被补记下来。
   *
   * @returns {Promise<{changed:boolean, name:string}>}
   */
  async detectChange(platform, cookie, marks) {
    if (!cookie?.value || !marks.includes(cookie.name)) return { changed: false, name: '' };
    const rec = await this.recorded(platform);
    const accepted = normalizeAccepted(rec[cookie.name]);
    if (accepted.includes(fingerprint(cookie.value))) return { changed: false, name: '' };
    await this.record(platform, cookie.name, cookie.value);
    return { changed: true, name: cookie.name };
  }

  /**
   * 带「信任关键 Cookie 存在」的验证。
   *
   * 微博这类平台的 SUB 不会匿名下发，存在即真登录，不需要指纹这一层。
   * 但首次遇到时指纹库是空的（从旧版本升级、指纹文件被清、或用户在别处登录过），
   * 直接 verify 会得到未登录 —— 这正是「登录成功了却一直显示未登录」的直接原因。
   * 所以这里补一道自愈：命中 trustPresence 且关键 Cookie 在，就地补记指纹再验一次。
   *
   * @param {boolean} trustPresence 平台能力位（微博 true；小红书/抖音必须 false）
   * @returns {Promise<{loggedIn:boolean, marks:string[], detail:string, backfilled:boolean}>}
   */
  async verifyOrTrust(platform, cookies, marks, trustPresence) {
    const first = await this.verify(platform, cookies, marks);
    if (first.loggedIn || !trustPresence) return { ...first, backfilled: false };

    const present = cookies.filter((c) => c.value && marks.includes(c.name));
    if (!present.length) return { ...first, backfilled: false };

    for (const c of present) await this.record(platform, c.name, c.value);
    const again = await this.verify(platform, cookies, marks);
    return { ...again, backfilled: true };
  }

  async clear(platform) {
    const d = await this.load();
    delete d[platform];
    await this._save();
  }
}

module.exports = { LoginState, fingerprint, FORMAT_VERSION };
