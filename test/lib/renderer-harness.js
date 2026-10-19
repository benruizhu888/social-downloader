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
    this.disabled = false;
    /**
     * id 的注册回调，由脚手架注入（见 createHarness 的 makeNode）。
     *
     * 为什么需要它：`renderOptions()` / `rerenderLog()` 都是**运行期**用
     * createElement 建节点再赋值 `.id`。早先 byId 只装 index.html 里的静态 id，
     * 于是 `$('opt_downloadImages')` 恒为 null —— `collectCurrent()` 静默读不到选项，
     * 测试却全绿（它断言的是「不抛异常」）。真实的 getElementById 能找到任何在文档树里的节点，
     * 替身必须一样能找到，否则替身本身就在骗人。
     */
    this._sink = null;
    this._id = '';
    /**
     * 所在 document 的引用，由 makeNode 注入。
     * 焦点管理（focus / document.activeElement / 弹窗焦点归还）需要它 ——
     * 替身里没有焦点概念时，「关闭弹窗后焦点回不去」这类问题根本无法被断言。
     */
    this._doc = null;
  }
  /**
   * 聚焦。真实浏览器的两个副作用这里都还原：
   *   · document.activeElement 指向该元素；
   *   · 上一个焦点元素收到 blur。
   * 只读不算「有焦点」：Tab 循环判据就是 activeElement。
   */
  focus() {
    const doc = this._doc;
    if (!doc) return;
    const prev = doc.activeElement;
    if (prev && prev !== this) prev.blur();
    doc.activeElement = this;
  }
  blur() {
    const doc = this._doc;
    if (doc && doc.activeElement === this) doc.activeElement = doc.body || null;
  }
  /** 渲染后才有 offsetParent（display:none / 未挂载时为 null）——焦点陷阱要过滤掉隐藏元素 */
  get offsetParent() { return this.isConnected(this._doc && this._doc.body) ? this.parentNode : null; }
  get id() { return this._id; }
  set id(v) {
    this._id = String(v == null ? '' : v);
    if (this._id && typeof this._sink === 'function') this._sink(this._id, this);
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get hidden() { return this._hidden; }
  set hidden(v) { this._hidden = !!v; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this._text || this._rawText; }
  set textContent(v) {
    this._text = String(v);
    this._rawText = '';
    this._detachChildren();
  }
  set innerHTML(_v) {
    this._detachChildren();
    this._text = '';
  }
  get innerHTML() { return ''; }
  /**
   * 清空子节点时必须**同时断开 parentNode**。
   * 只清数组的话，被清掉的节点仍能沿 parentNode 走回文档树 ——
   * `closest()` 与「是否真的在文档里」的判断都会被骗，
   * 于是「从界面上删掉的节点」还会被当成活的（真机上是不会的）。
   */
  _detachChildren() {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
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
   * 事件委托的前提：从自己往上找最近一个匹配的祖先（含自身）。
   *
   * 产品代码里到处是 `e.target.closest('.tab')` 这种写法（选项卡、日志级别筛选）：
   * 没有 closest 就只能让测试直接对父节点 fire，于是「点到了子元素还能不能切平台」
   * 这条最真实的行为永远测不到。
   */
  closest(sel) {
    let node = this;
    while (node) {
      if (node.tagName !== '#TEXT' && matchesAny(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** 是否仍挂在文档树上（用于 getElementById 判断「这是不是活着的节点」） */
  isConnected(root) {
    let node = this;
    while (node) {
      if (node === root) return true;
      node = node.parentNode;
    }
    return false;
  }
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
  /**
   * 派发事件（测试用）。
   *
   * 与浏览器对齐的三件事，缺一条就会得出相反的结论：
   *   ① 从 target 往上一路冒泡到 body，`target` 始终是最初那个节点，
   *      `currentTarget` 随正在执行的节点变化（事件委托全靠它）；
   *   ② `ev.stopPropagation()` 能中断后续祖先，否则「委托 + 停止冒泡」的写法测不了；
   *   ③ `disabled` 的元素不触发 click（自身监听器不跑、也不向上冒泡）——
   *      这正是「运行中按钮点不动」这类行为的判据。
   */
  fire(type, ev) {
    const evt = ev || {};
    if (!evt.target) evt.target = this;
    if (!evt.type) evt.type = type;
    let stopped = false;
    /**
     * 真实事件对象一定带 preventDefault / stopPropagation。
     * 缺了它，「Tab 循环自己接管焦点」这类代码只能在真机上跑通、测试里一碰就抛
     * TypeError —— 于是没人敢写、也没有对应的测试。
     */
    if (typeof evt.preventDefault !== 'function') evt.preventDefault = () => {};
    if (typeof evt.stopPropagation !== 'function') evt.stopPropagation = () => { stopped = true; };
    // 浏览器：disabled 表单控件上不会产生 click，事件也不会从它冒泡出去
    if (type === 'click' && this.disabled) return evt;
    let node = this;
    while (node && !stopped) {
      evt.currentTarget = node;
      const list = (node.listeners[type] || []).slice();
      for (const fn of list) fn(evt);
      node = node.parentNode;
    }
    return evt;
  }
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
      // 示例值：非真实博主/笔记
      exampleProfile: 'https://www.xiaohongshu.com/user/profile/EXAMPLE0000000000000000',
      exampleItem: 'https://www.xiaohongshu.com/explore/EXAMPLE0000000000000001?xsec_token=xxxx',
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
      exampleProfile: 'https://www.douyin.com/user/MS4wLjABAAAAxxxxxxxx',
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
  // document 字面量里建的 body 早于 documentRef 赋值，这里补挂一次
  const sealDocument = (doc) => {
    documentRef = doc;
    if (doc.body) doc.body._doc = doc;
  };

  /** document 自身的引用（在 document 字面量建好后再回填，见下方 documentRef = document） */
  let documentRef = null;

  /** 建节点时必须挂上 id 注册回调，否则运行期 `el.id = 'opt_x'` 不会被 getElementById 看到 */
  const makeNode = (tag) => {
    const el = new MockNode(tag);
    el._sink = (id, node) => byId.set(id, node);
    // 回指 document：focus()/blur() 与 offsetParent 都依赖它（见 MockNode 的注释）
    el._doc = documentRef;
    return el;
  };

  /**
   * 按真实嵌套关系把 index.html 建成一棵树（而不是一张扁平的节点表）。
   * 只有真嵌套了，`box.querySelector(...)`、`box.children`、`applyOptionScope`
   * 这类「只在自己子树里找」的行为才和浏览器一致。index.html 是我们自己的模板，
   * 结构规整，用一个栈式解析器足够，不需要引入 HTML 解析库。
   */
  const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
  const docListeners = {};
  const document = {
    body: makeNode('body'),
    /**
     * 焦点所在元素。
     * 弹窗的「打开时聚焦输入框 / 关闭后焦点归还 / Tab 循环」三件事都以它为判据，
     * 替身里没有 activeElement 时这些行为一条都断言不了。
     */
    activeElement: null,
    /** 节点是否仍在文档树里（弹窗关掉后判断「焦点目标还在不在」要用） */
    contains(node) {
      return !!(node && node.isConnected(this.body));
    },
    /** document 级监听（Esc 关闭弹窗这类全局快捷键） */
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = docListeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    /**
     * getElementById：先看注册表（运行期赋 id 的节点会立刻登记），
     * 但只认「还挂在文档树上」的那一个；不在文档里就按树重新找一遍。
     *
     * 为什么不能只查注册表：`renderOptions()` 每次都 `box.innerHTML = ''` 重建，
     * 旧节点留在注册表里但已经脱离文档。只查表会让 `collectCurrent()` 读到
     * **已从界面消失的**那个复选框 —— 测试全绿、真机读到的是另一份数据。
     */
    getElementById: (id) => {
      const hit = byId.get(id);
      if (hit && hit.isConnected(document.body)) return hit;
      const walk = (n) => {
        for (const c of n.children) {
          if (c.id === id) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      const found = walk(document.body);
      if (found) {
        byId.set(id, found);
        return found;
      }
      // 既不注册也不在树上：只有「刚 createElement、还没 append」这一种可能，
      // 浏览器会给 null，这里容错返回，避免测试在 append 之前取不到节点
      return hit || null;
    },
    createElement: (tag) => {
      const el = makeNode(tag);
      allNodes.push(el);
      return el;
    },
    createTextNode: (s) => {
      const el = makeNode('#text');
      el.textContent = s;
      return el;
    },
    createDocumentFragment: () => {
      const el = makeNode('#fragment');
      el.fragment = true;
      return el;
    },
    querySelector: (sel) => queryAll(sel)[0] || null,
    querySelectorAll: (sel) => queryAll(sel),
  };
  sealDocument(document);

  (function buildTree() {
    const src = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '');
    const rootTag = makeNode('#root');
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
      const el = makeNode(tag);
      const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1];
      if (cls) el.className = cls;
      const id = (attrs.match(/\bid="([^"]*)"/) || [])[1];
      if (id) el.id = id;
      for (const a of attrs.matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
        el.dataset[a[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = a[2];
      }
      if (/\bhidden\b(\s|>|=|$)/.test(attrs)) el.hidden = true;
      // disabled 也要从静态 HTML 读出来（停止按钮初始就是禁用的）
      if (/\bdisabled\b(\s|>|=|$)/.test(attrs)) el.disabled = true;
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

  /* --------- 可泵的 setInterval --------- */
  /**
   * 真实的 setInterval 在测试里只会让用例多等一秒（而心跳本来就是按秒推进统计的），
   * 所以改成「注册起来、由 h.tick(ms) 推进」。
   * 这也让「运行中每秒刷新已用/剩余」这条行为第一次可以被断言。
   */
  const intervals = new Map();
  let intervalSeq = 0;
  const clearAllIntervals = () => intervals.clear();
  /**
   * 推进虚拟时钟并触发到期的 interval 回调（每个 interval 每 tick **一次**）。
   * 只补一次而不是把积压的周期全跑一遍：一次 tick 想跑 10 个周期没有任何测试价值，
   * 却能把一个死循环放大成卡死。
   */
  const tick = (ms = 0) => {
    if (ms > 0) clockOffset += ms;
    const at = now();
    const due = [...intervals.entries()]
      .filter(([, it]) => it.next <= at)
      .sort((a, b) => a[1].next - b[1].next);
    for (const [id, it] of due) {
      if (!intervals.has(id)) continue; // 回调里被 clearInterval 掉了
      it.next = at + it.ms;
      try {
        it.fn();
      } catch {
        /* 定时器回调抛错不该炸掉测试进程（真实浏览器里也是孤立的一次） */
      }
    }
    return at;
  };

  /* --------- IPC 桩 --------- */
  const copied = [];
  let inspectResult = { mode: 'profile' };
  const settings = Object.assign(
    { activePlatform: 'weibo', ffmpegPath: '', platforms: { weibo: { outDir: 'C:\\out' } } },
    opts.settings || {}
  );
  const platforms = opts.platforms || DEFAULT_PLATFORMS;

  const windowObj = { __ui: null, __handler: null, __events: [] };
  /**
   * `omitApi: true` 用来模拟「预加载脚本没注入」——
   * 这正是 P0-5 里最尴尬的形态：界面能开，但点什么都无声无息。
   */
  if (!opts.omitApi) {
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
  }

  const sandbox = {
    console, document, window: windowObj,
    /** 启动失败横幅的「重试」按钮走 location.reload()，测试里只记账、不真的刷新 */
    location: {
      reload: () => {
        windowObj.__reloads = (windowObj.__reloads || 0) + 1;
      },
    },
    performance: { now: () => now() },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return ++rafSeq; },
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => {
      const id = ++intervalSeq;
      const period = Math.max(1, Number(ms) || 1);
      intervals.set(id, { fn, ms: period, next: now() + period });
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); },
    Date: FakeDate, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    /**
     * 浏览器里本来就有的两个构造器。替身沙箱默认只给「最小可用集」，
     * 少一个就会让渲染层走 catch 分支而测试看不出来 ——
     * 例如 siteHostOf() 用 new URL() 取域名，缺了 URL 就会静默退回平台名，
     * 于是「登录区显示当前网站」这个功能在测试里永远显示不出来，
     * 而在真机上却是好的。替身必须与真机环境对齐，不能让测试比真实环境更严苛。
     */
    URL, URLSearchParams,
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
    el: (id) => document.getElementById(id),
    txt: (id) => (document.getElementById(id) ? document.getElementById(id).textContent : undefined),
    ui: () => windowObj.__ui,
    /**
     * 派发一个 document 级事件（Esc 关闭弹窗这类全局快捷键）。
     * 直接走 listeners 而不是 fire()：document 不是节点，没有冒泡链。
     */
    fireDoc: (type, ev = {}) => {
      const evt = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev);
      for (const fn of (docListeners[type] || []).slice()) fn(evt);
      return evt;
    },
    /** 当前焦点所在元素（配合 el.focus() 断言「关闭弹窗后焦点回没回去」） */
    activeEl: () => document.activeElement,
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
    tick,
    intervals,
    clearAllIntervals,
    /** 设置滚动相关尺寸（日志跟随/上翻暂停这类行为靠它才测得动） */
    setScroll: (id, v = {}) => {
      const el = document.getElementById(id);
      if (!el) return null;
      for (const k of ['scrollTop', 'scrollHeight', 'clientHeight']) {
        if (v[k] !== undefined) el[k] = v[k];
      }
      return el;
    },
    now,
    MockNode,
  };
}

module.exports = { createHarness, MockNode };
