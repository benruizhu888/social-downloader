/**
 * 下载引擎
 * - 并发控制（默认 4，可调）
 * - 断点续传（Range 追加，已完成的直接跳过）
 * - 指数退避重试，能识别永久性失败（404/403）不再浪费时间
 * - 微博 CDN 防盗链：必须带 Referer，否则 403
 *
 * ⚠️ fetchImpl 由 runner 注入，真机上一定是 `core/net.js` 的 sessionFetch
 *    （Chromium 网络栈）。构造函数里的 `globalThis.fetch` 只是给纯 Node 单元测试
 *    留的退路 —— 真机上用它会出现「采集成功、下载全片 fetch failed」，别再退回这一步。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const { describeNetworkError, refererFor } = require('./net');

/* ------------------------- 同一主机的失败冷却参数 ------------------------- */

/**
 * 真实症状（用户 2026-10-15 的日志，一次任务里）：
 *   · 小红书 50 个文件 → 9 个 `net::ERR_CONNECTION_RESET`
 *   · 同一时段微博 198/198、抖音 88/88 全过
 * 说明不是网络整体不通，而是**同一个 CDN 被短时间高频请求后开始主动断连**（限流）。
 * 原来的处置只有「按 700ms 指数退避重试**这一个文件**」，其他 worker 仍在同时猛打同一主机，
 * 于是变成「同一批文件轮流失败」——失败被摊到 9 个不同文件上，重试也救不回来。
 *
 * 做法：按**主机**统计失败（滑动窗口），达到阈值就给这个主机一段冷却，
 * 冷却期内该主机的任务先等一会儿再发。正常时完全不生效（零成本自调优）。
 */
const HOST_FAIL_WINDOW = 30000; // 统计窗口：只看最近 30 秒
const HOST_FAIL_THRESHOLD = 3; // 窗口内失败达到 3 次开始冷却
const HOST_COOLDOWN_BASE = 3000; // 冷却起步 3 秒
const HOST_COOLDOWN_MAX = 30000; // 冷却封顶 30 秒

class Downloader {
  constructor({
    fetchImpl,
    concurrency = 4,
    maxRetry = 3,
    skipExisting = true,
    logger,
    onProgress,
    referer,
    refreshUrl,
  } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.concurrency = concurrency;
    this.maxRetry = maxRetry;
    this.skipExisting = skipExisting;
    this.logger = logger || (() => {});
    this.onProgress = onProgress || (() => {});
    this.referer = referer || 'https://weibo.com/';
    /**
     * 可选：候选链全部失败（403/404）之后，向平台层要一份**新地址**再试一次。
     * 签名类地址（微博视频的 `?Expires=…&ssig=…`）会过期，换地址是唯一的出路。
     * 没有它就保持原行为（直接判失败），有它则**每个任务最多刷新一次**，不会重试风暴。
     */
    this.refreshUrl = typeof refreshUrl === 'function' ? refreshUrl : null;
    this.stats = { done: 0, skipped: 0, failed: 0, bytes: 0 };
    this._written = new Set(); // 本次会话实际写入过的文件，用于判断能否安全续传
    this._active = 0;
    this._queue = [];
    this._stopped = false;
    /** host -> { times: number[], until: number, lastLogAt: number }（见上方冷却参数注释） */
    this._hostState = new Map();
  }

  /* ---------------------------- 同主机冷却 ---------------------------- */

  _hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** 命中冷却就先等一会儿。分段 sleep，停止请求能及时生效 */
  async _respectCooldown(url) {
    const host = this._hostOf(url);
    if (!host) return;
    for (;;) {
      if (this._stopped) return;
      const st = this._hostState.get(host);
      const wait = st ? st.until - Date.now() : 0;
      if (wait <= 0) return;
      await sleep(Math.min(wait, 200));
    }
  }

  /**
   * 记一次网络失败。
   * 只统计**网络层**失败：404/403 是永久失败（err.fatal，链接本身没了），
   * 磁盘 EPERM 是本地问题，都不该让这个主机的其他文件跟着等。
   */
  _noteHostFail(url) {
    const host = this._hostOf(url);
    if (!host) return;
    const now = Date.now();
    const st = this._hostState.get(host) || { times: [], until: 0, lastLogAt: 0 };
    st.times = st.times.filter((t) => now - t < HOST_FAIL_WINDOW);
    st.times.push(now);
    this._hostState.set(host, st);
    if (st.times.length < HOST_FAIL_THRESHOLD) return;

    const cool = Math.min(HOST_COOLDOWN_MAX, HOST_COOLDOWN_BASE * (st.times.length - HOST_FAIL_THRESHOLD + 1));
    if (now + cool > st.until) st.until = now + cool;
    /**
     * 退避日志本身不能再变成新的刷屏源：每个主机最多每半个窗口提醒一次
     * （用固定的时间间隔而不是「冷却时长」，否则冷却越涨、日志越久不打，用户会以为卡住了）。
     */
    if (st.lastLogAt && now - st.lastLogAt < HOST_FAIL_WINDOW / 2) return;
    st.lastLogAt = now;
    this.logger(
      `${Math.round(HOST_FAIL_WINDOW / 1000)} 秒内 ${host} 已失败 ${st.times.length} 次，` +
        `暂停 ${Math.round(cool / 1000)} 秒后再继续（这类 CDN 会按请求频率主动断连，属于限流，不是链接失效）`
    );
  }

  stop() {
    this._stopped = true;
    this._queue.length = 0;
  }

  /** 加入任务；任务 { url, dest, kind, meta } */
  push(task) {
    this._queue.push(task);
  }

  async run() {
    this._stopped = false;
    const workers = [];
    const n = Math.max(1, Math.min(this.concurrency, 16));
    for (let i = 0; i < n; i++) workers.push(this._worker());
    await Promise.all(workers);
    return this.stats;
  }

  async _worker() {
    while (!this._stopped) {
      const task = this._queue.shift();
      if (!task) break;

      let lastErr = null;
      let ok = false;
      for (let attempt = 0; attempt <= this.maxRetry; attempt++) {
        if (this._stopped) break;
        // 这个主机刚被限流的话，先等它缓一缓再发 —— 猛冲只会继续被重置
        await this._respectCooldown(task.url);
        if (this._stopped) break;
        try {
          await this._downloadOne(task);
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          // CDN 断连（terminated / socket hang up）多为瞬时，重试即可；
          // 但 404、403 属于永久失败，重试没有意义。
          if (err.fatal) break;
          // 只把「网络层」的失败记到主机账上：磁盘 EPERM 与主机限流无关
          if (!isTransientFsError(err)) this._noteHostFail(task.url);
          /**
           * 「文件写不进去」这类（EPERM/EACCES/EBUSY）比网络抖动更需要耐心：
           * 杀毒软件扫完一遍、上一个句柄真正关掉，都要几百毫秒到几秒。
           * 网络抖动 0.7s 起步就够了，这里给到 1.2s 起步（1.2/2.4/4.8s）。
           */
          const base = isTransientFsError(err) ? 1200 : 700;
          if (attempt < this.maxRetry) await sleep(base * 2 ** attempt);
        }
      }

      if (!ok) {
        this.stats.failed++;
        // `fetch failed` 这种壳子对用户毫无意义（真相在 err.cause 里），
        // 统一翻译成「域名解析失败 / 连接被拒绝 / 代理连不上」这类可行动的描述。
        const msg = describeNetworkError(lastErr);
        this.logger(`失败：${path.basename(task.dest)} → ${msg}`);
        this.onProgress({ event: 'fail', task, error: msg, stats: this._snapshot() });
      }
    }
  }

  /**
   * 组装一次下载请求的头。
   *
   * 防盗链要的 `Referer` 走 `refererFor()`：**明文目标 + 加密 Referer 这个组合
   * 会被 Chromium 网络栈直接拦掉整个请求**（`net::ERR_BLOCKED_BY_CLIENT`），
   * 那种情况下宁可不带 Referer，也不要让请求发不出去。详见 core/net.js。
   */
  _headers(url) {
    const headers = { 'User-Agent': desktopUA() };
    const referer = refererFor(url, this.referer);
    if (referer) headers.Referer = referer;
    return headers;
  }

  _snapshot() {
    return { ...this.stats, remaining: this._queue.length };
  }

  /**
   * 依次尝试候选 URL：原图/原片不可用（404/403）时自动回退到下一个。
   * 只有永久性失败才切换地址；网络抖动交给外层重试，避免无谓地换源。
   *
   * 全部候选都打完仍然 403/404 时，再向平台层要一次**新地址**（签名会过期），
   * 有新的就整条链重跑一遍 —— 但**每个任务只刷新一次**，杜绝重试风暴。
   */
  async _downloadOne(task) {
    let urls = [task.url, ...(task.altUrls || [])].filter(Boolean);
    let refreshed = false;
    let lastErr;
    for (let i = 0; i < urls.length; i++) {
      try {
        await this._downloadFrom(urls[i], task);
        return;
      } catch (err) {
        lastErr = err;
        if (!err.fatal) throw err;
        // 换地址意味着内容不同，已写入的部分必须丢弃后从头下载
        await fsp.unlink(task.dest).catch(() => {});
        if (i < urls.length - 1) continue;
        if (!refreshed && this.refreshUrl) {
          refreshed = true;
          const fresh = await this._askFreshUrls(task, urls);
          if (fresh.length) {
            urls = fresh;
            i = -1; // 下一轮循环从新链的第一条开始
            continue;
          }
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /** 向平台层要一份新地址（失败一律视为「没有新地址」，绝不把普通失败升级成异常） */
  async _askFreshUrls(task, tried) {
    try {
      const fresh = await this.refreshUrl(task);
      const list = (Array.isArray(fresh) ? fresh : []).filter(
        (u) => typeof u === 'string' && u.startsWith('http') && !tried.includes(u)
      );
      if (list.length) {
        this.logger(`地址已失效，改用重新获取的地址重试：${path.basename(task.dest)}`);
      }
      return list;
    } catch {
      return [];
    }
  }

  /**
   * 探总长度：HEAD 优先，拿不到就退一步用「只要 1 字节」的 Range 请求。
   *
   * 为什么要退这一步（真机实测，第 17 轮）：微博视频 CDN `f.video.weibocdn.com`
   * **直接拒绝 HEAD**（403），但接受带 Range 的 GET（206，并从 Content-Range 给出总长）。
   * 只试 HEAD 的后果是总长恒为 null，于是：
   *   · 进度条只能显示占位值（那条细进度条永远不动）
   *   · 「跳过已存在」对视频彻底失效 —— 每次跑都要把上百个视频重下一遍
   */
  async _probeTotal(url) {
    try {
      const head = await this.fetchImpl(url, { method: 'HEAD', headers: this._headers(url) });
      /**
       * ⚠️ 必须先看状态码：微博视频 CDN 拒绝 HEAD 时回的是 **403 + Content-Length: 146**
       * （一段错误页 HTML）。不看状态码就会把「146」当成文件总长，
       * 于是「已存在 5000 字节 ≠ 146」→ 每次都判定为要重下，
       * 细进度条还会按 146 字节乱跳。
       */
      const okHead = head.status === 200 || head.status === 206;
      const len = okHead ? head.headers?.get?.('content-length') : null;
      if (len) {
        const n = parseInt(len, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      /* HEAD 不给就用下一种 */
    }
    try {
      const headers = this._headers(url);
      headers.Range = 'bytes=0-0';
      const r = await this.fetchImpl(url, { headers });
      const okRange = r.status === 200 || r.status === 206;
      const cr = okRange ? r.headers?.get?.('content-range') || '' : '';
      const m = cr.match(/\/(\d+)\s*$/);
      let total = m ? parseInt(m[1], 10) : NaN;
      if ((!Number.isFinite(total) || total <= 0) && okRange) {
        // 服务端忽略 Range 直接回了整份 —— content-length 就是总长
        const len = r.headers?.get?.('content-length');
        total = len ? parseInt(len, 10) : NaN;
      }
      // 这个响应体我们不读，立刻断掉，别把整个文件拖下来
      try {
        if (r.body && typeof r.body.cancel === 'function') await r.body.cancel();
      } catch {
        /* 忽略 */
      }
      if (Number.isFinite(total) && total > 0) return total;
    } catch {
      /* 探不到就按未知处理，后面会给占位值 */
    }
    return null;
  }

  /**
   * 打开目标文件的写句柄（带 Windows 专项恢复）。
   *
   * ⚠️ 为什么这里不能用 `fs.createWriteStream(dest)` 直接建流（第 18 轮真凶之一）：
   *   createWriteStream 的 open 是**异步**的，失败通过 'error' 事件抛。
   *   真机上 Electron 的 `ses.fetch` 返回的是 **WHATWG 流**（有 getReader、没有 pipe，
   *   test/session-fetch-main.js 实测确认），于是走的是下面「手动 ws.write」那条分支；
   *   而那条分支在 open 失败的那一刻**还没有挂任何 'error' 监听器**，
   *   EPERM 就直接冲成 uncaughtException 写进 crash.log，下载器自己
   *   只拿到一具空壳失败 —— 用户第 18 轮日志正是这个形态（9 条 uncaughtException，
   *   3 个文件，界面上只有冷冰冰的「失败 3」）。
   *   改成先 `fsp.open`（Promise 版，失败是正常 reject），再从 fd 建流，
   *   错误就能被 try/catch 接住，也保证一定走到 finally 里关句柄。
   *
   * ⚠️ 为什么失败后要「去只读 / 换临时名」而不是原地重试（第 18 轮真凶之二）：
   *   真机实验（tmp/eperm-probe.js）量过：只读属性 → `EPERM ... open`，且**重试
   *   多少次都不会好**；而「被别的进程独占」「删除挂起」都不会报 EPERM。
   *   所以处置必须对症：先去掉只读属性；目标名仍然写不进去时，
   *   换一个临时名写、写完再 rename 回去（rename 与「建新文件」走的不是同一条检查，
   *   「文件名被占用/删除挂起/杀软拦截」这类场景往往只有它能成）。
   *
   * @returns {Promise<{ fh: import('fs/promises').FileHandle, tmp: string|null }>}
   */
  async _openTarget(dest, append) {
    for (let i = 0; i < 3; i++) {
      try {
        return { fh: await fsp.open(dest, append ? 'a' : 'w'), tmp: null };
      } catch (err) {
        // 只有「权限/占用」这一类才值得处置；ENOENT、EISDIR 等直接抛，别瞎折腾
        if (!isTransientFsError(err)) throw err;
        await clearReadOnly(dest);
        if (i < 2) await sleep(120 * (i + 1));
      }
    }
    const tmp = tmpNameFor(dest);
    try {
      return { fh: await fsp.open(tmp, 'w'), tmp };
    } catch (err) {
      throw Object.assign(
        new Error(
          `无法创建文件 ${path.basename(dest)}（${err.code || err.message}）：` +
            `可能是只读、被其他程序占用，或被杀毒软件拦截`
        ),
        { code: err.code }
      );
    }
  }

  /** 临时名 → 目标名。rename 在 Windows 上会覆盖同名文件；撞上只读目标就先删再改。 */
  async _commitTmp(tmp, dest) {
    try {
      await fsp.rename(tmp, dest);
      return;
    } catch {
      /* 目标只读或被占用：先删掉再改名 */
    }
    await fsp.unlink(dest).catch(() => {});
    await fsp.rename(tmp, dest);
  }

  async _downloadFrom(url, task) {
    const dest = task.dest;
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    let start = 0;
    try {
      const st = await fsp.stat(dest);
      start = st.size;
    } catch {
      start = 0;
    }

    // 先探一次总长度（HEAD 不给就用 1 字节的 Range 请求兜底，见 _probeTotal）
    let total = await this._probeTotal(url);

    if (this.skipExisting && total !== null && start === total && start > 0) {
      this.stats.skipped++;
      this.logger(`跳过（已存在）：${path.basename(dest)}`);
      this.onProgress({ event: 'skip', task, stats: this._snapshot() });
      return;
    }
    if (total !== null && start > total) start = 0; // 文件比远端还大，重下

    // 关键：只有「本次会话自己写过的文件」才允许 Range 续传。
    // 上次遗留的文件可能是另一种画质（例如先下了 large、现在要 original），
    // 按 Range 拼接会把两种画质的字节混在一起，得到能打开但内容损坏的图片。
    if (start > 0 && !this._written.has(dest)) start = 0;

    /**
     * 在发请求**之前**先占住目标文件，三个理由：
     *   ① 落不了盘要尽早知道，别把几百 KB 下完了才发现写不进去；
     *   ② 万一只能落到临时名，就必须**从头重下**（临时文件是空的，续传会缺前面那段），
     *      先占位才知道该不该带 Range；
     *   ③ fsp.open 的失败是正常 reject（见 _openTarget 的注释）。
     */
    const { fh, tmp } = await this._openTarget(dest, start > 0);
    this._written.add(dest);

    const headers = this._headers(url);
    // 落到临时名 = 从头写，不能续传
    if (start > 0 && !tmp) headers.Range = `bytes=${start}-`;
    const resumeFrom = tmp ? 0 : start;

    const streamPath = tmp || dest;
    const ws = fs.createWriteStream(streamPath, { fd: fh.fd, autoClose: false });
    /**
     * 写流自身的错误也必须有人接：只靠 `ws.write()` 的回调是不可靠的
     * （Node 文档原话：要可靠地发现写入错误，请监听 'error' 事件）。
     * 漏了它，就会再收获一发 uncaughtException。
     */
    let wsErr = null;
    ws.on('error', (e) => {
      wsErr = wsErr || e;
    });

    let written = resumeFrom;
    let ok = false;

    try {
      const res = await this.fetchImpl(url, { headers });
      if (!res.ok && res.status !== 206) {
        if (res.status === 404 || res.status === 403) {
          throw Object.assign(new Error(`HTTP ${res.status}（资源不可用或已失效）`), { fatal: true });
        }
        throw new Error(`HTTP ${res.status}`);
      }

      // 边下边上报（200ms 节流）：等下完才报的话，大视频会让进度条长时间不动
      let lastReport = 0;
      const report = () => {
        const now = Date.now();
        if (now - lastReport < 200) return;
        lastReport = now;
        this.onProgress({ event: 'progress', task, written, total, stats: this._snapshot() });
      };

      const body = res.body;
      if (body && typeof body.pipe === 'function') {
        // Node 流：进度计数挂在一个中间 PassThrough 上 ——
        // 早先把 'data' 直接挂在 body 上会让它提前进入流动模式，
        // pipeline 还没接管就先把前面几块丢掉了（文件会静默截断）。
        const counter = new PassThrough();
        counter.on('data', (c) => {
          written += c.length;
          this.stats.bytes += c.length;
          report();
        });
        await pipeline(body, counter, ws);
      } else {
        if (body) {
          // WHATWG 流（真机上 Electron 的 ses.fetch 就是这种）
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            written += value.length;
            this.stats.bytes += value.length;
            await new Promise((resolve, reject) => {
              ws.write(value, (err) => (err ? reject(err) : resolve()));
            });
            if (wsErr) throw wsErr;
            report();
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          await new Promise((resolve, reject) => {
            ws.write(buf, (err) => (err ? reject(err) : resolve()));
          });
          if (wsErr) throw wsErr;
        }
        if (wsErr) throw wsErr;
        await new Promise((resolve, reject) => {
          ws.on('finish', resolve);
          ws.on('error', reject);
          ws.end();
        });
      }
      if (wsErr) throw wsErr;

      // 空文件视为失败
      const after = await fsp.stat(streamPath).catch(() => ({ size: 0 }));
      if (after.size === 0) throw new Error('下载结果为空');

      /**
       * 句柄先关：Windows 上带着打开的句柄是改不了名的。
       * 而且「完成」必须等文件真正落到目标名之后再算 —— 否则改名失败时
       * 会出现同一个任务既计成功又计失败的对不上账。
       */
      await fh.close().catch(() => {});
      if (tmp) await this._commitTmp(tmp, dest);

      ok = true;
      this.stats.done++;
      this.onProgress({ event: 'done', task, size: after.size, stats: this._snapshot() });
    } finally {
      /**
       * 句柄一定关。早先「手动 ws.write」那条分支一旦在写入中出错就直接抛出，
       * 既没有 end 也没有 destroy —— 句柄一直挂在那个文件上，
       * Windows 上表现为「这个文件从此再也打不开」（第 18 轮那 3 个文件的 EPERM）。
       */
      try {
        if (!ws.destroyed) ws.destroy();
      } catch {
        /* 忽略 */
      }
      await fh.close().catch(() => {}); // 成功路径上已经关过一次，重复关无害
      if (tmp) {
        if (!ok) await fsp.unlink(tmp).catch(() => {});
      } else if (!ok && resumeFrom === 0 && written === 0) {
        // 一个字节都没写进去：别留下空文件占位（旧行为也是「HTTP 出错就不建文件」）
        await fsp.unlink(dest).catch(() => {});
      }
    }
  }
}

/**
 * 这几类错误是 Windows 上「**原样重试多少次都不会好**」的典型：
 *   EPERM  只读属性 / 文件正被杀毒软件短暂持有 / 上一支句柄没关导致删除挂起
 *   EACCES 同类（POSIX 下就是没有写权限）
 *   EBUSY  文件被别的程序打开
 * 它们都不是「资源没了」（那是 404/403，永久失败），所以不该放弃，
 * 但重试之前必须先做对应的处置（去只读 → 换临时名）。
 */
function isTransientFsError(err) {
  const c = err && err.code;
  return c === 'EPERM' || c === 'EACCES' || c === 'EBUSY' || c === 'EAGAIN';
}

/** 去掉目标文件的只读属性 —— Windows 上 `open` 报 EPERM 的头号成因 */
async function clearReadOnly(dest) {
  try {
    const st = await fsp.stat(dest);
    if ((st.mode & 0o222) === 0) await fsp.chmod(dest, 0o666);
  } catch {
    /* 文件不存在或无权修改：忽略，后面还有临时名兜底 */
  }
}

/** 目标名写不进去时用的临时名（必须与目标同目录，rename 才不会跨卷） */
function tmpNameFor(dest) {
  return `${dest}.part-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function desktopUA() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

/** 带重试地运行单个下载（供 Live Photo 等需要单独控制的地方使用） */
async function downloadWithRetry(downloader, task, maxRetry = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      await downloader._downloadOne(task);
      return true;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw lastErr;
}

module.exports = {
  Downloader,
  downloadWithRetry,
  isTransientFsError,
  clearReadOnly,
  tmpNameFor,
};
