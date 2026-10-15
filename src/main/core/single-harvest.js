/**
 * 单作品采集器（小红书 / 抖音共用）
 *
 * 与列表采集器（core/harvester.js）的关系：
 *   两者共用**同一套底层手法** —— 隐藏窗口打开页面、注入脚本复制页面自己发的
 *   接口响应、首屏直出数据兜底 —— 因为签名（小红书的 x-s、抖音的 a_bogus）
 *   只能在页面环境里生成。
 *   但流程完全不同，所以不强行合并进 Harvester：
 *     列表：滚动触发懒加载 → 反复采集 → 直到无新增 → 再逐个补全详情
 *     单作品：打开一篇 → 等这一篇的数据出现 → 收工
 *   把单作品塞进 Harvester 会让那个已经被真机反复调过的循环多出一堆
 *   「如果不是单作品模式就……」的分支，两边都更容易出错。
 *
 * 与 Harvester 相同的对外接口：`ingest(url, data)` / `stop()`。
 * 主进程把注入脚本截获的数据转发进来时走的就是 ingest（见 main.js 的 harvest:data），
 * 所以 TaskRunner 那边 `setCollector()` 的接法一字不用改。
 *
 * ⚠️ 核心约束：**只认目标 id**。
 *   作品详情页底部永远挂着「相关推荐 / 为你推荐」，里面的作品结构与目标作品
 *   完全一样，解析层从数据上分不出来（这与主页采集里「喜欢」列表那个坑同源）。
 *   所以这里不做「采到什么算什么」，而是严格按 id 过滤：宁可报失败，
 *   也不能把别人的作品下到用户磁盘上。
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const { attachUrlGuards } = require('../url-guard');
const { SSR_BUNDLE_JS } = require('./ssr-walk');
const { harvestArguments } = require('../../preload/harvest-match');
/** 媒体完整度打分复用列表采集器那一份 —— 「同一件事只有一份实现」 */
const { mediaScore } = require('./harvester');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class SingleHarvester {
  /**
   * @param {object} opts
   * @param {string}   opts.partition  持久化分区
   * @param {string}   opts.url        作品页地址
   * @param {string}   opts.targetId   目标作品 id（严格匹配，见模块头注释）
   * @param {string[]} [opts.altIds]   备选 id（同一作品的不同编号形态）
   * @param {Function} opts.parse      (data) => items
   * @param {Function} opts.wrapSSR    (arr) => data
   * @param {Function} [opts.onLog]
   * @param {number}   [opts.timeoutMs=30000] 单轮等待上限
   * @param {number}   [opts.pollMs=700]      轮询间隔
   * @param {boolean}  [opts.showWindow=false]
   */
  constructor({
    partition,
    url,
    targetId,
    altIds = [],
    parse,
    wrapSSR,
    onLog,
    timeoutMs = 30000,
    pollMs = 700,
    showWindow = false,
  }) {
    this.partition = partition;
    this.url = url;
    this.parse = parse;
    this.wrapSSR = wrapSSR || ((arr) => arr);
    this.onLog = onLog || (() => {});
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.showWindow = !!showWindow;

    /** 严格匹配用的 id 集合 */
    this.want = new Set([targetId, ...(altIds || [])].map((x) => String(x || '')).filter(Boolean));

    this.items = new Map();
    this.intercepted = 0; // 截获到多少个候选响应（区分「页面没发请求」和「发了但没数据」）
    this.ssrFound = 0; // 首屏直出里找到多少条候选作品
    this.ssrHits = 0; // 「翻到了数据」的次数
    this.ssrError = ''; // 取到了却没带回来的原因（诊断用）
    this.skippedForeign = 0; // 被 id 过滤挡掉的「别人的作品」条数
    this.win = null;
    this.stopped = false;
  }

  /** 主进程转发截获数据用（与 Harvester 同名同签名） */
  ingest(url, data) {
    if (!data || typeof data !== 'object') return 0;
    this.intercepted++;
    let list = [];
    try {
      list = this.parse(data) || [];
    } catch (err) {
      this.onLog(`解析响应失败：${err.message}`);
      return 0;
    }
    let added = 0;
    for (const it of list) {
      if (!it || !it.id) continue;
      const id = String(it.id);
      if (this.want.size && !this.want.has(id)) {
        // 详情页底部的「相关推荐」走的就是这条路：结构完整、但根本不是这篇
        this.skippedForeign++;
        continue;
      }
      const old = this.items.get(id);
      if (!old || mediaScore(it) > mediaScore(old)) {
        this.items.set(id, it);
        added++;
      }
    }
    return added;
  }

  /** 在页面上下文里翻首屏直出数据（与 Harvester 共用同一段注入脚本） */
  async _harvestSSR() {
    if (!this.win || this.win.isDestroyed()) return 0;
    try {
      const got = await this.win.webContents.executeJavaScript(SSR_BUNDLE_JS);
      const arr = got && got.notes;
      if (!Array.isArray(arr) || !arr.length) return 0;
      this.ssrFound = arr.length;
      this.ssrHits++;
      // wrapSSR 把「首屏的作品数组」包成该平台解析层认识的结构
      return this.ingest('ssr:initial-state', this.wrapSSR(arr));
    } catch (err) {
      // 「页面里有数据却带不过来」和「页面里没数据」是两件事，必须分开记
      this.ssrError = (err && err.message) || String(err);
      return 0;
    }
  }

  async _load() {
    try {
      await this.win.loadURL(this.url);
    } catch (err) {
      this.onLog(`页面加载失败：${err.message}`);
    }
    // 等首屏请求发出（与列表采集器同一节奏，实测足够）
    await sleep(1200);
  }

  /** 轮询直到目标作品出现 */
  async _waitForTarget(deadline, label) {
    while (!this.stopped && Date.now() < deadline && this.items.size === 0) {
      if (!this.win || this.win.isDestroyed()) break;
      await sleep(this.pollMs);
      await this._harvestSSR();
    }
    if (this.items.size) this.onLog(`${label}取到作品数据（共 ${this.items.size} 条媒体条目）`);
  }

  /** 一条都没采到时的现场报告（沿用列表采集器的思路：把可观测事实都摆出来） */
  async _diagnoseEmpty() {
    const lines = [];
    lines.push(`该作品没有采到数据（截获到 ${this.intercepted} 个候选响应）`);
    if (this.ssrError) lines.push(`首屏数据取到了但没能带回主进程（${this.ssrError}）`);
    if (this.ssrFound) lines.push(`首屏数据里有 ${this.ssrFound} 条候选作品，但都不是目标 id`);
    if (this.skippedForeign) {
      lines.push(`已忽略 ${this.skippedForeign} 条「相关推荐」里的他人作品（不属于本次目标）`);
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
      /* 窗口可能已不可用 */
    }
    if (pageUrl && /login|passport/i.test(pageUrl)) {
      lines.push('页面已被重定向到登录页 —— 请先完成登录');
    } else if (pageUrl && pageUrl !== this.url) {
      lines.push(`页面最终地址已变化：${pageUrl}`);
    }
    if (bodyLen >= 0 && bodyLen < 800) {
      lines.push(`页面正文只有 ${bodyLen} 个字符，内容区基本是空的 —— 该链接当前打不开这篇作品`);
    }
    if (this.intercepted === 0) {
      lines.push('一个相关接口请求都没截获到：多为链接已失效（重新复制一次作品链接）或该作品已删除/仅自己可见');
    }
    return lines.join('；');
  }

  async start() {
    this.win = new BrowserWindow({
      show: this.showWindow,
      width: 1366,
      height: 900,
      webPreferences: {
        partition: this.partition,
        preload: path.join(__dirname, '..', '..', 'preload', 'harvest-preload.js'),
        // 与列表采集窗同一取舍：注入脚本必须与页面脚本同处一个 JS 世界，
        // 否则包装不了页面的 fetch/XHR，截获全部落空。详见 harvester.js 的同名注释。
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        // 单作品模式要放行详情接口（/aweme/v1/web/aweme/detail、sns/web/v1/feed）
        additionalArguments: harvestArguments({ single: true }),
      },
    });

    // 作品页里「打开 App 看更多」这类深链比主页还密集，护栏必须挂
    attachUrlGuards(this.win.webContents, {
      log: (m) => this.onLog(m),
      notifyWebOpen: false,
    });

    this.onLog(`正在打开作品页：${this.url}`);
    await this._load();

    // 未登录通常先被重定向到登录页，早点说出来比最后只给一个「0 条」有用
    const current = this.win.webContents.getURL();
    if (/login|passport/i.test(current) && !/login/i.test(this.url)) {
      this.onLog('检测到页面跳转到登录页 —— 请先完成登录再试');
    }

    await this._waitForTarget(Date.now() + this.timeoutMs, '已');

    /**
     * 首屏是间歇性空壳的（小红书尤其明显，与列表采集同一个现象）：
     * 服务端不报错、正文却只有导航与页脚。重新加载一次往往就好。
     */
    if (!this.stopped && this.items.size === 0 && this.win && !this.win.isDestroyed()) {
      this.onLog('首次加载没有取到该作品，重新加载一次再试…');
      await this._load();
      await this._waitForTarget(Date.now() + Math.min(this.timeoutMs, 15000), '重载后');
    }

    if (!this.stopped && this.items.size === 0) {
      try {
        this.onLog(await this._diagnoseEmpty());
      } catch {
        /* 诊断失败不影响返回空结果 */
      }
    }

    const items = [...this.items.values()];
    this.close();
    return items;
  }

  stop() {
    this.stopped = true;
  }

  close() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
      this.win = null;
    }
  }
}

module.exports = { SingleHarvester };
