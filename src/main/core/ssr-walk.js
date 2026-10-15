/**
 * 从「首屏直出 / 前端 store 状态」里把作品数组捞出来。
 *
 * 为什么需要它 —— 有些主页首屏作品是被服务端直出到全局对象里的
 * （`window.__INITIAL_STATE__` 之类），压根不走 fetch/XHR，
 * 注入脚本的 fetch/XHR 钩子一个字节都截不到。这时只能在页面上下文里翻对象树。
 *
 * ⚠️ 这里踩过三个坑，都表现在「明明有数据却一条都捞不到」：
 *
 *   1. **没识别框架包装**。Vue/Pinia 会把数组包成 ref：
 *        notes = { __v_isRef: true, _value: [ ... ] }
 *      照着 `Object.values` 走会走进 `{__v_isRef, _value}` 这层壳，
 *      看到的是 `true` 和 `undefined`，永远碰不到真正的数组。
 *
 *   2. **判定特征只认 `note_id`，不认小红书真实的 `note_card`**。
 *      小红书首屏的作品节点长这样：
 *        { id: 'xxx', note_card: { note_id, display_title, image_list, ... }, xsec_token: '…' }
 *      顶层只有 `id`，`note_id` 埋在 `note_card` 里；原来的判定
 *      （只找 note_id / noteId / aweme_id / awemeId）在数组这一层命中 0 个，
 *      于是整段数据被判成「不是作品列表」，直接跳过。
 *
 *   3. **只把「整条数组」当作品列表，漏掉「单独的作品对象」**。
 *      作品有时混在一个普通数组里（前面几个不是作品），
 *      这种数组整体判定不通过，往下钻时又不会把「单个作品对象」收下来。
 *
 * 所以本模块做三件事：拆开框架包装 → 认全各平台「这是个作品」的特征 →
 * 逐层往下找，并且同时收「作品列表」和「单个作品对象」。
 *
 * ⚠️ 这个函数会被 `Function.prototype.toString()` 序列化后注入页面执行，
 * **必须自包含**：所有常量都得写在函数体里面。
 * 早先把 NOTE_HINTS / ID_KEYS 放在模块作用域，注入到页面立刻 ReferenceError
 * （`ID_KEYS is not defined`）—— ssr-walk.test.js 里那条
 * 「注入页面后仍可用」就是为了锁死这一点。
 */

function collectNoteArrays(roots, options) {
  // ↓↓ 必须写在函数体内（见文件头第 3 段注释）
  const NOTE_HINTS = [
    // 小红书：接口形态是驼峰 noteCard，首屏直出/前端 store 是下划线 note_card，两个都要认
    'note_card',
    'noteCard',
    'image_list',
    'images_list',
    'imageList',
    // 抖音
    'aweme_id',
    'awemeId',
    'statistics',
  ];
  const ID_KEYS = ['note_id', 'noteId', 'aweme_id', 'awemeId', 'id'];

  const opts = options || {};
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 9;
  const maxNotes = typeof opts.maxNotes === 'number' ? opts.maxNotes : 500;
  const seen = new Set();
  const out = [];

  /** 拆掉 Vue/Pinia 等框架的 ref 包装，露出真正的值 */
  function unwrap(v) {
    let cur = v;
    let guard = 0;
    while (
      cur &&
      typeof cur === 'object' &&
      (cur.__v_isRef === true || cur.__v_isShallow === true) &&
      '_value' in cur &&
      guard++ < 5
    ) {
      cur = cur._value;
    }
    return cur;
  }

  /** 单个对象看起来像不像一个作品 */
  function isNote(it) {
    const o = unwrap(it);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const hasId = ID_KEYS.some((k) => typeof o[k] === 'string' || typeof o[k] === 'number');
    const hasHint = NOTE_HINTS.some((k) => k in o);
    return hasId && hasHint;
  }

  /** 整条数组看起来像不像作品列表 */
  function looksLikeNoteList(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const probe = Math.min(arr.length, 8);
    let hits = 0;
    for (let i = 0; i < probe; i++) if (isNote(arr[i])) hits++;
    return hits >= Math.ceil(probe * 0.6);
  }

  /** DOM 节点不翻：它身上挂着 React fiber（`__reactFiber$xxx`），整个对象图又大又环 */
  function isDom(v) {
    return !!v && typeof v === 'object' && (v.nodeType > 0 || typeof v.nodeName === 'string');
  }

  function walk(node, depth) {
    if (out.length >= maxNotes || depth > maxDepth) return;
    const v = unwrap(node);
    if (!v || typeof v !== 'object') return;
    if (isDom(v)) return;
    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      if (looksLikeNoteList(v)) {
        for (const it of v) {
          if (out.length >= maxNotes) break;
          if (isNote(it)) out.push(unwrap(it));
        }
        return; // 已是作品列表，不再往里钻（避免把字段也当成作品）
      }
      for (const it of v) walk(it, depth + 1);
      return;
    }

    // 单个作品对象（混在普通数组/普通对象里的那种）也要收
    if (isNote(v)) {
      out.push(v);
      return;
    }

    for (const key of Object.keys(v)) {
      walk(v[key], depth + 1);
    }
  }

  for (const r of roots || []) walk(r, 0);
  return out.length ? out : null;
}

/**
 * 在页面里把「候选根对象」取出来。
 *
 * ⚠️ 坑（真机取证，第 17 轮）：`window.RENDER_DATA` **不是数据对象，而是那个 DOM 元素**。
 *   浏览器会把带 `id` 的元素挂到 window 上，所以 `window.RENDER_DATA` 拿到的是
 *     <script id="RENDER_DATA" type="application/json">…</script>
 *   它的自有属性只有 `__reactFiber$xxx` / `__reactProps$xxx`，
 *   `JSON.stringify` 直接报「循环引用」——collectNoteArrays 照着翻，一条都翻不出来，
 *   而且要在 fiber 图里空转很久。真正的数据是它的 `textContent`，
 *   并且**还是百分号编码过的**（`%7B%22app%22%3A…`），必须 decodeURIComponent 之后再 parse。
 *
 * 所以这里做两件事：
 *   ① 根对象是 DOM 元素时，取它的文本并按 JSON 解析（带 URL 解码兜底）
 *   ② 兜底扫一遍页面里所有含作品特征的 `<script>`，避免下次改了挂载点又全线失效
 *
 * 同 collectNoteArrays：会被序列化注入页面，**必须自包含**。
 */
function pickSSRRoots(names) {
  const HINTS = ['aweme_id', 'awemeId', 'note_card', 'noteCard', 'note_id', 'noteId', 'image_list', 'imageList'];
  const roots = [];
  const hits = [];

  function jsonFromText(raw) {
    if (!raw) return null;
    let txt = String(raw).trim();
    if (!txt) return null;
    if (/%[0-9A-Fa-f]{2}/.test(txt)) {
      try {
        txt = decodeURIComponent(txt);
      } catch (e) {
        /* 不是合法编码就用原文再试一次 */
      }
    }
    try {
      return JSON.parse(txt);
    } catch (e) {
      return null;
    }
  }

  function isEl(v) {
    return !!v && typeof v === 'object' && (v.nodeType > 0 || typeof v.nodeName === 'string');
  }

  function push(v, tag) {
    if (v && typeof v === 'object') {
      roots.push(v);
      hits.push(tag);
    }
  }

  for (const k of names || []) {
    let v = null;
    try {
      v = window[k];
    } catch (e) {
      v = null;
    }
    if (isEl(v)) {
      push(jsonFromText(v.textContent || ''), k + '(script文本)');
      continue;
    }
    push(v, k);
  }

  // 兜底：数据未必挂在 window 上，可能只是页面里的一个 JSON script
  try {
    const scripts = document.querySelectorAll('script');
    for (let i = 0; i < scripts.length && roots.length < 12; i++) {
      const s = scripts[i];
      const txt = s.textContent || '';
      if (!txt || txt.length > 4000000) continue;
      let want = false;
      for (const h of HINTS) {
        if (txt.indexOf(h) >= 0) {
          want = true;
          break;
        }
      }
      if (!want) continue;
      push(jsonFromText(txt), 'script#' + (s.id || i));
    }
  } catch (e) {
    /* 页面上下文异常，忽略 */
  }

  return { roots: roots, hits: hits };
}

/**
 * 把页面里的作品对象**在页面内**洗成纯数据，才带得回主进程。
 *
 * ⚠️ 这是「图集补全成功 0 / N」的最后一环，也是最隐蔽的一环（第 17 轮真机取证）：
 *   · 页面侧走查实测能翻到 51 条作品（`hasNote: true`，数据好好地在那儿）
 *   · 但 `executeJavaScript` 的返回值一次都没进到 `ingest`
 * 原因：作品的字段里混着 Vue 响应式代理、DOM 引用和环，
 * `executeJavaScript` 要把结果跨进程序列化成 JSON，遇到它们直接失败 ——
 * 而 `_harvestSSR` 原本是 `catch { return 0 }`，把这个失败**完全静默**掉了。
 * 于是「页面里有数据」和「一条都没采到」长期共存，从日志上完全看不出来。
 *
 * 所以：① 在页面里先深拷贝成纯数据（丢掉 DOM / 函数 / 环 / 框架内部字段）
 *      ② 顺手把体积压住（超长字符串截断、层数与条数封顶），别把几 MB 搬过 IPC。
 *
 * 同其它两个函数：会被 `toString()` 注入页面，**必须自包含**。
 */
function plainNotes(notes, options) {
  const opts = options || {};
  const maxNotes = typeof opts.maxNotes === 'number' ? opts.maxNotes : 200;
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 12;
  const maxKeys = typeof opts.maxKeys === 'number' ? opts.maxKeys : 400;
  const maxStr = 4000;
  const out = [];

  function copy(v, depth, seen) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string') return v.length > maxStr ? v.slice(0, maxStr) : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t !== 'object') return null; // function / symbol / bigint 一律丢掉
    // DOM 节点：它身上挂着 React fiber，整个对象图又大又环
    if (v.nodeType > 0 || typeof v.nodeName === 'string') return null;
    if (depth > maxDepth) return null;
    if (seen.has(v)) return null; // 环
    seen.add(v);

    if (Array.isArray(v)) {
      const r = [];
      for (let i = 0; i < Math.min(v.length, 300); i++) r.push(copy(v[i], depth + 1, seen));
      return r;
    }
    const r = {};
    const keys = Object.keys(v);
    for (let i = 0; i < Math.min(keys.length, maxKeys); i++) {
      const k = keys[i];
      if (k.charCodeAt(0) === 95 && k.indexOf('__') === 0) continue; // 跳过框架内部字段
      const c = copy(v[k], depth + 1, seen);
      if (c !== null) r[k] = c;
    }
    return r;
  }

  for (const n of notes || []) {
    if (out.length >= maxNotes) break;
    // 每条作品各用一份 seen：只拦「这条自己内部的环」，不会因为共享子对象而误删别人的字段
    const c = copy(n, 0, new Set());
    if (c && typeof c === 'object') out.push(c);
  }
  return out;
}

/**
 * 完整的注入脚本：取根对象 → 捞出作品数组 → 洗成可跨进程传输的纯数据。
 *
 * 抽成常量而不是各自内联 —— 列表采集（core/harvester.js）与单作品采集
 * （core/single-harvest.js）用的是**同一段逻辑**，而这个项目的教训恰恰是
 * 「同一件事写两份，改一份漏一份」。两处都从这里取，只有一份源码。
 *
 * 最后一步 `plain(...)` 不能省：作品对象里混着 Vue 响应式代理 / DOM 引用 / 环，
 * `executeJavaScript` 要把它序列化成 JSON 会直接失败。
 */
/** 逐一遍历的首屏根对象（三家页面各自可能用的全局变量名） */
const SSR_WALK_ROOTS = [
  '__INITIAL_STATE__',
  '_SSR_HYDRATED_DATA',
  '_ROUTER_DATA',
  'RENDER_DATA',
  '__NUXT__',
  '__INITIAL_SSR_STATE__',
];

const SSR_BUNDLE_JS = `(() => {
  const pick = ${pickSSRRoots.toString()};
  const picked = pick(${JSON.stringify(SSR_WALK_ROOTS)});
  if (!picked.roots.length) return null;
  const collect = ${collectNoteArrays.toString()};
  const notes = collect(picked.roots);
  if (!notes || !notes.length) return null;
  const plain = ${plainNotes.toString()};
  const safe = plain(notes);
  return safe && safe.length ? { notes: safe, hits: picked.hits, raw: notes.length } : null;
})()`;

module.exports = {
  collectNoteArrays,
  pickSSRRoots,
  plainNotes,
  /** 注入页面时用它把函数序列化过去（必须自包含，见模块头注释） */
  SSR_WALK_SOURCE: collectNoteArrays.toString(),
  SSR_ROOT_SOURCE: pickSSRRoots.toString(),
  SSR_PLAIN_SOURCE: plainNotes.toString(),
  /** 完整注入脚本（列表采集与单作品采集共用这一份） */
  SSR_BUNDLE_JS,
  SSR_WALK_ROOTS,
};
