/**
 * 小红书平台适配器
 *
 * 小红书接口需要 x-s / x-t 签名（页面混淆 JS 实时生成），直连必然失败，
 * 因此走浏览器内采集：真实页面自己发带签名的请求，注入脚本复制响应。
 */
const { Harvester } = require('../core/harvester');
const { SingleHarvester } = require('../core/single-harvest');
const { parseXhsResponse } = require('../sources/parsers/xhs');

/** 从主页链接里提取账号标识，用于建目录 */
function extractChannelId(input) {
  const s = String(input || '');
  const m = s.match(/user\/profile\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  const m2 = s.match(/\/user\/([A-Za-z0-9_-]+)/);
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
        // 解析层已按「原图优先」排好序，这里整条链带过去，由编排层按开关取舍
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
    likeCount: it.likeCount,
    /**
     * ⚠️ 令牌必须一起带到统一模型里 —— 这是本轮修掉的那个「每篇只下一张封面」的真凶。
     *
     * 采集器把「统一 item」交给 `detailUrlOf` 去算详情地址，而它算的时候会**再查一次
     * `it.xsecToken`**。早先这里没把令牌带出来，于是：
     *   · 解析层算出的 `noteDetail` 是**带令牌的**（对的）
     *   · 采集器重算出来的却是**裸 `/explore/<id>`**（令牌丢了）
     * 而真正被 loadURL 打开的是后者 → 小红书对无令牌地址返回空壳 →
     * 10 篇详情页全都补不出图集，日志只显示「成功补全 0 / 10」，看不出任何原因。
     */
    xsecToken: it.xsecToken || '',
    /** 详情页地址（带上打开它必需的 xsec_token）——列表页只给封面，完整图集要去这里拿 */
    noteDetail: noteDetailUrlOf(it),
    medias,
  };
}

/**
 * 这篇作品的详情页地址。
 *
 * `xsec_token` 是必须的：小红书对「未带令牌直接访问 /explore/<id>」会跳走或返回空，
 * 表现就是「补全阶段全部失败」而看不出原因。令牌来自列表数据本身，不额外请求。
 *
 * 这是个**幂等**函数：`noteDetailUrlOf(toUnified(x)) === toUnified(x).noteDetail`。
 * 没有令牌时不能硬拼一个会跳走的地址 —— 如果上游已经把可用的详情地址算好
 * （`noteDetail` 字段），就直接沿用，别把一条能用的地址降级成一条会跳走的地址。
 */
function noteDetailUrlOf(it) {
  const id = it && it.id ? String(it.id) : '';
  if (!id) return '';
  const token = it && it.xsecToken ? String(it.xsecToken) : '';
  if (token) {
    return `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user`;
  }
  const known = it && typeof it.noteDetail === 'string' ? it.noteDetail : '';
  if (known) return known;
  return `https://www.xiaohongshu.com/explore/${id}`;
}

/**
 * 这份作品是不是「列表页信息不全」。
 *
 * 小红书主页的列表节点**只有一张封面**（实测确认），所以：
 *   · 只有 1 张图   → 可能只是封面，真实图集可能有 9 张
 *   · 一张媒体都没有 → 必须先补
 *   · 已经有视频/实况 → 列表页信息是完整的，不必浪费一次详情页（每次约 1~3 秒）
 * 从这个判定出发，视频笔记也会被补全 —— 列表节点里连视频地址都没有。
 */
function needsNoteDetail(it) {
  const m = (it && it.medias) || [];
  if (m.length === 0) return true;
  if (m.length > 1) return false;
  return m[0].kind === 'image';
}

module.exports = {
  id: 'xhs',
  name: '小红书',
  siteURL: 'https://www.xiaohongshu.com',
  referer: 'https://www.xiaohongshu.com/',
  partition: 'persist:xhs',
  loginURL: 'https://www.xiaohongshu.com/explore',
  /**
   * 实测：匿名访问 explore 页 2.7 秒后就会写入 web_session / webId / a1，
   * 所以「存在」不等于「已登录」。这里只保留 web_session 作为候选关键 Cookie，
   * 真正的判定交给 LoginState 的指纹验证（值发生变化才算用户登录）。
   */
  loginMarks: ['web_session'],
  weakMarks: ['webId', 'a1', 'gid', 'acw_tc', 'websectiga', 'sec_poison_id'],
  cookieDomains: ['.xiaohongshu.com'],
  supportsManualCookie: false,
  supportsOnlyOriginal: false, // 主页接口只返回本人作品，无需过滤
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
    placeholder: '粘贴小红书博主主页链接，或单篇笔记链接',
    hint: '小红书：主页链接批量下载；单篇笔记链接只下载这一条。采集靠内置浏览器滚动加载，必须先登录。',
    exampleProfile: 'https://www.xiaohongshu.com/user/profile/XHS_USER_ID_PLACEHOLDER',
    exampleItem: 'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER?xsec_token=XHS_XSEC_TOKEN_PLACEHOLDER',
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
    /** 逐篇打开详情补全图集/视频：关掉会快很多，但每篇只能拿到一张封面 */
    fetchNoteDetail: true,
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
    {
      key: 'fetchNoteDetail',
      label: '逐篇补全图集',
      type: 'bool',
      hint: '较慢但完整',
      scope: 'profile',
    },
    { key: 'skipExisting', label: '跳过已存在文件', type: 'bool' },
    { key: 'concurrency', label: '并发数', type: 'number', min: 1, max: 16, step: 1 },
    { key: 'maxItems', label: '最多作品数', type: 'number', min: 1, max: 5000, step: 50, scope: 'profile' },
  ],

  extractChannelId,
  normalizeHome,
  noteDetailUrlOf,
  needsNoteDetail,

  async collectItems({ input, ctx, emit, log, setCollector, options }) {
    const opts = options || {};
    // 关掉「逐篇补全」时不必传这两个钩子，采集器自然跳过整个详情阶段
    const deep = opts.fetchNoteDetail !== false;
    const harvester = new Harvester({
      partition: ctx.partition,
      url: normalizeHome(input),
      parse: (data) => parseXhsResponse(data).map(toUnified),
      wrapSSR: (arr) => ({ data: { notes: arr } }),
      onLog: log,
      onProgress: (total, added) => emit({ type: 'harvest-progress', total, added }),
      needsDetail: deep ? needsNoteDetail : null,
      detailUrlOf: deep ? noteDetailUrlOf : null,
      // 编排层随后还会按「最多作品数」截断，超出的作品补全了也会被丢掉 → 不必白跑
      detailLimit: Number(opts.maxItems) || 0,
    });
    setCollector(harvester);

    let items = [];
    try {
      items = await harvester.start();
    } catch (err) {
      throw new Error(`采集失败：${err.message}`);
    }
    return { items, rootId: extractChannelId(input) };
  },

  /**
   * 采集**单个**作品（界面里粘贴的就是这一篇的链接）。
   *
   * 为什么不需要「逐篇补全」那一步：单作品模式打开的本来就是详情页，
   * 页面返回的数据就是完整图集（列表节点只有一张封面的问题在这里不存在）。
   *
   * `url` 直接用用户给的地址而不是重新拼一个 —— 小红书详情页**必须带 xsec_token**，
   * 而令牌只在用户复制的原始链接里。少一个参数就会 302 到 404 空壳页。
   * 缺令牌的情况仍要给出明确提示，否则用户只会看到「采不到」而不知为何。
   */
  async collectSingleItem({ url, itemId, ctx, emit, log, setCollector }) {
    emit({ type: 'phase', phase: 'harvest', message: '正在打开这篇笔记…' });
    if (!/xsec_token=/i.test(String(url))) {
      log('提示：链接里没有 xsec_token，小红书可能返回空内容。若失败请重新从网页/App 复制完整链接');
    }

    const harvester = new SingleHarvester({
      partition: ctx.partition,
      url,
      targetId: itemId,
      parse: (data) => parseXhsResponse(data).map(toUnified),
      wrapSSR: (arr) => ({ data: { notes: arr } }),
      onLog: log,
    });
    setCollector(harvester);

    const items = await harvester.start();
    if (!items.length) {
      throw new Error(
        `没能读取这篇笔记（id=${itemId}）：请确认链接可正常打开、已登录小红书，或重新复制一次作品链接`
      );
    }
    return { items, rootId: itemId };
  },
};

module.exports.toUnified = toUnified;
