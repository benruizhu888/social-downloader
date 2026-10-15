/**
 * 页面登录态探针
 *
 * 为什么不能只看 Cookie —— 实测（test/probe-login.js）得出的结论：
 *   抖音    匿名访问 douyin.com 后 1.1 秒写入 ttwid，8.9 秒写入 passport_csrf_token
 *   小红书  匿名访问 /explore 后 2.7 秒写入 web_session / webId / a1
 *   微博    SUB 只有真登录才有
 *
 * 也就是说小红书和抖音的「关键 Cookie」在访客状态下同样会下发。
 * 只看 Cookie 存在 → 一点「登录」按钮，窗口两秒内自动关闭，用户看到的就是「闪退」；
 * 只看 Cookie 指纹变化 → 首次安装时访客 Cookie 第一次出现，同样被误判成登录成功。
 *
 * 所以对这两家必须以「页面自己认为已登录」为唯一依据：
 *   小红书  window.__INITIAL_STATE__.user.loginInfo.secretKey / localStorage.xhs_secret_key / 侧栏「我」入口
 *   抖音    localStorage.HasUserLogin === '1' / window.LOGIN_STATUS === '1' / 已登录头像入口
 *
 * 本模块刻意拆成两半，保证可单测：
 *   collectScript(id)  —— 页面内执行的采集脚本，只取事实，不做判断
 *   decision(id, snap) —— 纯函数，按事实下结论
 * 两者都不依赖 Electron；真正执行脚本的动作放在 main.js。
 */

/** 小红书：只采集事实 */
const XHS_COLLECT = `(() => {
  const ls = {};
  for (const k of ['xhs_secret_key', 'web_session']) {
    try { ls[k] = localStorage.getItem(k) || ''; } catch (e) { ls[k] = ''; }
  }
  let secretKey = '';
  let stateUserId = '';
  try {
    const u = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user;
    if (u) {
      if (u.loginInfo) secretKey = String(u.loginInfo.secretKey || '');
      if (u.userPageData && u.userPageData.basicInfo) stateUserId = String(u.userPageData.basicInfo.userId || '');
      if (!stateUserId && u.loginInfo) stateUserId = String(u.loginInfo.userId || '');
    }
  } catch (e) { /* 状态结构变了就当取不到 */ }
  // 侧栏「我」入口：链接指向 /user/profile/ 且内部有一段文字正好是「我」。
  // 未登录时侧栏是「登录」按钮，不会命中；探索页里别人的头像链接也不会命中（那段文字不是「我」）。
  let meLink = false;
  try {
    const links = document.querySelectorAll('a[href*="/user/profile/"]');
    for (const a of links) {
      const parts = a.querySelectorAll('span,div,p,b,em');
      for (const el of parts) {
        if ((el.textContent || '').trim() === '我') { meLink = true; break; }
      }
      if (meLink) break;
    }
  } catch (e) { /* 忽略 */ }
  return { origin: location.origin, href: location.href, secretKey: secretKey, stateUserId: stateUserId, ls: ls, meLink: meLink };
})()`;

/** 抖音：只采集事实 */
const DOUYIN_COLLECT = `(() => {
  const ls = {};
  for (const k of ['HasUserLogin', 'user_id', 'user_unique_id']) {
    try { ls[k] = localStorage.getItem(k) || ''; } catch (e) { ls[k] = ''; }
  }
  let loginStatus = '';
  try { loginStatus = String(window.LOGIN_STATUS || ''); } catch (e) { /* 忽略 */ }
  let avatar = false;
  let loginBtn = false;
  try {
    avatar = !!document.querySelector('[data-e2e="user-avatar"],[data-e2e="user-info"],[data-e2e="user-info-card"]');
  } catch (e) { /* 忽略 */ }
  try {
    loginBtn = !!document.querySelector('[data-e2e="login-button"],[data-e2e="login-and-register-button"]');
  } catch (e) { /* 忽略 */ }
  return { origin: location.origin, href: location.href, ls: ls, loginStatus: loginStatus, avatar: avatar, loginBtn: loginBtn };
})()`;

const SCRIPTS = { xhs: XHS_COLLECT, douyin: DOUYIN_COLLECT };

/** 该平台是否支持页面探针（微博靠 SUB 出现即真登录，不需要） */
function hasProbe(platformId) {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, platformId);
}

function collectScript(platformId) {
  return SCRIPTS[platformId] || null;
}

const OK = (detail) => ({ loggedIn: true, detail });
const NO = (detail) => ({ loggedIn: false, detail });

function originHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return String(origin || '').toLowerCase();
  }
}

/**
 * 探针只在「主站」上有意义。
 *
 * 登录过程可能把顶层导航到 passport / sso 子域，那边是另一套 localStorage，
 * 读不到标志纯属正常，不能当成「没登录」下结论 —— 所以这里只认主站域名，
 * 其余一律返回「暂不判定」，由调用方继续轮询等待页面回到主站。
 *
 * 注意不能写成 /(^|\.)xiaohongshu\.com$/ —— 那会把 passport 子域也算作主站。
 */
function isMainHost(host, apex) {
  return host === apex || host === 'www.' + apex;
}

/**
 * 小红书判定。
 */
function xhsDecision(snap) {
  if (!snap || !snap.origin) return NO('页面状态读取失败');
  const host = originHost(snap.origin);
  if (!isMainHost(host, 'xiaohongshu.com')) {
    return NO(`当前页面不在小红书主站（${host}），暂不判定`);
  }
  if (snap.secretKey) return OK('页面登录态 secretKey 非空');
  if (snap.stateUserId) return OK('页面登录态已带上用户 ID');
  if (snap.ls && snap.ls.xhs_secret_key) return OK('localStorage.xhs_secret_key 非空');
  if (snap.meLink) return OK('侧栏出现「我」的个人主页入口');
  return NO('页面仍处于访客态（无 secretKey、无 xhs_secret_key、无「我」入口）');
}

/**
 * 抖音判定。
 *
 * 刻意把游客标识（ttwid / passport_csrf_token）排除在外 —— 它们进不了这里的任何分支。
 */
function douyinDecision(snap) {
  if (!snap || !snap.origin) return NO('页面状态读取失败');
  const host = originHost(snap.origin);
  if (!isMainHost(host, 'douyin.com')) {
    return NO(`当前页面不在抖音主站（${host}），暂不判定`);
  }
  if (snap.ls && snap.ls.HasUserLogin === '1') return OK('localStorage.HasUserLogin = 1');
  if (snap.loginStatus === '1') return OK('window.LOGIN_STATUS = 1');
  if (snap.avatar) return OK('页面出现已登录头像入口');
  if (snap.loginBtn) return NO('页面仍显示「登录」按钮（访客态）');
  return NO('页面仍处于访客态（HasUserLogin 非 1、无已登录头像）');
}

const DECISIONS = { xhs: xhsDecision, douyin: douyinDecision };

function decision(platformId, snap) {
  const fn = DECISIONS[platformId];
  if (!fn) return NO('该平台不支持页面探针');
  try {
    return fn(snap);
  } catch (err) {
    return NO(`页面状态解析失败：${err.message}`);
  }
}

/**
 * 登录闸门 —— 把「探针结果 → 该做什么」这段状态机单独抽出来，离线可测。
 *
 * 为什么需要状态机而不是简单地「探针说已登录就关窗」：
 *   用户点「登录」有两种完全不同的动机 ——
 *     ① 我刚在页面上完成登录 → 应该记指纹 + 自动关窗
 *     ② 我本来就是登录状态，只是想换账号 → **绝不能自动关窗**，
 *        否则就是又一次「刚点开就没了」，与用户报的「闪退」体感一模一样
 *   区分依据只有一个：**开窗后的第一次探针结果**。
 *   第一次就是已登录 → 情形②；第一次是访客、之后变成已登录 → 情形①。
 *
 * next(probe) 返回的动作：
 *   'wait'              —— 继续等待，什么都不做
 *   'already-logged-in' —— 情形②：记指纹 + 提示，但保持窗口打开
 *   'just-logged-in'    —— 情形①：记指纹 + 提示 + 关窗
 */
function createLoginGate() {
  let firstDone = false;
  let atOpen = false;
  return {
    /** 开窗时页面就已经是登录态 */
    get loggedInAtOpen() {
      return atOpen;
    },
    /** 是否已经拿到过第一次结果 */
    get settled() {
      return firstDone;
    },
    next(probe) {
      const loggedIn = !!(probe && probe.loggedIn);
      if (!firstDone) {
        firstDone = true;
        if (loggedIn) {
          atOpen = true;
          return 'already-logged-in';
        }
        return 'wait';
      }
      if (!loggedIn) return 'wait';
      if (atOpen) return 'wait'; // 情形②的用户永远不会被我们自动关窗
      return 'just-logged-in';
    },
  };
}

module.exports = {
  hasProbe,
  collectScript,
  decision,
  createLoginGate,
  xhsDecision,
  douyinDecision,
  XHS_COLLECT,
  DOUYIN_COLLECT,
};
