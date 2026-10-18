/**
 * 单作品链接识别（纯函数 · 零依赖 · 可离线单测）
 *
 * 为什么单独抽一个模块 —— 它被三处同时使用，而这三处对「能不能 require Electron」
 * 的要求各不相同：
 *   · 平台适配器（跑在主进程，但适配器本身不 require electron）
 *   · TaskRunner（要被纯 Node 单测直接引用）
 *   · 主进程的 `input:inspect` IPC（界面里边输入边判定）
 * 所以本文件只做字符串/URL 解析：不发网络请求、不 require 任何东西。
 *
 * 覆盖的链接形态（三家 App 的「复制链接」与网页地址栏实测形态）：
 *   微博    weibo.com/<uid>/<mid>、weibo.com/detail/<mid>、
 *           m.weibo.cn/status/<mid>、m.weibo.cn/detail/<数字 id>
 *   小红书  xiaohongshu.com/explore/<id>?xsec_token=…、
 *           xiaohongshu.com/discovery/item/<id>、user/profile/<uid>/<id>
 *   抖音    douyin.com/video/<id>、douyin.com/note/<id>、
 *           douyin.com/…?modal_id=<id>、douyin.com/…?vid=<id>（信息流页正在播放的那条）、
 *           iesdouyin.com/share/video/<id>；`/user/<sec_uid>` 及其子页是博主主页
 *
 * 另外识别 `v.douyin.com` / `xhslink.com` 短链。短链的真实地址只能联网展开，
 * 这里只负责「认出来」，展开动作在 TaskRunner 里做（见 _expandShortLink）。
 *
 * ⚠️ 本模块的判定必须**保守**：宁可不识别（退回「当成博主主页」的旧行为），
 *    也不要把一个主页链接误判成单作品 —— 后者会让一次「下载全部作品」的请求
 *    变成只下一个，而且用户从界面上看不出哪里不对。
 */

/* ----------------------------- 微博 mid 编解码 ----------------------------- */

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * base62 的 mid → 十进制 id。
 *
 * 微博的规则是「每 7 位十进制 ↔ 4 位 base62」（10^7 < 62^4，所以 7 位十进制
 * 一定能塞进 4 位）。从右往左每 4 位切一段，每段解出一个十进制数 ——
 * 只有满 4 位的段才补足 7 位，最左那一段是最高位，补零会把数值本身改掉。
 *
 * ⚠️ 可逆性只对**合法 mid**（即由 idToMid 生成的那种）成立。
 *    随手编的 base62 串（例如 'P0RS…'）解出来的段可能超过 7 位十进制，
 *    此时 idToMid 再切段就会错位、还原不回去 —— 这不是 bug，是信息损失：
 *    这种串本来就不是微博生成的 mid（单测里对这一点有显式断言）。
 *    对本模块的用途（给 ajax 接口提供**备选** id）没有影响：
 *    主路径永远先用用户链接里的原始 mid，转换只是一个兜底尝试。
 *
 * @returns {string} 十进制 id；输入含非 base62 字符时返回 ''（例如路径里的保留字）
 */
function midToId(mid) {
  const s = String(mid || '');
  if (!s) return '';
  if (/^\d+$/.test(s)) return s; // 已经是数字 id
  let out = '';
  for (let i = s.length; i > 0; i -= 4) {
    const seg = s.slice(Math.max(0, i - 4), i);
    let n = 0n;
    for (const ch of seg) {
      const v = B62.indexOf(ch);
      if (v < 0) return ''; // 含非 base62 字符（例如路径里的保留字）→ 不当作 mid
      n = n * 62n + BigInt(v);
    }
    const dec = n.toString();
    out = (seg.length === 4 ? dec.padStart(7, '0') : dec) + out;
  }
  return out.replace(/^0+(?=\d)/, '');
}

/** 十进制 id → base62 的 mid（与 midToId 互逆，单测里两两互验） */
function idToMid(id) {
  const s = String(id || '');
  if (!/^\d+$/.test(s)) return '';
  let out = '';
  for (let i = s.length; i > 0; i -= 7) {
    const seg = s.slice(Math.max(0, i - 7), i);
    let n = BigInt(seg);
    let b = '';
    while (n > 0n) {
      b = B62[Number(n % 62n)] + b;
      n /= 62n;
    }
    b = b || '0';
    out = (seg.length === 7 ? b.padStart(4, '0') : b) + out;
  }
  return out;
}

/* -------------------------------- 输入预处理 -------------------------------- */

/**
 * 需从 URL 尾部剥掉的 ASCII 收尾符号。
 *
 * 三家平台的真实链接不会以这些字符结尾，剥掉是安全的；而分享文案里
 * 句末句号、markdown 的 `)`、引号包裹都会带来它们。
 */
const URL_TAIL = /[.,;:!?'"`)\]}>]+$/;
const trimUrlTail = (u) => String(u).replace(URL_TAIL, '');

/**
 * 分享文案里常夹着一整段话，先把 URL 抠出来。
 *
 * ⚠️ URL 主体只认 **ASCII 可见字符**（`[!-~]`，即 0x21–0x7E）。这不是随意收紧 ——
 * 三家 App 的「复制链接」文案里，链接后面经常**直接**跟中文标点或汉字，中间没有空格：
 *   · https://www.douyin.com/video/7300…，复制打开抖音看看…
 *   · https://www.xiaohongshu.com/explore/65f3…。
 *   · 「https://…」／《https://…》
 * 而真实链接永远是纯 ASCII（中文会被百分号编码成 %XX）。
 * 早先这里用「除了空白和几个括号之外都算 URL」的写法，整段中文会被并进 URL，
 * `new URL()` 把「，复制打开抖音」当成路径的一部分 → 三家平台的路径正则全部匹配不上
 * → 这条链接被判成「不是作品链接」并被悄悄跳过。用户的感受是：**粘了链接却没有任何反应**。
 */
function extractUrl(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const withScheme = s.match(/https?:\/\/[!-~]+/i);
  if (withScheme) return trimUrlTail(withScheme[0]);
  // 没带协议头的形态（用户手打或从别处摘出来）
  const bare = s.match(
    /(?:[a-z0-9-]+\.)*(?:weibo\.com|weibo\.cn|xiaohongshu\.com|xhslink\.com|douyin\.com|iesdouyin\.com)\/[!-~]+/i
  );
  return bare ? trimUrlTail('https://' + bare[0]) : '';
}


/** 解析成 URL 对象；失败返回 null（相对路径、乱码一律视为不可信） */
function toUrl(input) {
  const raw = extractUrl(input) || String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * 微博路径里不是 mid 的保留字。
 *
 * 为什么必须有这张表：`weibo.com/<uid>/<mid>` 的判定靠「第一段是纯数字」，
 * 但 `/1234567890/profile` 这类地址同样满足这个形状 —— 少了这张表，
 * 把一个「主页下的子页面」当成单作品，用户会看到「只下了一个文件」而毫无头绪。
 */
const WEIBO_RESERVED = new Set([
  'u', 'p', 'n', 's', 'i', 'w', 'tv', 'at', 'me', 'my', 'home', 'main', 'user', 'users',
  'profile', 'detail', 'status', 'statuses', 'ajax', 'api', 'fav', 'favorite', 'like', 'likes',
  'comment', 'comments', 'search', 'settings', 'messages', 'chat', 'groups', 'group', 'page',
  'album', 'photo', 'video', 'videos', 'topic', 'hot', 'weibo', 'show', 'num', 'card',
  'cardlist', 'manager', 'fans', 'follow', 'receive', 'new', 'mobile', 'about', 'help',
  'login', 'signup', 'oauth', 'passport', 'sso', 'adm', 'wenda', 'ttarticle', 'mblog',
]);

/** 需要联网展开的短链 */
const SHORT_LINK_HOSTS = [/^(?:.*\.)?xhslink\.com$/i, /^v\.douyin\.com$/i, /^(?:.*\.)?iesdouyin\.com$/i];

function isShortLink(input) {
  const u = toUrl(input);
  if (!u) return false;
  const host = u.hostname.replace(/^www\./i, '');
  if (!/^(?:v\.douyin\.com|xhslink\.com)$/i.test(host)) return false;
  return /^\/(?:[A-Za-z0-9_-]{2,})(?:\/)?$/.test(u.pathname);
}

/** 短链展开后的地址是否还落在同一家 —— 展开结果必须过这一关，避免被重定向到别处 */
function isShortLinkHost(host) {
  const h = String(host || '').toLowerCase();
  return SHORT_LINK_HOSTS.some((re) => re.test(h));
}

/* --------------------------------- 三平台识别 -------------------------------- */

/**
 * 微博：返回 `{itemId, altIds}` 或 null。
 * 主 id 取 base62 的 mid（`ajax/statuses/show` 直接吃这个），
 * 备选是换算出来的十进制 id。
 */
function parseWeibo(u) {
  const path = u.pathname.replace(/\/+$/, '');
  let mid = '';

  // m.weibo.cn/status/<mid>、weibo.com/detail/<mid>
  let m = path.match(/^\/(?:status|statuses|detail)\/([A-Za-z0-9]{5,20})$/i);
  if (m) mid = m[1];

  // weibo.com/<uid>/<mid>：第一段必须是纯数字（uid），第二段不是保留字
  if (!mid) {
    m = path.match(/^\/(\d{5,20})\/([A-Za-z0-9]{5,20})$/i);
    if (m && !WEIBO_RESERVED.has(m[2].toLowerCase())) mid = m[2];
  }

  // 查询参数形态：?mid=… / ?id=…（部分分享链接只有参数）
  if (!mid) {
    const q = u.searchParams.get('mid') || u.searchParams.get('id') || '';
    if (/^[A-Za-z0-9]{5,20}$/.test(q)) mid = q;
  }

  if (!mid) return null;
  const numeric = midToId(mid);
  const altIds = numeric && numeric !== mid ? [numeric] : [];
  return {
    itemId: mid,
    altIds,
    /** 打开/校验用的规范地址（优先用数字 id 的详情页，它不依赖 uid 段） */
    url: numeric
      ? `https://m.weibo.cn/detail/${numeric}`
      : `https://m.weibo.cn/status/${mid}`,
  };
}

/** 小红书：长 id 就是笔记 id；xsec_token 保留在 URL 里一起带走 */
function parseXhs(u) {
  const path = u.pathname.replace(/\/+$/, '');
  let id = '';
  let m = path.match(/^\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9]{8,40})$/i);
  if (m) id = m[1];
  if (!id) {
    // user/profile/<uid>/<noteId>（较少见，但确实是合法形态）
    m = path.match(/^\/user\/profile\/[A-Za-z0-9]+\/([A-Za-z0-9]{8,40})$/i);
    if (m) id = m[1];
  }
  if (!id) return null;
  return { itemId: id, altIds: [], token: u.searchParams.get('xsec_token') || '', url: u.toString() };
}

/* --------------------------------- 抖音 --------------------------------- */

/**
 * 抖音链接形状判定（纯函数 · 单一事实来源）。
 *
 * 为什么必须抽成一个函数，而不是让 `parseDouyin` 各判各的：
 * 「这条抖音链接到底是不是作品页」有**两个使用方** ——
 *   · 解析层：决定走单作品流程（parseDouyin）
 *   · 守门层：决定要不要在开浏览器前就把话说明白（platforms/douyin.js）
 * 两处各写一套正则，迟早出现「解析说不是作品、守门说过得去」的缝，
 * 而缝里的那一次跑动，用户要白等 20~40 秒才看到一句指向「登录/链接/页面」的报错。
 *
 * 判定给出的 kind：
 *   work      作品页（/video|note/<id>、/share/…/<id>、?modal_id=<id>、信息流页的 ?vid=<id>）
 *   profile   博主主页（/user/<sec_uid>，含其下的子页）
 *   search    搜索结果 / 话题 / 特效页 —— 一定不是某位博主的主页
 *   feed      推荐 / 精选 / 关注 / 直播等信息流页 —— 同上
 *   workNoId  看着是作品页，但取不到有效 id（链接被截断）
 *   unknown   认不出来（分享页、未知路径…）→ 保持旧行为，交给调用方
 *
 * @param {URL} u 已解析的地址
 * @returns {{kind:string, id:string}}
 */
function classifyDouyinUrl(u) {
  const path = u.pathname.replace(/\/+$/, '');
  // /user/<sec_uid> 及其子页（/user/<uid>/fans 之类）都算主页
  const isProfilePath = /^\/user\/[A-Za-z0-9_-]+(?:\/|$)/i.test(path);
  const modal = u.searchParams.get('modal_id') || '';
  const vid = u.searchParams.get('vid') || '';

  // 作品 id 三个来源，优先级：路径 > modal_id > vid
  let m = path.match(/^\/(?:video|note)\/(\d{15,25})$/i) || path.match(/^\/share\/(?:video|note)\/(\d{15,25})$/i);
  let id = m ? m[1] : '';
  if (!id && /^\d{15,25}$/.test(modal)) id = modal;
  /**
   * `vid=`：抖音在信息流页（首页推荐 / 发现 / 精选）用这个参数标记「正在播放的那条作品」。
   * 用户 2026-10-16 的日志里能看到它的形态：
   *   /user/…?enter_from=author_card&from_gid=7670006158224573684&…&vid=7670006158224573684
   *
   * ⚠️ 只在**非主页**路径下认它。上面那条例子里 `/user/<sec_uid>?…&vid=<id>` 是
   * 「从某条视频点进博主主页」留下的出处参数，**不是要下载的作品**；
   * 若在这里认了它，用户粘一次「下载该博主全部作品」的主页链接就会变成只下一条 ——
   * 正是本模块开头那句「宁可不识别」要防的错。
   */
  if (!id && /^\d{15,25}$/.test(vid) && !isProfilePath && !/^\/share\/user/i.test(path)) id = vid;
  if (id) return { kind: 'work', id };

  if (isProfilePath) return { kind: 'profile', id: '' };
  if (/^\/(?:search|jingxuan\/search|hashtag|challenge|topic|music)(?:\/|$)/i.test(path)) {
    return { kind: 'search', id: '' };
  }
  // 末尾斜杠已在上面剥掉，所以首页的 path 就是空串
  if (path === '') return { kind: 'feed', id: '' }; // douyin.com 首页 = 推荐流
  if (/^\/(?:discover|recommend|foryou|hot|live|follow|following|jingxuan|collection|mix|nearby)(?:\/|$)/i.test(path)) {
    return { kind: 'feed', id: '' };
  }
  if (/^\/(?:video|note|share\/video|share\/note)(?:\/|$)/i.test(path)) return { kind: 'workNoId', id: '' };
  return { kind: 'unknown', id: '' };
}

/** 抖音：video / note / share 路径，另加 modal_id 与信息流页的 vid 形态（判定见 classifyDouyinUrl） */
function parseDouyin(u) {
  const { kind, id } = classifyDouyinUrl(u);
  if (kind !== 'work' || !id) return null;
  return { itemId: id, altIds: [], url: `https://www.douyin.com/video/${id}` };
}

/** 「怎么拿到正确的链接」这段建议，三种问题共用（避免三份文案各自漂移） */
const DOUYIN_HOWTO =
  '要下单个作品：在浏览器里打开那条视频后复制地址栏（地址里会带 /video/作品id 或 modal_id=作品id），' +
  '或在抖音 App 里点「分享 → 复制链接」拿到 v.douyin.com 短链；' +
  '要批量下载某位博主：粘贴他的主页链接（地址里带 /user/…）。';

/**
 * 抖音输入体检：给「准备按博主主页处理」的这条链接做一次形状判断。
 *
 * 为什么需要它 —— 用户 2026-10-16 的日志：连续三次「任务开始（博主主页）」的输入
 * 其实是抖音的搜索/精选结果页（`douyin.com/jingxuan/search/爱心代码?aid=…&type=general`）。
 * 解析层认不出作品 id 就 return null，而 null 的语义是「不是作品链接 → 按博主主页处理」，
 * 于是这些链接被静默降级成主页采集：打开搜索页 → 搜索页根本不请求主页作品接口
 * （它走 /search/item，在白名单黑名单里）→ 截获 0 个响应 → 重载一次再等 ≈20~40 秒 →
 * 抛出一句把原因指向「① 已登录 ② 链接正确 ③ 页面能显示作品」的错误。
 * 用户看到的就是「抖音这条视频下不了」。
 *
 * 判定刻意保守：**只拦「一定不是主页」的那几类**（search / feed / workNoId），
 * 认出 unknown 一律放过（继续按主页处理）—— 宁可多跑一次，也不能把主页链接拦下来。
 *
 * @returns {string} 空串 = 不必拦；否则是可以直接展示给用户的说明
 */
function douyinInputProblem(input) {
  const u = toUrl(input);
  if (!u) return '';
  const host = u.hostname.toLowerCase().replace(/^www\./i, '');
  if (!/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host)) return '';
  const { kind } = classifyDouyinUrl(u);
  if (kind === 'search') {
    return `这条链接是抖音的搜索结果 / 话题页，里面没有作品 id，没法下载。${DOUYIN_HOWTO}`;
  }
  if (kind === 'feed') {
    return `这条链接是抖音的推荐 / 精选 / 关注这类信息流页，既不是博主主页也不是某个作品。${DOUYIN_HOWTO}`;
  }
  if (kind === 'workNoId') {
    return (
      '这条链接看着是抖音作品页，但里面没有有效的作品 id（19 位数字）—— ' +
      '多半是复制时被截断或漏了参数。请重新完整复制一次作品链接（App 里用「分享 → 复制链接」）。'
    );
  }
  return '';
}

/**
 * 判定一条输入是不是「单个作品」链接。
 *
 * @param {string} input 用户粘贴的任意文本（可含分享文案）
 * @returns {{platform:string, itemId:string, altIds:string[], token:string, url:string}|null}
 *          null = 不是单作品链接（按原来的博主主页流程处理）
 */
function parseSingleUrl(input) {
  const u = toUrl(input);
  if (!u) return null;

  const host = u.hostname.toLowerCase().replace(/^www\./i, '');

  // 短链：平台未知，先交给上层展开（展开后重新走一次本函数）
  if (/^(?:v\.douyin\.com|xhslink\.com)$/i.test(host)) {
    return { platform: '', itemId: '', altIds: [], token: '', url: u.toString(), shortLink: true };
  }

  let r = null;
  let platform = '';
  if (/(^|\.)weibo\.(com|cn)$/.test(host)) {
    platform = 'weibo';
    r = parseWeibo(u);
  } else if (/(^|\.)xiaohongshu\.com$/.test(host)) {
    platform = 'xhs';
    r = parseXhs(u);
  } else if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host)) {
    platform = 'douyin';
    r = parseDouyin(u);
  }
  if (!r) return null;
  return { platform, shortLink: false, ...r };
}

/** 界面提示用的一句话（不含任何平台专有名词的硬编码，名字由调用方给） */
function describeSingle(result, platformName) {
  if (!result) return '';
  if (result.shortLink) return '识别到短链 —— 将在开始下载时展开为作品地址';
  return `已识别为${platformName || ''}单个作品（ID ${result.itemId}）`;
}

/** 这三个站点的主机名 —— 用来区分「粘贴的是主页」和「粘贴的是别的网站」 */
const PLATFORM_HOSTS = /(^|\.)(weibo\.(com|cn)|xiaohongshu\.com|douyin\.com|iesdouyin\.com)$/i;

/**
 * 把「一大段粘贴内容」拆成多条作品链接。
 *
 * 只按换行拆，不按逗号/空格拆 —— 分享文案里空格和标点太常见
 * （「3.14 复制打开抖音，看看…」），按它们拆会把一条链接切碎。
 * 一行里多余的分享文案由 parseSingleUrl → extractUrl 负责抠出真正的 URL。
 *
 * @param {string} text 输入框里的原始内容
 * @returns {{lines:number, targets:object[], ignored:{line:string,reason:string}[]}}
 *          - lines：非空行数（用来判断「用户粘了几行」，0 行表示空输入）
 *          - targets：识别成功的作品链接（已按 平台+id 去重）
 *          - ignored：被跳过的行及原因（界面与日志要如实说明，不能悄悄丢）
 */
function parseInputList(text) {
  const lines = String(text || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const targets = [];
  const ignored = [];
  const seen = new Set();

  for (const line of lines) {
    const r = parseSingleUrl(line);
    if (!r) {
      /**
       * 分开说「主页链接」「该平台的其它页面」和「根本不是链接」—— 三者的处置建议完全不同。
       *
       * 为什么把 douyinInputProblem 排在前面：抖音的搜索页也是「受支持站点的地址」，
       * 早先它会被 `looksLikeProfile` 说成「这是博主主页链接」——用户按这句话去查自己的主页链接，
       * 白忙一场。真有平台说得清这是什么页面，就用平台的说法。
       */
      const problem = douyinInputProblem(line);
      ignored.push({
        line,
        reason: problem
          ? problem.split('。')[0]
          : looksLikeProfile(line)
            ? '这是博主主页链接（批量模式只处理作品链接）'
            : '不是受支持的作品链接',
      });
      continue;
    }
    // 短链没有 id，只能用地址本身去重
    const key = r.shortLink ? `short:${r.url}` : `${r.platform}:${r.itemId}`;
    if (seen.has(key)) {
      ignored.push({ line, reason: '与前面的链接重复' });
      continue;
    }
    seen.add(key);
    targets.push(r);
  }

  return { lines: lines.length, targets, ignored };
}

/** 这一行看起来是「某个受支持站点的地址」吗（用于把提示写得更具体） */
function looksLikeProfile(line) {
  const u = toUrl(line);
  if (!u) return false;
  return PLATFORM_HOSTS.test(u.hostname.toLowerCase().replace(/^www\./i, ''));
}

module.exports = {
  parseSingleUrl,
  parseInputList,
  describeSingle,
  extractUrl,
  isShortLink,
  isShortLinkHost,
  midToId,
  idToMid,
  /** 抖音专用：链接形状判定与「不能当主页处理」的说明（platforms/douyin.js 与界面共用） */
  classifyDouyinUrl,
  douyinInputProblem,
};
