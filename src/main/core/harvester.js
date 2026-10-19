/**
 * 浏览器内采集引擎（小红书 / 抖音共用）
 *
 * 不直接调 API（签名做不了），而是用真实浏览器打开博主主页：
 * 页面自己的 JS 会带正确签名发请求，注入脚本把响应复制出来。
 * 配合自动滚动触发「加载更多」，直到没有新增内容为止。
 *
 * 平台差异通过注入 parse / wrapSSR / matchHint 三个函数收敛，
 * 采集流程本身完全共用。
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const { attachUrlGuards } = require('../url-guard');
const { SSR_BUNDLE_JS } = require('./ssr-walk');
const { harvestArguments } = require('../../preload/harvest-match');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 「滚到底」到底该滚谁 —— 这是抖音采不到东西的真凶。
 *
 * 实测（真机取证，第 17 轮）：抖音博主主页把作品区放进了**独立的 overflow 容器**
 *   div.parent-route-container  clientH=844  scrollH=3900  overflow-y:auto
 * 而 document.body.scrollHeight 只有 844 —— 页面在视口内就显示完了。
 * 采集器原本只做 `window.scrollTo(0, document.body.scrollHeight)`，
 * 在这个布局下等于**一次都没有真正滚动过**：
 *   · 不触发「加载更多」→ 页面一个 aweme/post 请求都不发
 *   · 截获数永远是 0 → 日志只剩「未采集到作品（截获到 0 个候选响应）」
 * 用户看到的是「抖音一条都采不到」，而页面其实渲染得好好的（正文里能看到「作品 142」）。
 *
 * 所以这里两件事都做：
 *   ① 照旧滚 window（小红书 / 微博还是这个布局）
 *   ② 找出「内容高度超出可视高度最多、且真的可滚动」的那个容器，把它也滚到底
 *
 * 之所以用「超出最多」而不是「第一个可滚动的」：外层容器包着内层，
 * 差最大的那个一定是最外层，滚它才能带动整页的懒加载。
 *
 * ⚠️ 这个函数会被 `toString()` 后注入页面执行（见 SCROLL_TO_BOTTOM_JS），
 * **必须自包含**，不能引用本模块作用域里的任何东西。它同时被单测用假 DOM 调用。
 */
function scrollPageToBottom() {
  const doc = document;
  const win = window;
  const docH = doc.documentElement ? doc.documentElement.scrollHeight : 0;
  const bodyH = doc.body ? doc.body.scrollHeight : 0;
  const pageH = docH > bodyH ? docH : bodyH;
  try {
    win.scrollTo(0, pageH);
  } catch (e) {
    /* 有些页面禁止脚本滚动，忽略 */
  }

  let best = null;
  let bestDelta = 0;
  const all = doc.querySelectorAll ? doc.querySelectorAll('div,main,section') : [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el) continue;
    const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (delta <= 40 || delta <= bestDelta) continue;
    let oy = '';
    try {
      oy = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowY : '';
    } catch (e) {
      oy = '';
    }
    // overflow:visible 的元素设 scrollTop 没有任何效果，还会把「差最大」的判据带偏
    if (oy !== 'auto' && oy !== 'scroll') continue;
    bestDelta = delta;
    best = el;
  }
  if (best) best.scrollTop = best.scrollHeight;
  return bestDelta || pageH;
}

/** 注入页面用的源码（自包含，见上） */
const SCROLL_TO_BOTTOM_JS = '(' + scrollPageToBottom.toString() + ')()';

/**
 * 带缓存版的滚动：优先滚上一轮找到的那个容器，找不到再全量重扫。
 *
 * 为什么需要缓存（J-1）：`scrollPageToBottom` 每次都要 `querySelectorAll('div,main,section')`
 * 并在页面里对**每个**元素调一次 `getComputedStyle`。抖音主页那种页面有一两千个节点，
 * 一轮下来就是两千次样式计算 —— 而采集循环每 1.3 秒跑一轮、一跑几十轮。
 * 实测这是采集期间渲染进程 CPU 的主要来源（窗口隐藏时也在烧）。
 *
 * 缓存的失效条件（两条，缺一不可）：
 *   · 元素 `isConnected === false`（页面重渲染把容器换掉了）；
 *   · 调用方每 5 轮强制重扫一次（懒加载结构可能变了，但我们不想每轮都付全量扫描的钱）。
 *
 * ⚠️ 与 `scrollPageToBottom` 一样，本函数会被 `toString()` 后注入页面执行，
 * **必须自包含**（不能引用模块作用域里的任何东西），所以 `byPath` / `pathOf` 都写在里面。
 *
 * @param {number[]|null} cachedPath 上一次算出的「从 documentElement 下来的子节点下标链」
 * @returns {{delta:number, path:number[]|null, hit:boolean}}
 */
function scrollPageToBottomCached(cachedPath) {
  const doc = document;
  const win = window;

  /** 把元素表示成「子节点下标链」，跨轮次仍能定位（比 nth-child 选择器更稳） */
  function pathOf(el) {
    const p = [];
    let n = el;
    while (n && n.parentNode && n !== doc.documentElement) {
      const parent = n.parentNode;
      const kids = parent.children || [];
      const idx = Array.prototype.indexOf.call(kids, n);
      if (idx < 0) return null;
      p.unshift(idx);
      n = parent;
    }
    return n === doc.documentElement ? p : null;
  }

  function byPath(p) {
    let n = doc.documentElement;
    if (!n || !Array.isArray(p)) return null;
    for (const i of p) {
      const kids = n.children || [];
      if (!kids[i]) return null;
      n = kids[i];
    }
    return n;
  }

  // 滚 window 这一步永远要做：小红书/微博就是普通文档流（成本极低）
  const docH = doc.documentElement ? doc.documentElement.scrollHeight : 0;
  const bodyH = doc.body ? doc.body.scrollHeight : 0;
  const pageH = docH > bodyH ? docH : bodyH;
  try {
    win.scrollTo(0, pageH);
  } catch (e) {
    /* 有些页面禁止脚本滚动，忽略 */
  }

  // ① 缓存命中：只算一次 scrollHeight-clientHeight（不需要 getComputedStyle）
  const cached = byPath(cachedPath);
  if (cached && cached.isConnected !== false) {
    const d = (cached.scrollHeight || 0) - (cached.clientHeight || 0);
    if (d > 40) {
      cached.scrollTop = cached.scrollHeight;
      return { delta: d, path: cachedPath, hit: true };
    }
  }

  // ② 全量扫描（与 scrollPageToBottom 同一判据：差最大 + 真的可滚）
  let best = null;
  let bestDelta = 0;
  const all = doc.querySelectorAll ? doc.querySelectorAll('div,main,section') : [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el) continue;
    // 先算差值：绝大多数节点（差 <= 40）连样式都不用取
    const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (delta <= 40 || delta <= bestDelta) continue;
    let oy = '';
    try {
      oy = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowY : '';
    } catch (e) {
      oy = '';
    }
    if (oy !== 'auto' && oy !== 'scroll') continue;
    bestDelta = delta;
    best = el;
  }
  if (best) {
    best.scrollTop = best.scrollHeight;
    return { delta: bestDelta, path: pathOf(best), hit: false };
  }
  return { delta: pageH, path: null, hit: false };
}

/**
 * 造一次「带缓存滚动」的注入脚本。
 * @param {number[]|null} path
 * @returns {string}
 */
function scrollScriptWith(path) {
  return '(' + scrollPageToBottomCached.toString() + ')(' + JSON.stringify(path || null) + ')';
}

/**
 * 「这份作品有多完整」的打分 —— 用来决定详情页补全的结果要不要覆盖列表页的结果。
 *
 * 为什么不能简单比 medias 条数：
 *   列表页的小红书节点只有一张封面（1 分）；详情页拿到的视频笔记是
 *   「1 个视频 + 1 张封面」，条数同样是 2 但信息量完全不同。
 *   视频/实况给 3 倍权重，就能让「只有封面」永远不会盖掉「有视频的完整版本」，
 *   也避免「1 张封面」把自己覆盖成一样的东西（>= 判断会来回抖）。
 */
function mediaScore(item) {
  const ms = Array.isArray(item?.medias) ? item.medias : [];
  let s = 0;
  for (const m of ms) s += m && (m.kind === 'video' || m.kind === 'livephoto') ? 3 : 1;
  return s;
}

/** 覆盖时不要把原来有、新的一份没有的文本字段弄丢 */
function mergeItem(oldIt, newIt) {
  const out = { ...oldIt, ...newIt };
  /**
   * `xsecToken` 与 `noteDetail` 同属「打开这条作品的凭证」。
   * 详情页响应本身不带令牌，若放任新的一份把 old 的令牌覆盖成空串，
   * 这条作品就再也算不出可用的详情地址了 —— 下一轮补全会打到 404。
   */
  for (const k of ['title', 'author', 'dateHint', 'folderTitle', 'authorUid', 'noteDetail', 'xsecToken']) {
    if (!newIt[k] && oldIt[k]) out[k] = oldIt[k];
  }
  if (newIt.likeCount == null && oldIt.likeCount != null) out.likeCount = oldIt.likeCount;
  /**
   * noteDetail（作品详情页地址）单独处理：详情页响应本身**不带**打开它所需的令牌，
   * 于是同一篇作品第二次被解析时这个地址会「变短」。若直接让新的覆盖旧的，
   * 就等于把一条能用的地址降级成一条会跳走的地址（表现为补全阶段莫名其妙全都失败）。
   * 通用判据：新的只是旧的前缀 → 旧的信息更多 → 保留旧的。
   */
  if (oldIt.noteDetail && newIt.noteDetail && oldIt.noteDetail.startsWith(newIt.noteDetail)) {
    out.noteDetail = oldIt.noteDetail;
  }
  return out;
}

/**
 * 把「parse 的返回值」归一成 `{items, skipped, hasMore}`。
 *
 * 为什么允许两种形态：`parse` 在本项目里是平台适配器提供的闭包，
 * 历史上只返回数组；现在还需要带出「跳过几条」「还有没有下一页」（P1-5 / J-1）。
 * 为了不把每个适配器和每个测试都改一遍，这里**两种都认**：
 *   数组 → {items: 数组, skipped: 0, hasMore: undefined}
 *   对象 → 按字段取，缺什么补什么
 * 旧写法继续可用，新写法按需升级。
 *
 * @param {Array|{items?:Array, skipped?:number, hasMore?:boolean}} parsed
 * @returns {{items: Array, skipped: number, hasMore: boolean|undefined}}
 */
function normalizePage(parsed) {
  if (Array.isArray(parsed)) return { items: parsed, skipped: 0, hasMore: undefined };
  if (parsed && typeof parsed === 'object') {
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      skipped: Number(parsed.skipped) > 0 ? Number(parsed.skipped) : 0,
      hasMore: typeof parsed.hasMore === 'boolean' ? parsed.hasMore : undefined,
    };
  }
  return { items: [], skipped: 0, hasMore: undefined };
}

class Harvester {
  /**
   * @param {object} opts
   * @param {string}   opts.partition  持久化分区
   * @param {string}   opts.url        博主主页
   * @param {Function} opts.parse      (data) => items  把截获的响应解析成统一 item
   * @param {Function} opts.wrapSSR    (arr) => data    把首屏直出数组包成 parse 认识的结构
   * @param {Function} opts.onLog
   * @param {Function} opts.onProgress
   * @param {Function} [opts.detailUrlOf] (item) => url|null  作品详情页地址
   * @param {Function} [opts.needsDetail] (item) => boolean   这份作品是否「信息不全」
   * @param {number}   [opts.detailLimit] 最多补全多少个（默认不限制）
   */
  constructor({
    partition,
    url,
    parse,
    wrapSSR,
    onLog,
    onProgress,
    maxIdle = 5,
    minRounds = 8,
    timeoutMs = 240000,
    showWindow = false,
    detailUrlOf = null,
    needsDetail = null,
    detailLimit = 0,
    /**
     * 详情页的轮询节奏。
     *
     * ⚠️ 这两个默认值是真机量出来的（第 17 轮），不是拍脑袋：
     * 小红书详情页把作品数据填进首屏 store 的时间实测是 **4.6 秒和 10.8 秒**
     * （还有一篇是单图笔记，永远只有 1 个媒体）。
     * 旧值是 650ms × 7 轮 ≈ 4.5 秒 —— 刚好全部错过，
     * 于是用户看到的就是「图集补全成功 0 / 10」「每篇只下到一张封面」，
     * 而日志里还一切正常。现在 800ms × 16 轮 ≈ 12.8 秒的**上限**，
     * 并且「这篇的数据一出现就立刻收工」（见 _fillDetails 的 touches 判据），
     * 所以单图笔记不会白等到上限 —— 上限只是兜底。
     */
    detailPollMs = 800,
    detailRounds = 16,
    /** 看到这篇作品的数据之后，再等几轮让更完整的版本进来 */
    detailSettleRounds = 2,
    /** 采够这么多就停（0 = 不限）。编排层最后还会截断，但那时已经白采了一大堆（J-1） */
    maxItems = 0,
    /** 有新增时的滚轮间隔；空闲时放宽到 idleSleepMs（自适应，见 start 里的循环） */
    activeSleepMs = 700,
    idleSleepMs = 1300,
    /** 首屏直出探测的最小间隔（同一 URL）：它要遍历页面所有全局对象，比滚动贵得多 */
    ssrMinGapMs = 900,
  }) {
    this.partition = partition;
    this.url = url;
    this.parse = parse;
    this.wrapSSR = wrapSSR || ((arr) => arr);
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.maxIdle = maxIdle;
    /**
     * 热身轮数：这么多轮之内不判定「无新增」。
     * 页面首屏作品是异步填进前端 store 的，慢网下 5 轮（约 6.5 秒）
     * 就可能一条都还没到，于是被判成「这个博主没有作品」。
     */
    this.minRounds = minRounds;
    this.timeoutMs = timeoutMs;
    /**
     * 采集窗默认隐藏。
     *
     * 为什么默认 hidden 是安全的、以及为什么仍然留一个开关：
     *   隐藏窗口下 document.visibilityState === 'hidden'，Chromium 会暂停
     *   与「帧」相关的回调（requestAnimationFrame 等）。对**首屏 SSR 直出**或
     *   **滚动触发加载更多**的页面没影响（滚的是真实布局），所以默认隐藏是为了不打扰用户。
     *   但这句话是**待验证的假设** —— 诊断脚本用 --show=1 可以让窗口可见，
     *   用来区分「页面没渲染」和「接口没返回」这两类 0 条。
     */
    this.showWindow = !!showWindow;

    /**
     * 「详情页补全」——小红书列表节点只带一张封面，靠它下载等于每篇只拿到 1 张图。
     * 平台适配器提供两个纯函数（本模块不认识任何平台字段）：
     *   detailUrlOf(item) → 该作品的详情页地址
     *   needsDetail(item) → 这份作品是不是「信息不全」
     * 采集完列表后逐个打开详情页，把页面自己发的详情接口响应截获回来补全。
     */
    this.detailUrlOf = detailUrlOf;
    this.needsDetail = needsDetail;
    this.detailLimit = Number(detailLimit) > 0 ? Number(detailLimit) : 0;
    this.detailPollMs = detailPollMs;
    this.detailRounds = detailRounds;
    this.detailSettleRounds = detailSettleRounds;
    /**
     * 「这篇作品的数据被看到过几次」的计数（按 id）。
     *
     * 为什么需要它：判断「详情页的数据到底到位没有」，不能只看媒体数有没有变多 ——
     * 单图笔记的媒体数永远不会变多，那就只能一路干等到上限；
     * 也不能只看「有没有截获到响应」，因为页面一直在发无关请求（配置、未读数、IM…），
     * 噪声永远在涨。真正准确的判据是：**详情页有没有产出过这篇作品本身**。
     */
    this.touches = new Map();
    /**
     * 是否处于「详情补全」阶段。
     *
     * ⚠️ 这个开关是必须的：详情页底部永远挂着「相关推荐」，里面是**别人的**作品。
     * 如果不加限制地 ingest，采集结果会被推荐流灌成一堆无关作品，
     * 用户勾了「最多 10 个作品」，最后下回来 40 个别人的笔记。
     * 所以这一阶段只接受「列表页已经认识的那批 id」。
     */
    this.detailPhase = false;

    this.items = new Map();
    this.stopped = false;
    this.win = null;
    /** 采集上限（见构造参数 maxItems） */
    this.maxItems = Number(maxItems) > 0 ? Number(maxItems) : 0;
    this.activeSleepMs = activeSleepMs;
    this.idleSleepMs = idleSleepMs;
    this.ssrMinGapMs = ssrMinGapMs;
    /**
     * 解析层「跳过」了多少条结构异常的数据（P1-5）。
     * 单独计数而不是只打日志：收尾时要能说「本次共跳过 N 条」，否则用户只会觉得少了东西。
     */
    this.parseSkipped = 0;
    /** 同一作品被「更新」（拿到更完整的一份）的次数，与新增分开统计（P1-14） */
    this.updated = 0;
    /**
     * 页面自己说「没有下一页」了（解析层的 hasMore === false）。
     * 置位后主循环把 idle 直接抬到上限，下一轮就收工 —— 不必再猜 5 轮（J-1）。
     */
    this.noMorePages = false;
    /** 滚动的容器缓存（见 scrollPageToBottomCached） */
    this._scrollPath = null;
    /** 首屏直出探测的节流状态（J-1） */
    this._ssrAt = 0;
    this._ssrUrl = '';
    this.intercepted = 0; // 截获到多少个候选响应（用于区分「没发请求」和「发了没数据」）
    this.ssrFound = 0; // 首屏直出里找到多少条候选作品（用于区分「没数据」和「解析没对上」）
    /**
     * 「翻全局对象**确实翻到了数据**」的累计次数。
     *
     * ⚠️ 这里计的是「有结果」，不是「翻过」：探测动作是我们自己发起的轮询，
     * 它本身不能证明页面还在正常出数据。把它当成信号会让「连续几篇都毫无收获」
     * 的提前收工判据永远不成立 —— 用户就要干等十几分钟。详见 _fillDetails。
     */
    this.ssrHits = 0;
    /** 首屏直出数据最终是从哪个全局对象/哪个 script 里取到的（诊断用） */
    this.ssrRoots = '';
    /** 首屏直出数据「取到了但没能带回主进程」的原因（诊断用，见 _harvestSSR 的 catch） */
    this.ssrError = '';
  }

  /**
   * 把「parse 的返回值」归一成 `{items, skipped, hasMore}`。
   *
   * 为什么允许两种形态：`parse` 在本项目里是平台适配器提供的闭包，
   * 历史上只返回数组；现在还需要带出「跳过几条」「还有没有下一页」。
   * 为了不把每个适配器和每个测试都改一遍，这里**两种都认**：
   *   数组 → {items: 数组, skipped: 0, hasMore: undefined}
   *   对象 → 按字段取，缺什么补什么
   * 这样旧写法继续可用，新写法按需升级。
   *
   * @param {Array|{items?:Array, skipped?:number, hasMore?:boolean}} parsed
   * @returns {{items: Array, skipped: number, hasMore: boolean|undefined}}
   */
  static normalizePage(parsed) {
    return normalizePage(parsed);
  }

  /** 供主进程转发截获到的数据 */
  ingest(url, data) {
    if (!data || typeof data !== 'object') return 0;
    this.intercepted++;
    let page;
    try {
      page = normalizePage(this.parse(data));
    } catch (err) {
      // 整页解析抛异常（解析层已经逐条容错了，这里兜的是「结构完全看不懂」那种）
      this.onLog(`解析响应失败：${err.message}`);
      return 0;
    }
    /**
     * 逐条容错的战果必须说出来（P1-5）：用户看到的是「作品比预期少」，
     * 而这句话是唯一能把「少了」和「接口本来就这么点」区分开的信息。
     */
    if (page.skipped) {
      this.parseSkipped += page.skipped;
      this.onLog(`解析时跳过 ${page.skipped} 条结构异常的数据（不影响其余作品）`);
    }
    // 页面自己说没有下一页 → 交给主循环提前收工（J-1）
    if (page.hasMore === false) this.noMorePages = true;

    const items = page.items;
    let added = 0;
    let updated = 0;
    for (const it of items) {
      if (!it?.id) continue;
      // 详情阶段只认列表页已有的作品，否则推荐流会把别人的笔记也灌进来
      if (this.detailPhase && !this.items.has(it.id)) continue;
      // 放在过滤之后：被推荐流带进来的别人的作品不算「这篇的数据到位了」
      this.touches.set(it.id, (this.touches.get(it.id) || 0) + 1);
      const old = this.items.get(it.id);
      if (!old) {
        this.items.set(it.id, it);
        added++;
        continue;
      }
      // 同一作品再次出现（详情页补全）：只接受「更完整」的那一份。
      // 早先的写法是「已存在就整条丢掉」，于是详情页拿到的完整图集永远进不来 ——
      // 表现就是「小红书每篇只下到一张封面」，而日志还一切正常。
      if (mediaScore(it) > mediaScore(old)) {
        this.items.set(it.id, mergeItem(old, it));
        updated++;
        continue;
      }
      /**
       * 完整度相同、但「详情地址」信息量不一样时，也要换。
       *
       * 真机取证（第 16 轮）：发现页里同一篇笔记会同时出现两个副本 ——
       * 一个带 `xsec_token`，一个不带。而小红书对不带令牌的 `/explore/<id>`
       * 会直接 302 到 `/404?...error_code=300031`，正文只剩 700 多字符的页脚。
       * 若不带令牌的那份先入库、且此后一直「完整度相同」，补全阶段就永远打开一篇 404，
       * 用户看到的还是「成功补全 0 / N」。
       *
       * 判据是「地址更长的那份更能打开」：令牌本身就是一段查询参数，
       * 带令牌的地址严格更长、且严格更可用（不带令牌的那条必然被跳走）。
       * 两份完全一样时长度相同 → 不替换，保持原有的「不做无意义抖动」行为。
       */
      const richer = (this._detailUrlFor(it) || '').length > (this._detailUrlFor(old) || '').length;
      if (mediaScore(it) === mediaScore(old) && richer) {
        this.items.set(it.id, mergeItem(old, it));
        updated++;
      }
    }
    /**
     * 返回值只算**真新增**（P1-14）。
     *
     * 早先「换成更完整的一份」也会 `added++`，于是 onProgress 报的「新增 N 个」
     * 把更新也算进去了：界面数字一路涨、最后作品数却对不上，用户会以为丢了作品。
     * 更新单独计 `this.updated`，收尾日志里分开说「新增 / 更新」。
     */
    this.updated += updated;
    if (added) this.onProgress(this.items.size, added);
    return added;
  }

  /**
   * 采集结束时「一条都没有」的现场报告。
   *
   * 用户之前只看到「没有采集到任何作品。请确认 ① ② ③」——
   * 三条都确认过了也没用，因为那三条根本区分不了下面这些完全不同的情况：
   *   · 页面压根没发相关请求（前端没渲染 / 链接被降级）
   *   · 发了但服务端返回空（多半是链接里的 xsec_token 过期）
   *   · 拦截到了但解析没对上（结构改版）
   *   · 窗口本身挂了
   * 所以这里把能观测到的事实都摆出来，让下一次上报能直接定位。
   */
  async _diagnoseEmpty() {
    const lines = [];
    lines.push(`未采集到作品（截获到 ${this.intercepted} 个候选响应）`);

    if (this.ssrError) {
      lines.push(`首屏直出数据取到了，但没能带回主进程（${this.ssrError}）`);
    }
    if (this.ssrFound) {
      lines.push(
        `首屏直出数据里找到了 ${this.ssrFound} 条候选作品，但都没能解析出可下载内容` +
          (this.ssrRoots ? `（数据来源：${this.ssrRoots}）` : '')
      );
    }

    let bodyLen = -1;
    let pageUrl = '';
    try {
      pageUrl = this.win.webContents.getURL();
      bodyLen = await Promise.race([
        this.win.webContents.executeJavaScript('document.body ? document.body.innerText.length : -1'),
        sleep(2000).then(() => -1),
      ]);
    } catch {
      /* 窗口可能已经不可用 */
    }

    if (bodyLen >= 0 && bodyLen < 1500) {
      // 页面只剩导航/页脚这类静态文字，说明内容区根本没渲染出来
      lines.push(`页面正文只有 ${bodyLen} 个字符，内容区基本是空的 —— 说明这个链接当前打不开作品列表`);
    }
    if (pageUrl && /login|passport/i.test(pageUrl)) {
      lines.push('页面已被重定向到登录页');
    } else if (pageUrl && !pageUrl.includes('user/profile') && !pageUrl.includes('user/')) {
      lines.push(`页面最终地址已不在博主主页上：${pageUrl}`);
    }
    if (this.intercepted === 0) {
      lines.push(
        '一个相关接口请求都没截获到：多半是链接里的 token 已失效（重新在浏览器打开该博主主页并复制地址），或该账号当前不展示作品'
      );
      /**
       * 「页面渲染得很正常，却一个请求都没发」—— 抖音改版后就是这个形态：
       * 作品区被放进独立的 overflow 容器，滚 window 完全无效，懒加载永远不触发。
       * 采集器已经按「页面里差最大的可滚动容器」兜底（见 scrollPageToBottom），
       * 真到这一步说明结构又变了，把页面滚动信息一并摆出来，下次能直接定位。
       */
      if (bodyLen >= 1500) {
        let scrollInfo = '';
        try {
          scrollInfo = String(
            await Promise.race([
              this.win.webContents.executeJavaScript(SCROLL_TO_BOTTOM_JS),
              sleep(2000).then(() => ''),
            ])
          );
        } catch {
          /* 忽略 */
        }
        lines.push(
          `页面正文有 ${bodyLen} 个字符（内容区已渲染）${scrollInfo ? `，页面可滚动量 ${scrollInfo}` : ''} —— 说明滚动没有触发到加载更多的容器上`
        );
      }
    }
    return lines.join('；');
  }

  stop() {
    this.stopped = true;
  }

  /**
   * 兜底：有些主页首屏是服务端直出的（作品数据塞在 window.__INITIAL_STATE__ 之类的全局对象里），
   * 压根不会走 fetch/XHR，截获不到。这里在页面上下文里把作品数组翻出来。
   *
   * 识别逻辑全部收敛在 core/ssr-walk.js（纯函数，可离线单测）——
   * 这里只负责「从页面里取到 roots + 把函数序列化注入」。
   * 之前的判定逻辑内联在这个字符串里，既认不出 Vue 的 ref 包装、
   * 也不认小红书的 note_card，导致「有数据却一条都捞不到」且无法单测。
   */
  async _harvestSSR() {
    if (!this.win || this.win.isDestroyed()) return 0;
    /**
     * 节流（J-1）：同一 URL 上 900ms 内只探一次。
     *
     * 为什么盯 URL 而不是盯时间：详情补全阶段每篇都是新 URL（必须探），
     * 而同一篇页面在等待期间会被翻很多次 —— 每次都遍历全部全局对象（包括
     * 一堆 Vue/React 的响应式代理），是采集期间最重的操作之一。
     * 900ms 是实测平衡点：详情页的数据落在 4.6s / 10.8s 这类**秒级**时间上，
     * 900ms 的粒度足够细，同时把无效探测砍掉一大半。
     */
    let url = '';
    try {
      url = this.win.webContents.getURL() || '';
    } catch {
      url = '';
    }
    const now = Date.now();
    if (url && url === this._ssrUrl && now - this._ssrAt < this.ssrMinGapMs) return 0;
    this._ssrUrl = url;
    this._ssrAt = now;

    /**
     * 取根对象与捞作品数组的脚本收敛在 core/ssr-walk.js（纯函数、可离线单测）——
     * 这里只负责「把脚本注入页面 + 把结果转成 ingest 认识的结构」。
     *
     * ⚠️ 脚本里的 `plain(...)` 不能省。
     *
     * 作品对象里混着 Vue 响应式代理 / DOM 引用 / 环，`executeJavaScript` 要把它
     * 跨进程序列化成 JSON 会直接失败 —— 而失败原本被下面的 `catch` 静默吞掉，
     * 于是「页面里明明有 51 条作品」和「一条都没采到」长期共存，日志上完全看不出来。
     *
     * 这段脚本现在是 core/ssr-walk.js 的 SSR_BUNDLE_JS，与单作品采集器
     * （core/single-harvest.js）共用同一份 —— 避免「改一处漏一处」。
     */
    const js = SSR_BUNDLE_JS;

    try {
      const got = await this.win.webContents.executeJavaScript(js);
      const arr = got && got.notes;
      if (!Array.isArray(arr) || !arr.length) return 0;
      if (got.hits && got.hits.length) this.ssrRoots = got.hits.join(', ');
      this.ssrFound = arr.length;
      if (got.raw > arr.length) {
        // 有作品因为含循环引用/超深结构被丢弃 —— 必须说出来，否则又是一次静默退化
        this.onLog(`首屏直出数据里有 ${got.raw - arr.length} 个作品含不可序列化字段，已跳过`);
      }
      // 只有「翻到了数据」才算一次有效信号（详见 ssrHits 的注释）
      this.ssrHits++;
      const added = this.ingest('ssr:initial-state', this.wrapSSR(arr));
      if (added) this.onLog(`首屏直出数据里提取到 ${added} 个作品`);
      return added;
    } catch (err) {
      /**
       * 之前这里是 `catch { return 0 }` —— 把「页面里有数据却带不过来」彻底吞掉了。
       * 现在记下来：它和「页面里没数据」是完全不同的两件事，处置方式完全相反。
       */
      this.ssrError = (err && err.message) || String(err);
      return 0;
    }
  }

  /**
   * 详情页补全：逐个打开「信息不全」的作品详情，把完整图集/视频补回来。
   *
   * 为什么必须有这一步（小红书）：
   *   博主主页列表里每个作品节点**只有一张封面**（实测确认），
   *   完整图集与视频地址只在作品详情里。不补全的话：
   *     · 9 图的笔记只下到 1 张
   *     · 视频笔记连视频都没有，只下到一张封面
   *   而这两件事用户从界面完全看不出来，只会觉得「这软件漏图」。
   *
   * 结束条件用「媒体数变多就提前收工」而不是死等固定时长：
   *   多数详情页 1~2 秒就把数据填好了，等满 4 秒纯属浪费 ——
   *   200 篇作品下，这点差别是 3 分钟和 13 分钟的区别。
   */
  /**
   * 这篇作品该打开哪个详情页。
   *
   * 优先平台适配器的 `detailUrlOf`；它算不出来（或算出来是空的）时退回统一模型里
   * 已经带好的 `noteDetail`。**这个兜底不是多余的保险**：适配器的详情地址是
   * 「带令牌」才有效的，一旦它重算时拿不到令牌就会把一条能用的地址降级成会跳走的地址 ——
   * 那正是「图集补全成功 0/10」的成因。两条路都走不通才判定为「打不开详情」。
   */
  _detailUrlFor(it) {
    let byAdapter = '';
    try {
      byAdapter = (this.detailUrlOf && this.detailUrlOf(it)) || '';
    } catch {
      byAdapter = '';
    }
    return byAdapter || (it && typeof it.noteDetail === 'string' ? it.noteDetail : '');
  }

  async _fillDetails() {
    if (!this.detailUrlOf || !this.needsDetail) return 0;
    if (!this.win || this.win.isDestroyed()) return 0;

    let targets = [...this.items.values()].filter((it) => {
      try {
        return !!this.needsDetail(it) && !!this._detailUrlFor(it);
      } catch {
        return false;
      }
    });
    if (!targets.length) return 0;

    if (this.detailLimit && targets.length > this.detailLimit) {
      this.onLog(`需补全图集的作品有 ${targets.length} 个，按「最多作品数」只补前 ${this.detailLimit} 个`);
      targets = targets.slice(0, this.detailLimit);
    }

    this.onLog(`列表页只给出封面，正在逐个打开 ${targets.length} 个作品详情补全图集/视频…`);
    this.detailPhase = true; // 只接受已知 id，挡掉详情页底部的「相关推荐」
    let filled = 0;
    let noGain = 0;
    const interceptedBefore = this.intercepted;
    /**
     * 提前收工的判据必须是「**最近几篇作品的数据都没看到**」，而不是「没截获到响应」。
     *
     * 页面每时每刻都在发无关请求（站点配置、未读计数、IM 会话…），
     * 这些同样会被注入脚本当成「候选响应」转发过来 —— 用「有没有截获到响应」当信号，
     * 噪声永远在涨，这条提前收工就永远不会触发（实测：补全期间收到 120 个响应，
     * 其中没有一个是作品数据）。换成 touches 才真的能区分
     * 「详情页是死的（404 / 令牌失效）」和「这些笔记本来就只有一张图」。
     *
     * 本轮把「整场是否见过数据」改成**滑动窗口**（J-2）：
     *   早先用的是 `!sawWithData`（整场一次都没见过），于是只要开头成功补全过一篇，
     *   后面 200 篇全是 404 也会一路跑到时间上限 —— 用户白等十几分钟。
     *   现在只看**最近 3 篇**：它们既没有增益、也没有任何一篇返回过数据，就认定
     *   「这一批详情链接已经失效」，立刻收工。中途只要有一篇见到数据，窗口自然滚掉。
     */
    const recent = []; // 最近 3 篇：{ gain: boolean, hadData: boolean }
    const RECENT_WINDOW = 3;
    /** 全程见过数据的篇数（只用于收尾日志区分「成功 0」的两种成因） */
    let sawWithData = 0;
    /**
     * 补全总预算（J-2）：`min(30 分钟, 目标数 × 12 秒)`。
     *
     * 12 秒 ≈ 单篇详情页的实测上限（detailPollMs × detailRounds ≈ 12.8s）。
     * 没有这个上限时，300 篇的作品即便每篇都慢慢等也没有任何约束；
     * 有了它，最坏情况 30 分钟内收尾，而小批量（10 篇）只给 2 分钟 —— 足够。
     */
    const budgetMs = Math.min(30 * 60 * 1000, targets.length * 12000);
    const detailStarted = Date.now();

    for (let i = 0; i < targets.length; i++) {
      if (this.stopped) break;
      /**
       * 总预算检查放在**每篇开头**：单篇最长可以等 12 秒，放在开头才能保证
       * 「超出预算就不再开新的一篇」，收益最直接。
       */
      if (Date.now() - detailStarted > budgetMs) {
        this.onLog(
          `图集补全已用完总时限（${Math.round(budgetMs / 1000)} 秒），停止继续补全（已完成 ${i}/${
            targets.length
          }，列表页封面照常下载）`
        );
        break;
      }
      const target = targets[i];
      const id = target.id;
      const before = mediaScore(this.items.get(id));
      const seenBefore = this.touches.get(id) || 0;
      const url = this._detailUrlFor(target);
      if (!url) continue;

      try {
        await this.win.loadURL(url);
      } catch {
        /* 打不开就保持列表页那点信息，不影响其它作品 */
      }

      /**
       * 等到「这篇作品的数据真的出现」为止，而不是死等固定轮数。
       *
       * 小红书详情页把数据填进首屏 store 的实测时间是 4.6s / 10.8s（还有单图笔记永远是 1 个媒体），
       * 而旧逻辑最后一次翻首屏数据是在约 4.5s —— 刚好全部错过。
       * 现在每一轮都看一眼「这篇的数据出现了吗」：
       *   · 出现了 → 再多等 detailSettleRounds 轮（让更完整的版本进来）就收工
       *   · 一直没出现 → 一直等到上限（兜底）
       * 于是单图笔记不会白等满上限，晚到的图集也不会被漏掉。
       */
      let seenAt = -1;
      for (let k = 0; k < this.detailRounds; k++) {
        if (this.stopped) break;
        await sleep(this.detailPollMs);
        // 详情页的数据主要走服务端直出，所以要勤翻全局对象（隔一轮一次 + 最后一轮必翻）
        if (k % 2 === 1 || k === this.detailRounds - 1) await this._harvestSSR();

        const touched = (this.touches.get(id) || 0) > seenBefore;
        if (touched) {
          if (seenAt < 0) seenAt = k;
          sawWithData++;
        }
        // 媒体变多就收工（图集补进来了）
        if (mediaScore(this.items.get(id)) > before && (touched || k >= 3)) break;
        // 数据已到位，再等两轮收尾就够了 —— 不必把上限耗完
        if (seenAt >= 0 && k >= seenAt + this.detailSettleRounds) break;
      }

      const after = mediaScore(this.items.get(id));
      const gained = after > before;
      const hadData = (this.touches.get(id) || 0) > seenBefore;
      if (gained) {
        filled++;
        noGain = 0;
      } else {
        noGain++;
      }
      recent.push({ gain: gained, hadData });
      if (recent.length > RECENT_WINDOW) recent.shift();

      /**
       * 提前收工：最近 3 篇**既没增益、也没有一篇返回过数据**。
       * 两个条件必须同时成立 —— 只看 noGain 会误杀「这些笔记本来就只有一张图」的正常情况
       * （那种情况详情页是**有**数据的，只是媒体数不变）。
       */
      const windowFull = recent.length >= RECENT_WINDOW;
      const windowDead = windowFull && recent.every((r) => !r.hadData);
      if (noGain >= RECENT_WINDOW && windowDead) {
        this.onLog(
          `连续 ${noGain} 篇都没能补全，且最近 ${RECENT_WINDOW} 篇详情页都没有返回任何作品数据 —— 提前结束补全（列表页的封面仍会照常下载）`
        );
        break;
      }

      if ((i + 1) % 5 === 0 || i + 1 === targets.length) {
        this.onLog(`图集补全进度：${i + 1}/${targets.length}（成功 ${filled}）`);
      }
    }

    this.detailPhase = false;
    /**
     * 收尾日志必须带上「这段时间收到了多少响应」。
     *
     * 因为「成功 0」有且只有两种成因，而它们要采取的动作完全相反：
     *   · 收到了不少响应却一条都没补全 → 解析/字段对不上，或者是令牌换来的空数据
     *   · 一个响应都没收到           → 详情页压根没打开成（地址无效 / 被跳走）
     * 之前只打一句「成功补全 0 / N 个作品」，两种成因在日志里长得一模一样，
     * 用户只能看到「图集没下下来」却无从下手。这里把可观测事实一并写出来。
     */
    const gotResponses = this.intercepted - interceptedBefore;
    /**
     * 「成功 0」的两种成因要分开说，否则用户只能看到一句没有指向的话：
     *   · 一篇作品的数据都没看到 → 详情链接失效 / 被跳走（要重新粘链接）
     *   · 看到过数据但媒体没变多 → 这些笔记本来就是单图（不是故障，不用管）
     */
    const hint = filled === 0 && !sawWithData
      ? '（详情页全程没有返回作品数据 —— 多为详情链接已失效，请重新打开博主主页复制新链接）'
      : filled === 0
        ? '（详情页数据取到了，但媒体数没有变多 —— 这些笔记本身可能只有一张图）'
        : '';
    this.onLog(
      `图集补全结束：成功补全 ${filled} / ${targets.length} 个作品（补全期间收到 ${gotResponses} 个响应，其中 ${sawWithData} 篇看到过作品数据）${hint}`
    );
    return filled;
  }

  async start() {
    this.win = new BrowserWindow({
      show: this.showWindow,
      width: 1366,
      height: 900,
      webPreferences: {
        partition: this.partition,
        preload: path.join(__dirname, '..', '..', 'preload', 'harvest-preload.js'),
        // 关键点：注入脚本必须与页面脚本处于同一个 JS 世界，
        // 否则 contextIsolation 会把它隔离出去，包装的 fetch/XHR 页面根本用不到，截获全部落空。
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false, // 后台窗口不能被节流，否则不会加载更多
        /**
         * 判定「该截哪个响应」的函数必须这样传下来，不能 `require`。
         * 采集窗是 sandbox 化的，沙箱 preload 的 `require` 只认
         * electron / events / timers / url —— 相对路径会直接 `module not found`，
         * 而 preload 一挂，症状是**采集永远 0 个作品**（真机探针实测，
         * 见 test/harvest-preload.test.js）。关 sandbox 能解决，但这个窗口加载远端页面、
         * 且 contextIsolation 必须为 false，不值得为此放开完整 Node 能力。
         * 这与 core/ssr-walk.js、SCROLL_TO_BOTTOM_JS 是同一套手法。
         */
        additionalArguments: harvestArguments(),
      },
    });

    // 采集窗是深链最容易被触发的地方（博主主页里到处是「打开 App 看更多」）。
    // 这里一律 deny：本窗口的职责只是待着让页面自己发请求，
    // 一旦让它导航走或开新窗，采集就断了；更要紧的是自定义协议会被交给操作系统。
    attachUrlGuards(this.win.webContents, {
      log: (m) => this.onLog(m),
      // 博主主页会频繁弹窗，正常的 http(s) 弹窗不必报给用户，只报真正被拦下的深链
      notifyWebOpen: false,
    });

    this.onLog(`正在打开博主主页：${this.url}`);
    try {
      await this.win.loadURL(this.url);
    } catch (err) {
      this.onLog(`页面加载失败：${err.message}`);
    }

    await sleep(2500); // 等首屏请求发出
    await this._harvestSSR(); // 首屏若走服务端直出，fetch 钩子抓不到，这里补一次

    // 未登录通常会被重定向到登录页
    const current = this.win.webContents.getURL();
    if (/login|passport/i.test(current) && !/login/i.test(this.url)) {
      this.onLog('检测到页面跳转到登录页 —— 请先完成登录再采集');
    }

    const started = Date.now();
    let idle = 0;
    let round = 0;
    let lastCount = this.items.size;
    /**
     * 前几轮不许「无新增」判定退出。
     *
     * 原先的循环是「连续 maxIdle 轮没新增就结束」，从第 1 轮就开始计数，
     * 于是 `sleep(2500)` 之后只要页面还没把作品填进来（慢网、首屏还在异步取数），
     * 大约 9 秒就会判成「没有作品」—— 对一个还在加载的页面来说太快了。
     * 这里给一个「热身轮数」：热身期间只滚动、不计 idle。
     */
    const minRounds = Math.max(this.maxIdle, this.minRounds);

    while (!this.stopped && Date.now() - started < this.timeoutMs) {
      round++;
      try {
        /**
         * 每 5 轮强制重扫一次滚动容器（懒加载可能换掉节点）；
         * 其余轮次用上一轮缓存的「子节点下标链」，省掉整页的 getComputedStyle。
         */
        const forceScan = round % 5 === 0 || !this._scrollPath;
        const got = await this.win.webContents.executeJavaScript(
          scrollScriptWith(forceScan ? null : this._scrollPath)
        );
        if (got && typeof got === 'object') {
          // 缓存未命中（hit=false）时 got.path 就是新一轮算出来的容器
          if (got.path) this._scrollPath = got.path;
          else if (got.hit === false) this._scrollPath = null;
        }
      } catch {
        /* 页面跳转/销毁时忽略 */
      }
      /**
       * 自适应间隔（J-1）：这一轮有新内容就快一点（700ms），没新内容就慢下来（1300ms）。
       * 早先固定 1300ms —— 有新增时白等半秒，几十轮下来是十几秒的差距；
       * 而空闲时把间隔压到 700ms 又会白白多滚几十次。
       */
      const grewLast = this.items.size > lastCount || round === 1;
      await sleep(grewLast ? this.activeSleepMs : this.idleSleepMs);

      // 首屏数据是异步填进前端 store 的：只在开头取一次很可能取到空壳。
      // 还没拿到任何作品时，每隔几轮再取一次，直到有内容为止。
      if (this.items.size === 0 && round % 3 === 0) {
        await this._harvestSSR();
      }

      const count = this.items.size;
      if (count > lastCount) {
        lastCount = count;
        idle = 0;
        this.onLog(`已采集 ${count} 个作品`);
      } else if (round >= minRounds) {
        // 热身期结束才开始累计「连续无新增」
        idle++;
        if (idle >= this.maxIdle) {
          this.onLog('连续多次滚动无新增内容，采集结束');
          break;
        }
      }

      /**
       * 页面自己说没有下一页 → 不必再猜「连续 N 轮无新增」，本轮就收工。
       * 把 idle 抬到 maxIdle-1 而不是直接 break，是为了让本轮已有的日志与
       * 「已采集 N 个作品」正常走完（下一轮进来 idle 再加一就退出）。
       */
      if (this.noMorePages) {
        this.noMorePages = false;
        if (idle < this.maxIdle - 1) {
          idle = this.maxIdle - 1;
          this.onLog('接口已返回「没有更多」，不再继续滚动');
        }
      }

      /**
       * 采够就停（J-1）：早先只由编排层在采集结束后截断，采集器仍然会把主页滚到底。
       * 「最多 10 个作品」却滚了 200 个的时长全白花，而且请求越多越容易被风控。
       */
      if (this.maxItems && this.items.size >= this.maxItems) {
        this.onLog(`已采集到设定的上限 ${this.maxItems} 个作品，停止继续滚动`);
        break;
      }
    }

    if (Date.now() - started >= this.timeoutMs) this.onLog('达到采集时间上限，结束采集');

    /**
     * 列表阶段的收尾账目（P1-14）：**新增与更新分开说**。
     *
     * 早先「同一作品拿到更完整的一份」也会算进 `added`，于是
     * 「已采集 N 个作品」的数字会反复上涨、最后又回落到真实条数 ——
     * 用户看到的是「数字乱跳」，其实是把更新当成了新增。
     */
    if (this.items.size) {
      const skippedText = this.parseSkipped ? `，解析跳过 ${this.parseSkipped} 条异常数据` : '';
      this.onLog(
        `列表采集完成：共 ${this.items.size} 个作品（新增 ${this.items.size} / 更新 ${this.updated}${skippedText}）`
      );
    }

    /**
     * 一条都没采到 → 重载一次页面再试。
     *
     * 实测：同一个博主主页链接，小红书会**间歇性**返回一个只有导航/页脚的空壳
     * （正文一千多字符、作品区什么都没有），而服务端不会给出任何错误码。
     * 这种情况下重新加载一次往往就能正常渲染 —— 不做重试的话，用户看到的是
     * 「未采集到作品（截获到 19 个候选响应）」，而其实重新粘一次链接就好了，纯属白跑。
     */
    if (!this.stopped && this.items.size === 0 && this.win && !this.win.isDestroyed()) {
      this.onLog('首屏没有取到作品，重新加载一次页面再试…');
      try {
        await this.win.loadURL(this.url);
      } catch {
        /* 重载失败就按空结果收尾 */
      }
      await sleep(2500);
      await this._harvestSSR();
      for (let warm = 0; warm < 4 && !this.stopped && this.items.size === 0; warm++) {
        try {
          await this.win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight); true');
        } catch {
          /* 页面可能已跳转，忽略 */
        }
        await sleep(1300);
        await this._harvestSSR();
      }
      this.onLog(
        this.items.size > 0 ? `重载后采集到 ${this.items.size} 个作品` : '重载后仍未取到作品'
      );
    }

    // 列表采集完毕 → 再逐个补全（详情页补全期间会离开主页，所以必须放在最后）
    if (!this.stopped) {
      try {
        await this._fillDetails();
      } catch (err) {
        this.onLog(`图集补全阶段异常，已跳过：${err.message}`);
      }
    }

    // 一条都没采到时，把现场事实说清楚（比「请确认 ①②③」有用得多）
    if (this.items.size === 0) {
      try {
        this.onLog(await this._diagnoseEmpty());
      } catch {
        /* 诊断失败不影响返回空结果 */
      }
    }

    this.close();
    return [...this.items.values()];
  }

  close() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
      this.win = null;
    }
  }
}

module.exports = {
  Harvester,
  mediaScore,
  mergeItem,
  scrollPageToBottom,
  SCROLL_TO_BOTTOM_JS,
  scrollPageToBottomCached,
  scrollScriptWith,
  normalizePage,
};
