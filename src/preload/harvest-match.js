/**
 * 「页面发的哪个响应值得复制一份回主进程」的判定。
 *
 * ⚠️ 为什么判定函数是「自包含 + toString 注入」这种写法（第 19 轮，真机探针抓出来的）：
 *   最自然的写法是把判定放进本文件、让 preload `require('./harvest-match')` ——
 *   但采集窗是 **sandbox 化**的（`nodeIntegration:false` 且没关 sandbox），
 *   沙箱 preload 里的 `require` 只认 `electron` / `events` / `timers` / `url`，
 *   **相对路径直接报 `module not found`**。真机探针实测：
 *       Unable to load preload script: …\harvest-preload.js
 *       Error: module not found: ./harvest-match
 *   而 preload 一挂，症状既不是报错也不是弹窗，而是**采集永远 0 个作品**。
 *   关掉 sandbox 能解决，但那会让预加载脚本拿到完整 Node 能力，
 *   而这个窗口是加载远端页面的（且 contextIsolation 必须为 false）—— 不值得。
 *   于是改用项目里已有的手法（同 `core/ssr-walk.js`、`SCROLL_TO_BOTTOM_JS`）：
 *   **把函数体 `toString()` 出来，由主进程通过 `additionalArguments` 传给 preload**。
 *   好处是判定逻辑只有一份，且 `test/harvest-preload.test.js` 会用**真实 preload**
 *   端到端验证它确实生效。
 *
 * ⚠️ 这里栽过的一跤（用户实测）：抖音主页除「作品」外还有「喜欢」标签，
 * 而「喜欢」走的是 `/aweme/v1/web/aweme/favorite`，返回体里同样是 `aweme_list` ——
 * 与「作品」**字段结构完全一致**，解析层从数据上根本分不出来。
 * 早先的匹配串是 `aweme\/v1\/web\/aweme`（少了 `/post`），
 * 把这一前缀下的**所有**接口都截了回来：喜欢、相关推荐、合集…
 * 于是用户下载自己主页时，把自己的点赞内容也下到了磁盘上。
 * 现在抖音改成**白名单**（只认主页作品），另加显式黑名单兜底。
 */

/**
 * 判定一个响应 URL 是否值得截获。
 *
 * ⚠️ 会被 `toString()` 注入 preload，**必须自包含**：
 * 所有正则都得写在函数体里面（写到模块作用域会立刻 ReferenceError）。
 * `test/harvest-match.test.js` 里那条「自包含」断言就是为了锁死这一点。
 */
function matches(url) {
  const u = String(url || '');
  if (!u) return false;
  // 抖音：只认「主页作品」这一个接口
  const POST = /aweme\/v1\/web\/aweme\/post(?:[/?#]|$)/i;
  // 抖音：同样返回 aweme_list、但绝不是主页作品的接口，一律不许截
  //   favorite 喜欢（用户点赞的，多为别人的作品）← 真凶
  //   related 相关推荐 / collection 合集 / listcollection 收藏 / detail 单作品详情
  //   tab/feed 首页推荐流 / search 搜索 / mix 合集详情
  const NOT_POST = /aweme\/(favorite|related|collection|listcollection|detail|search)|tab\/feed|search\/item|mix\/aweme/i;
  if (NOT_POST.test(u)) return false;
  if (POST.test(u)) return true;
  // 小红书：主页作品接口 + edith 域下的各类接口（逐篇补全图集要靠它截获详情）
  if (/edith\.xiaohongshu\.com|sns\/web\/v1\/user_posted|user_posted/i.test(u)) return true;
  return false;
}

/**
 * 单作品模式的判定（与上面的 `matches` 只差「放不放行详情接口」）。
 *
 * 为什么必须单独一份，而不是给 matches 加个开关参数：
 *   这个函数会被 `toString()` 后经 additionalArguments 送进沙箱 preload，
 *   **参数传不进去** —— 所以「带开关的同一个函数」是不可能实现的，
 *   只能生成两份各自自包含的函数（这也是本文件一直用 toString 手法的代价）。
 *
 * 与主页模式的区别只有两处：
 *   · 抖音：放行 `/aweme/v1/web/aweme/detail`（单作品详情）
 *   · 小红书：放行 `sns/web/v1/feed`（笔记详情接口）
 * 噪声接口的黑名单**保持不变** —— 详情页底部同样挂着「相关推荐」，
 * 抖音的 related 接口照样会把别人的作品灌进来。区别在于单作品模式下
 * 采集器会按目标 id 严格过滤（见 core/single-harvest.js），
 * 但少截一份无关数据总归更省事、也少一次解析。
 *
 * 同样必须自包含。
 */
function matchesSingle(url) {
  const u = String(url || '');
  if (!u) return false;
  // 抖音：与目标作品无关、且会灌进别人作品的接口，一律不许截（与主页模式同一份黑名单）
  const DY_NOISE = /aweme\/(favorite|related|collection|listcollection|search)|tab\/feed|search\/item|mix\/aweme/i;
  if (DY_NOISE.test(u)) return false;
  // 抖音：主页作品 + 单作品详情
  const DY_OK = /aweme\/v1\/web\/aweme\/(?:post|detail)(?:[/?#]|$)/i;
  if (DY_OK.test(u)) return true;
  // 小红书：主页作品 + 笔记详情（feed）+ edith 域下的各类接口
  if (/sns\/web\/v1\/(?:user_posted|feed)|user_posted|edith\.xiaohongshu\.com/i.test(u)) return true;
  return false;
}

/**
 * 兜底判定：只做「是不是这两家的接口」的粗筛。
 *
 * 什么时候会用到它：主进程忘了把 `matches` 的源码传下来（不应该发生，但属于
 * 故障模式的一种）。此时宁可多截一点回来 —— **正确性由第二道防线保证**：
 * 抖音适配器还会按作者 id 过滤掉不是目标博主的作品（见 platforms/douyin.js）。
 * 反过来「什么都不截」会让整个采集静默失败，那才是更糟的失败模式。
 *
 * 同样必须自包含。
 */
function coarseMatches(url) {
  return /douyin\.com|xiaohongshu\.com|xhscdn|aweme|sns\/web/i.test(String(url || ''));
}

/** 主进程用它拼 `additionalArguments` 传给 preload */
const ARG_MATCH = '--harvest-match=';
const ARG_COARSE = '--harvest-coarse=';

/** 注入页面/preload 用的函数源码（必须自包含，见各自的注释） */
const MATCH_SOURCE = matches.toString();
const SINGLE_SOURCE = matchesSingle.toString();
const COARSE_SOURCE = coarseMatches.toString();

/**
 * 采集窗 `webPreferences.additionalArguments` 的内容。
 *
 * 主进程与真机探针（test/harvest-preload-main.js）**共用这一份** ——
 * 否则探针验的就不是真东西了（这个坑当场踩过一次：探针自己拼了个空的
 * webPreferences，于是 preload 走了兜底分支，测试结果毫无意义）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.single] 单作品模式：放行详情接口（见 matchesSingle）
 */
function harvestArguments(opts = {}) {
  const exact = opts.single ? SINGLE_SOURCE : MATCH_SOURCE;
  return [ARG_MATCH + exact, ARG_COARSE + COARSE_SOURCE];
}

/** preload 自报「用的是哪一档判定」，主进程据此判断接线有没有断 */
const MODE_INJECTED = 'injected';
const MODE_COARSE = 'coarse';
const MODE_ALL = 'all';
/** preload 上报模式的 IPC 频道 */
const CH_MATCH_MODE = 'harvest:match-mode';

module.exports = {
  matches,
  matchesSingle,
  coarseMatches,
  harvestArguments,
  MATCH_SOURCE,
  SINGLE_SOURCE,
  COARSE_SOURCE,
  ARG_MATCH,
  ARG_COARSE,
  MODE_INJECTED,
  MODE_COARSE,
  MODE_ALL,
  CH_MATCH_MODE,
};
