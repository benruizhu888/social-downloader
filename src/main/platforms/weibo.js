/**
 * 微博平台适配器
 *
 * 与其他两家最大的不同：微博可以直连接口（登录 Cookie 即可），
 * 不需要内嵌浏览器采集。因此这个适配器完全不走 Harvester。
 */
const { WeiboClient } = require('../sources/weibo-api');
const { safeName } = require('../core/runner');

/** 微博时间 "Tue Oct 09 22:50:04 +0800 2026" → 'YYYY-MM-DD' */
function parseWeiboDate(createdAt) {
  if (!createdAt) return '';
  const d = new Date(String(createdAt).replace(/^\w+\s/, ''));
  if (isNaN(d.getTime())) {
    const t = Date.parse(createdAt);
    if (isNaN(t)) return '';
    return fmt(new Date(t));
  }
  return fmt(d);
}
function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 微博的 media → 统一 media 模型 */
function normalizeMedia(m) {
  if (m.kind === 'image') {
    return { kind: 'image', url: m.url, candidates: m.candidates || [m.url], ext: m.ext || 'jpg' };
  }
  if (m.kind === 'video') {
    return {
      kind: 'video',
      url: m.url,
      /**
       * 视频必须把候选链带出去。
       *
       * 微博视频地址带签名（`?Expires=…&ssig=…`），会过期；一条微博通常同时有
       * 1080p/hd/720p/ld/sd/HLS 好几档，签名各自独立。早先这里把 altUrls 丢了，
       * 于是每段视频只剩一个地址 —— 一旦 403 就直接失败，
       * 日志里就是「189 个文件成功，4 个视频 HTTP 403」，连一次回退机会都没有。
       */
      altUrls: m.altUrls || [],
      ext: m.ext || 'mp4',
      cover: m.cover || null,
      coverCandidates: m.cover ? [m.cover] : [],
    };
  }
  if (m.kind === 'livephoto') {
    return {
      kind: 'livephoto',
      url: m.url,
      // https 升级失败的兜底地址要一起带出去（动态片段同样可能是明文 http）
      altUrls: m.altUrls || [],
      ext: m.ext || 'mp4',
      cover: m.cover || null,
      coverCandidates: m.coverCandidates || (m.cover ? [m.cover] : []),
    };
  }
  return null;
}

function toUnified(post) {
  return {
    id: post.id,
    title: post.text || '',
    dateHint: parseWeiboDate(post.createdAt),
    filePrefix: safeName(post.text, 24),
    folderTitle: '',
    author: '',
    likeCount: null,
    medias: (post.medias || []).map(normalizeMedia).filter(Boolean),
    isRetweet: post.isRetweet,
    authorUid: post.authorUid,
  };
}

module.exports = {
  id: 'weibo',
  name: '微博',
  siteURL: 'https://weibo.com',
  referer: 'https://weibo.com/',
  partition: 'persist:weibo',
  loginURL: 'https://passport.weibo.com/sso/login.php?url=https%3A%2F%2Fweibo.com%2F&display=0',
  // 判定登录态的关键 Cookie（SUB 只有真登录才会有，实测可靠）
  loginMarks: ['SUB'],
  /** 匿名访问就会产生的 Cookie，只用于信息展示，绝不作为登录依据 */
  weakMarks: ['SUBP', 'SSOLoginState', 'XSRF-TOKEN', 'WBPSESS'],
  /**
   * 关键 Cookie 存在即等价于已登录。
   *
   * 依据（在本机真实分区上核对过）：登录后 SUB 会同时落在 `.weibo.com`、`.weibo.cn`、
   * `.sina.com.cn` 三处，有效期一年 —— 而匿名访问只会拿到 SUBP，不会拿到 SUB。
   * 所以微博不需要「指纹」这一层。
   *
   * 为什么必须显式声明：小红书/抖音的 web_session / ttwid 是匿名即下发的，
   * 它们绝不能开这个能力位，否则又会回到「点登录就闪退」的老毛病。
   */
  trustKeyCookie: true,
  cookieDomains: ['.weibo.com', '.weibo.cn', '.sina.com.cn'],
  /** 微博是唯一支持手动粘贴 Cookie 的平台（session 丢登录态时的兜底） */
  supportsManualCookie: true,
  /** 主页接口会返回转发微博，需要「仅原创」过滤 */
  supportsOnlyOriginal: true,
  supportsOriginalImage: true,
  supportsLivePhoto: true,
  /** 「仅原创」过滤的日志措辞（微博语境） */
  filterLabels: { retweet: '转发微博', other: '非本账号发布的微博' },
  /** 内嵌浏览器采集？微博不需要 */
  needsBrowserHarvest: false,
  /**
   * 抓数据要把 Cookie 头注入 fetch（接口直连型平台）。
   * 小红书/抖音走浏览器内采集，签名在页面环境里生成，不需要注入。
   * 用能力位而不是在 main.js 里判 `p.id === 'weibo'`：加平台时不必改主进程。
   */
  injectCookieIntoFetch: true,
  /** 采集方式是分页读接口，不是滚动加载，选项也不同 */
  inputMeta: {
    placeholder: '粘贴微博主页链接 / 单条微博链接 / UID / 昵称',
    hint: '微博：支持主页链接（weibo.com/u/1234567890，批量下载）、单条微博链接（只下载这一条）、纯 UID，或直接输入昵称搜索',
    /** 界面「支持三种输入」说明块里的示例（只说明格式，不是可下载地址） */
    exampleProfile: 'https://weibo.com/u/1234567890',
    exampleItem: 'https://weibo.com/1234567890/P0RSAbcde',
  },
  defaultOptions: {
    outDir: '',
    lastInput: '',
    downloadImages: true,
    downloadVideos: true,
    downloadLive: true,
    convertLiveToMov: true,
    organizeByDate: true,
    skipExisting: true,
    originalQuality: true,
    onlyOriginal: true,
    concurrency: 4,
    maxPages: 200,
    maxItems: 0,
  },
  /**
   * 选项声明。
   *
   * `scope: 'profile'` = **只在博主主页批量模式生效**，界面会在「单个/多个作品」模式下
   * 自动隐藏它（见 renderer/app.js 的 applyOptionScope）。加这个标记的原因是：
   * 单作品流程里 maxItems / maxPages / onlyOriginal 确实不会被读取，
   * 让它们留在界面上，用户会以为「我设了最多 5 个，怎么没生效」。
   * 判断依据是 runner 里的实际行为，不是猜测 —— 加选项时要跟代码对一遍。
   */
  optionsSchema: [
    { key: 'downloadImages', label: '下载图片', type: 'bool' },
    { key: 'downloadVideos', label: '下载视频', type: 'bool' },
    { key: 'downloadLive', label: '下载 Live Photo 动态片段', type: 'bool' },
    { key: 'convertLiveToMov', label: 'Live Photo 转 MOV', type: 'bool' },
    { key: 'organizeByDate', label: '按日期分目录', type: 'bool' },
    { key: 'originalQuality', label: '下载原图', type: 'bool' },
    { key: 'onlyOriginal', label: '只要原创（排除转发）', type: 'bool', scope: 'profile' },
    { key: 'skipExisting', label: '跳过已存在文件', type: 'bool' },
    { key: 'concurrency', label: '并发数', type: 'number', min: 1, max: 16, step: 1 },
    {
      key: 'maxPages',
      label: '最多抓取页数',
      type: 'number',
      min: 1,
      max: 2000,
      step: 10,
      hint: '每页约 10 条微博',
      scope: 'profile',
    },
    {
      key: 'maxItems',
      label: '最多作品数',
      type: 'number',
      min: 0,
      max: 20000,
      step: 50,
      hint: '0 表示不限',
      scope: 'profile',
    },
  ],

  /**
   * 采集作品。微博直接用注入 Cookie 的 fetch 走接口。
   * @returns {{ items: Array, rootId: string }}
   */
  async collectItems({ input, options, ctx, emit, log, signal }) {
    const client = new WeiboClient({
      fetchImpl: ctx.fetchImpl,
      cookie: ctx.cookie || '',
      logger: log,
    });

    emit({ type: 'phase', phase: 'resolve', message: '正在解析博主…' });
    const uid = await client.resolveUid(input);
    log(`博主 UID：${uid}`);
    emit({ type: 'uid', uid });

    emit({ type: 'phase', phase: 'fetch', message: '正在读取微博列表…' });
    let totalPosts = 0;
    const posts = await client.fetchPosts(uid, {
      maxPages: Number(options.maxPages) || 200,
      signal,
      onPage: (pagePosts, pageNo) => {
        totalPosts += pagePosts.length;
        emit({ type: 'fetch-progress', page: pageNo, posts: totalPosts });
      },
    });
    log(`共读取 ${posts.length} 条微博`);

    return { items: posts.map(toUnified), rootId: uid };
  },

  /**
   * 采集**单条**微博。
   *
   * 微博是唯一走接口直连的平台，所以不需要采集窗 —— 直接调
   * `ajax/statuses/show`（refreshMediaUrls 用的也是它，那条路的可用性已经被验证过）。
   *
   * 为什么不从主页列表里找那一条：用户粘来的可能是别人的微博、也可能是很久以前的，
   * 为了找它把整个主页翻一遍既慢又浪费请求。
   *
   * `altIds` 是同一个微博的另一种编号形态（base62 的 mid ↔ 十进制 id）。
   * 接口主要吃 mid，但换版本后也可能只认数字 id，所以依次试 —— 全部失败才报错。
   */
  async collectSingleItem({ itemId, altIds = [], ctx, emit, log }) {
    emit({ type: 'phase', phase: 'fetch', message: '正在读取这条微博…' });
    const client = new WeiboClient({
      fetchImpl: ctx.fetchImpl,
      cookie: ctx.cookie || '',
      logger: log,
    });

    const ids = [itemId, ...altIds].filter(Boolean);
    let post = null;
    for (const id of ids) {
      post = await client.fetchPostDetail(id);
      if (post) break;
      log(`按 id=${id} 没取到，换下一种编号形态重试…`);
    }
    if (!post) {
      throw new Error(
        `没能读取这条微博（id=${itemId}）：可能是链接已失效、微博被删除，或这条微博仅自己可见`
      );
    }

    const item = toUnified(post);
    if (!item.medias.length) {
      log('提示：这条微博没有可下载的图片或视频（可能是纯文字微博）');
    }
    return { items: [item], rootId: itemId };
  },

  /**
   * 某个下载任务失败（403/404）之后，重新取一份**带新签名**的地址。
   *
   * 微博视频/实况视频的地址带 `Expires` 与 `ssig`，是会过期的：列表接口一次性
   * 拿回几百条，排到队尾去下载时签名早已失效 —— 这就是「189 个成功、4 个视频 403」。
   * 候选链（各画质档）能救回一部分，但整个 `page_info` 都过期时就只能回接口重读。
   *
   * 返回空数组 = 拿不到新地址，下载器按原样报失败；下载器对这个钩子**只调用一次**，
   * 不会形成重试风暴。
   */
  async refreshMediaUrls(task, { ctx } = {}) {
    if (!task || !task.itemId) return [];
    if (task.kind !== 'video' && task.kind !== 'live-src') return [];
    try {
      const client = new WeiboClient({ fetchImpl: ctx && ctx.fetchImpl, cookie: (ctx && ctx.cookie) || '' });
      const post = await client.fetchPostDetail(task.itemId);
      if (!post) return [];
      const want = task.kind === 'video' ? 'video' : 'livephoto';
      const urls = [];
      for (const m of post.medias || []) {
        if (m.kind !== want) continue;
        for (const u of [m.url, ...(m.altUrls || [])]) {
          if (u && !urls.includes(u)) urls.push(u);
        }
      }
      return urls;
    } catch {
      return []; // 刷新失败不该把「一次普通失败」升级成异常
    }
  },
};

module.exports.toUnified = toUnified;
module.exports.normalizeMedia = normalizeMedia;
module.exports.parseWeiboDate = parseWeiboDate;
