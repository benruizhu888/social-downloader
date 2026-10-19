/**
 * 采集窗口池（按 `partition|mode` 复用）
 *
 * 为什么需要（J-3）：单作品链路每打开一篇作品就新建一个 BrowserWindow，
 * 用完即 destroy。而 `runTargets` 现在允许 2 个并发 —— 一批 30 条链接就是 30 次
 * 「建窗 → 加载远端页面 → 销毁」。真机上这一步的代价不是零：
 *   · 每个窗口都要重新初始化渲染进程、重新解析 preload、重新握手；
 *   · 销毁是**异步**的，短时间内大量建/毁会让 GPU 进程反复重启（本机实测过
 *     冒烟时 `GPU process exited unexpectedly` 那一串）。
 * 复用窗口后，第二条链接的「打开」接近一次 loadURL。
 *
 * 三条约束（都是真机上必须遵守的）：
 *   1. **不同 partition 绝不能复用同一个窗口** —— 那会把 A 平台的 Cookie
 *      带进 B 平台的页面，轻则未登录、重则串号；
 *   2. **不同 mode 也不共用** —— 列表采集与单作品采集的 preload 参数不同
 *      （`harvestArguments({single:true})`），混用会让响应白名单错档；
 *   3. **空闲 60 秒回收** —— 用户只下一两条时，池里留着一个隐藏窗口没问题；
 *      但一小时后还挂着就是白占内存。
 *
 * 只做「借/还」两件事，不认识任何 electron 之外的东西，因此可以离线单测
 * （注入 `createWindow` 与假计时器）。
 */
const DEFAULT_IDLE_MS = 60000;

class BrowserPool {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.createWindow] (key) => BrowserWindow 造窗函数（测试可注入）
   * @param {number}   [opts.idleMs=60000] 空闲回收时间
   * @param {Function} [opts.setTimeoutFn]
   * @param {Function} [opts.clearTimeoutFn]
   */
  constructor({
    createWindow,
    idleMs = DEFAULT_IDLE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this.createWindow = createWindow || null;
    this.idleMs = idleMs;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    /** key -> { win, timer, busy } */
    this.slots = new Map();
    /** 统计：借了几次、复用了几次、新建了几次（日志与测试都用得上） */
    this.stats = { acquires: 0, reuses: 0, creates: 0, destroys: 0 };
    this._closed = false;
  }

  /**
   * 借一个窗口。
   *
   * 池里有活着且空闲的 → 直接给；否则新建一个。
   * 注意 `acquire` 不 await loadURL —— 加载页面是调用方的事（每个用途要打开的地址不同）。
   *
   * @param {{partition:string, mode?:string, create?:Function}} opts
   * @returns {object} BrowserWindow（调用方用完必须 `release`）
   */
  acquire({ partition, mode = 'single', create } = {}) {
    const key = `${partition || ''}|${mode || ''}`;
    this.stats.acquires++;

    const slot = this.slots.get(key);
    if (slot && slot.win && !this._isDead(slot.win)) {
      if (slot.timer) {
        this._clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.busy = true;
      this.stats.reuses++;
      return slot.win;
    }

    const make = create || this.createWindow;
    if (typeof make !== 'function') {
      throw new Error('BrowserPool 需要一个 createWindow 函数才能建窗');
    }
    const win = make(key);
    this.stats.creates++;
    this.slots.set(key, { win, timer: null, busy: true });
    return win;
  }

  /**
   * 还回去（不销毁）。
   *
   * 顺手把页面切到 `about:blank`：隐藏窗口停在一个正在播放视频的页面上会持续占 CPU，
   * 而且下次 loadURL 之前的这段时间还可能触发页面的定时器。
   *
   * @param {object} win
   */
  release(win) {
    if (!win || this._isDead(win)) return;
    let key = null;
    for (const [k, slot] of this.slots) {
      if (slot.win === win) {
        key = k;
        break;
      }
    }
    if (!key) {
      // 不在池子里（例如被外部 destroy 过）—— 直接收掉，不能泄漏
      this._destroy(win);
      return;
    }
    const slot = this.slots.get(key);
    slot.busy = false;
    try {
      win.hide?.();
      // 不用 await：这一步失败也不影响复用（下次 loadURL 会覆盖掉）
      win.loadURL?.('about:blank')?.catch?.(() => {});
    } catch {
      /* 窗口可能已经在销毁中 */
    }
    if (this._closed) {
      this._destroy(win);
      this.slots.delete(key);
      return;
    }
    slot.timer = this._setTimeout(() => {
      const cur = this.slots.get(key);
      if (!cur) return;
      if (cur.busy) return; // 又被借走了，别误杀
      this._destroy(cur.win);
      this.slots.delete(key);
    }, this.idleMs);
    // 让定时器不阻塞进程退出（Node 环境）
    if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref();
  }

  /** 关掉池里所有窗口（应用退出 / 测试收尾用） */
  destroyAll() {
    this._closed = true;
    for (const [, slot] of this.slots) {
      if (slot.timer) this._clearTimeout(slot.timer);
      this._destroy(slot.win);
    }
    this.slots.clear();
  }

  /** 池子里现在有几个窗口（测试与诊断用） */
  size() {
    return this.slots.size;
  }

  _isDead(win) {
    try {
      return typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
    } catch {
      return true;
    }
  }

  _destroy(win) {
    try {
      if (win && !this._isDead(win)) {
        win.destroy();
        this.stats.destroys++;
      }
    } catch {
      /* 已经销毁了 */
    }
  }
}

/**
 * 进程级单例。
 *
 * 为什么是单例而不是每个调用方各持一个：池子的价值就在于**跨任务复用** ——
 * 用户连点两次「下载单个作品」时，第二个任务应当捡到第一个任务刚还回来的窗口。
 * 每个 runner 各建一个池，等于每条链接都新建一次，白做。
 */
let shared = null;

/** @returns {BrowserPool} */
function getPool() {
  if (!shared) {
    shared = new BrowserPool({
      createWindow: () => {
        // 延迟 require：让本模块在纯 Node 单测里也能被加载（不需要 electron）
        const { BrowserWindow } = require('electron');
        return new BrowserWindow({ show: false });
      },
    });
  }
  return shared;
}

/** 仅测试用：换掉单例（传 null 表示重置） */
function __setPool(pool) {
  shared = pool;
}

module.exports = { BrowserPool, getPool, __setPool, DEFAULT_IDLE_MS };
