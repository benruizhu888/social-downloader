/**
 * 媒体扩展名判定（唯一实现）
 *
 * 为什么值得单独一个文件：本轮审计发现同一件事在仓库里有**三份实现**，
 * 三份的白名单还不一样：
 *   · `sources/parsers/util.js`  → 有 m3u8，没有 m4v
 *   · `sources/weibo-api.js`     → 有 m3u8，也有 m4v
 *   · `core/runner.js`           → 有 m4v，**没有 m3u8**
 * 差别不是风格问题：同一串 URL 在解析层被当成 `a.m3u8`、到了编排层却变成 `a.jpg`，
 * 于是落盘文件名与真实内容对不上 —— 用户拿到一个「图片」其实是 HLS 播放列表，
 * 播放器打不开、看图软件也打不开，而日志里显示「下载成功」。
 *
 * 统一后的白名单**就是三份的并集**（不做任何新增），这样：
 *   · 原来认得的，现在仍然认得（行为不回退）；
 *   · 原来不认得的那几种（对 runner 来说是 m3u8），现在认得 —— 这正是修复点。
 *
 * 关于 `m3u8` 的显式决定（审计要求「必须显式决定并锁进测试」）：
 *   **保留**。m3u8 本身是文本播放列表、不是可播放媒体，但它是一个**真实的地址形态**
 *   （微博的 HLS 档位就叫 `stream_url`），把它标成 `.jpg` 只会让「下到一个播不了的文件」
 *   变得更难排查。保留扩展名至少让文件名自己说出真相。
 *
 * 关于 `m4v`：并集里保留（runner 原本就认），它对图片链路无影响 —— 图片地址不会以 .m4v 结尾。
 */

/**
 * 认得的所有媒体扩展名（顺序无关，只用于拼正则与文档）。
 *
 * ⚠️ 加新扩展名请同时更新 `test/ext-consistency.test.js`：那份测试锁的是
 * 「三处调用点行为一致」，不是「白名单里有哪些」。
 */
const MEDIA_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'mp4',
  'mov',
  'm4v',
  'm3u8',
];

/** 预编译的正则：命中「路径末尾或查询串之前」的扩展名 */
const EXT_RE = new RegExp(`\\.(${MEDIA_EXTS.join('|')})(?=\\?|/|$)`, 'i');

/**
 * 从 URL 推断扩展名。
 *
 * 只看**路径部分**（`?` 之前、`#` 之前）会更准，但历史上三份实现都是对整串做匹配，
 * 且真实地址的签名参数里不会出现 `.jpg` 这种形态 —— 为了不回退行为，这里保持一致。
 *
 * @param {string} url
 * @param {string} [fallback='jpg'] 认不出来时用它
 * @returns {string} 小写扩展名，`jpeg` 归一成 `jpg`
 */
function extFromUrl(url, fallback = 'jpg') {
  const m = String(url || '').match(EXT_RE);
  return (m ? m[1].toLowerCase() : fallback).replace('jpeg', 'jpg');
}

/**
 * 归一化一个「已经是扩展名」的字符串（媒体条目自带 `ext` 字段时用）。
 *
 * 解析层给的 ext 可能是 'JPEG'、'jpeg'、'.jpg'，落到文件名上必须统一，
 * 否则同一批文件里会出现 `img01.jpg` 与 `img02.JPEG` 两种写法。
 *
 * @param {string} ext
 * @param {string} [fallback='jpg']
 * @returns {string}
 */
function normalizeExt(ext, fallback = 'jpg') {
  const s = String(ext || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (!s) return fallback;
  return s === 'jpeg' ? 'jpg' : s;
}

module.exports = { MEDIA_EXTS, extFromUrl, normalizeExt };
