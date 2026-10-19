/**
 * 小红书 / 抖音的共用适配逻辑
 *
 * 这两家的适配器本来有**逐字重复**的三段代码（`normalizeHome`、`extractChannelId`、
 * `toUnified` 的媒体映射），差别只有两处：
 *   · 抖音多一个 `authorUid`（用它把「喜欢/推荐」里的别人作品过滤掉）；
 *   · 小红书多 `xsecToken` + `noteDetail`（打开详情页补全图集所必需）。
 * 复制粘贴的代价在上一轮已经付过一次：`toUnified` 里「媒体候选链」那段
 * 一处改了 `altUrls`、另一处没改，于是同一批图在抖音能回退、在小红书不能。
 *
 * 所以这里收敛成三个纯函数 + 一个工厂。**平台特有的字段通过 `extra` 注入**，
 * 公共部分（媒体映射）只有一份实现。
 */

/**
 * 主页地址归一化：用户经常只粘 `www.xiaohongshu.com/user/profile/xxx`（没有协议头）。
 *
 * 不做「必须 http(s)」的强校验：真正的可访问性由浏览器/接口自己判定，
 * 这里补一个协议头就够了；判错反而会把本来能用的输入挡在门外。
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeHome(input) {
  const s = String(input || '').trim();
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

/**
 * 从主页链接里提取账号标识（用于建目录名）。
 *
 * @param {RegExp[]} patterns 依次尝试的正则，取第一个捕获组
 * @param {string} [fallback='unknown']
 * @returns {(input:string) => string}
 */
function makeExtractChannelId(patterns, fallback = 'unknown') {
  return function extractChannelId(input) {
    const s = String(input || '');
    for (const re of patterns) {
      const m = s.match(re);
      if (m && m[1]) return m[1];
    }
    return fallback;
  };
}

/**
 * 把一个「平台解析层产出的作品」映射成统一媒体模型。
 *
 * 统一模型（见 core/runner.js 头部注释）：
 *   { id, title, dateHint, filePrefix, folderTitle, author, likeCount, medias }
 *
 * 媒体映射三家的语义必须一致，否则编排层按 kind 分支时会出现
 * 「同一份作品在一个平台被当成图片、在另一个平台被当成视频」这类诡异问题。
 *
 * @param {object} it 解析层产出的作品
 * @returns {object[]} 统一后的媒体数组
 */
function toUnifiedMedias(it) {
  const medias = [];
  for (const m of (it && it.medias) || []) {
    if (!m) continue;
    if (m.kind === 'image') {
      medias.push({
        kind: 'image',
        url: m.url,
        // 解析层已按「原图优先」排好序，整条链带过去，由编排层按开关取舍
        candidates: [m.url, ...(m.altUrls || [])],
        ext: m.ext || 'jpg',
      });
    } else if (m.kind === 'livephoto') {
      medias.push({
        kind: 'livephoto',
        url: m.url,
        altUrls: [],
        ext: 'mp4',
        cover: m.cover || null,
        coverCandidates: m.cover ? [m.cover, ...(m.altUrls || [])] : [],
      });
    } else if (m.kind === 'video') {
      medias.push({
        kind: 'video',
        url: m.url,
        ext: m.ext || 'mp4',
        cover: m.cover || null,
        coverCandidates: m.cover ? [m.cover] : [],
      });
    }
  }
  return medias;
}

/**
 * 造一个平台的 `toUnified`。
 *
 * @param {object} [opts]
 * @param {(it:object) => object} [opts.extra] 平台特有字段（抖音 authorUid、小红书 xsecToken/noteDetail）
 * @param {(it:object) => string} [opts.folderTitleOf] 目录名里的标题（默认用作品标题）
 * @param {(it:object) => string} [opts.filePrefixOf] 文件名前缀（默认空）
 * @returns {(it:object) => object}
 */
function makeToUnified({ extra, folderTitleOf, filePrefixOf } = {}) {
  return function toUnified(it) {
    const src = it || {};
    return {
      id: src.id,
      title: src.title || '',
      dateHint: src.createdAt || '',
      filePrefix: filePrefixOf ? filePrefixOf(src) : '',
      folderTitle: folderTitleOf ? folderTitleOf(src) : src.title || '',
      author: src.author || '',
      likeCount: src.likeCount,
      ...(extra ? extra(src) : {}),
      medias: toUnifiedMedias(src),
    };
  };
}

module.exports = { normalizeHome, makeExtractChannelId, makeToUnified, toUnifiedMedias };
