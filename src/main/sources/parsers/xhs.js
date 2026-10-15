/**
 * 小红书作品解析
 * 数据来源：页面自身请求的 /api/sns/web/v1/user_posted 响应（已被注入脚本截获）
 *
 * 媒体类型：
 *   image     —— 普通图片
 *   video     —— 视频笔记
 *   livephoto —— 图集里的实况图（图片本身带一段独立动态片段）
 */
const { normalizeUrl, extFromUrl, deepFindVideo, deepFindImages, unique } = require('./util');

// 判定"这是个作品"的强特征：小红书作品必然带图集或视频。
// ⚠️ 必须同时认驼峰与下划线两种写法：
//    接口响应里是 `noteCard`，而**首屏直出/前端 store 里是 `note_card`**。
//    早先只写了 `noteCard`，导致从首屏直出数据里一条作品都识别不出来。
const NOTE_HINT = [
  'image_list',
  'images',
  'imageList',
  'images_list',
  'video',
  'noteCard',
  'note_card',
];

/** 递归捞出所有像作品的节点，用于页面首屏直出数据的兜底解析 */
function deepCollectNotes(obj, depth = 0, seen = new Set(), out = []) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (seen.has(obj)) return out;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) deepCollectNotes(item, depth + 1, seen, out);
    return out;
  }

  const id = obj.note_id || obj.noteId || obj.id;
  if (id && NOTE_HINT.some((k) => k in obj)) {
    out.push(obj);
    return out; // 已识别为作品，不再往里钻，避免把子字段也当成作品
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepCollectNotes(v, depth + 1, seen, out);
  }
  return out;
}

/**
 * 小红书图片 URL 带有「经过处理」的标记，去掉才是原图：
 *   1. `!nd_dft_wlteh_webp_3` / `!nd_prv_wlteh_webp_3` 之类的后缀（webp + 默认/预览尺寸）
 *   2. `?imageView2/2/w/1080/format/jpg` 之类的缩放/转码参数
 *
 * ⚠️ 两步的顺序**不能反** —— 这是本轮查出来的一个真实缺陷：
 *   形如 `…/abc!nd_dft_wlteh_webp_3?imageView2/2/w/1080/format/jpg` 的地址，
 *   若先删后缀再删参数：第一次匹配因为后缀后面还跟着 `?…` 而落空
 *   （`![^/?#]*$` 要求 `!` 段一直顶到字符串结尾），
 *   第二次只删掉了参数，最终留下 `…/abc!nd_dft_wlteh_webp_3` ——
 *   也就是**仍然带着处理标记**的地址，CDN 照样返回压过的 webp，
 *   用户勾了「下载原图」却拿到压缩图，而且完全看不出来为什么。
 *   所以正确顺序是：先摘查询串，再摘后缀（此时后缀必然在末尾）。
 */
function toOriginalUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';

  // 先把「路径」与「查询/片段」切开分别处理，而不是对整串做两次正则替换 ——
  // 那样写会踩到顺序坑（见上面的注释），而且处理不了「后缀后面还跟着签名参数」的形态。
  const cut = u.search(/[?#]/);
  const head = cut < 0 ? u : u.slice(0, cut);
  const tail = cut < 0 ? '' : u.slice(cut);

  const cleanHead = head.replace(/![^/?#]*$/, ''); // 摘掉结尾的 `!处理标记`
  const cleanTail = isProcessingQuery(tail) ? '' : tail; // 只丢处理参数，签名参数保留
  return cleanHead + cleanTail;
}

/**
 * 判断查询串是不是「图片处理指令」。
 *
 * 为什么不能见到 `?` 就删：处理参数（imageView2 / imageMogr2 / image_process…）
 * 只是让 CDN 现算一张缩略图，删掉即得原图；而签名类参数（x-signature、sign…）
 * 一旦误删，原图请求会直接 403 —— 那才是真的「下不到原图」。
 * 所以只有确认整段查询以处理指令开头时才丢。
 */
function isProcessingQuery(tail) {
  return /^[?#](?:imageView2|imageView|imageMogr2|image_process|thumbnail|watermark)/i.test(tail);
}

/**
 * 从 `info_list` / `infoList` 里按「图片场景」挑一个地址。
 *
 * 实测到的两种形态：
 *   接口响应：  info_list: [{ image_scene: 'WB_DFT', url }, …]   ← 驼峰/下划线混用
 *   前端 store：infoList:  [{ imageScene: 'WB_PRV', url }, …]
 * `WB_DFT` 是「默认图」（原图），`WB_PRV` 是预览图 —— 有 DFT 就必须优先，否则下到的是糊的。
 */
function sceneUrl(list, prefer) {
  if (!Array.isArray(list) || !list.length) return null;
  const sceneOf = (it) => String((it && (it.image_scene || it.imageScene)) || '');
  const hit = list.find((it) => prefer.test(sceneOf(it)));
  const pick = hit || list[0];
  return pick ? (typeof pick === 'string' ? pick : pick.url) : null;
}

/** 收集一张图所有可用的原始来源（按"更可能是原图"排序） */
function imageSources(item) {
  if (!item) return [];
  const infoList = item.info_list || item.infoList;
  const urlList = item.url_list || item.urlList;
  const origin = item.origin || item.original;
  const list = [
    // 下划线（接口）与驼峰（前端 store）两套写法都要认
    item.url_default || item.urlDefault,
    item.url,
    item.origin_url || item.originUrl,
    sceneUrl(infoList, /WB_DFT/i), // 默认图优先
    origin ? origin.url || origin.urlDefault : null,
    Array.isArray(urlList) ? urlList[0] : null,
    item.url_pre || item.urlPre,
    sceneUrl(infoList, /WB_PRV|PRE/i), // 预览图仅兜底
  ];
  return unique(list.map((u) => normalizeUrl(u)).filter(Boolean));
}

/** 原图优先的候选链：先试去掉处理后缀的原图，再退回原样地址 */
function imageCandidates(item) {
  const sources = imageSources(item);
  return unique([...sources.map(toOriginalUrl), ...sources]).filter(Boolean);
}

/** 取一张图的代表地址（用于封面等场景） */
function pickImage(item) {
  const c = imageCandidates(item);
  return c.length ? c[0] : null;
}

/** 实况图：图片项自带一段动态片段（字段名各版本不一，逐个探测） */
function liveVideoOf(img) {
  if (!img || typeof img !== 'object') return null;
  const isLive = img.live_photo === true || img.livePhoto === true || img.live === true;
  if (!isLive && !img.video) return null;
  return deepFindVideo(img.video || img, 0) || null;
}

function noteToItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 直出数据里作品常被包一层 noteCard / note_card，摊平后再解析。
  // 两种写法都要认：接口响应是驼峰，首屏直出/前端 store 是下划线。
  const card =
    raw.note_card && typeof raw.note_card === 'object'
      ? raw.note_card
      : raw.noteCard && typeof raw.noteCard === 'object'
        ? raw.noteCard
        : null;
  const note = card ? { ...raw, ...card } : raw;
  const id = String(note.note_id || note.noteId || note.id || '');
  if (!id) return null;

  // 字段名两套写法都要认（实测：接口响应是下划线，前端 store/首屏直出是驼峰）
  const title = note.display_title || note.displayTitle || note.title || note.desc || '';
  const medias = [];

  // 图集（含实况图）
  const imageList = note.image_list || note.imageList || note.images || note.images_list || [];
  let idx = 0;
  for (const img of Array.isArray(imageList) ? imageList : []) {
    const candidates = imageCandidates(img);
    if (!candidates.length) continue;
    idx++;

    const liveUrl = liveVideoOf(img);
    if (liveUrl) {
      // 实况图：静态帧挂 cover，动态片段单独下载后再转 MOV
      medias.push({
        kind: 'livephoto',
        url: liveUrl,
        cover: candidates[0],
        altUrls: candidates.slice(1),
        index: idx,
        ext: 'mp4',
      });
    } else {
      medias.push({
        kind: 'image',
        url: candidates[0],
        altUrls: candidates.slice(1),
        index: idx,
        ext: extFromUrl(candidates[0], 'jpg'),
      });
    }
  }

  // 视频笔记：字段位置各版本差异大，走递归兜底
  const isVideo = note.type === 'video' || note.noteType === 'video' || !!note.video;
  const videoUrl = deepFindVideo(note.video || note, 0);
  if (isVideo && videoUrl) {
    const cover = pickImage(note.cover || note.image_list?.[0] || (note.imageList || [])[0]);
    medias.push({ kind: 'video', url: videoUrl, cover, ext: 'mp4' });
  } else if (videoUrl && medias.length === 0) {
    medias.push({ kind: 'video', url: videoUrl, cover: null, ext: 'mp4' });
  }

  // 列表页的作品节点只带 cover，不带完整图集（完整图集要打开笔记详情才有）。
  // 所以这里必须把 cover 也用上，否则列表阶段一条媒体都拿不到。
  if (medias.length === 0 && note.cover) {
    const coverCandidates = imageCandidates(note.cover);
    if (coverCandidates.length) {
      medias.push({
        kind: 'image',
        url: coverCandidates[0],
        altUrls: coverCandidates.slice(1),
        index: 1,
        ext: extFromUrl(coverCandidates[0], 'jpg'),
      });
    }
  }

  // 极端兜底：结构变了也能靠扫描捞到图
  if (medias.length === 0) {
    const found = deepFindImages(note, 0).slice(0, 12);
    found.forEach((u, i) =>
      medias.push({ kind: 'image', url: u, altUrls: [], index: i + 1, ext: extFromUrl(u, 'jpg') })
    );
  }

  return {
    id,
    title,
    createdAt: note.time ? new Date(Number(note.time)).toISOString() : '',
    author: note.user?.nickname || note.author?.name || '',
    likeCount:
      note.interact_info?.liked_count ||
      note.interactInfo?.likedCount ||
      note.interact_info?.likedCount ||
      null,
    /**
     * 打开这篇笔记详情页所必需的令牌（列表节点与接口响应里都有）。
     * 列表节点只带封面，完整图集/视频地址要去详情页拿 —— 没有它就只能下封面。
     * 位置实测有两处：顶层 `xsecToken` 与 `note_card.xsecToken`，两处都认。
     */
    xsecToken: raw.xsecToken || note.xsecToken || note.xsec_token || '',
    /** 这篇的媒体是不是「只知道一张封面」——决定要不要打开详情页补全 */
    coverOnly: medias.length === 1 && medias[0].kind === 'image',
    medias,
  };
}

/** 从截获的响应里提取作品列表 */
function parseXhsResponse(data) {
  let notes = data?.data?.notes || data?.notes || data?.data?.note_list;
  if (!Array.isArray(notes)) {
    // 首屏直出 / 接口改版：结构未知时递归找
    notes = deepCollectNotes(data);
  }
  if (!Array.isArray(notes)) return [];
  return notes.map(noteToItem).filter(Boolean);
}

/** 是否还有下一页 */
function hasMore(data) {
  const d = data?.data || data || {};
  return !!(d.has_more ?? d.hasMore ?? (Array.isArray(d.notes) && d.notes.length > 0));
}

module.exports = {
  parseXhsResponse,
  noteToItem,
  hasMore,
  stripSuffix: toOriginalUrl, // 兼容旧调用名
  toOriginalUrl,
  imageCandidates,
  liveVideoOf,
  deepCollectNotes,
};
