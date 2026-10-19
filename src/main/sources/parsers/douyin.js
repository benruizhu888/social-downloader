/**
 * 抖音作品解析
 * 数据来源：页面自身请求的 /aweme/v1/web/aweme/post 响应（已被注入脚本截获）
 */
const { normalizeUrl, extFromUrl, deepFindVideo, deepFindImages, unique, mapItemsSafely, isoOrEmpty } = require('./util');

/**
 * 抖音图集的图片地址带"模板处理"段，形如：
 *   https://p3-sign.douyinpic.com/tos-cn-i-0813/oQEAxXXX~tplv-dy-aweme-images:q75.webp?x-signature=...
 * 把 `~tplv-...` 去掉一般就是原图。签名参数是否仍然有效由服务端决定，
 * 因此这里只是把原图放在候选链首位，失败会自动回退到原始地址。
 */
function toOriginalImageUrl(url) {
  const u = String(url || '');
  if (!u) return '';
  return u.replace(/~tplv-[^?#]*/i, '');
}

/** 图集里单张图的所有候选来源：原图 → 官方无水印地址 → 原样地址 */
function douyinImageCandidates(img) {
  if (!img) return [];
  const downloadList = Array.isArray(img.download_url_list) ? img.download_url_list : [];
  const base = unique(
    [img.url_list?.[0], ...downloadList, img.url].map((u) => normalizeUrl(typeof u === 'string' ? u : u?.url)).filter(Boolean)
  );
  return unique([...base.map(toOriginalImageUrl), ...base]).filter(Boolean);
}

/** 实况图：抖音图集里的图片可能自带一段动态片段 */
function douyinLiveVideoOf(img) {
  if (!img || typeof img !== 'object') return null;
  if (!img.video) return null;
  const v = img.video;
  const url =
    pickFromUrlList(v.play_addr) ||
    pickFromUrlList(v.play_addr_h264) ||
    pickFromUrlList(v.download_addr) ||
    deepFindVideo(v, 0);
  return url ? dewatermark(url) : null;
}

/** 递归捞出所有带 aweme_id 的节点，用于页面首屏直出数据的兜底解析 */
function deepCollectAwemes(obj, depth = 0, seen = new Set(), out = []) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (seen.has(obj)) return out;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) deepCollectAwemes(item, depth + 1, seen, out);
    return out;
  }

  if (obj.aweme_id || obj.awemeId) {
    out.push(obj);
    return out;
  }
  const info = obj.aweme_info;
  if (info && typeof info === 'object' && (info.aweme_id || info.awemeId)) {
    out.push(info);
    return out;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepCollectAwemes(v, depth + 1, seen, out);
  }
  return out;
}

/**
 * 抖音视频地址默认带水印（playwm），替换为 play 通常可得到无水印版本。
 * 拿不到也不影响下载，仅影响观感。
 */
function dewatermark(url) {
  return String(url)
    .replace(/\/playwm\//, '/play/')
    .replace(/(\/|&)playwm(?=\?|&|$)/, '$1play');
}

function pickFromUrlList(node) {
  if (!node) return null;
  if (typeof node === 'string') return normalizeUrl(node);
  const list = node.url_list || node.download_url_list || node.url;
  if (Array.isArray(list)) {
    for (const u of list) {
      const n = normalizeUrl(typeof u === 'string' ? u : u?.url);
      if (n) return n;
    }
  }
  return normalizeUrl(list);
}

function awemeToItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 直出数据里作品可能被包一层 aweme_info / aweme，摊平后再解析
  const nested = raw.aweme_info && typeof raw.aweme_info === 'object' ? raw.aweme_info : raw.aweme;
  const aw = nested && typeof nested === 'object' ? { ...raw, ...nested } : raw;
  const id = String(aw.aweme_id || aw.awemeId || aw.id || '');
  if (!id) return null;

  const medias = [];

  // 图集（含实况图）
  const images = aw.images || aw.image_list || aw.image_post_info?.images || [];
  if (Array.isArray(images) && images.length) {
    images.forEach((img, i) => {
      const candidates = douyinImageCandidates(img);
      if (!candidates.length) return;
      const liveUrl = douyinLiveVideoOf(img);
      if (liveUrl) {
        // 实况图：静态帧挂 cover，动态片段单独下载后转 MOV
        medias.push({
          kind: 'livephoto',
          url: liveUrl,
          cover: candidates[0],
          altUrls: candidates.slice(1),
          index: i + 1,
          ext: 'mp4',
        });
      } else {
        medias.push({
          kind: 'image',
          url: candidates[0],
          altUrls: candidates.slice(1),
          index: i + 1,
          ext: extFromUrl(candidates[0], 'jpg'),
        });
      }
    });
  }

  // 视频：优先无水印源，其次播放地址
  const v = aw.video || {};
  let videoUrl =
    pickFromUrlList(v.download_addr) ||
    pickFromUrlList(v.play_addr) ||
    pickFromUrlList(v.play_addr_h264) ||
    deepFindVideo(v, 0);
  if (videoUrl) videoUrl = dewatermark(videoUrl);
  if (videoUrl) {
    medias.push({
      kind: 'video',
      url: videoUrl,
      cover: pickFromUrlList(aw.video?.cover || aw.video?.origin_cover) || null,
      ext: 'mp4',
    });
  }

  // 兜底扫描
  if (medias.length === 0) {
    const found = deepFindImages(aw, 0).slice(0, 12);
    found.forEach((u, i) =>
      medias.push({ kind: 'image', url: u, altUrls: [], index: i + 1, ext: extFromUrl(u, 'jpg') })
    );
  }

  return {
    id,
    title: aw.desc || aw.item_title || '',
    /**
     * 发布时间：`create_time` 正常是秒级数字，但脏数据（`'刚刚'`、null、超大数）
     * 会让 `toISOString()` 抛 RangeError，进而把**整页**作品带崩（P1-5）。
     * 走 isoOrEmpty：非法就给空串，时间缺失不影响下载。
     */
    createdAt: aw.create_time ? isoOrEmpty(new Date(Number(aw.create_time) * 1000)) : '',
    author: aw.author?.nickname || '',
    /**
     * 作者的稳定标识（sec_uid 优先，其次 uid）。
     *
     * 为什么必须带出来：抖音「喜欢」列表走 `/aweme/v1/web/aweme/favorite`，
     * 返回体和「作品」一样是 `aweme_list`，**从数据结构上分不出是哪一路**。
     * 但「喜欢」里的东西绝大多数是**别人**的作品 —— 作者 id 就是在这里
     * 把「主页作品」和「点赞 / 推荐」区分开的唯一可靠依据（见 platforms/douyin.js）。
     */
    authorUid: String(aw.author?.sec_uid || aw.author?.uid || ''),
    likeCount: aw.statistics?.digg_count ?? null,
    medias,
  };
}

/**
 * 从截获的响应里提取作品列表（带解析统计）。
 *
 * 逐条 try/catch：一条脏数据只丢它自己。早先是 `list.map(awemeToItem).filter(Boolean)`，
 * 任何一条抛异常都会让整页变成「解析响应失败」，用户看到的是「作品凭空少了一半」。
 *
 * @param {object} data
 * @returns {{items: object[], skipped: number}}
 */
function parseDouyinResponseDetailed(data) {
  let list = data?.aweme_list || data?.data?.aweme_list;
  if (!Array.isArray(list)) {
    // 首屏直出 / 接口改版：结构未知时递归找
    list = deepCollectAwemes(data);
  }
  if (!Array.isArray(list)) return { items: [], skipped: 0 };
  return mapItemsSafely(list, awemeToItem);
}

function parseDouyinResponse(data) {
  return parseDouyinResponseDetailed(data).items;
}

function hasMore(data) {
  const d = data || {};
  return !!(d.has_more ?? d.hasMore);
}

module.exports = {
  parseDouyinResponse,
  parseDouyinResponseDetailed,
  awemeToItem,
  hasMore,
  dewatermark,
  deepCollectAwemes,
  toOriginalImageUrl,
  douyinImageCandidates,
  douyinLiveVideoOf,
};
