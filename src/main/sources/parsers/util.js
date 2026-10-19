/** 解析层公共工具：两家平台字段结构都不稳定，一律走多路径 + 递归兜底 */

/**
 * 扩展名判定统一走 `core/ext.js`（本轮把仓库里三份彼此不一致的实现合成一份）。
 * 这里保留同名导出，是为了让 xhs/douyin 的调用点一行都不用改。
 */
const { extFromUrl } = require('../../core/ext');

/**
 * 小红书视频流的 master_url 经常是 base64 编码的（形如 aHR0cDovL3Nuc3ZpZGVv...），
 * 直接当 URL 用会 404。这里做一次「看起来像 base64 且解码后是 http 链接」的还原。
 */
function decodeMaybeBase64(u) {
  if (typeof u !== 'string') return u;
  if (/^https?:/i.test(u)) return u;
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(u)) {
    try {
      const dec = Buffer.from(u, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(dec)) return dec;
    } catch {
      /* 解码失败就按原样处理 */
    }
  }
  return u;
}

function normalizeUrl(u) {
  const s = decodeMaybeBase64(u);
  if (typeof s !== 'string') return null;
  if (s.startsWith('//')) return 'https:' + s;
  return s.startsWith('http') ? s : null;
}

/** 取数组中第一个合法 URL */
function firstUrl(list) {
  if (Array.isArray(list)) {
    for (const item of list) {
      const u = normalizeUrl(typeof item === 'string' ? item : item?.url);
      if (u) return u;
    }
  }
  return null;
}

/** 递归找视频地址：优先 master_url / play_addr 等已知字段，再扫 mp4 */
function deepFindVideo(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 7) return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFindVideo(item, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  // 已知字段优先
  for (const key of ['master_url', 'backup_url_1', 'play_addr', 'download_addr', 'url', 'play_url', 'video_url']) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (typeof v === 'string') {
      const u = normalizeUrl(v);
      if (u && /(\.mp4|video_id=|play|stream)/i.test(u)) return u;
    }
    if (v && typeof v === 'object') {
      const hit = firstUrl(v.url_list) || deepFindVideo(v, depth + 1, seen);
      if (hit) return hit;
    }
  }

  // 兜底扫描
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const u = normalizeUrl(v);
      if (u && /\.mp4(\?|$)|video_id=/.test(u.toLowerCase())) return u;
      if (/^(stream|h264|h265|play_addr|download_addr)$/i.test(k) && u) return u;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = deepFindVideo(v, depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/** 递归找图片数组里的最佳 URL */
function deepFindImages(obj, depth = 0, seen = new Set(), out = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  if (seen.has(obj)) return out;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) deepFindImages(item, depth + 1, seen, out);
    return out;
  }
  for (const key of ['url_default', 'url_pre', 'url', 'origin_url']) {
    const v = obj[key];
    const u = normalizeUrl(typeof v === 'string' ? v : (Array.isArray(v) ? v[0] : null));
    // 只收图片，视频交给 deepFindVideo
    if (u && /\.(jpg|jpeg|png|webp|heic|gif)(\?|$)/i.test(u)) {
      if (!out.includes(u)) out.push(u);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFindImages(v, depth + 1, seen, out);
  }
  return out;
}

/** 去重并保序 */
function unique(arr) {
  const out = [];
  for (const x of arr) {
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * 逐条解析：**一条脏数据只丢它自己**，不能连累整页。
 *
 * 复现的缺陷（P1-5）：`parseXhsResponse` 早先是 `notes.map(noteToItem).filter(Boolean)`。
 * 只要有一条作品的字段长得奇怪（实测最典型的是 `time` 是 `'今天'` 这种非数字，
 * `new Date(Number(...)).toISOString()` 直接抛 `RangeError: Invalid time value`），
 * 整个 `map` 就炸掉 —— 上层 `ingest` 的 catch 把**整页**当失败丢掉，
 * 日志只留一句「解析响应失败」。表现就是「明明有 20 篇，只下到 3 篇」。
 *
 * 语义约定：
 *   · `mapFn` 返回假值 → 计入 skipped（结构不完整，本来就不该产出作品）
 *   · `mapFn` 抛异常   → 计入 skipped，并通过 `onSkip(err, raw)` 回调报告
 * 两个计数合并成一个 `skipped`，因为对用户来说它们是同一件事：「这几条没解析出来」。
 *
 * @param {Array} list 原始数组（接口响应里的作品列表）
 * @param {Function} mapFn (raw) => item|null
 * @param {Function} [onSkip] (err, raw) => void
 * @returns {{items: Array, skipped: number}}
 */
function mapItemsSafely(list, mapFn, onSkip) {
  const items = [];
  let skipped = 0;
  if (!Array.isArray(list)) return { items, skipped };
  for (const raw of list) {
    try {
      const it = mapFn(raw);
      if (it) items.push(it);
      else skipped++;
    } catch (err) {
      skipped++;
      if (typeof onSkip === 'function') {
        try {
          onSkip(err, raw);
        } catch {
          /* 报告失败不能再把解析带崩 */
        }
      }
    }
  }
  return { items, skipped };
}

/**
 * 明文 http 的媒体地址升级成 https。
 *
 * 为什么必须有它（第 16 轮真机矩阵实测，微博视频 403 的真正根因）：
 *   微博接口把视频地址给成 `http://f.video.weibocdn.com/...`，而它的 CDN 对
 *   **http 形态一律 403** —— 与 UA / Referer / Cookie 全都无关，
 *   同一串地址把 `http:` 换成 `https:` 立刻 206，内容是真 MP4。
 *   雪上加霜的是：Chromium 网络栈对「http 目标 + https Referer」会**整体拦掉**整个请求
 *   （`net::ERR_BLOCKED_BY_CLIENT`），于是防盗链 Referer 又带不上 —— 明文地址就是死路。
 *
 * 返回 null 表示无需升级（本来就是 https，或不是明文 http）。
 * 调用方应把「升级版」放在候选链首项、并把原始地址留作兜底 —— 万一某个源没配 https，也不会更糟。
 */
function httpsUpgraded(u) {
  if (typeof u !== 'string' || !/^http:\/\//i.test(u)) return null;
  return 'https://' + u.slice(7);
}

module.exports = {
  normalizeUrl,
  extFromUrl,
  firstUrl,
  deepFindVideo,
  deepFindImages,
  decodeMaybeBase64,
  unique,
  httpsUpgraded,
  mapItemsSafely,
  /** 把任意日期输入变成 ISO 串；非法时返回 ''（绝不让 RangeError 冲出去） */
  isoOrEmpty,
};

/**
 * `new Date(x).toISOString()` 的安全版本。
 *
 * 为什么要单独一个函数：`toISOString()` 对 Invalid Date 会抛 `RangeError`，
 * 而作品时间来自平台数据（可能是 `'今天'`、`''`、`0`、超大数），一律不可信。
 * 报错位置在解析循环深处，一次抛出就是**整页丢失**（见 mapItemsSafely 的注释）。
 *
 * @param {Date} d
 * @returns {string} ISO 字符串，非法时为空串
 */
function isoOrEmpty(d) {
  if (!d || typeof d.toISOString !== 'function') return '';
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}
