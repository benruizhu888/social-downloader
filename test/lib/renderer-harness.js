/**
 * 渲染层测试脚手架（纯 Node，零依赖）
 *
 * 这个工程没有 Electron 依赖（package.json 只有 ffmpeg-static），源码最终被打进 app.asar
 * 交给已安装的应用加载 —— 本地跑不了真窗口。所以这里自建一个**最小 DOM 模拟器**：
 * 按 index.html 的真实 id / class / data 属性 / hidden 建出元素，把 app.js 整份丢进 vm 执行。
 *
 * 能证明的：$() 不会拿到 null、事件绑定不抛、日志/进度两条链路能走完、边界输入不炸。
 * 不能证明的：真实布局与滚动、CSS 实际生效、主进程 IPC 的双方行为。
 *
 * 两个刻意的取舍（都是被真实坑教出来的）：
 *   · requestAnimationFrame 用**手工泵**（pumpRaf）而不是同步直接执行 ——
 *     同步执行会让 `logRaf = requestAnimationFrame(cb)` 在 cb 跑完后把句柄写回去，
 *     rAF 合批只生效一次，测试就会得出「合批是坏的」这种假结论。
 *   · 不假装支持完整 CSS 选择器：只按最后一个复合选择器匹配，忽略祖先关系。
 *
 * 用法：
 *   const { createHarness } = require('./lib/renderer-harness');
 *   const h = createHarness();
 *   h.log('xx'); h.pumpRaf(); h.el('logCount').textContent;
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

/* ============================== 最小 DOM ============================== */

class MockClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

class MockNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.classList = new MockClassList();
    this._text = '';
    // 从 index.html 解析出来的静态文案（标签之间的文本）。
    // 单独存而不是建成子节点：真实的 `children` / `childElementCount` 本来就不含文本节点，
    // 混进去会让所有按节点数断言的用例集体失真。
    this._rawText = '';
    this._hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.fragment = false;
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get hidden() { return this._hidden; }
  set hidden(v) { this._hidden = !!v; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this._text || this._rawText; }
  set textContent(v) { this._text = String(v); this._rawText = ''; this.children = []; }
  set innerHTML(_v) { this.children = []; this._text = ''; }
  get innerHTML() { return ''; }
  appendChild(n) {
    if (!n) return n;
    if (n.fragment) {
      for (const c of n.children.slice()) this.appendChild(c);
      n.children = [];
      return n;
    }
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  insertBefore(n, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const a = this.listeners[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  getBoundingClientRect() { return { width: 100, height: 20, left: 0, top: 0 }; }
  /**
   * 选择器查询限定在**自己这棵子树**里，与真实 DOM 一致。
   *
   * 早先这里是在全局节点表上筛，于是 `box.querySelector('.log-empty')` 会命中
   * 上一次 rerender 留下的、已经脱离文档的旧占位节点 —— 那个节点上的 `.remove()`
   * 什么也不做，真正的占位留在原地，测试就会得出「空态没被清掉」这种假结论。
   * 替身的错误比产品的错误更贵：它会把人引到错误的方向上去改代码。
   */
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === '#TEXT') continue;
        if (matchesAny(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** 触发已注册的监听器（测试用） */
  fire(type, ev) { (this.listeners[type] || []).slice().forEach((fn) => fn(ev || {})); }
  /**
   * 递归取出全部后代文本（含从 index.html 解析出来的静态文案）。
   * 注意 textContent 的 setter 会把 _text 设上并清空 children，所以一个节点可能
   * 「只有 _text 没有 children」—— 只看 children 会漏掉整段正文，断言就会假失败。
   */
  allText() {
    const parts = [];
    if (this._rawText) parts.push(this._rawText);
    if (this._text) parts.push(this._text);
    for (const c of this.children) parts.push(c.tagName === '#TEXT' ? c.textContent : c.allText());
    return parts.join(' ');
  }
  /** 递归统计后代里的元素节点（不含文本节点） */
  countElements() {
    let n = 0;
    for (const c of this.children) {
      if (c.tagName === '#TEXT') continue;
      n += 1 + c.countElements();
    }
    return n;
  }
}

function simpleMatch(el, sel) {
  const tag = (sel.match(/^[a-zA-Z][\w-]*/) || [])[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const c of sel.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(c[1])) return false;
  for (const a of sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const v = el.dataset[a[1]] !== undefined ? el.dataset[a[1]] : el.attrs[a[1]];
    if (v === undefined) return false;
    if (a[2] !== undefined && String(v) !== a[2]) return false;
  }
  return true;
}

function matchesAny(el, sel) {
  return String(sel).split(',').some((part) => {
    const tokens = part.trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    return !!last && simpleMatch(el, last);
  });
}

/* ============================== 脚手架 ============================== */

const DEFAULT_PLATFORMS = [
  {
    id: 'weibo', name: '微博', siteURL: 'https://weibo.com', loginURL: 'https://passport.weibo.com/',
    inputMeta: {
      placeholder: '粘贴微博主页链接 / 单条微博链接 / UID / 昵称',
      hint: 'h',
      exampleProfile: 'https://weibo.com/u/1234567890',
      exampleItem: 'https://weibo.com/1234567890/P0RSAbcde',
    },
    needsBrowserHarvest: false, supportsManualCookie: true,
    supportsOriginalImage: true, supportsLivePhoto: true, supportsOnlyOriginal: true,
    optionsSchema: [
      { key: 'downloadImages', label: '下载图片', type: 'bool' },
      { key: 'onlyOriginal', label: '只要原创', type: 'bool', scope: 'profile' },
      { key: 'maxItems', label: '最多作品数', type: 'number', min: 0, max: 100, step: 1, scope: 'profile' },
    ],
  },
  {
    id: 'xhs', name: '小红书', siteURL: 'https://www.xiaohongshu.com', loginURL: 'https://www.xiaohongshu.com/',
    inputMeta: {
      placeholder: 'p3',
      hint: 'h3',
      exampleProfile: 'https://www.xiaohongshu.com/user/profile/XHS_USER_ID_PLACEHOLDER',
      exampleItem: 'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER?xsec_token=XHS_XSEC_TOKEN_PLACEHOLDER',
    },
    needsBrowserHarvest: true,
    supportsOriginalImage: true, supportsLivePhoto: true,
    optionsSchema: [{ key: 'downloadImages', label: '下载图片', type: 'bool' }],
  },
  {
    id: 'douyin', name: '抖音', siteURL: 'https://www.douyin.com', loginURL: 'https://www.douyin.com/',
    inputMeta: {
      placeholder: 'p2',
      hint: 'h2',
      exampleProfile: 'https://www.douyin.com/user/DOUYIN_SEC_UID_PLACEHOLDER',
      exampleItem: 'https://www.douyin.com/video/7300000000000000000',
    },
    needsBrowserHarvest: true,
    supportsOriginalImage: true, supportsLivePhoto: true,
    optionsSchema: [{ key: 'downloadImages', label: '下载图片', type: 'bool' }],
  },
];

/**
 * @param {object} [opts]
 * @param {Array}  [opts.platforms]  覆盖 app:info 返回的平台列表
 * @param {object} [opts.settings]   覆盖 settings:get 返回值
 * @param {object} [opts.api]        覆盖 / 追加 IPC 桩（async 函数）
 */
function createHarness(opts = {}) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

  const registry = [];
  const byId = new Map();
  const allNodes = [];

  const queryAll = (sel) => allNodes.filter((el) => el.tagName !== '#TEXT' && matchesAny(el, sel));

  /**
   * 按真实嵌套关系把 index.html 建成一棵树（而不是一张扁平的节点表）。
   * 只有真嵌套了，`box.querySelector(...)`、`box.children`、`applyOptionScope`
   * 这类「只在自己子树里找」的行为才和浏览器一致。index.html 是我们自己的模板，
   * 结构规整，用一个栈式解析器足够，不需要引入 HTML 解析库。
   */
  const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
  const document = {
    body: new MockNode('body'),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const el = new MockNode(tag);
      allNodes.push(el);
      return el;
    },
    createTextNode: (s) => {
      const el = new MockNode('#text');
      el.textContent = s;
      return el;
    },
    createDocumentFragment: () => {
      const el = new MockNode('#fragment');
      el.fragment = true;
      return el;
    },
    querySelector: (sel) => queryAll(sel)[0] || null,
    querySelectorAll: (sel) => queryAll(sel),
  };

  (function buildTree() {
    const src = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '');
    const rootTag = new MockNode('#root');
    const stack = [rootTag];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    let prevEnd = 0;
    while ((m = re.exec(src))) {
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const attrs = m[3] || '';
      // 记下这段标签之前的文本，归给「当前所在的元素」——
      // 静态文案（例如「单个作品 只下载这一条」）就是靠它才能被断言到
      const between = src.slice(prevEnd, m.index);
      prevEnd = re.lastIndex;
      if (between.trim()) stack[stack.length - 1]._rawText += between;
      if (tag === 'script' || tag === 'link' || tag === 'meta') continue;
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName === tag.toUpperCase()) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const el = new MockNode(tag);
      const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1];
      if (cls) el.className = cls;
      const id = (attrs.match(/\bid="([^"]*)"/) || [])[1];
      if (id) {
        el.id = id;
        byId.set(id, el);
      }
      for (const a of attrs.matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
        el.dataset[a[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = a[2];
      }
      if (/\bhidden\b(\s|>|=|$)/.test(attrs)) el.hidden = true;
      stack[stack.length - 1].appendChild(el);
      registry.push(el);
      if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(attrs)) stack.push(el);
    }
    document.body = rootTag;
  })();
  allNodes.push(...registry);



  /* --------- 手工泵的 rAF + 可推进的时钟 --------- */
  let rafSeq = 0;
  const rafQueue = [];
  const pumpRaf = () => {
    let guard = 0;
    while (rafQueue.length && guard++ < 500) rafQueue.shift()(++rafSeq);
  };
  /** 一次 rAF 回调里可能又排了新的，泵两轮更贴近真实（每帧执行一次） */
  const pumpFrames = (n = 1) => { for (let i = 0; i < n; i++) pumpRaf(); };

  let clockOffset = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + clockOffset);
      else super(...args);
    }
    static now() { return RealDate.now() + clockOffset; }
  }
  const now = () => FakeDate.now();
  const advance = (ms) => { clockOffset += ms; };

  /* --------- IPC 桩 --------- */
  const copied = [];
  let inspectResult = { mode: 'profile' };
  const settings = Object.assign(
    { activePlatform: 'weibo', ffmpegPath: '', platforms: { weibo: { outDir: 'C:\\out' } } },
    opts.settings || {}
  );
  const platforms = opts.platforms || DEFAULT_PLATFORMS;

  const windowObj = { __ui: null, __handler: null, __events: [] };
  windowObj.api = Object.assign({
    info: async () => ({ version: '1.1.0-test', defaultPlatform: platforms[0].id, platforms }),
    getSettings: async () => settings,
    setSettings: async (patch) => Object.assign(settings, patch || {}),
    checkFFmpeg: async () => ({ ok: true, version: '6.0' }),
    authStatus: async () => ({ loggedIn: true, marks: ['SUB'], detail: 'ok', weakSeen: [], loginWindowURL: 'https://weibo.com/u/1' }),
    onEvent: (cb) => { windowObj.__handler = cb; },
    inspectInput: async () => inspectResult,
    copyText: async (t) => { copied.push(t); },
    openLogin: () => {}, logout: async () => {}, openSite: async () => {},
    chooseDir: async () => '', openFolder: () => {}, exportLog: async () => ({ filePath: 'C:\\a.log' }),
    setCookie: async () => {}, start: async () => ({}), stop: async () => {},
  }, opts.api || {});

  const sandbox = {
    console, document, window: windowObj,
    performance: { now: () => now() },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return ++rafSeq; },
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    Date: FakeDate, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  let loadError = null;
  try {
    vm.runInContext(js, sandbox, { filename: 'src/renderer/app.js' });
  } catch (e) {
    loadError = e;
  }

  const pendingRaf = () => rafQueue.length;

  return {
    loadError,
    document,
    windowObj,
    byId,
    el: (id) => byId.get(id) || null,
    txt: (id) => (byId.get(id) ? byId.get(id).textContent : undefined),
    ui: () => windowObj.__ui,
    /** 派发一条主进程事件；同时留档，便于断言「发过什么」 */
    H: (ev) => {
      windowObj.__events.push(ev);
      return windowObj.__handler(ev);
    },
    events: () => windowObj.__events.slice(),
    setInspect: (r) => { inspectResult = r; },
    copied,
    settings,
    pumpRaf,
    pumpFrames,
    pendingRaf,
    advance,
    now,
    MockNode,
  };
}

module.exports = { createHarness, MockNode };
