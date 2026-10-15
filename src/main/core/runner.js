/**
 * 通用任务编排（三个平台共用一套）
 *
 * 平台差异全部收敛到「平台适配器」里：适配器只负责把作品采集成统一的 item 模型，
 * 之后的任务生成、去重、下载、转封装完全共用，互不影响。
 *
 * 统一作品模型：
 *   item = {
 *     id, title, author, likeCount,
 *     dateHint: 'YYYY-MM-DD' | '',   // 用于按日期分目录
 *     filePrefix: '',                // 文件名前缀（微博用正文前 24 字）
 *     folderTitle: '',               // 是否把标题拼进目录名
 *     noteDetail: '',                // 作品详情页地址（小红书逐篇补全图集时用）
 *     medias: [ { kind, url, candidates?, altUrls?, ext, cover?, coverCandidates? } ]
 *     isRetweet?, authorUid?         // 微博用于「仅原创」过滤
 *   }
 *   kind: 'image' | 'video' | 'livephoto'
 */
const path = require('path');
const fsp = require('fs/promises');

const { Downloader } = require('./downloader');
const { convertToMOV, findFFmpeg } = require('./ffmpeg');
const { randomUUID } = require('crypto');
const { parseSingleUrl, parseInputList } = require('../url-parse');

/** 短链展开用的 UA —— 与 downloader.js 的 desktopUA() 保持一致，两处不能各写一套 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function safeName(s, max = 40) {
  return (
    String(s || '')
      /**
       * 正文常整段夹着分享短链（微博把视频分享写成 `http://t.cn/AX0I…`）。
       * 早先不处理它，`/`→`_` 的替换会把它变成 `http___t.cn_AX0I_…`，
       * 文件名里就拖出一长串垃圾（用户日志里确实是这个形态：
       * `天来了也没招_http___t.cn_AX0I_video.mp4`）。
       * 必须在「替换分隔符」**之前**剥掉 —— 那时 `//` 还在，才认得出来。
       */
      .replace(/https?:\/\/\S+/gi, ' ')
      // 社交平台正文常带零宽空格/软连字符，肉眼不可见但会进入文件名
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      // 剥掉链接后常在原位置留下连续下划线，合并掉，否则名字里一堆 `___`
      .replace(/_{2,}/g, '_')
      .replace(/^_+/, '')
      .slice(0, max)
      // Windows 文件名不能以点或空格结尾
      .replace(/[._\s]+$/, '')
  );
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 候选链：开启原图时按顺序依次尝试，否则直接用最后一项（常规最佳）。
 *
 * ⚠️ 候选数组在项目里有**两个字段名**：微博用 `candidates`，
 * 小红书/抖音的解析层用 `altUrls`（适配器 toUnified 通常已把它们合成 `candidates`）。
 * 这里两个都认 —— 早先只读 `candidates`，于是漏掉 altUrls 时整条回退链静默消失：
 * 「原图 404 就自动退回 preview」这条保护直接失效，用户看到的是随机失败。
 */
function buildChain(candidates, fallbackUrl, preferOriginal = true) {
  const list = (Array.isArray(candidates) && candidates.length ? candidates : [fallbackUrl]).filter(Boolean);
  if (!list.length) return [];
  return preferOriginal ? list : [list[list.length - 1]];
}

/** 取一个媒体条目的候选链（两套字段名都认） */
function mediaCandidates(media) {
  if (!media) return [];
  if (Array.isArray(media.candidates) && media.candidates.length) return media.candidates;
  if (Array.isArray(media.altUrls) && media.altUrls.length) return media.altUrls;
  return [];
}

/**
 * 封面 / 实况图静态帧的候选链。
 * 优先用专门的 coverCandidates（三方适配器都会给），没有才退回媒体自身的候选链。
 */
function coverCandidatesOf(media) {
  if (!media) return [];
  if (Array.isArray(media.coverCandidates) && media.coverCandidates.length) return media.coverCandidates;
  return mediaCandidates(media);
}

function dateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class TaskRunner {
  /**
   * @param {object} opts
   * @param {object} opts.adapter   平台适配器
   * @param {object} opts.ctx       适配器运行上下文（session / cookie / partition …）
   * @param {Function} opts.emit
   * @param {Function} opts.getSettings
   */
  constructor({ adapter, ctx, emit, getSettings }) {
    this.adapter = adapter;
    this.ctx = ctx || {};
    this.emit = emit || (() => {});
    this.getSettings = getSettings || (() => ({}));
    this.stopped = false;
    this.ac = new AbortController();
    this.downloader = null;
    this.collector = null; // 浏览器采集器（仅小红书/抖音有）
  }

  log(msg) {
    this.emit({ type: 'log', message: msg });
  }

  stop() {
    this.stopped = true;
    this.ac.abort();
    this.collector?.stop?.();
    this.downloader?.stop();
    this.log('已请求停止，等待当前任务收尾…');
  }

  /** 主进程把注入脚本截获的数据转发进来 */
  ingest(url, data) {
    return this.collector?.ingest?.(url, data) || 0;
  }

  async run({ input, outDir, options }) {
    const s = this.getSettings();
    const merged = { ...s, ...options };

    if (!outDir) throw new Error('请先选择保存目录');
    if (!input) throw new Error('请先粘贴博主主页链接或作品链接');

    /**
     * 输入分流。判定统一走 url-parse，界面上的提示与这里用的是**同一份代码** ——
     * 「界面说会下 3 个、实际下了 8 个」这类问题从根上避免。
     *
     *   · 多行          → 作品链接流程（逐条采集，合并下载）
     *   · 单行 + 作品链接 → 同一条流程，只有一条
     *   · 其余          → 原来的博主主页流程（这条路上没有新代码，回归风险最小）
     */
    const list = parseInputList(input);
    if (list.lines > 1) return this.runTargets({ outDir, merged, list });
    if (list.targets.length) return this.runTargets({ outDir, merged, list });

    // ---- 采集（各平台自己的方式）----
    this.emit({ type: 'phase', phase: 'harvest', message: '正在采集作品列表…' });
    const { items: rawItems, rootId } = await this.adapter.collectItems({
      input,
      options: merged,
      ctx: this.ctx,
      emit: (e) => this.emit(e),
      log: (m) => this.log(m),
      signal: this.ac.signal,
      setCollector: (c) => (this.collector = c),
    });

    if (this.stopped) {
      this.emit({ type: 'phase', phase: 'done', message: '已停止', rootDir: outDir });
      return { stopped: true };
    }

    let items = rawItems || [];
    if (!items.length) {
      throw new Error(
        `没有采集到任何作品。请确认：① 已登录${this.adapter.name} ② 链接正确 ③ 页面能正常显示作品`
      );
    }

    // ---- 仅原创过滤（微博：排除转发与他人内容）----
    if (merged.onlyOriginal && this.adapter.supportsOnlyOriginal) {
      let droppedRetweet = 0;
      let droppedOther = 0;
      const uid = String(rootId || '');
      items = items.filter((it) => {
        if (it.isRetweet) {
          droppedRetweet++;
          return false;
        }
        if (it.authorUid && uid && it.authorUid !== uid) {
          droppedOther++;
          return false;
        }
        return true;
      });
      // 措辞由平台决定（微博叫「转发微博」），未提供时用中性说法
      const labels = this.adapter.filterLabels || {
        retweet: '转发内容',
        other: '非本账号发布的内容',
      };
      if (droppedRetweet) this.log(`已排除 ${droppedRetweet} 条${labels.retweet}（其图片属于原作者）`);
      if (droppedOther) this.log(`已排除 ${droppedOther} 条${labels.other}`);
      this.log(`仅原创模式：保留 ${items.length} / ${rawItems.length} 条`);
    }

    const maxItems = Number(merged.maxItems || 0);
    if (maxItems > 0 && items.length > maxItems) {
      this.log(`作品数 ${items.length} 超过上限 ${maxItems}，只处理前 ${maxItems} 个`);
      items = items.slice(0, maxItems);
    }
    this.log(`共采集 ${items.length} 个作品`);

    return this._downloadItems(items, { outDir, rootId, merged });
  }

  /**
   * 作品链接流程（单条与多条共用同一条路径）。
   *
   * 为什么不给「单条」单独留一条路：两者的差别只有两处（rootId 命名、失败是否中断），
   * 拆成两个方法后这两处必然会在某次修改里跑偏。这里用同一个循环表达，
   * 单条就是「长度为 1 的批量」，行为自然一致。
   *
   * 几条值得留意的设计：
   *   ① 短链（v.douyin.com / xhslink.com）先联网展开 —— 这两家的 App「复制链接」
   *      给的都是短链，而短链本身解析不出作品 id。展开失败只跳过这一条，不中断整批。
   *   ② 平台不匹配只跳过并提示。批量场景下用户很容易把不同平台的链接混在一起粘进来，
   *      整批报错等于让他一条条挑出来重来；全部都不匹配时才报错。
   *   ③ **单条失败不拖垮整批**：这是批量与单条最大的行为差异，也是批量功能的底线。
   *   ④ 「仅原创」与「最多作品数」在这里一律不适用（目标就是粘进来的这些），
   *      再套一遍截断会在用户把「最多作品数」设成 1 的旧设置下把目标丢掉。
   *
   * @param {{outDir:string, merged:object, list:{targets:object[], ignored:object[]}}} ctx
   */
  async runTargets({ outDir, merged, list }) {
    if (!outDir) throw new Error('请先选择保存目录');
    const targets = (list && list.targets) || [];
    const ignored = (list && list.ignored) || [];

    if (!targets.length) {
      const detail = ignored.map((x) => `  · ${x.reason}：${x.line.slice(0, 60)}`).join('\n');
      throw new Error(
        '没有识别到可下载的作品链接。每行放一条作品链接，例如：\n' +
          '  https://www.douyin.com/video/7300000000000000000\n' +
          '  https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER\n' +
          (detail ? `\n被跳过的内容：\n${detail}` : '')
      );
    }

    // 被跳过的行必须如实说出来：用户粘了 10 行只下 8 个，不解释看起来就是丢文件
    for (const x of ignored) this.log(`已跳过：${x.reason} —— ${x.line.slice(0, 60)}`);

    // ---- 短链展开 ----
    const wanted = [];
    const badShort = [];
    for (const t of targets) {
      if (!t.shortLink) {
        wanted.push(t);
        continue;
      }
      this.emit({ type: 'phase', phase: 'resolve', message: '正在展开短链…' });
      const expanded = await this._expandShortLink(t.url);
      const parsed = expanded ? parseSingleUrl(expanded) : null;
      if (!parsed || !parsed.itemId) {
        this.log(`短链展开失败，已跳过：${t.url}`);
        badShort.push(t.url);
        continue;
      }
      this.log(`短链已展开：${expanded}`);
      wanted.push(parsed);
    }

    /**
     * 全部待展开的短链都没展开成功时，必须单独报错。
     * 若放任它往下走，wanted 会是空的，最后落到「这些链接属于 X，但当前选的是 Y」
     * 那句话上 —— 用户看到的提示与真正的原因（短链打不开）毫不相干，
     * 只会去反复切换平台，白费功夫。
     */
    if (!wanted.length && badShort.length) {
      throw new Error(
        `短链展开失败：这 ${badShort.length} 条短链都没能解析出作品地址。\n` +
          '请确认网络能访问对应平台（短链是 302 跳转，需要联网展开），\n' +
          '或改用网页版复制出来的完整作品链接：\n' +
          badShort.map((u) => `  · ${u}`).join('\n')
      );
    }

    // ---- 平台归属过滤 ----
    const names = { weibo: '微博', xhs: '小红书', douyin: '抖音' };
    const mine = wanted.filter((t) => !t.platform || t.platform === this.adapter.id);
    if (wanted.length - mine.length) {
      this.log(`已跳过 ${wanted.length - mine.length} 条其它平台的链接（当前面板是${this.adapter.name}）`);
    }
    if (!mine.length) {
      const owners = [...new Set(wanted.map((t) => names[t.platform] || t.platform))].join('、');
      throw new Error(
        `这些链接属于${owners}，但当前选的是${this.adapter.name} —— 请先切换到对应平台再开始`
      );
    }

    // 将来新增平台时若忘了实现单作品，这里要给一句人话，而不是一个 TypeError
    if (typeof this.adapter.collectSingleItem !== 'function') {
      throw new Error(`${this.adapter.name}暂不支持单作品下载，请改用博主主页链接`);
    }

    // ---- 逐条采集 ----
    const total = mine.length;
    if (total > 1) this.log(`共 ${total} 条作品链接，开始逐个读取…`);
    const items = [];
    const seenIds = new Set();
    const failed = [];

    for (let i = 0; i < total; i++) {
      if (this.stopped) break;
      const t = mine[i];
      this.emit({
        type: 'phase',
        phase: 'harvest',
        message: total > 1 ? `正在读取第 ${i + 1}/${total} 个作品…` : `正在读取${this.adapter.name}作品…`,
      });
      if (total > 1) this.log(`[${i + 1}/${total}] ${t.itemId || t.url}`);
      try {
        const r = await this.adapter.collectSingleItem({
          url: t.url,
          itemId: t.itemId,
          altIds: t.altIds || [],
          ctx: this.ctx,
          emit: (e) => this.emit(e),
          log: (m) => this.log(m),
          signal: this.ac.signal,
          setCollector: (c) => (this.collector = c),
        });
        for (const it of r.items || []) {
          const id = String(it.id || '');
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          items.push(it);
        }
      } catch (err) {
        // 一条失败不能拖垮整批（见方法头注释第 ③ 条）
        failed.push({ target: t, message: err.message });
        this.log(`第 ${i + 1} 条失败：${err.message}`);
      }
    }

    if (this.stopped) {
      this.emit({ type: 'phase', phase: 'done', message: '已停止', rootDir: outDir });
      return { stopped: true };
    }

    if (!items.length) {
      const detail = failed
        .slice(0, 5)
        .map((f) => `  · ${f.target.itemId || f.target.url}：${f.message}`)
        .join('\n');
      throw new Error(`这 ${total} 条链接都没能读取到内容：\n${detail}`);
    }
    if (failed.length) {
      this.log(`${failed.length} 条读取失败（详见上面的日志），其余作品继续下载`);
    }

    const mediaCount = items.reduce((n, it) => n + ((it.medias && it.medias.length) || 0), 0);
    if (!mediaCount) throw new Error('这些作品里没有可下载的图片或视频');
    this.log(`合计 ${items.length} 个作品、${mediaCount} 个媒体文件`);

    /**
     * 目录名：只有一条作品时用作品 id（与「下载单个作品」的落盘位置完全一致，
     * 用户重跑同一条也能靠 skipExisting 跳过）；多条时归到一个固定的批次目录 ——
     * 用固定的 'batch' 而不是时间戳，是为了让**重跑同一批能跳过已下载的文件**，
     * 每个作品在自己的子目录里，批次之间也不会互相覆盖。
     */
    const rootId = items.length === 1 ? String(items[0].id) : 'batch';
    return this._downloadItems(items, { outDir, rootId, merged });
  }

  /**
   * 展开短链。
   *
   * 抖音的 v.douyin.com 与小红书的 xhslink.com 都是 302 跳转，用分区会话直接跟随
   * 跳转、再读 `res.url`（跟随后的最终地址）即可 —— 好处是顺带带上了该平台的
   * Cookie 与代理设置（与下载用的是同一条网络链路）。
   *
   * 兜底：少数短链返回的是一个带脚本跳转的 HTML 页（此时 res.url 仍是短链本身），
   * 就退一步从响应体里正则找作品地址。两条路都走不通时返回空串，由调用方报错。
   *
   * @returns {Promise<string>} 真实作品页地址；失败返回 ''
   */
  async _expandShortLink(url) {
    const impl = this.ctx.fetchImpl || globalThis.fetch;
    if (typeof impl !== 'function') return '';
    try {
      const res = await impl(url, { redirect: 'follow', headers: { 'User-Agent': DESKTOP_UA } });
      const finalUrl = (res && res.url) || '';
      if (finalUrl && parseSingleUrl(finalUrl)) return finalUrl;
      // 兜底：从响应体里找作品地址
      const text = typeof res?.text === 'function' ? await res.text() : '';
      const hit = String(text || '').match(
        /https?:\/\/(?:www\.)?(?:douyin\.com\/(?:video|note)\/\d{15,25}|xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]+[^"'\s<>\\]*)/
      );
      if (hit) return hit[0];
    } catch (err) {
      this.log(`短链展开出错：${err.message}`);
    }
    return '';
  }

  /**
   * 「作品列表 → 落盘」的公共后半段（主页批量与单作品共用）。
   *
   * 抽出来的理由不只是复用：这一段里有大量真机调出来的细节
   * （按目标路径去重、Live Photo 的候选链、转 MOV 的幂等判断），
   * 复制成两份必然会让其中一份慢慢跑偏。
   *
   * @param {object[]} items  统一作品模型
   * @param {{outDir:string, rootId:string, merged:object}} ctx
   */
  async _downloadItems(items, { outDir, rootId, merged }) {
    const {
      downloadImages = true,
      downloadVideos = true,
      downloadLive = true,
      convertLiveToMov = false,
      convertToMov = false,
      organizeByDate = false,
      skipExisting = true,
      originalQuality = true,
      concurrency = 4,
      ffmpegPath = '',
    } = merged || {};

    // ---- 生成下载任务 ----
    const rootDir = path.join(outDir, `${this.adapter.id}_${rootId || 'unknown'}`);
    await fsp.mkdir(rootDir, { recursive: true });

    // 按目标路径去重：同一路径若入队多次，多个 worker 会并发写同一文件（Windows 上表现为 EPERM）
    const taskMap = new Map();
    const liveMap = new Map();
    const movJobs = [];
    const addTask = (t) => {
      if (!taskMap.has(t.dest)) taskMap.set(t.dest, t);
    };
    let imgCount = 0;
    let vidCount = 0;
    let liveCount = 0;

    for (const item of items) {
      const date = organizeByDate ? dateOf(item.dateHint) : '';
      const folder =
        safeName(`${date ? date + '_' : ''}${item.folderTitle ? item.folderTitle + '_' : ''}${item.id}`, 60) ||
        String(item.id);
      const postDir = path.join(rootDir, folder);
      const stem = item.filePrefix ? `${item.filePrefix}_` : '';

      let imgIdx = 0;
      let liveIdx = 0;

      for (const media of item.medias || []) {
        if (media.kind === 'image' && downloadImages) {
          imgIdx++;
          imgCount++;
          const chain = buildChain(mediaCandidates(media), media.url, originalQuality);
          if (!chain.length) continue;
          const ext = (media.ext || 'jpg').replace('jpeg', 'jpg');
          addTask({
            url: chain[0],
            altUrls: chain.slice(1),
            dest: path.join(postDir, `${stem}img${String(imgIdx).padStart(2, '0')}.${ext}`),
            kind: 'image',
            itemId: item.id,
          });
        } else if (media.kind === 'video' && downloadVideos) {
          vidCount++;
          const ext = media.ext || 'mp4';
          const dest = path.join(postDir, `${stem}video.${ext}`);
          addTask({
            url: media.url,
            altUrls: media.altUrls || [],
            dest,
            kind: 'video',
            itemId: item.id,
          });
          if (media.cover && downloadImages) {
            imgCount++;
            const cChain = buildChain(coverCandidatesOf(media), media.cover, originalQuality);
            addTask({
              url: cChain[0] || media.cover,
              altUrls: cChain.slice(1),
              dest: path.join(postDir, `${stem}cover.jpg`),
              kind: 'image',
              itemId: item.id,
            });
          }
          if (convertToMov) {
            const movDest = path.join(postDir, `${stem}video.mov`);
            if (!(await exists(movDest))) movJobs.push({ srcDest: dest, movDest });
          }
        } else if (media.kind === 'livephoto') {
          liveIdx++;
          liveCount++;
          const lstem = `${stem}live${String(liveIdx).padStart(2, '0')}`;
          // 静态帧：只要勾选了图片或 Live 之一就保存，避免实况图丢帧
          if (media.cover && (downloadImages || downloadLive)) {
            imgCount++;
            const chain = buildChain(coverCandidatesOf(media), media.cover, originalQuality);
            const ext = chain.length ? guessExt(chain[0], 'jpg') : 'jpg';
            addTask({
              url: chain[0] || media.cover,
              altUrls: chain.slice(1),
              dest: path.join(postDir, `${lstem}.${ext}`),
              kind: 'image',
              itemId: item.id,
            });
          }
          if (downloadLive) {
            const srcDest = path.join(postDir, `${lstem}_src.${media.ext || 'mp4'}`);
            const movDest = path.join(postDir, `${lstem}.mov`);
            // 上次已转出 mov 的话不必再拉源文件，重跑能省掉一大半流量
            if (!(await exists(movDest))) {
              // 动态片段也要走候选链：微博把这段地址给成明文 http，CDN 对 http 形态直接 403
              addTask({
                url: media.url,
                altUrls: media.altUrls || [],
                dest: srcDest,
                kind: 'live-src',
                itemId: item.id,
              });
              if (!liveMap.has(srcDest)) liveMap.set(srcDest, { srcDest, movDest, itemId: item.id });
            }
          }
        }
      }
    }

    const tasks = [...taskMap.values()];
    const liveJobs = [...liveMap.values()];

    this.emit({
      type: 'summary',
      total: tasks.length,
      /**
       * 作品数单独发一份。
       * 界面上「作品数」和「总文件」是两格不同的统计；只发 total（文件数）时，
       * 渲染层只能拿它去填作品数，两个数字永远相等 —— 用户一眼就看出不对。
       */
      items: items.length,
      images: imgCount,
      videos: vidCount,
      live: liveCount,
      rootDir,
    });
    this.log(`待下载 ${tasks.length} 个文件（图片 ${imgCount} / 视频 ${vidCount} / Live ${liveCount}）`);

    // 停止发生在下载前时也要收尾，否则界面按钮会一直停在忙碌态
    if (this.stopped) {
      this.emit({ type: 'phase', phase: 'done', message: '已停止', rootDir });
      return { stopped: true };
    }

    // ---- 下载 ----
    this.emit({ type: 'phase', phase: 'download', message: '开始下载…' });
    this.downloader = new Downloader({
      fetchImpl: this.ctx.fetchImpl,
      concurrency,
      skipExisting,
      referer: this.adapter.referer,
      logger: (m) => this.log(m),
      /**
       * 地址过期兜底：候选链全打完仍 403/404 时，让平台层重新取一份新地址。
       * 目前只有微博需要（视频地址带会过期的 Expires/ssig 签名）；
       * 没实现这个方法的平台自动退化成「不刷新」，下载器那边是纯可选的。
       */
      refreshUrl: this.adapter.refreshMediaUrls
        ? (task) => this.adapter.refreshMediaUrls(task, { ctx: this.ctx })
        : null,
      // 显式组装字段：早先这里用了 { type:'dl', ...p }，p.type 会把 'dl' 覆盖掉，
      // 导致渲染进程认不出事件、进度数字永不更新。
      onProgress: (p) =>
        this.emit({
          type: 'dl',
          event: p.event,
          file: p.task?.dest,
          written: p.written,
          total: p.total,
          size: p.size,
          error: p.error,
          stats: p.stats,
        }),
    });
    tasks.forEach((t) => this.downloader.push(t));
    const stats = await this.downloader.run();
    this.log(`下载完成：新增 ${stats.done}，跳过 ${stats.skipped}，失败 ${stats.failed}`);

    // ---- Live Photo 转 MOV ----
    if (convertLiveToMov && liveJobs.length && !this.stopped) {
      this.emit({ type: 'phase', phase: 'convert', message: `正在把 ${liveJobs.length} 个 Live Photo 转 MOV…` });
      const bin = await findFFmpeg(ffmpegPath);
      if (!bin) {
        this.log('未找到 ffmpeg，跳过 Live Photo 转换（原始文件已保留）');
        this.emit({ type: 'ffmpeg-missing' });
      } else {
        let ok = 0;
        let failed = 0;
        let skipped = 0;
        for (let i = 0; i < liveJobs.length; i++) {
          if (this.stopped) break;
          const job = liveJobs[i];

          // 幂等：上次已转成功就跳过，重跑不会重复失败
          if (await exists(job.movDest)) {
            skipped++;
            this.emit({ type: 'convert-progress', done: i + 1, total: liveJobs.length, ok, failed });
            continue;
          }
          try {
            await fsp.access(job.srcDest);
          } catch (err) {
            failed++;
            const why =
              err.code === 'ENOENT'
                ? '源文件缺失（该动态片段此前下载失败）'
                : `源文件不可访问（${err.code}，可能被其他程序占用）`;
            this.log(`Live 转 MOV 失败：${path.basename(job.srcDest)} → ${why}`);
            this.emit({ type: 'convert-progress', done: i + 1, total: liveJobs.length, ok, failed });
            continue;
          }
          try {
            await convertToMOV({
              input: job.srcDest,
              output: job.movDest,
              contentId: randomUUID(),
              ffmpegBin: bin,
              signal: this.ac.signal,
            });
            // 转换成功后删除中间源文件，只保留 mov
            await fsp.unlink(job.srcDest).catch(() => {});
            ok++;
          } catch (err) {
            failed++;
            this.log(`Live 转 MOV 失败（源文件已保留）：${path.basename(job.srcDest)} → ${err.message}`);
          }
          this.emit({ type: 'convert-progress', done: i + 1, total: liveJobs.length, ok, failed });
        }
        this.log(`Live 转 MOV 完成：成功 ${ok}，失败 ${failed}，已存在跳过 ${skipped}`);
      }
    }

    // ---- 视频转封装为 MOV（保留原视频）----
    if (convertToMov && movJobs.length && !this.stopped) {
      this.emit({ type: 'phase', phase: 'convert', message: `正在转换 ${movJobs.length} 个视频…` });
      const bin = await findFFmpeg(ffmpegPath);
      if (!bin) {
        this.log('未找到 ffmpeg，跳过转换（原视频已保留）');
        this.emit({ type: 'ffmpeg-missing' });
      } else {
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < movJobs.length; i++) {
          if (this.stopped) break;
          const job = movJobs[i];
          if (!(await exists(job.srcDest))) {
            failed++;
            continue;
          }
          try {
            await convertToMOV({ input: job.srcDest, output: job.movDest, ffmpegBin: bin });
            ok++;
          } catch (err) {
            failed++;
            this.log(`转 MOV 失败（原视频保留）：${path.basename(job.srcDest)} → ${err.message}`);
          }
          this.emit({ type: 'convert-progress', done: i + 1, total: movJobs.length, ok, failed });
        }
        this.log(`视频转 MOV 完成：成功 ${ok}，失败 ${failed}`);
      }
    }

    this.emit({ type: 'phase', phase: 'done', message: '全部完成', rootDir });
    return { ...stats, rootDir };
  }
}

function guessExt(url, fallback) {
  const m = String(url || '').match(/\.(jpg|jpeg|png|gif|webp|heic|mp4|mov|m4v)(?=\?|$)/i);
  return (m ? m[1].toLowerCase() : fallback).replace('jpeg', 'jpg');
}

module.exports = { TaskRunner, safeName, buildChain, guessExt, dateOf };
