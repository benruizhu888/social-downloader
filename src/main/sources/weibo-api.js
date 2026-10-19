/**
 * 微博数据接口层
 *
 * 设计要点：
 * 1. fetch 可注入 —— Electron 中传入 session.fetch（自动携带登录 Cookie），
 *    脱离 Electron 环境时可注入 Node 原生 fetch 做单元测试。
 * 2. 媒体解析宽容 —— 微博不同版本/不同客户端发布的微博，字段结构差异很大，
 *    全部走多路径探测，绝不因单个字段缺失而崩掉整条微博。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const { describeNetworkError, isNetworkError, refererFor } = require('../core/net');
const { httpsUpgraded } = require('./parsers/util');
const { extFromUrl } = require('../core/ext');

/**
 * 单次请求的默认超时。
 *
 * 为什么必须有它（P1-1）：微博接口偶尔会「连上了但一个字节都不回」——
 * undici 的默认超时很长（分钟级），于是整个任务卡在第一个请求上，
 * 界面上「正在读取微博列表…」永远不结束，用户只能强杀。
 * 15 秒是实测下的平衡点：正常接口 200~800ms 返回，慢网也很少超过 3 秒。
 */
const DEFAULT_TIMEOUT_MS = 15000;

class WeiboError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WeiboError';
    this.code = code;
  }
}

class WeiboClient {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl 注入的 fetch 实现
   * @param {string}   [opts.cookie]  非 Electron 环境下手动附加的 Cookie
   */
  constructor({ fetchImpl, cookie = '', logger } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.cookie = cookie;
    this.logger = logger || (() => {});
    this.uidCache = new Map();
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  /**
   * 发一次 GET 并解析 JSON（带超时、可取消、有限重试）。
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {object}  [opts.headers]    额外请求头
   * @param {number}  [opts.retries=2]  网络类失败的额外重试次数
   * @param {number}  [opts.timeoutMs=15000] 单次请求的超时
   * @param {AbortSignal} [opts.signal] 外部取消信号（用户点了停止）
   */
  async requestJSON(url, { headers = {}, retries = 2, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    // Referer 统一过 refererFor：微软/新浪的接口都是 https，正常都会保留；
    // 万一被 302 到 http 端点，带 https 的 Referer 会被 Chromium 直接拦掉整个请求。
    const referer = refererFor(url, 'https://weibo.com/');
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 已经取消了就别再发请求（包括重试）
      if (signal?.aborted) throw abortError();

      /**
       * 每次尝试都用一个**新的** controller 与**独立**的计时器：
       *   · 复用同一个 controller 的话，第一次超时之后重试会立刻又被 abort；
       *   · 计时器如果跨尝试累计，重试越多次、可用时间越短，行为无法解释。
       */
      const ac = new AbortController();
      let timedOut = false;
      const onOuterAbort = () => ac.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            ...(referer ? { Referer: referer } : {}),
            'Accept-Language': 'zh-CN,zh;q=0.9',
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...headers,
          },
          credentials: 'include',
          signal: ac.signal,
        });
        const text = await res.text();
        if (res.status === 403 || text.includes('前方有点拥堵')) {
          throw new WeiboError('需要登录：请先在登录窗口登录微博', 'NEED_LOGIN');
        }
        if (!res.ok) throw new WeiboError(`HTTP ${res.status}`, 'HTTP');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new WeiboError('响应不是合法 JSON（可能已被重定向到登录页）', 'BAD_JSON');
        }
        return json;
      } catch (err) {
        /**
         * 取消与超时都要**立刻结束、且不重试**：
         *   · 取消：用户按了停止，再重试就是「停不下来」；
         *   · 超时：已经白等了 15 秒，重试 2 次就是 45 秒的空白界面。
         * 两者的文案必须能让人立刻知道发生了什么（前者是操作，后者是故障）。
         */
        if (signal?.aborted) throw abortError();
        if (timedOut) throw timeoutError(timeoutMs);
        // 网络层错误（ENOTFOUND / 连接超时 / 代理不通）在 undici 里只有一句
        // `fetch failed`，直接抛给界面等于什么都没说 —— 翻译成人话再抛。
        lastErr = isNetworkError(err) ? new WeiboError(describeNetworkError(err), 'NETWORK') : err;
        // 登录态问题不做重试，直接抛
        if (lastErr.code === 'NEED_LOGIN' || lastErr.code === 'BAD_JSON') throw lastErr;
        await sleep(600 * (attempt + 1));
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.('abort', onOuterAbort);
      }
    }
    throw lastErr;
  }

  /** 输入可以是：纯 uid / 主页 URL / 昵称 */
  async resolveUid(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new WeiboError('请输入博主主页链接、昵称或 UID', 'EMPTY');

    // 纯数字
    if (/^\d{5,15}$/.test(raw)) return raw;

    // 从 URL 中提取：weibo.com/u/1234567890  或  m.weibo.cn/u/1234567890
    const urlMatch = raw.match(/weibo\.(?:com|cn)\/(?:u\/)?(?:p\/)?(\d{5,15})/);
    if (urlMatch) return urlMatch[1];

    // 形如 https://weibo.com/n/昵称  中的 oid
    const oidMatch = raw.match(/[?&](?:oid|uid)=(\d{5,15})/);
    if (oidMatch) return oidMatch[1];

    if (this.uidCache.has(raw)) return this.uidCache.get(raw);

    // 否则当作昵称搜索
    const found = await this.searchUserByName(raw);
    if (!found) throw new WeiboError(`没找到昵称为「${raw}」的用户，建议直接粘贴主页链接`, 'NO_USER');
    this.uidCache.set(raw, found);
    return found;
  }

  async searchUserByName(name) {
    const url = `https://weibo.com/ajax/side/search?q=${encodeURIComponent(name)}`;
    try {
      const json = await this.requestJSON(url);
      const users = json?.data?.users || json?.users || [];
      if (users.length) return String(users[0].uid || users[0].id);
    } catch {
      /* 忽略，交给下面的兜底 */
    }
    // 兜底：m.weibo.cn 搜索接口
    const url2 = `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D3%26q%3D${encodeURIComponent(
      name
    )}&page_type=searchall`;
    try {
      const json2 = await this.requestJSON(url2);
      const cards = json2?.data?.cards || [];
      for (const card of cards) {
        const group = card.card_group || [];
        for (const item of group) {
          const u = item.user;
          if (u && (u.id || u.uid)) return String(u.id || u.uid);
        }
      }
    } catch {
      /* 忽略 */
    }
    return null;
  }

  /**
   * 分页抓取博主时间线微博
   * @param {string} uid
   * @param {object} opts
   * @param {number}  opts.maxPages  最多抓多少页（每页约 10 条）
   * @param {Function} opts.onPage   每页回调 (freshPosts, pageNo, rawData)
   * @param {AbortSignal} opts.signal
   */
  async fetchPosts(uid, { maxPages = 1000, onPage, signal } = {}) {
    const all = [];
    const seen = new Set(); // 接口重复返回很常见，按 id 去重是必要的兜底
    let page = 1; // 传给接口的 page 参数
    let sinceId = '';
    // 独立计数器：走 since_id 游标时 page 参数恒定不变，
    // 若用 page 判断上限，maxPages 会完全失效（永远满足 page <= maxPages）。
    let requests = 0;

    while (requests < maxPages) {
      if (signal?.aborted) break;
      // 关键：since_id 与 page 不可同时递增。两者一起变会让服务端反复吐同一批数据，
      // 因此一旦拿到 since_id 就固定 page=1，纯用游标翻页。
      const url = sinceId
        ? `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=1&feature=0&since_id=${sinceId}`
        : `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`;

      let json;
      try {
        // signal 必须透传：用户点停止时，正在进行的这一页请求要立刻断掉，
        // 而不是等它自己超时（否则「停止」按钮看起来要等十几秒才生效）。
        json = await this.requestJSON(url, { signal });
      } catch (err) {
        // 用户主动停止不算「读取异常」，原样抛给上层（runner 会按「已停止」收尾）
        if (err?.code === 'ABORTED') throw err;
        // 末尾分页常常报错，视为结束而不是失败
        if (requests > 0) {
          this.logger(`第 ${requests + 1} 页读取异常，视为已到末尾：${err.message}`);
          break;
        }
        throw err;
      }
      requests++;

      const list = json?.data?.list || [];
      if (!Array.isArray(list) || list.length === 0) break;

      const posts = list.map(parsePost).filter(Boolean);
      /**
       * 只把**真正新增**的推给 onPage。
       *
       * 微博接口会重复返回同一条（翻页边界、置顶微博），早先回调里写的是
       * `totalPosts += pagePosts.length`，于是界面上的「已读取 N 条」比真实条数多，
       * 与最后「共读取 X 条微博」对不上 —— 用户会以为中间丢了一批（P1-14 的一种）。
       */
      const freshPosts = [];
      for (const p of posts) {
        if (!p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        all.push(p);
        freshPosts.push(p);
      }
      onPage?.(freshPosts, requests, json?.data);

      // 整页都是已见过的 → 游标不再前进，直接收尾，避免死循环
      if (freshPosts.length === 0 && posts.length) {
        this.logger('本页内容均已抓取过，结束分页');
        break;
      }

      const nextSince = json?.data?.since_id;
      if (nextSince && nextSince !== sinceId) {
        sinceId = nextSince;
      } else {
        page++;
      }
      await sleep(350 + Math.random() * 400); // 温和限速，降低风控概率
    }

    if (requests >= maxPages) {
      this.logger(`已达到「最多 ${maxPages} 页」的限制，停止继续翻页`);
    }
    return all;
  }

  /** 单条微博详情（当列表页视频地址缺失时兜底） */
  async fetchPostDetail(id) {
    const url = `https://weibo.com/ajax/statuses/show?id=${id}&locale=zh-CN`;
    try {
      const json = await this.requestJSON(url, { retries: 1 });
      return json ? parsePost(json) : null;
    } catch {
      return null;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 「用户按了停止」—— 与故障区分开，界面按「已停止」而不是「失败」处理 */
function abortError() {
  return new WeiboError('已取消（任务被停止，未完成的请求不再继续）', 'ABORTED');
}

/** 「等太久」—— 文案里必须带秒数，否则用户不知道是不是卡死了 */
function timeoutError(timeoutMs) {
  return new WeiboError(
    `请求超时（${Math.round(timeoutMs / 1000)} 秒内没有拿到响应）：请检查网络或稍后重试`,
    'TIMEOUT'
  );
}

/* ------------------------------------------------------------------ */
/*                          媒体解析                                   */
/* ------------------------------------------------------------------ */

const VIDEO_KEYS = [
  'mp4_1080p_mp4',
  'mp4_hd_mp4',
  'mp4_720p_mp4',
  'hevc_mp4_hd',
  'hevc_mp4_720p',
  'mp4_ld_mp4',
  'mp4_sd_mp4',
  'stream_url_hd',
  'stream_url',
];

/**
 * 收集一条视频微博**所有**可用的地址，按画质从高到低。
 *
 * 为什么必须收成候选链、而不是只挑第一个：
 *   微博的视频地址是**带签名的**（`?Expires=…&ssig=…`），列表接口返回的那一份
 *   很可能在轮到自己下载时已经过期 —— 用户日志里的形态就是
 *   「189 个文件全部成功，只有 4 个视频 HTTP 403」。
 *   不同转码档（1080p / hd / 720p / ld / sd / HLS）的签名各自独立，
 *   一档 403 时换另一档往往还能拿到。
 *
 * 为什么每个地址还要配一个 https 升级版（本轮真机矩阵实测的第二个根因）：
 *   微博把视频地址给成 `http://f.video.weibocdn.com/...`，而它的 CDN 对
 *   **http 形态一律 403**（UA / Referer / Cookie 都不是变量，换 https 立刻 206）。
 *   同时 Chromium 对「http 目标 + https Referer」会整体拦掉请求，防盗链 Referer 带不上。
 *   所以候选链是「每个档位先给 https，再留原始 http 兜底」—— 先保传输成功，再保画质。
 */
function videoCandidates(pageInfo) {
  const pushRaw = (u) => {
    const n = normalizeUrl(typeof u === 'string' ? u : u?.url);
    return typeof n === 'string' && /^https?:/i.test(n) ? n : null;
  };
  // 地址可能出现的位置（实测不同版本各不一样，全都认）
  const sources = [pageInfo?.urls, pageInfo?.media_info?.urls, pageInfo?.media_info, pageInfo?.mediaInfo].filter(
    (o) => o && typeof o === 'object' && !Array.isArray(o)
  );
  const raw = [];
  for (const key of VIDEO_KEYS) {
    for (const src of sources) {
      const n = pushRaw(src[key]);
      if (n && !raw.includes(n)) raw.push(n);
    }
  }
  // 一个已知字段都没命中时才走递归兜底（它的启发式较松，只在没有更好选择时使用）
  if (!raw.length) {
    const d = pushRaw(deepFindVideo(pageInfo, 0));
    if (d) raw.push(d);
  }
  // 先排 https 组（同一档位升级后的地址），再排原始的明文 http 组 ——
  // 这样只要 https 能通，就绝不会在明文地址上浪费一次 403。
  // 而「签名过期」这类单档故障在 https 组内部就能换档解决。
  const secure = [];
  const plain = [];
  for (const u of raw) {
    const up = httpsUpgraded(u);
    if (up) {
      if (!secure.includes(up)) secure.push(up);
      if (!plain.includes(u)) plain.push(u);
    } else if (!secure.includes(u)) {
      secure.push(u); // 本来就是 https
    }
  }
  return [...secure, ...plain];
}

/** 从任意对象里递归找出第一个像视频地址的字符串 */
function deepFindVideo(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFindVideo(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      if (/\.mp4(\?|$)/.test(lower) || /video_.*\?|fid=/.test(lower)) return v;
      if (/^(stream_url|mp4_|play_url|video)/i.test(k) && v.startsWith('http')) return v;
    }
  }
  // 第二优先：对象里的 url 字段
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = deepFindVideo(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把新浪图床 URL 的尺寸段升级为原图。
 * 例：wx1.sinaimg.cn/large/xxx.jpg  →  wx1.sinaimg.cn/original/xxx.jpg
 *     wx1.sinaimg.cn/orj1080/xxx.jpg →  wx1.sinaimg.cn/original/xxx.jpg
 * 非新浪图床或已是原图时返回 null。
 */
const SINA_SEG =
  /^(?:thumbnail|thumb\d+|square|bmiddle|mw\d+|large|orj\d+|woriginal|worignal|wap\d+)$/i;

function toOriginalUrl(url) {
  const u = normalizeUrl(url);
  if (typeof u !== 'string' || !/sinaimg\.cn/i.test(u)) return null;
  const m = u.match(/(sinaimg\.cn)\/([^/?#]+)\//i);
  if (!m) return null;
  const seg = m[2];
  if (/^original$/i.test(seg)) return null; // 已是原图
  if (!SINA_SEG.test(seg)) return null; // 不是尺寸段，避免误替换
  return u.replace(`${m[1]}/${seg}/`, `${m[1]}/original/`);
}

/**
 * 完整候选链：尽量原图 → 字段里的 original → 常规最佳。
 * 下载器按顺序尝试，前一个不可用时自动回退。
 */
function pickImageCandidates(pic) {
  const out = [];
  const push = (u) => {
    const n = normalizeUrl(typeof u === 'string' ? u : u?.url);
    if (typeof n === 'string' && n.startsWith('http') && !out.includes(n)) out.push(n);
  };
  const best = pickBestImage(pic);
  if (best) {
    const upgraded = toOriginalUrl(best);
    if (upgraded) push(upgraded);
  }
  // 其余尺寸按从大到小全部纳入，保证原图拿不到时仍有多级兜底
  for (const key of ['original', 'largest', 'large', 'pic_big', 'bmiddle', 'pic']) {
    push(pic?.[key]);
  }
  if (best) push(best);
  return out;
}

/** 从 pic_info 里挑最大尺寸的原图 */
function pickBestImage(pic) {
  if (!pic || typeof pic !== 'object') return null;
  const order = ['original', 'largest', 'large', 'pic_big', 'bmiddle', 'pic'];
  for (const key of order) {
    const node = pic[key];
    // 先补全协议再校验，否则 //wx1.sinaimg.cn/... 这类地址会被误判为无效
    const url = normalizeUrl(typeof node === 'string' ? node : node?.url);
    if (url && typeof url === 'string' && url.startsWith('http')) return url;
  }
  // 有些版本直接把 url 放在 pic 上
  if (typeof pic.url === 'string' && normalizeUrl(pic.url).startsWith('http')) return normalizeUrl(pic.url);
  return null;
}

/** 判断一个 pic_info 是否为 Live Photo，并取出动态片段地址 */
function detectLivePhoto(pic) {
  if (!pic || typeof pic !== 'object') return null;
  const isLive =
    pic.type === 'livephoto' ||
    pic.type === 'live_photo' ||
    pic.live_photo === 1 ||
    !!pic.video ||
    !!pic.video_src ||
    (Array.isArray(pic.ext) && pic.ext.some?.((e) => e?.type === 'livephoto'));

  const candidates = [
    pic.video,
    pic.video_src,
    pic.videoSrc,
    pic.play_url,
    pic.playUrl,
    pic.live_video,
    deepFindVideo(pic, 0),
  ].filter((u) => typeof u === 'string' && u.startsWith('http'));

  const videoUrl = candidates[0] || null;
  if (!videoUrl) return null;

  return {
    videoUrl,
    isConfirmedLive: isLive || !!videoUrl, // 只要有独立视频片段就按 Live 处理
  };
}

/**
 * 把一条原始微博标准化为：
 * { id, mid, createdAt, text, picNum, medias: [ {kind, url, cover, pid, ext} ] }
 */
function parsePost(raw) {
  const mb = raw?.mblog || raw;
  if (!mb || typeof mb !== 'object') return null;

  const id = String(mb.id || mb.idstr || mb.mid || '');
  const createdAt = mb.created_at || '';
  const text = (mb.text_raw || mb.text || '').replace(/\s+/g, ' ').trim();
  const medias = [];

  // ---- 视频 ----
  const pageInfo = mb.page_info;
  if (pageInfo && (pageInfo.type === 'video' || pageInfo.media_info || pageInfo.urls)) {
    // 收成候选链（高清优先），下载器在 403/404 时会自动换下一档，见 videoCandidates 注释
    const chain = videoCandidates(pageInfo);
    if (chain.length) {
      medias.push({
        kind: 'video',
        url: chain[0],
        altUrls: chain.slice(1),
        cover: pageInfo.page_pic?.url || pageInfo.pic || null,
        pid: id,
        ext: extFromUrl(chain[0], 'mp4'),
      });
    }
  }

  // ---- 图片 / Live Photo ----
  const picInfos = mb.pic_infos;
  if (picInfos && typeof picInfos === 'object') {
    for (const [pid, pic] of Object.entries(picInfos)) {
      const live = detectLivePhoto(pic);
      const img = pickBestImage(pic);
      // Live Photo 与静态图互斥：实况图已通过 cover 携带静态帧，
      // 若再单独产出 image，会导致同一张图被下载两次。
      if (live?.videoUrl) {
        // 动态片段地址同样可能是明文 http —— 一视同仁升级，原始地址留作兜底
        const lv = normalizeUrl(live.videoUrl);
        const secure = httpsUpgraded(lv);
        medias.push({
          kind: 'livephoto',
          url: secure || lv,
          altUrls: secure ? [lv] : [],
          cover: img,
          coverCandidates: pickImageCandidates(pic),
          pid,
          ext: extFromUrl(secure || lv, 'mp4'),
        });
      } else if (img) {
        medias.push({
          kind: 'image',
          url: normalizeUrl(img),
          candidates: pickImageCandidates(pic),
          cover: null,
          pid,
          ext: extFromUrl(img, 'jpg'),
        });
      }
    }
  }

  // ---- 老格式 pics 数组兜底 ----
  if (medias.length === 0 && Array.isArray(mb.pics)) {
    for (const picRaw of mb.pics) {
      const pic = Array.isArray(picRaw) ? picRaw[0] : picRaw;
      const img = pickBestImage(pic);
      if (img) {
        medias.push({
          kind: 'image',
          url: normalizeUrl(img),
          candidates: pickImageCandidates(pic),
          cover: null,
          pid: pic?.pid || id,
          ext: extFromUrl(img, 'jpg'),
        });
      }
    }
  }

  return {
    id,
    mid: String(mb.mid || id),
    createdAt,
    text,
    picNum: mb.pic_num || medias.length,
    medias,
    // 转发微博：正文与图片实际属于原作者，仅原创模式下应排除
    isRetweet: !!mb.retweeted_status,
    // 作者 UID，用于确保抓到的确实是目标账号发布的内容
    authorUid: String(mb.user?.id || mb.user?.idstr || ''),
  };
}

function normalizeUrl(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

module.exports = {
  WeiboClient,
  WeiboError,
  parsePost,
  deepFindVideo,
  videoCandidates,
  pickBestImage,
  pickImageCandidates,
  toOriginalUrl,
  extFromUrl,
};
