const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  settings: null,
  platforms: {},      // id -> 适配器元信息
  order: [],          // 选项卡顺序
  platform: 'weibo',
  running: false,
  rootDir: '',
  loginUrls: {},   // platform -> 登录窗当前地址
  auth: {},        // platform -> 最近一次登录态
  stats: { total: 0, done: 0, skip: 0, fail: 0, item: 0 },
  bytes: 0,
  speed: 0,
  lastTick: 0,
  lastBytes: 0,
  curFile: '',
  curPct: null,
  inflight: new Map(), // 下载目标路径 -> { written, total }，用于画「当前文件」细进度条
  logLines: [],        // 与 DOM 分离的完整日志（DOM 会裁剪，导出的必须是全量）
  logFilter: 'all',    // 当前级别筛选：all | info | ok | warn | err
  logQuery: '',        // 当前关键字（大小写不敏感，命中处高亮）
  logFollow: true,     // 是否自动跟随到最新一行（用户上滚查看时自动关闭）
  failures: [],        // 失败明细：{ name, file, error, at }，进度条只给数字，细节靠它
  startedAt: 0,        // 本次任务开始时间戳（0 = 未开始）
  endedAt: 0,          // 任务结束时间戳（用来把「已用」冻结在结束那一刻，而不是一直涨）
  eta: null,           // 预计剩余秒数（样本不足时为 null，界面显示「—」）
  /**
   * 输入框当前识别出的模式：'profile' | 'single' | 'batch' | 'empty'。
   * 由主进程 input:inspect 判定（与 runner 决定流程用的是同一份代码），
   * 界面据此换标题/按钮文案，并隐藏只对主页模式生效的选项。
   */
  inputMode: 'profile',
};

/* ------------------------------- 工具 ------------------------------- */

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}
function fmtSpeed(bps) {
  return bps > 0 ? fmtBytes(bps) + '/s' : '';
}
/** 秒 → m:ss / h:mm:ss（进度区的「已用 / 剩余」用） */
function fmtDuration(sec) {
  // 估值可能因为除零/样本异常跑到 Infinity 或 NaN —— 一律按 0 处理，
  // 界面上宁可显示 0:00，也不能出现「Infinity:NaN:NaN」
  let s = Number(sec);
  if (!Number.isFinite(s)) s = 0;
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}
function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}
function curMeta() {
  return state.platforms[state.platform] || { name: state.platform };
}

/** 当前输入模式的短标签（写日志首行 / 失败清单一类的地方用） */
function modeLabel() {
  if (state.inputMode === 'batch') return '批量作品';
  if (state.inputMode === 'single') return '单个作品';
  return '博主主页';
}

/** 按下时从点击位置扩散一圈涟漪，让点击有明确的视觉回声 */
function attachRipples(root) {
  (root || document).querySelectorAll('.btn, .tab').forEach((el) => {
    if (el.__ripple) return;
    el.__ripple = true;
    el.addEventListener('pointerdown', (e) => {
      if (el.disabled || el.classList.contains('busy')) return;
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.1;
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = e.clientX - rect.left - size / 2 + 'px';
      span.style.top = e.clientY - rect.top - size / 2 + 'px';
      el.appendChild(span);
      setTimeout(() => span.remove(), 620);
    });
  });
}

function setBusy(btn, busy, text) {
  if (busy) {
    if (!btn.dataset.idleText) btn.dataset.idleText = btn.textContent;
    btn.textContent = text || btn.textContent;
    btn.classList.add('busy');
  } else {
    btn.classList.remove('busy');
    btn.textContent = btn.dataset.idleText || btn.textContent;
  }
}

/**
 * 统一维护「任务运行中」这个状态。
 *
 * 除了记录状态，还要同步 body 上的类名 —— CSS 里进度条的流光动画挂在 `body.running` 下，
 * 空转时不再重绘（之前是常驻动画，是掉帧/卡顿的来源之一）。
 */
function setRunning(v) {
  state.running = !!v;
  document.body.classList.toggle('running', state.running);
  // 下载停顿时不会有事件进来，「已用 / 剩余」会冻住 —— 跑一个 1s 的心跳把时间推着走。
  // 它只是调 scheduleStats（rAF 合批），不会造成额外重排。
  if (state.running) {
    if (!tickTimer) tickTimer = setInterval(scheduleStats, 1000);
  } else if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = 0;
  }
}
let tickTimer = 0;

/**
 * 日志窗口最多保留多少行。
 *
 * 早期版本无上限 —— 一场几万张图的下载会往 DOM 里塞几万个节点，
 * 内存一路涨、滚动越来越钝，最后表现为「界面卡住、点不动」。
 * 超出上限时**成批**裁掉最老的（而不是每加一行删一行，避免频繁重排）。
 */
const LOG_MAX_LINES = 400;
const LOG_TRIM_BATCH = 100;

/**
 * 导出用的「全量日志」上限。DOM 只留 400 行，但用户上报问题时需要完整上下文，
 * 所以额外在内存里留一份纯文本。5000 行 ≈ 数百 KB，是可控的量级。
 */
const LOG_KEEP = 5000;

/**
 * 筛选后一次性重建 DOM 时最多渲染多少行。
 * 只筛「错误」时通常只有几十行；切回「全部」时给个上限，
 * 避免一次性插入几千个节点把界面卡住。
 */
const LOG_RENDER_MAX = 1200;

/* --------------------------- 日志：级别与筛选 --------------------------- */

const LOG_LEVELS = ['all', 'info', 'ok', 'warn', 'err'];

/**
 * 级别归一。
 *
 * 主进程只发 `{type:'log', message}`，没有级别字段 —— 过去级别是渲染层一句正则现判的，
 * 散在 handleEvent 各分支里，改一处漏一处。这里收敛成一个函数：
 * 调用方显式给的 kind 优先（'ok' 这类只有调用方知道），否则按关键词推断。
 */
function normalizeLevel(msg, kind) {
  if (kind) return kind;
  const s = String(msg || '');
  /**
   * 「失败 0 / 错误 0」是**成功收尾**，不能因为句子里有「失败」两个字就标红 ——
   * 「视频转 MOV 完成：成功 3，失败 0」被标红过一次之后，用户就不再信任颜色了。
   * 所以先看这一条，再看错误关键词。
   */
  if (/(失败|错误)\s*[:：]?\s*0(?![0-9])/.test(s)) return 'ok';
  if (/(失败|错误|异常|不可用|无法|没能|没找到|没有可下载|崩溃|超时|拒绝|不完整|已中止)/.test(s)) return 'err';
  if (/(警告|注意|已跳过|已排除|超过上限|不生效|未找到|停止中)/.test(s)) return 'warn';
  if (/(完成|成功|已就绪|已保存|已导出|已展开|已切换)/.test(s)) return 'ok';
  return 'info';
}

/** 这条日志在当前筛选（级别 + 关键字）下要不要显示 */
function logVisible(e) {
  if (state.logFilter !== 'all' && e.level !== state.logFilter) return false;
  const q = state.logQuery;
  if (!q) return true;
  return e.text.toLowerCase().includes(q.toLowerCase());
}

/** 把一行文本按关键字拆成「普通片段 + <mark>」，用 DOM 拼而不是 innerHTML */
function appendHighlighted(parent, text, q) {
  if (!q) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (;;) {
    const k = lower.indexOf(ql, i);
    if (k < 0) {
      parent.appendChild(document.createTextNode(text.slice(i)));
      return;
    }
    if (k > i) parent.appendChild(document.createTextNode(text.slice(i, k)));
    const mk = document.createElement('mark');
    mk.textContent = text.slice(k, k + q.length);
    parent.appendChild(mk);
    i = k + q.length;
    if (i >= text.length) return;
  }
}

function buildLogNode(e) {
  const line = document.createElement('div');
  const tSpan = document.createElement('span');
  tSpan.className = 't';
  tSpan.textContent = e.t;
  const bSpan = document.createElement('span');
  bSpan.className = e.level === 'info' ? '' : e.level;
  appendHighlighted(bSpan, e.text, state.logQuery);
  line.append(tSpan, bSpan);
  return line;
}

/* ------------------------------ 写入与渲染 ------------------------------ */

let logSeq = 0;
let logQueue = [];   // 待插入的日志（rAF 合批，避免每行一次强制回流）
let logRaf = 0;
let pendingNew = 0;  // 关闭跟随后又新增的条数（按钮上的「N 条新日志」）

/**
 * 写一条日志。
 *
 * **记账**（state.logLines，全量、不受筛选与 DOM 裁剪影响）与**渲染**必须分开：
 * 早期版本两者混在一起，每行都 appendChild + scrollTop=scrollHeight，
 * 高频事件下每次写日志都强制同步布局 —— 日志越长越钝（「点着像卡住」的来源之一）。
 * 现在渲染统一走 rAF + DocumentFragment，一帧最多一次。
 */
function log(msg, kind = '', platform = '') {
  const t = new Date().toTimeString().slice(0, 8);
  const tag = platform && state.platforms[platform] ? `[${state.platforms[platform].name}] ` : '';
  const entry = { t, level: normalizeLevel(msg, kind), text: tag + msg, seq: ++logSeq };

  state.logLines.push(entry);
  if (state.logLines.length > LOG_KEEP) {
    state.logLines.splice(0, state.logLines.length - LOG_KEEP);
  }

  logQueue.push(entry);
  /**
   * 只有**当前筛选下真的会显示出来**的行才算「新日志」。
   * 否则用户筛到「错误」级别时，一条普通信息也会把「↓ 1 条新日志」点亮 ——
   * 点下去什么也没多出来，是最招人烦的一种假提示。
   */
  if (!state.logFollow && logVisible(entry)) pendingNew++;
  scheduleLogFlush();
  return entry;
}

function scheduleLogFlush() {
  if (logRaf) return;
  logRaf = requestAnimationFrame(() => {
    logRaf = 0;
    flushLog();
  });
}

/** 把队列里的日志按当前筛选插到末尾 */
function flushLog() {
  const box = $('log');
  if (!box) return;

  if (logQueue.length) {
    const frag = document.createDocumentFragment();
    let appended = 0;
    for (const e of logQueue) {
      if (!logVisible(e)) continue;
      frag.appendChild(buildLogNode(e));
      appended++;
    }
    logQueue = [];
    if (appended) {
      // 空态占位行要清掉，否则「还没有日志」会一直挂在最上面
      const empty = box.querySelector('.log-empty');
      if (empty) empty.remove();
      box.appendChild(frag);
      trimLogDom(box);
    }
  }

  updateLogCounts();
  updateLogNew();
  if (state.logFollow) box.scrollTop = box.scrollHeight;
}

/**
 * 超过上限时成批裁掉最老的。
 *
 * ⚠️ 上一次插入的「已省略」提示会**挡在队首**：如果只判断 firstElementChild 是不是
 * log-cut 就 break，第一次裁剪之后再也不会真正裁掉任何一行，而每次都会再插入一条新提示 ——
 * 结果是 DOM 节点数与提示条数一起单调增长（实测写 3000 条会留下 2998 个节点 + 98 条提示），
 * 长任务照样越跑越卡。正确做法：先把旧提示摘掉，再裁到上限，最后补一条新提示。
 */
function trimLogDom(box) {
  if (box.childElementCount <= LOG_MAX_LINES + LOG_TRIM_BATCH) return;
  const head = box.firstElementChild;
  if (head && head.classList.contains('log-cut')) box.removeChild(head);

  let removed = 0;
  while (removed < LOG_TRIM_BATCH && box.childElementCount > LOG_MAX_LINES) {
    const node = box.firstElementChild;
    if (!node) break;
    box.removeChild(node);
    removed++;
  }
  // 留一条提示，避免用户以为日志丢了
  const cut = document.createElement('div');
  cut.className = 'log-cut';
  cut.textContent = `…… 界面只保留最近 ${LOG_MAX_LINES} 条；点「导出日志」可拿到全部 ${state.logLines.length} 条 ……`;
  box.insertBefore(cut, box.firstElementChild);
}

/** 筛选条件变化时整体重建（只重建可见的部分，且有 LOG_RENDER_MAX 上限） */
function rerenderLog() {
  const box = $('log');
  if (!box) return;
  box.innerHTML = '';
  logQueue = [];
  pendingNew = 0;

  const shown = [];
  for (const e of state.logLines) if (logVisible(e)) shown.push(e);

  const frag = document.createDocumentFragment();
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = state.logLines.length
      ? '当前筛选条件下没有日志 —— 换一个级别，或清空关键字试试'
      : '还没有日志。开始一次下载后，这里会实时输出每一步。';
    frag.appendChild(empty);
  } else {
    const start = Math.max(0, shown.length - LOG_RENDER_MAX);
    if (start > 0) {
      const cut = document.createElement('div');
      cut.className = 'log-cut';
      cut.textContent = `…… 前面还有 ${start} 条符合条件的日志，点「导出日志」可拿到全部 ……`;
      frag.appendChild(cut);
    }
    for (let i = start; i < shown.length; i++) frag.appendChild(buildLogNode(shown[i]));
  }
  box.appendChild(frag);

  updateLogCounts();
  box.scrollTop = state.logFollow ? box.scrollHeight : 0;
  updateLogNew();
}

/** 各段上的计数（每次 flush 重算：全量数组最多 5000 条，成本可忽略） */
function updateLogCounts() {
  const c = { all: state.logLines.length, info: 0, ok: 0, warn: 0, err: 0 };
  for (const e of state.logLines) c[e.level] = (c[e.level] || 0) + 1;

  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set('cntAll', c.all);
  set('cntInfo', c.info);
  set('cntOk', c.ok);
  set('cntWarn', c.warn);
  set('cntErr', c.err);

  const bar = $('logFilter');
  const segWarn = bar ? bar.querySelector('[data-level="warn"]') : null;
  const segErr = bar ? bar.querySelector('[data-level="err"]') : null;
  if (segWarn) segWarn.classList.toggle('has-warn', c.warn > 0);
  if (segErr) segErr.classList.toggle('has-err', c.err > 0);

  const el = $('logCount');
  if (el) {
    const filtered = c[state.logFilter];
    el.textContent =
      state.logFilter === 'all' && !state.logQuery || filtered === undefined
        ? `${c.all} 条`
        : `${c.all} 条 · 当前筛选 ${filtered} 条`;
  }
  return c;
}

function updateLogNew() {
  const btn = $('btnLogNew');
  if (!btn) return;
  btn.hidden = !(pendingNew > 0 && !state.logFollow);
  if (!btn.hidden) btn.textContent = `↓ ${pendingNew} 条新日志`;
}

function setLogFilter(level) {
  if (!LOG_LEVELS.includes(level)) return;
  state.logFilter = level;
  document.querySelectorAll('#logFilter .seg-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.level === level);
  });
  rerenderLog();
}

function setLogFollow(on) {
  state.logFollow = !!on;
  const btn = $('btnLogFollow');
  if (btn) btn.textContent = `跟随最新：${state.logFollow ? '开' : '关'}`;
  if (state.logFollow) {
    pendingNew = 0;
    const box = $('log');
    if (box) box.scrollTop = box.scrollHeight;
  }
  updateLogNew();
}

/** 滚动时：贴底 → 自动恢复跟随；上翻查看 → 暂停跟随，别把人拽回底部 */
function onLogScroll() {
  const box = $('log');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  if (atBottom && !state.logFollow) setLogFollow(true);
  else if (!atBottom && state.logFollow) setLogFollow(false);
}

/** 导出用的完整文本（含一段环境头，方便直接贴给我定位问题） */
function exportLogText() {
  const p = curMeta();
  const c = updateLogCounts();
  const head = [
    '社交平台作品下载器 · 运行日志',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `软件版本：${state.info?.version || '—'}    当前平台：${p.name || state.platform}`,
    `统计：总文件 ${state.stats.total} / 已下载 ${state.stats.done} / 跳过 ${state.stats.skip} / 失败 ${state.stats.fail}`,
    `日志分级：信息 ${c.info} / 成功 ${c.ok} / 警告 ${c.warn} / 错误 ${c.err}`,
    `保存目录：${state.rootDir || '（未开始）'}`,
    '-'.repeat(52),
    '',
  ].join('\n');
  // 导出始终是**全量**（不受界面筛选影响）：定位问题靠的正是「被筛掉的那些行」
  const body = state.logLines.map((l) => `${l.t} [${l.level}] ${l.text}`).join('\n');
  return `${head}${body}\n`;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function setPhase(text) {
  $('phaseText').textContent = text;
}

function endTask() {
  setRunning(false);
  state.endedAt = Date.now();
  state.inflight.clear();
  renderMinis();
  const start = $('btnStart');
  setBusy(start, false);
  // 别无条件解锁：批量模式下若一条链接都没识别出来，按钮本来就该是禁用的
  start.disabled = state.inputMode === 'batch' && !(lastInspect && lastInspect.count);
  const stop = $('btnStop');
  setBusy(stop, false);
  stop.disabled = true;
}

/**
 * 「当前文件」细进度条。
 *
 * 主进度条走的是「文件数」，一个大视频要下 5 分钟，那 5 分钟里主条一动不动，
 * 看起来就像卡死了。这里把并发中的每个文件各画一条，任何一个在动都看得见。
 *
 * 节点按目标路径复用（progress 事件每秒十几条，重建 DOM 会白白产生重排）。
 */
const miniNodes = new Map(); // dest -> { row, fill, pct }

function renderMinis() {
  const box = $('minis');
  if (!box) return;
  box.classList.toggle('on', state.inflight.size > 0);

  for (const [key, node] of miniNodes) {
    if (!state.inflight.has(key)) {
      node.row.remove();
      miniNodes.delete(key);
    }
  }

  for (const [key, v] of state.inflight) {
    let node = miniNodes.get(key);
    if (!node) {
      const row = document.createElement('div');
      row.className = 'mini';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = basename(key);
      name.title = key;
      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('div');
      fill.className = 'fill';
      track.appendChild(fill);
      const pct = document.createElement('span');
      pct.className = 'pct';
      row.append(name, track, pct);
      box.appendChild(row);
      node = { row, fill, pct };
      miniNodes.set(key, node);
    }
    // 总长未知的 CDN（少数）没有百分比可算，用一小段占位 + 已下字节，别显示成 0%
    const pct = v.total ? Math.min(100, Math.floor((v.written / v.total) * 100)) : null;
    node.fill.style.width = (pct === null ? 8 : pct) + '%';
    node.pct.textContent =
      pct === null
        ? `${fmtBytes(v.written)}`
        : `${pct}% · ${fmtBytes(v.written)} / ${fmtBytes(v.total)}`;
  }
}

/** 进行中的文件按已下比例折算成「个」，让主进度条连续（而不是一跳一个文件） */
function inflightFraction() {
  let f = 0;
  for (const v of state.inflight.values()) {
    if (v.total) f += Math.min(1, v.written / v.total);
    else f += 0.15; // 总长未知时给一点占位，至少能看出在推进
  }
  return f;
}

/**
 * 进度渲染的 rAF 合批。
 *
 * 进度事件是 200ms 节流 × 并发数（4 并发下每 200ms 最多 4 条），每条都直接
 * renderStats 会写 5 个统计格 + 进度条宽度 + 若干文本，触发多次强制同步布局。
 * 合到「每帧一次」后体感是更平滑（而不是更慢）：进度展示只看最终态，中间态丢了无影响。
 */
let statsRaf = 0;
function scheduleStats() {
  if (statsRaf) return;
  statsRaf = requestAnimationFrame(() => {
    statsRaf = 0;
    renderStats();
  });
}

function renderStats() {
  const { total, done, skip, fail, item } = state.stats;
  $('stTotal').textContent = total;
  $('stDone').textContent = done;
  $('stSkip').textContent = skip;
  $('stFail').textContent = fail;
  $('stItem').textContent = item;

  const processed = done + skip + fail;
  const live = processed + inflightFraction(); // 含当前文件的小数部分
  const pct = total ? Math.min(100, Math.round((live / total) * 100)) : 0;
  $('bar').style.width = (total ? Math.min(100, (live / total) * 100) : 0).toFixed(2) + '%';
  // 跑完一轮后不要退回「等待开始」：统计显示 40/40、阶段显示「完成」，这里却写着等待，
  // 用户会以为任务没执行。只有一次都没跑过才用初始文案。
  const idleText = state.startedAt && !state.running ? '任务已结束' : '等待开始';
  $('curFile').textContent = state.curFile || (state.running ? '准备中…' : idleText);

  /**
   * 剩余时间估算：已完成比例 ÷ 已用时间 → 速率，再除以剩余量。
   *
   * 样本不足（开始不到 3 秒、或还没有任何文件完成）时**不给数字**（显示「—」）：
   * 头几秒的速率抖动极大，报一个 20 分钟再跳到 2 分钟，比不报更让人焦虑。
   */
  if (state.running && state.startedAt) {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    if (total > 0 && live > 0 && elapsed > 3) {
      const remain = (total - live) / (live / elapsed);
      state.eta = Number.isFinite(remain) && remain > 0 ? remain : 0;
    } else {
      state.eta = null;
    }
  } else {
    state.eta = null;
  }

  // liveMeta 改用 DOM 组装。这里拼的都是本地数字，但一旦将来把平台返回的字段
  // 拼进来 innerHTML 就是 XSS —— 索性不留这条路（日志/徽章本来也是 textContent）。
  const meta = $('liveMeta');
  meta.textContent = '';
  const parts = [];
  const sp = fmtSpeed(state.speed);
  if (sp) parts.push([sp, true]);
  if (state.bytes) parts.push([`已下载 ${fmtBytes(state.bytes)}`, false]);
  if (state.curPct !== null) parts.push([`当前文件 ${state.curPct}%`, false]);
  parts.push([total ? `${pct}% · ${processed} / ${total}` : '0 / 0', false]);
  parts.forEach(([text, strong], i) => {
    if (i) meta.appendChild(document.createTextNode(' · '));
    const el = document.createElement(strong ? 'b' : 'span');
    el.textContent = text;
    meta.appendChild(el);
  });

  const el = $('elapsedText');
  if (el) {
    // 结束后把「已用」冻结在 endedAt，否则它会随着之后的任何一次重渲染继续往上涨
    const ref = state.running ? Date.now() : state.endedAt || Date.now();
    el.textContent = fmtDuration(state.startedAt ? (ref - state.startedAt) / 1000 : 0);
  }
  const etaEl = $('etaText');
  if (etaEl) etaEl.textContent = state.eta === null ? '—' : '约 ' + fmtDuration(state.eta);
  const spEl = $('speedText');
  if (spEl) spEl.textContent = state.speed > 0 ? fmtSpeed(state.speed) : '—';

  renderMinis();
  renderFailures();
}

/* ------------------------------ 失败明细 ------------------------------ */

/** 界面上最多列多少条失败，超过的用一行概括（全量始终在 state.failures 里） */
const FAIL_SHOW_MAX = 60;

function addFailure(ev) {
  state.failures.push({
    name: basename(ev.file),
    file: ev.file || '',
    error: ev.error || '未知原因',
    at: new Date().toTimeString().slice(0, 8),
  });
}

function renderFailures() {
  const box = $('failBox');
  if (!box) return;
  box.hidden = state.failures.length === 0;
  if (box.hidden) return;

  $('failCount').textContent = state.failures.length;
  const list = $('failList');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  const show = state.failures.slice(-FAIL_SHOW_MAX);
  for (const f of show) {
    const row = document.createElement('div');
    row.className = 'f-row';
    const name = document.createElement('span');
    name.className = 'f-name';
    name.textContent = f.name || f.file || '(未知文件)';
    name.title = f.file || f.name;
    const why = document.createElement('span');
    why.className = 'f-why';
    why.textContent = f.error;
    why.title = f.error;
    row.append(name, why);
    frag.appendChild(row);
  }
  if (state.failures.length > show.length) {
    const more = document.createElement('div');
    more.className = 'f-more';
    more.textContent = `…… 另有 ${state.failures.length - show.length} 条，点「复制清单」拿到全部 ……`;
    frag.appendChild(more);
  }
  list.appendChild(frag);
}

/** 复制用的失败清单（纯文本，可直接贴进 issue / 聊天窗口） */
function failuresText() {
  const head = [
    '社交平台作品下载器 · 失败清单',
    `平台：${curMeta().name || state.platform}`,
    `时间：${new Date().toLocaleString('zh-CN')}`,
    `保存目录：${state.rootDir || '（未开始）'}`,
    `共 ${state.failures.length} 项`,
    '-'.repeat(52),
  ];
  const body = state.failures.map((f) => `${f.at}\t${f.error}\t${f.file || f.name}`);
  return head.concat(body).join('\n') + '\n';
}


/* --------------------------- 平台面板渲染 --------------------------- */

function platformOptions(id) {
  return (state.settings?.platforms?.[id]) || {};
}

/** 选项按各平台自己的 schema 动态渲染 —— 平台之间不共用一套选项 */
function renderOptions() {
  const p = curMeta();
  const box = $('options');
  const vals = platformOptions(state.platform);
  box.innerHTML = '';
  for (const f of p.optionsSchema || []) {
    if (f.type === 'bool') {
      const label = document.createElement('label');
      label.className = 'chk';
      // scope 由平台 schema 声明（'profile' = 只在博主主页模式生效），见 applyOptionScope
      label.dataset.scope = f.scope || '';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `opt_${f.key}`;
      input.dataset.key = f.key;
      input.checked = vals[f.key] !== undefined ? !!vals[f.key] : !!f.default;
      const span = document.createElement('span');
      span.textContent = f.label;
      label.append(input, span);
      box.appendChild(label);
    } else if (f.type === 'number') {
      const label = document.createElement('label');
      label.className = 'num';
      label.dataset.scope = f.scope || '';
      const span = document.createElement('span');
      span.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'number';
      input.id = `opt_${f.key}`;
      input.dataset.key = f.key;
      input.min = f.min ?? 0;
      input.max = f.max ?? 9999;
      input.step = f.step ?? 1;
      input.value = vals[f.key] !== undefined ? vals[f.key] : (p.defaultOptions?.[f.key] ?? 0);
      label.append(span, input);
      if (f.hint) {
        const unit = document.createElement('i');
        unit.className = 'unit';
        unit.textContent = f.hint;
        label.appendChild(unit);
      }
      box.appendChild(label);
    }
  }
  // 重建之后要按「当前输入模式」重新应用一次显隐，否则切平台/hidden 状态会丢
  applyOptionScope(state.inputMode);
  attachRipples(box);
}

function renderBadges() {
  const p = curMeta();
  // 全部按能力位/选项 schema 判断，不写 p.id === 'xxx' —— 这样新增平台无需改渲染层
  const hasOpt = (k) => (p.optionsSchema || []).some((f) => f.key === k);
  const items = [];
  items.push(p.needsBrowserHarvest ? '采集方式：内置浏览器滚动加载' : '采集方式：接口直连');
  items.push(p.supportsManualCookie ? '支持手动粘贴 Cookie' : '仅支持登录窗口扫码');
  if (p.supportsOnlyOriginal) items.push('支持「只要原创」过滤');
  if (p.supportsOriginalImage) items.push('图片可下原图');
  if (p.supportsLivePhoto) items.push('实况图可转 MOV');
  if (hasOpt('convertToMov')) items.push('视频可转封装为 MOV');
  const box = $('platformBadges');
  box.innerHTML = '';
  for (const t of items) {
    const s = document.createElement('span');
    s.className = 'badge';
    s.textContent = t;
    box.appendChild(s);
  }
}

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  state.order.forEach((id) => {
    const b = document.createElement('button');
    b.className = 'tab' + (id === state.platform ? ' active' : '');
    b.dataset.platform = id;
    b.textContent = state.platforms[id].name;
    box.appendChild(b);
  });
  attachRipples(box);
}

/* ----------------------------- 链接区 ----------------------------- */

function setLink(el, url, emptyText) {
  const box = $(el);
  if (url) {
    box.textContent = url;
    box.classList.remove('empty');
    box.dataset.url = url;
    box.title = url;
  } else {
    box.textContent = emptyText || '—';
    box.classList.add('empty');
    box.dataset.url = '';
    box.title = '';
  }
}

function updateLinks() {
  const p = curMeta();
  const cached = state.auth[state.platform] || {};
  setLink('siteUrl', p.siteURL);
  // 优先显示登录窗「当前」地址（登录过程中会跳转），其次上次记录的，最后退回平台声明的登录页
  setLink(
    'loginUrlState',
    state.loginUrls[state.platform] || cached.loginWindowURL || cached.loginURL || p.loginURL
  );
  // 「最近填写」那一格是单行布局，多行输入会被压成一坨 —— 多条时只显示第一条 + 总数
  const raw = $('inputUid').value.trim();
  const lines = raw.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  setLink(
    'targetUrl',
    lines.length > 1 ? `${lines[0]}　（等 ${lines.length} 条）` : raw,
    '（在下面填写后自动显示）'
  );
  scheduleInspect();
}

/* ---------------------- 输入类型判定（博主主页 / 单作品） ---------------------- */

/**
 * 输入框里粘的是「博主主页」还是「单个作品」。
 *
 * 判定放在主进程（`input:inspect`），界面只负责显示 —— 与真正决定走哪条流程的
 * 那份代码同源，避免「提示说 A、实际做 B」。详见 src/main/url-parse.js。
 *
 * 加了 180ms 防抖：粘贴一长串分享文案时会在极短时间内触发多次 input 事件，
 * 每次都打一次 IPC 纯属浪费。
 */
let inspectTimer = null;
let lastInspect = { mode: 'profile' };

function scheduleInspect() {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(runInspect, 180);
}

/**
 * 把「当前模式」写进 state，并同步三处界面表现：
 *   ① 第 2 节标题（目标博主 / 目标作品 / 目标作品（多个））
 *   ② 开始按钮文案
 *   ③ 选项区里只对主页模式生效的选项是否隐藏
 * 集中在一个函数里做，避免这三处各改各的、最后对不上（这正是「界面说 A、实际做 B」的来源）。
 */
function applyInputMode(mode, info) {
  state.inputMode = mode || 'profile';
  const btn = $('btnStart');

  if (state.inputMode === 'batch') {
    const n = (info && info.count) || 0;
    $('targetTitle').textContent = '目标作品（多个）';
    setStartLabel(n ? `下载这 ${n} 个作品` : '没有可下载的作品');
    // 一条都没生效时直接禁用：点下去只会看到一个报错，不如提前拦住
    if (!state.running) btn.disabled = n === 0;
  } else if (state.inputMode === 'single') {
    $('targetTitle').textContent = '目标作品';
    setStartLabel(`下载这个${(info && info.platformName) || ''}作品`);
    if (!state.running) btn.disabled = false;
  } else {
    $('targetTitle').textContent = '目标博主';
    setStartLabel('开始下载');
    if (!state.running) btn.disabled = false;
  }

  applyOptionScope(state.inputMode);
}

/**
 * 只对「博主主页」模式生效的选项（schema 里 scope:'profile'）在其它模式下隐藏。
 *
 * 为什么不直接从 DOM 里删掉：值要留着并写回设置 —— 用户从批量切回主页时，
 * 之前设的「最多作品数」应该还在。用 hidden 属性既能保住值，
 * 也让 collectCurrent() 继续读得到（它按 `opt_<key>` 找元素，与可见性无关）。
 */
function applyOptionScope(mode) {
  const box = $('options');
  if (!box) return;
  const isProfile = (mode || 'profile') === 'profile';
  let hidden = 0;
  for (const el of box.children) {
    const onlyProfile = el.dataset && el.dataset.scope === 'profile';
    const shouldHide = onlyProfile && !isProfile;
    el.hidden = shouldHide;
    if (shouldHide) hidden++;
  }
  const tip = $('optionScopeTip');
  if (tip) {
    tip.hidden = hidden === 0;
    tip.textContent = hidden
      ? `下方已隐藏 ${hidden} 个仅在博主主页模式生效的选项（当前是${
          isProfile ? '博主主页' : '单个/多个作品'
        }模式，这些设置不会被读取）`
      : '';
  }
}

/**
 * 提示条右侧的「切到 XX 平台并继续」按钮。
 *
 * 只在链接**明确属于另一个平台**时出现：过去这里只写一句「请先切换到 XX」，
 * 用户得自己切选项卡 —— 而切平台会把输入框换成那个平台上次的内容，
 * 于是刚粘的链接就没了，只能再粘一次。有了按钮，切换 + 保留输入一步到位。
 */
function setSwitchButton(platformId, platformName) {
  const btn = $('btnSwitchPlatform');
  if (!btn) return;
  if (!platformId || !platformName || platformId === state.platform) {
    btn.hidden = true;
    btn.dataset.platform = '';
    btn.textContent = '';
    return;
  }
  btn.hidden = false;
  btn.dataset.platform = platformId;
  btn.textContent = `切换到${platformName}并继续`;
}

async function runInspect() {
  const box = $('inputMode');
  const textEl = $('inputModeText');
  const input = $('inputUid').value.trim();

  const show = (warn, text) => {
    box.hidden = false;
    box.classList.toggle('warn', !!warn);
    textEl.textContent = text;
  };

  if (!input) {
    lastInspect = { mode: 'profile' };
    box.hidden = true;
    setSwitchButton('', '');
    $('inputUid').placeholder = curMeta().inputMeta?.placeholder || '粘贴博主主页链接';
    applyInputMode('profile');
    return;
  }

  let r = null;
  try {
    r = await window.api.inspectInput({ platform: state.platform, input });
  } catch {
    r = null;
  }
  if (!r || r.mode === 'empty') r = { mode: 'profile' };
  lastInspect = r;

  /**
   * invalid：这条链接是**该平台的其它页面**（例如抖音的搜索页 / 信息流页）——
   * 既不是博主主页，也不是作品链接。提前把话说清楚，别让用户点了开始才看到一句
   * 把原因指向「① 已登录 ② 链接正确 ③ 页面能显示作品」的报错（他正是拿着那种日志来问问题的）。
   *
   * 按钮**不禁用**：判定万一是错的，用户仍然可以跑；主进程用的是同一份判定，
   * 会用同一句话回给他 —— 界面上「提前说」与「跑起来报」永远一致。
   */
  if (r.mode === 'invalid') {
    show(true, `⚠️ ${r.text}`);
    setSwitchButton('', '');
    applyInputMode('profile');
    return;
  }

  // profile：不是作品链接，按原来的博主主页流程走，界面保持原样
  if (r.mode === 'profile') {
    box.hidden = true;
    setSwitchButton('', '');
    applyInputMode('profile');
    return;
  }

  if (r.mode === 'batch') {
    if (r.mismatch) {
      // 混着多家平台时没法一键切（切到哪一家都还有别的会被跳过），只在唯一一家时给按钮
      const ids = r.otherPlatformIds || [];
      const one = ids.length === 1 ? ids[0] : '';
      show(
        true,
        `⚠️ 这 ${r.total} 条链接都属于${r.otherPlatforms}，但当前选的是${r.currentName} —— ` +
          `请先切换到「${r.otherPlatforms}」，否则开始后会直接报错。`
      );
      setSwitchButton(one, one ? r.otherPlatforms : '');
    } else {
      setSwitchButton('', '');
      // 把「会下几个、会跳过几条」一次说清：批量最容易出的疑问就是「怎么少了几个」
      const parts = [`识别到 ${r.total} 条链接，其中 ${r.count} 条可在当前平台下载`];
      if (r.alienCount) parts.push(`${r.alienCount} 条属于其它平台（开始时会跳过）`);
      if (r.ignoredCount) parts.push(`${r.ignoredCount} 行无法识别（开始时会跳过）`);
      if (r.hasShortLink) parts.push('含短链，开始时会先自动展开');
      const dir = $('inputDir').value.trim();
      if (dir && r.count) parts.push(`保存到 ${dir}\\${state.platform}_batch\\（每个作品一个子目录）`);
      show(false, parts.join('；') + '。');
    }
    applyInputMode('batch', r);
    return;
  }

  // single
  if (r.mismatch) {
    show(
      true,
      `⚠️ 这是${r.platformName}的链接，但当前选的是${r.currentName} —— ` +
        `请先切换到「${r.platformName}」，否则开始后会直接报错。`
    );
    setSwitchButton(r.platform, r.platformName);
  } else if (r.shortLink) {
    show(false, `识别到${r.platformName}短链 —— 开始下载时会先展开为作品地址，然后只下载这一个作品。`);
    setSwitchButton('', '');
  } else {
    /**
     * 把落盘位置直接写在提示里 —— 用户最常问的就是「单个作品下到哪去了」。
     * 目录规则与主进程严格一致：`{保存目录}/{平台id}_{作品id}/`，
     * 平台 id 取主进程判定出来的 `r.platform`（不是当前选项卡），
     * 作品 id 就是解析出来的 itemId。改动任一侧都要同步（runner.runTargets 的 rootId）。
     */
    const dir = $('inputDir').value.trim();
    const where = dir ? `，保存到 ${dir}\\${r.platform}_${r.itemId}\\` : '（保存目录还没选）';
    show(false, `已识别为${r.platformName}单个作品（ID ${r.itemId}）—— 只下载这一个作品${where}。`);
    setSwitchButton('', '');
  }
  applyInputMode('single', r);
}

/** 改开始按钮的文案；下载进行中不动（那时按钮显示的是「下载中…」） */
function setStartLabel(text) {
  const btn = $('btnStart');
  if (!btn) return;
  btn.dataset.idleText = text; // setBusy 恢复文案时读的就是这个字段
  if (!state.running) btn.textContent = text;
}

async function copyFrom(el, label) {
  const box = $(el);
  const url = box.dataset.url;
  if (!url) return toast(`${label}为空，暂无可复制的内容`);
  await window.api.copyText(url);
  toast(`已复制${label}`);
}

async function refreshAuth() {
  const p = curMeta();
  const st = await window.api.authStatus(state.platform);
  state.auth[state.platform] = st;
  if (st.loginWindowURL) state.loginUrls[state.platform] = st.loginWindowURL;
  $('authDot').classList.toggle('on', st.loggedIn);
  if (st.loggedIn) {
    $('authText').textContent = `已登录${p.name}${st.expire ? `（至 ${st.expire}）` : ''}`;
    $('authText').title = st.detail || `命中凭证：${st.marks.join('、')}`;
  } else {
    // 明确区分「没有 Cookie」与「只有匿名 Cookie」——后者最容易被误认为已登录
    const weak = st.weakSeen || [];
    $('authText').textContent = `未登录${p.name} —— 请先登录`;
    $('authText').title = weak.length
      ? `${st.detail}\n站点已下发访客标识（${weak.join('、')}），它们匿名访问就会产生，不代表已登录。`
      : st.detail || `判定依据：${st.cookieHint}`;
  }
  updateLinks();
  return st;
}

/**
 * 填「支持三种输入」说明块里的示例链接。
 *
 * 示例文案来自各平台适配器的 `inputMeta`（不在渲染层写 `p.id === 'xxx'`）——
 * 与「平台差异留在平台模块里」这条既有约定一致，加平台时这里不用改。
 */
function renderInputKinds() {
  const meta = curMeta().inputMeta || {};
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v || '—';
  };
  set('egProfile', meta.exampleProfile);
  set('egItem', meta.exampleItem);
}

function applyPlatform(id) {
  state.platform = id;
  const p = curMeta();
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.platform === id);
  });
  $('platformHint').textContent = p.inputMeta?.hint || '';
  $('inputHint').textContent = p.needsBrowserHarvest
    ? '采集方式是在内置浏览器里打开该主页并滚动加载，因此必须先登录，且页面本身要能正常显示作品。'
    : '微博支持主页链接、单条微博链接、纯 UID 或昵称搜索。抓取范围是主页模式下该账号发布过的全部图片与视频。';
  $('inputUid').placeholder = p.inputMeta?.placeholder || '粘贴博主主页链接或作品链接';
  $('inputUid').value = platformOptions(id).lastInput || '';
  $('inputDir').value = platformOptions(id).outDir || '';
  renderInputKinds();
  renderBadges();
  renderOptions();
  updateLinks(null);
}

async function switchPlatform(id) {
  if (state.running) return toast('任务运行中，无法切换平台');
  await persist();
  applyPlatform(id);
  await window.api.setSettings({ activePlatform: id });
  await refreshAuth();
}

/* ---------------------------- 设置读写 ---------------------------- */

/** 把界面上当前平台的值收集成一个 options patch */
function collectCurrent() {
  const p = curMeta();
  const opts = { lastInput: $('inputUid').value.trim(), outDir: $('inputDir').value.trim() };
  for (const f of p.optionsSchema || []) {
    const el = $(`opt_${f.key}`);
    if (!el) continue;
    if (f.type === 'bool') opts[f.key] = el.checked;
    else if (f.type === 'number') opts[f.key] = parseInt(el.value, 10);
  }
  return opts;
}

async function persist() {
  if (!state.settings) return null;
  const patch = { platform: state.platform, options: collectCurrent() };
  state.settings = await window.api.setSettings(patch);
  return state.settings;
}

/* ------------------------------ 任务 ------------------------------ */

async function onStart() {
  if (state.running) return;
  const p = curMeta();
  const input = $('inputUid').value.trim();
  if (!input) return toast('请先粘贴博主主页链接，或单个作品链接');
  const outDir = $('inputDir').value.trim();
  if (!outDir) return toast('请先选择保存目录');

  setRunning(true);
  setBusy($('btnStart'), true, '下载中…');
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  state.stats = { total: 0, done: 0, skip: 0, fail: 0, item: 0 };
  state.bytes = 0;
  state.speed = 0;
  state.lastTick = 0;
  state.lastBytes = 0;
  state.curFile = '';
  state.curPct = null;
  state.inflight.clear();
  state.failures = [];
  state.startedAt = Date.now();
  state.endedAt = 0;
  state.eta = null;
  renderStats();
  setPhase('准备中…');
  // 把「这次跑的是哪种模式、粘了什么」写进日志首行：事后排查时，
  // 「只下了一个」还是「下了全部」往往就是靠这一行定位的
  log(`任务开始（${modeLabel()}）：${input.replace(/\s+/g, ' ').slice(0, 120)}`, '', state.platform);

  const options = collectCurrent();
  state.settings = await window.api.setSettings({ platform: state.platform, options });

  const res = await window.api.start({ platform: state.platform, input, outDir, options });
  if (res?.error) {
    log(res.error, 'err', state.platform);
    toast(res.error);
    endTask();
    setPhase('已停止');
  }
}

const PHASE_TEXT = {
  resolve: '解析博主…',
  fetch: '读取作品列表…',
  harvest: '采集作品列表…',
  download: '下载中…',
  convert: '转换中…',
  done: '完成',
};

function handleEvent(ev) {
  const name = ev.platform && state.platforms[ev.platform] ? state.platforms[ev.platform].name : '';
  switch (ev.type) {
    case 'log':
      // 级别交给 normalizeLevel 统一判定（这里过去是就地写一句正则，和别处各判各的）
      log(ev.message, '', ev.platform || '');
      break;
    case 'phase':
      setPhase(PHASE_TEXT[ev.phase] || ev.phase);
      if (ev.phase === 'done') {
        state.speed = 0;
        state.curPct = null;
        state.curFile = '';
        endTask();
        renderStats();
        if (ev.rootDir) {
          state.rootDir = ev.rootDir;
          $('btnOpen').disabled = false;
        }
        toast(ev.message || '任务结束');
      }
      break;
    case 'uid':
      log(`博主 UID：${ev.uid}`, '', state.platform);
      break;
    case 'fetch-progress':
      setPhase(`读取作品列表… 第 ${ev.page} 页，已读 ${ev.posts} 条`);
      break;
    case 'harvest-progress':
      state.stats.item = ev.total;
      setPhase(`采集作品列表… 已发现 ${ev.total} 个作品`);
      scheduleStats();
      break;
    case 'summary':
      state.stats.total = ev.total;
      /**
       * 「作品数」要的是**几个作品**，不是几个文件。
       * 早先这里用 `ev.total`（文件数）覆盖 item，于是「作品数」与「总文件」永远相等 ——
       * 用户按作品数估工作量时会发现数字明显不对。主进程现在会把 items 一并带出来；
       * 老版本主进程不发这个字段时，保留采集阶段已上报的数字，而不是退化成文件数。
       */
      if (Number.isFinite(ev.items)) state.stats.item = ev.items;
      state.rootDir = ev.rootDir;
      $('btnOpen').disabled = false;
      log(
        `共 ${ev.total} 个文件：图片 ${ev.images} / 视频 ${ev.videos}${ev.live ? ` / Live ${ev.live}` : ''}`,
        '',
        state.platform
      );
      renderStats();
      break;
    case 'dl': {
      const st = ev.stats || {};
      if (typeof st.bytes === 'number') {
        const now = performance.now();
        if (!state.lastTick) {
          state.lastTick = now;
          state.lastBytes = st.bytes;
        } else if (now - state.lastTick >= 400) {
          const dt = (now - state.lastTick) / 1000;
          state.speed = Math.max(0, (st.bytes - state.lastBytes) / dt);
          state.lastTick = now;
          state.lastBytes = st.bytes;
        }
        state.bytes = st.bytes;
      }
      if (ev.event === 'progress') {
        /**
         * 只认带了文件路径的事件。
         * 进度回调偶尔会不带 dest（字段缺失、或平台层提前返回），
         * 无条件下 set 会画出一行名字叫 "undefined" 的幽灵细进度条 —— 而且它永远不会消失，
         * 因为「完成」事件同样不带路径，删不掉它。
         */
        if (ev.file) {
          state.inflight.set(ev.file, { written: ev.written || 0, total: ev.total || null });
        }
        /**
         * 已下字节夹在 0–100%。
         * CDN 会返回与 content-length 不一致的字节数（分块、重试、gzip 计数差异），
         * 不夹住的话界面会出现「当前文件 150%」这种一眼假数字。
         */
        const total = Number(ev.total) || 0;
        const written = Number(ev.written) || 0;
        state.curPct = total > 0 && written > 0 ? Math.min(100, Math.round((written / total) * 100)) : null;
      } else {
        // done / skip / fail 都意味着这个文件不再进行中
        state.inflight.delete(ev.file);
        state.curPct = null;
        if (ev.event === 'done') state.stats.done++;
        else if (ev.event === 'skip') state.stats.skip++;
        else if (ev.event === 'fail') {
          state.stats.fail++;
          // 进度条只给「失败 N」这一个数字，出了事还得能落到具体文件 —— 一并记账
          addFailure(ev);
          log(`下载失败：${basename(ev.file)} ${ev.error || ''}`, 'err', state.platform);
        }
      }
      if (ev.file) state.curFile = basename(ev.file);
      scheduleStats();
      break;
    }
    case 'convert-progress':
      setPhase(`转换中… ${ev.done}/${ev.total}（成功 ${ev.ok}，失败 ${ev.failed}）`);
      break;
    case 'auth':
      // 主进程可能上报「已登录」也可能上报「关窗仍是未登录」（用户在窗口里没走完登录）。
      // 界面文案必须跟着走，否则关窗后弹一句「登录成功」但状态仍是未登录，看着像 bug。
      if (ev.platform === state.platform) {
        refreshAuth();
        toast(
          ev.loggedIn === false
            ? ev.message || '仍未检测到登录状态'
            : `${ev.message || '登录成功'}，登录页面地址已更新，可一键复制`
        );
      } else if (name) {
        toast(ev.loggedIn === false ? `${name}：${ev.message || '未登录'}` : `${name}${ev.message || '登录成功'}`);
      }
      break;
    case 'login-url':
      // 登录过程中会多次跳转，实时把地址摊到界面上
      state.loginUrls[ev.platform] = ev.url;
      if (ev.platform === state.platform) updateLinks();
      break;
    case 'login-closed':
      if (ev.platform === state.platform) refreshAuth();
      break;
    case 'login-crashed':
      log('登录窗口的页面异常退出，请重新点击「登录」再试一次', 'err', ev.platform);
      break;
    case 'ffmpeg-missing':
      log('ffmpeg 不可用，已跳过转换（原文件已保留）', 'err', state.platform);
      break;
  }
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  state.info = await window.api.info();
  state.settings = await window.api.getSettings();
  state.order = state.info.platforms.map((p) => p.id);
  for (const p of state.info.platforms) state.platforms[p.id] = p;

  const active = state.settings.activePlatform || state.info.defaultPlatform;
  state.platform = state.platforms[active] ? active : state.order[0];

  renderTabs();
  applyPlatform(state.platform);
  await refreshAuth();

  const ff = await window.api.checkFFmpeg();
  const el = $('ffmpegState');
  if (ff.ok) {
    el.textContent = `ffmpeg 已就绪（${ff.version}）`;
    el.className = 'ff ok';
  } else {
    el.textContent = 'ffmpeg 未找到 —— 转 MOV 将不可用（不影响普通下载）';
    el.className = 'ff bad';
  }

  // 手动 Cookie 只对微博开放
  $('authText').addEventListener('click', () => {
    if (curMeta().supportsManualCookie) $('cookieModal').classList.add('show');
  });
  $('btnFfmpeg').addEventListener('click', async () => {
    const dir = await window.api.chooseDir();
    if (!dir) return;
    const p = dir.replace(/[\\/]+$/, '') + '\\ffmpeg.exe';
    state.settings = await window.api.setSettings({ ffmpegPath: p });
    toast('已记录 ffmpeg 路径，重启后生效');
  });

  attachRipples(document);
  window.api.onEvent(handleEvent);
}

/* ----------------------------- 事件绑定 ----------------------------- */

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchPlatform(tab.dataset.platform);
});
$('btnStart').addEventListener('click', onStart);
$('btnStop').addEventListener('click', async () => {
  setBusy($('btnStop'), true, '停止中…');
  await window.api.stop();
  setPhase('停止中…，等待当前任务收尾');
});
$('btnOpen').addEventListener('click', () => window.api.openFolder(state.rootDir));
$('btnDir').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (!dir) return;
  $('inputDir').value = dir;
  state.settings = await window.api.setSettings({
    platform: state.platform,
    options: { ...collectCurrent(), outDir: dir },
  });
  // 提示条里写着「保存到 …」，选了新目录要跟着刷新，否则显示的还是旧路径
  scheduleInspect();
});
$('btnLogin').addEventListener('click', () => {
  window.api.openLogin(state.platform);
  log(`已打开${curMeta().name}登录窗口，完成登录后会自动关闭`, '', state.platform);
});
$('btnLogout').addEventListener('click', async () => {
  await window.api.logout(state.platform);
  await refreshAuth();
  toast(`已退出${curMeta().name}登录`);
});
$('btnCopySite').addEventListener('click', () => copyFrom('siteUrl', '官网链接'));
$('btnCopyLogin').addEventListener('click', () => copyFrom('loginUrlState', '登录页地址'));
$('btnCopyTarget').addEventListener('click', () => copyFrom('targetUrl', '博主主页链接'));
$('btnOpenSite').addEventListener('click', async () => {
  await window.api.openSite(state.platform);
  toast(`已在浏览器中打开${curMeta().name}官网`);
});
// 输入目标链接时同步显示，方便随时复制
$('inputUid').addEventListener('input', updateLinks);

$('btnCookieCancel').addEventListener('click', () => $('cookieModal').classList.remove('show'));
$('btnCookieSave').addEventListener('click', async () => {
  const v = $('cookieText').value.trim();
  if (!v) return toast('请粘贴 Cookie 内容');
  try {
    await window.api.setCookie(state.platform, v);
    $('cookieModal').classList.remove('show');
    await refreshAuth();
    toast('Cookie 已保存');
  } catch (err) {
    toast(err.message);
  }
});

/* ----------------------------- 日志导出 ----------------------------- */

// 导出的必须是**全量**日志（DOM 只留 400 行），所以走 state.logLines 而不是读界面
$('btnExportLog').addEventListener('click', async () => {
  if (!state.logLines.length) return toast('当前还没有日志可导出');
  setBusy($('btnExportLog'), true, '导出中…');
  try {
    const res = await window.api.exportLog(exportLogText());
    if (res?.canceled) toast('已取消导出');
    else if (res?.error) toast(res.error);
    else {
      toast(`日志已导出到 ${res.filePath}`);
      // 这条也进日志，用户回头能在文件里看到「导出」这个动作
      log(`日志已导出：${res.filePath}`, 'ok');
    }
  } catch (err) {
    toast(`导出失败：${err.message}`);
  } finally {
    setBusy($('btnExportLog'), false);
  }
});

$('btnCopyLog').addEventListener('click', async () => {
  if (!state.logLines.length) return toast('当前还没有日志可复制');
  await window.api.copyText(exportLogText());
  toast(`已复制 ${state.logLines.length} 条日志到剪贴板`);
});

$('btnClearLog').addEventListener('click', () => {
  state.logLines.length = 0;
  logQueue = [];
  pendingNew = 0;
  rerenderLog(); // 会补上「还没有日志」的空态，而不是留一个白框
  toast('日志已清空');
});

/* ---------------------- 日志筛选 / 检索 / 跟随 ---------------------- */

$('logFilter').addEventListener('click', (e) => {
  const item = e.target.closest('.seg-item');
  if (item) setLogFilter(item.dataset.level);
});

// 关键字边打边筛。重建的节点数有 LOG_RENDER_MAX 上限，不会因为一次长任务卡住
$('logSearch').addEventListener('input', () => {
  state.logQuery = $('logSearch').value.trim();
  rerenderLog();
});

$('btnLogFollow').addEventListener('click', () => setLogFollow(!state.logFollow));
$('btnLogNew').addEventListener('click', () => setLogFollow(true));
$('log').addEventListener('scroll', onLogScroll, { passive: true });

/* --------------------------- 失败明细 --------------------------- */

$('btnCopyFail').addEventListener('click', async () => {
  if (!state.failures.length) return toast('当前没有失败项');
  await window.api.copyText(failuresText());
  toast(`已复制 ${state.failures.length} 项失败清单`);
});

$('btnClearFail').addEventListener('click', () => {
  state.failures = [];
  renderFailures();
  toast('失败明细已清除');
});

/* ------------------- 跨平台链接：一键切换并继续 ------------------- */

$('btnSwitchPlatform').addEventListener('click', async () => {
  const target = $('btnSwitchPlatform').dataset.platform;
  if (!target) return;
  // 切平台会把输入框换成「该平台上次填的内容」，所以先把当前这行链接存下来再放回去
  const keep = $('inputUid').value;
  await switchPlatform(target);
  $('inputUid').value = keep;
  updateLinks();
  toast(`已切换到${curMeta().name}，正在重新识别链接`);
});

/**
 * 供自动化测试驱动界面（test/smoke.js 的探针用）。
 * 页面始终只加载本地文件、CSP 里 script-src 只有 'self'，外部脚本进不来，
 * 所以这里暴露的引用不构成额外攻击面。
 */
window.__ui = {
  state,
  handleEvent,
  log,
  renderStats,
  renderFailures,
  renderMinis,
  renderInputKinds,
  exportLogText,
  failuresText,
  setLogFilter,
  setLogFollow,
  rerenderLog,
};

init();
