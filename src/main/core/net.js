/**
 * 统一的网络出口（三平台共用，不做任何平台分支）
 *
 * ── 为什么不能用 Node 自带的 `globalThis.fetch` ──────────────────────────────
 *
 * Node 的 fetch（undici）走的是 **Node 自己的 HTTP 栈**，与浏览器完全无关：
 *   ① **无视系统代理**。浏览器/加速器客户端设置的代理只对 Chromium 生效，
 *      undici 会直连 —— 需要走代理才通的环境里，它必然连不上。
 *   ② **没有 Happy Eyeballs**。Node 默认按 DNS 返回顺序连接（新版本还会优先 IPv6），
 *      IPv6 半通（Windows 上极常见：有 AAAA 记录但路由不通）时会老老实实等满
 *      连接超时；Chrome 是「IPv6/IPv4 并发起连、谁先通用谁」，几乎瞬间完成。
 *   ③ **不共享分区会话**。三个平台各自独立的分区（persist:weibo/xhs/douyin）
 *      在 Chromium 网络栈里带着 Cookie、TLS 会话票、证书例外、代理配置，
 *      undici 这些一样都没有。
 *
 * 症状非常典型：**内置浏览器能正常打开发作品页、能采到 35 个作品，
 * 一到下载/接口直连就整片 `fetch failed`**（用户第 15 轮的日志就是这个形态）。
 * 而且 `fetch failed` 是 undici 的通用壳，真实原因（ENOTFOUND / ECONNREFUSED /
 * 连接超时）全埋在 `err.cause` 里，用户与我都看不到 —— 所以这里同时给出人话翻译。
 *
 * Electron 的 `ses.fetch` / `net.fetch` 走的是 **Chromium 网络栈**，
 * 上面三条全部天然与浏览器一致，因此下载与接口直连统一改用它。
 *
 * ⚠️ 换过来之后又冒出一个只有 Chromium 栈才有的硬失败：
 *    **目标是 `http://` 而 `Referer` 是 `https://` 时，整个请求会被拦成
 *    `net::ERR_BLOCKED_BY_CLIENT`**（不是丢掉这个头，是请求根本没发出去）。
 *    所以下载器必须过一遍 `refererFor()`。实测矩阵见 `refererFor` 的注释。
 *
 * ⚠️ 本文件**不得** require('electron')：它要被纯 Node 的单元测试直接引用，
 *    所以 session 一律由调用方作为参数传进来。
 */

/**
 * 把「Node/undici 的错误码」翻译成人话。
 * 这些码都在 `err.cause.code` 上，`err.message` 永远只有一句 `fetch failed`。
 */
const NODE_NET_CODES = {
  ENOTFOUND: '域名解析失败（DNS 查不到该主机）',
  EAI_AGAIN: '域名解析超时（DNS 暂时查不到）',
  ECONNREFUSED: '连接被拒绝（对端未监听，或被防火墙/代理拦截）',
  ECONNRESET: '连接被重置（对端主动断开）',
  ECONNABORTED: '连接被中断',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENETDOWN: '网络未启用',
  ETIMEDOUT: '连接超时',
  EPIPE: '连接被提前关闭',
  EACCES: '连接被本机策略拒绝',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（迟迟连不上）',
  UND_ERR_HEADERS_TIMEOUT: '读取响应超时（已连上但迟迟没有回数据）',
  UND_ERR_BODY_TIMEOUT: '读取响应体超时',
  UND_ERR_SOCKET: '连接被提前关闭',
  UND_ERR_ABORTED: '请求已被取消',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链无法校验',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书校验失败',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书与域名不匹配',
};

/** Chromium 网络栈的写法（`net::ERR_xxx`），ses.fetch 出错时就是这一族 */
const CHROMIUM_NET_CODES = {
  'net::ERR_NAME_NOT_RESOLVED': '域名解析失败（DNS 查不到该主机）',
  'net::ERR_NAME_RESOLUTION_FAILED': '域名解析失败（DNS 查不到该主机）',
  'net::ERR_INTERNET_DISCONNECTED': '系统报告无网络连接',
  'net::ERR_CONNECTION_REFUSED': '连接被拒绝（对端未监听，或被防火墙/代理拦截）',
  'net::ERR_CONNECTION_TIMED_OUT': '连接超时',
  'net::ERR_CONNECTION_RESET': '连接被重置（对端主动断开）',
  'net::ERR_CONNECTION_CLOSED': '连接被对端关闭',
  'net::ERR_CONNECTION_ABORTED': '连接被中断',
  'net::ERR_CONNECTION_FAILED': '连接失败',
  'net::ERR_ADDRESS_UNREACHABLE': '地址不可达',
  'net::ERR_NETWORK_CHANGED': '网络已切换（请重试）',
  'net::ERR_PROXY_CONNECTION_FAILED': '代理服务器连不上（请检查加速器/代理是否在运行）',
  'net::ERR_TUNNEL_CONNECTION_FAILED': '代理隧道建立失败（请检查代理规则）',
  'net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED': '无法获取代理配置',
  'net::ERR_CERT_DATE_INVALID': '证书已过期或系统时间不正确',
  'net::ERR_CERT_AUTHORITY_INVALID': '证书不受信任',
  'net::ERR_CERT_COMMON_NAME_INVALID': '证书与域名不匹配',
  'net::ERR_SSL_PROTOCOL_ERROR': 'TLS 握手失败',
  'net::ERR_EMPTY_RESPONSE': '对端没有返回任何数据',
  'net::ERR_TOO_MANY_REDIRECTS': '重定向次数过多',
  'net::ERR_BLOCKED_BY_CLIENT': '请求被网络栈直接拦下（不支持的请求头组合，或本地拦截规则）',
  'net::ERR_TIMED_OUT': '请求超时',
};

/**
 * 沿 cause 链找到第一个带 code 的那一层。
 * undici 把真相放在 cause 里，Electron/Chromium 则直接把 `net::ERR_…`
 * 写在 message（新的 Electron 版本也会塞进 cause.code）。
 */
function causeOf(err) {
  let cur = err;
  const seen = new Set();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (cur.code) return cur;
    cur = cur.cause;
  }
  return err;
}

/** 从错误里抠出一个可用于翻译的 code（Node 的或 Chromium 的） */
function netCodeOf(err) {
  const c = causeOf(err) || {};
  const raw = String(c.code || c.errno || '');
  if (raw) return raw;
  const m = String((err && err.message) || '').match(/net::ERR_[A-Z_]+/);
  return m ? m[0] : '';
}

/** 这条错误是不是「网络层没通」（而不是 404 / 登录态之类） */
function isNetworkError(err) {
  if (!err) return false;
  const code = netCodeOf(err);
  if (code && (NODE_NET_CODES[code] || CHROMIUM_NET_CODES[code])) return true;
  const msg = String(err.message || '');
  return /fetch failed|Failed to fetch|NetworkError|net::ERR_/i.test(msg);
}

/**
 * 这些错误与「本机能不能连出去」无关，就别再让用户去查代理了 ——
 * 那会把排查方向带偏（例如 `ERR_BLOCKED_BY_CLIENT` 其实是请求头组合不对）。
 */
const NO_PROXY_HINT = new Set([
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_RESPONSE',
  'net::ERR_TOO_MANY_REDIRECTS',
  'net::ERR_EMPTY_RESPONSE',
]);

/**
 * 把错误变成一句人能看懂、且能据此行动的话。
 * 非网络错误原样返回 `err.message`（例如「HTTP 403」），不改变原有语义。
 */
function describeNetworkError(err) {
  if (!err) return '未知错误';
  const code = netCodeOf(err);
  const human = NODE_NET_CODES[code] || CHROMIUM_NET_CODES[code];
  if (human) {
    const hint = NO_PROXY_HINT.has(code)
      ? ''
      : '；若浏览器能打开该网站，请检查系统的代理 / 加速器 / 防火墙设置';
    return `${human}（${code}）${hint}`;
  }
  const msg = String(err.message || '').trim();
  if (!msg || msg === 'fetch failed') return `网络请求失败${code ? `（${code}）` : ''}`;
  return msg;
}

/**
 * 取一个走 Chromium 网络栈的 fetch。
 *
 * @param {object} [ses] Electron 的 Session（`session.fromPartition(...)`）。
 *                       传空时退回 Node 的全局 fetch —— 这条退路只给纯 Node 单元测试用，
 *                       真机上一定有 session，绝不会静默退回 Node 栈再犯同样的错。
 */
function sessionFetch(ses) {
  if (ses && typeof ses.fetch === 'function') {
    const bound = ses.fetch.bind(ses);
    // 用包装函数而不是直接返回 bound：调用方可能把返回值当普通函数再 bind / 传参，
    // 包装后行为与全局 fetch 完全一致（两个参数），不会踩到 this 绑定的坑。
    return (input, init) => bound(input, init);
  }
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  throw new Error('当前环境没有任何可用的 fetch 实现');
}

/**
 * 在某个 fetch 之上加一层 Cookie 注入（接口直连型平台用，例如微博）。
 *
 * 注意：Chromium 的请求本身也会带上该分区的 Cookie，这里显式加一份是为了
 * 兼容「手动粘贴 Cookie」这条兜底路径（Cookie 可能还没落到分区里）。
 * Cookie 头若被网络栈忽略也不会更糟 —— 分区里那份仍然生效。
 *
 * （实测：`Cookie` 头在 Chromium 栈里能正常送达，`Referer` 则有一个致命组合，见下。）
 *
 * @param {Function} base    底层 fetch
 * @param {Function} getCookie 每次调用时现取 Cookie，这样登录态刷新后不必重建
 */
function withCookie(base, getCookie) {
  return (input, init = {}) => {
    const cookie = typeof getCookie === 'function' ? getCookie() : '';
    if (!cookie) return base(input, init);
    return base(input, {
      ...init,
      headers: { ...(init.headers || {}), Cookie: cookie },
    });
  };
}

/**
 * 计算该不该在请求头里带 `Referer`。
 *
 * 实测（真实 Electron 28 + 本地 TLS 服务器，7 组组合）：
 *
 * | 目标 | Referer | 结果 |
 * | --- | --- | --- |
 * | https | https 跨源（`https://weibo.com/`） | ✅ 送达 |
 * | https | 同源 | ✅ 送达 |
 * | https | http 跨源 | ✅ 送达（升级不算降级） |
 * | http  | http 跨源 | ✅ 送达 |
 * | **http** | **https 跨源** | ❌ **`net::ERR_BLOCKED_BY_CLIENT`** |
 * | https | 不带 | ✅ 但服务端收到空 |
 *
 * 也就是说只有「**明文目标 + 加密 Referer**」这一种组合会出事，而且是**整个请求被拦掉**，
 * 不是「悄悄丢掉这个头」—— 下载会直接失败。所以遇到这种组合宁可不要 Referer：
 * 少一个头最多让对方多校验一次，比整个请求发不出去强得多。
 *
 * 另外两个结论（别走弯路）：
 * - `session.webRequest.onBeforeSendHeaders` 里**改不动 Referer**（实测注入后服务端仍收到空），
 *   所以不要试图用 webRequest 来补 Referer。
 * - 微博图床是 https，配上 `https://weibo.com/` 的 Referer 正落在 ✅ 那一行 —— 生产路径没问题。
 */
function refererFor(url, referer) {
  if (!referer) return '';
  try {
    const target = new URL(url);
    const ref = new URL(referer);
    if (target.protocol === 'http:' && ref.protocol === 'https:') return '';
  } catch {
    /* 地址不合法时不做这层判断，交给底层报错 */
  }
  return referer;
}

module.exports = {
  sessionFetch,
  withCookie,
  refererFor,
  describeNetworkError,
  isNetworkError,
  netCodeOf,
  NODE_NET_CODES,
  CHROMIUM_NET_CODES,
};
