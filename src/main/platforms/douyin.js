/**
 * 抖音平台适配器
 *
 * 抖音接口带 a_bogus / ArgusSecurityPlugin 校验，直连会返回
 * "Blocked by ArgusSecurityPlugin Uifid Not Found"，
 * 因此与小红书一样走浏览器内采集。
 */
const { Harvester } = require('../core/harvester');
const { SingleHarvester } = require('../core/single-harvest');
const { parseDouyinResponse } = require('../sources/parsers/douyin');

/** 从主页链接里提取 sec_uid，用于建目录 */
function extractChannelId(input) {
  const s = String(input || '');
  const m = s.match(/\/user\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const m2 = s.match(/[?&]sec_uid=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  return 'unknown';
}

function normalizeHome(input) {
  const s = String(input || '').trim();
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

function toUnified(it) {
  const medias = [];
  for (const m of it.medias || []) {
    if (m.kind === 'image') {
      medias.push({
        kind: 'image',
        url: m.url,
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
  return {
    id: it.id,
    title: it.title || '',
    dateHint: it.createdAt || '',
    filePrefix: '',
    folderTitle: it.title || '',
    author: it.author || '',
    authorUid: it.authorUid || '',
    likeCount: it.likeCount,
    medias,
  };
}

/**
 * 只保留「目标博主本人发布的作品」。
 *
 * 用户实测（第 19 轮）：下载自己的抖音主页，结果把「喜欢」里的内容也下下来了。
 * 成因有两层，这边是第二层：
 *   · 第一层在截获白名单（`src/preload/harvest-match.js`）—— 早先的匹配串
 *     `aweme/v1/web/aweme` 把 `/aweme/favorite`（喜欢）、`/aweme/related`（相关推荐）
 *     一并截了回来，而这两个接口返回的也是 `aweme_list`，结构上与「作品」一模一样；
 *   · 这一层是兜底：**作者对不上就不采信**。这样将来接口再改名、
 *     或者又冒出某个「顺带返回一串作品」的接口，也不会把别人的东西混进下载队列。
 *
 * `targetUid` 拿不到时（链接里没有 `/user/<sec_uid>`）不做过滤 ——
 * 宁可多下，也不能因为识别不出目标而一条都不采。
 *
 * @returns {object[]} 过滤后的作品，以及被丢掉多少条（用于日志说明）
 */
function itemsForChannel(data, targetUid) {
  const list = parseDouyinResponse(data);
  if (!targetUid || targetUid === 'unknown') return { items: list, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const it of list) {
    // authorUid 缺失时不做判断（宁可保留，也不能因为字段缺失就整批丢掉）
    if (it.authorUid && it.authorUid !== targetUid) {
      dropped++;
      continue;
    }
    kept.push(it);
  }
  return { items: kept, dropped };
}

module.exports = {
  id: 'douyin',
  name: '抖音',
  siteURL: 'https://www.douyin.com',
  referer: 'https://www.douyin.com/',
  partition: 'persist:douyin',
  loginURL: 'https://www.douyin.com/',
  /**
   * 实测：匿名访问 douyin.com 后 1.1 秒就会写入 ttwid，8.9 秒写入 passport_csrf_token。
   * 这两个都只是设备/风控标识，**绝不能**作为登录依据 —— 早期版本把它们算进去，
   * 结果一点「登录」按钮，窗口 1.2 秒后自动关闭，用户看到的就是「闪退」。
   * 真正只有登录后才有的会话 Cookie 是下面这几个。
   */
  loginMarks: ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt'],
  weakMarks: ['ttwid', 'passport_csrf_token', 'odin_tt', 'msToken', 'UIFID'],
  cookieDomains: ['.douyin.com'],
  supportsManualCookie: false,
  /**
   * 不开「仅原创」这个用户选项（主页里没有转发这种概念）。
   * 但注意：这不代表「不用过滤」——「喜欢」列表返回的结构和作品一模一样，
   * 过滤在 collectItems 里用作者 id 做（永远生效，不是可选项），
   * 与微博那个用户可勾选的 `onlyOriginal` 是两回事。见 itemsForChannel。
   */
  supportsOnlyOriginal: false,
  supportsOriginalImage: true,
  supportsLivePhoto: true, // 图集里的实况图带独立动态片段
  needsBrowserHarvest: true,
  /** 采集在页面环境里完成，签名由页面自己算，不需要把 Cookie 注入 fetch */
  injectCookieIntoFetch: false,
  /**
   * 关键 Cookie 存在**不等于**已登录：web_session / ttwid 匿名访问就会下发。
   * 绝不能开这个能力位，否则会回到「点一下登录就闪退」。
   */
  trustKeyCookie: false,
  inputMeta: {
    placeholder: '粘贴抖音博主主页链接，或单个作品链接',
    hint: '抖音：主页链接批量下载；单个作品链接（douyin.com/video/… 或 v.douyin.com 短链）只下载这一条。采集靠内置浏览器滚动加载，必须先登录。',
    exampleProfile: 'https://www.douyin.com/user/DOUYIN_SEC_UID_PLACEHOLDER',
    exampleItem: 'https://www.douyin.com/video/7300000000000000000',
  },
  defaultOptions: {
    outDir: '',
    lastInput: '',
    downloadImages: true,
    downloadVideos: true,
    downloadLive: true,
    convertLiveToMov: true,
    convertToMov: false,
    originalQuality: true,
    skipExisting: true,
    concurrency: 4,
    maxItems: 500,
  },
  /** `scope:'profile'` 的选项只在博主主页模式生效，界面会自动隐藏（见 weibo.js 的同名说明） */
  optionsSchema: [
    { key: 'downloadImages', label: '下载图片', type: 'bool' },
    { key: 'downloadVideos', label: '下载视频', type: 'bool' },
    { key: 'downloadLive', label: '下载 Live 图动态片段', type: 'bool' },
    { key: 'convertLiveToMov', label: 'Live 图转 MOV', type: 'bool' },
    { key: 'convertToMov', label: '视频转封装为 MOV', type: 'bool' },
    { key: 'originalQuality', label: '下载原图', type: 'bool' },
    { key: 'skipExisting', label: '跳过已存在文件', type: 'bool' },
    { key: 'concurrency', label: '并发数', type: 'number', min: 1, max: 16, step: 1 },
    { key: 'maxItems', label: '最多作品数', type: 'number', min: 1, max: 5000, step: 50, scope: 'profile' },
  ],

  extractChannelId,
  normalizeHome,

  async collectItems({ input, ctx, emit, log, setCollector }) {
    const targetUid = extractChannelId(input);
    let droppedForeign = 0;
    const harvester = new Harvester({
      partition: ctx.partition,
      url: normalizeHome(input),
      parse: (data) => {
        const r = itemsForChannel(data, targetUid);
        droppedForeign += r.dropped;
        return r.items.map(toUnified);
      },
      wrapSSR: (arr) => ({ aweme_list: arr }),
      onLog: log,
      onProgress: (total, added) => emit({ type: 'harvest-progress', total, added }),
    });
    setCollector(harvester);

    let items = [];
    try {
      items = await harvester.start();
    } catch (err) {
      throw new Error(`采集失败：${err.message}`);
    }
    // 说明给用户看：这不是失败，是把「点赞 / 推荐」里的别人的作品挡在外面了
    if (droppedForeign) {
      log(`已忽略 ${droppedForeign} 条非本博主的作品（点赞 / 推荐 / 合集等，不属于主页作品）`);
    }
    return { items, rootId: targetUid };
  },

  /**
   * 采集**单个**作品。
   *
   * 与主页采集的两处差别：
   *   1. 解析时不套 `itemsForChannel` —— 那个过滤是「只留目标博主的作品」，
   *      而单作品的目标就是这一条本身；重复过滤反而会在字段缺失时误杀。
   *   2. 真正的把关在 SingleHarvester 内部：按 aweme_id 严格匹配。
   *      详情页底部挂着「相关推荐」，结构与目标作品完全一样，只有 id 能分辨。
   */
  async collectSingleItem({ url, itemId, ctx, emit, log, setCollector }) {
    emit({ type: 'phase', phase: 'harvest', message: '正在打开这个作品…' });

    const harvester = new SingleHarvester({
      partition: ctx.partition,
      url,
      targetId: itemId,
      parse: (data) => parseDouyinResponse(data).map(toUnified),
      wrapSSR: (arr) => ({ aweme_list: arr }),
      onLog: log,
    });
    setCollector(harvester);

    const items = await harvester.start();
    if (!items.length) {
      throw new Error(
        `没能读取这个作品（id=${itemId}）：请确认链接可正常打开、已登录抖音，或重新复制一次作品链接`
      );
    }
    return { items, rootId: itemId };
  },
};

module.exports.toUnified = toUnified;
module.exports.itemsForChannel = itemsForChannel;
