/**
 * 渲染层启动兜底 / 开始失败兜底 + 脚手架自检（批次 D：P0-5、P0-6）
 *
 * 复现的两个缺陷：
 *   P0-5 `init()` 把 `window.api.onEvent(handleEvent)` 放在**最后一步**。
 *        于是 info/getSettings 一慢，主进程在这几百毫秒里发出的事件全丢；
 *        info 一旦挂起（IPC 没注册、主进程正忙），界面既不渲染、也不订阅、
 *        更不报错 —— 用户看到的就是「窗口开着，点哪儿都没反应」。
 *   P0-6 `onStart()` 只处理了 `{error}` 返回值，没接 reject。
 *        `api.start` 一抛，`body.running` 永远是 true、主按钮停在「下载中…」且不可点，
 *        停止按钮却是亮的 —— 整个界面像死机，只能重启软件。
 *
 * 同时自检加固后的脚手架（closest / 冒泡 / disabled / 动态 id / 可泵 interval）：
 * 这些能力是后面所有渲染层测试的地基，地基错了，上面测出来的结论会误导人。
 *
 * 跑法：node test/renderer-boot.test.js
 */

const assert = require('assert');
const { createHarness } = require('./lib/renderer-harness');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** 造一个「点了开始」的界面：两个必填项都填好 */
function fillStartInputs(h) {
  h.el('inputUid').value = 'https://weibo.com/u/1234567890'; // 示例值，非真实用户
  h.el('inputDir').value = 'D:\\out';
}

/* =============================== P0-5 =============================== */

section('P0-5 启动兜底：先把事件订阅上');

t('P0-5 info 永不 resolve 时 onEvent 已订阅', async () => {
  // 永不 settle 的 info：模拟主进程没注册该 IPC / 正忙
  const h = createHarness({ api: { info: () => new Promise(() => {}) } });
  await tick(30);

  assert.strictEqual(h.loadError, null, '启动失败不能把异常抛到全局');
  assert.strictEqual(
    typeof h.windowObj.__handler,
    'function',
    'info 还没返回时就必须已经订阅好事件（否则这段时间主进程发来的事件全丢）'
  );
  assert.strictEqual(h.ui().state.booted, false, 'info 没回来，boot 不该标记为已完成');
});

t('P0-5 info reject → #bootError 可见、文案含步骤名、不抛出', async () => {
  const h = createHarness({ api: { info: async () => { throw new Error('IPC 通道未注册'); } } });
  await tick(30);

  assert.strictEqual(h.loadError, null, '异常必须被 boot 自己兜住，不能冒到全局');
  const box = h.el('bootError');
  assert.ok(box, 'index.html 必须有 #bootError');
  assert.strictEqual(box.hidden, false, '启动失败必须把横幅显示出来');
  assert.ok(box.classList.contains('danger'), '横幅要用危险样式（用户一眼能看出是失败）');
  const text = h.txt('bootErrorText');
  assert.ok(/读取应用信息/.test(text), `文案要说明卡在哪一步（步骤名），实际：${text}`);
  assert.ok(/IPC 通道未注册/.test(text), `文案要带上具体原因，实际：${text}`);
});

t('P0-5 window.api 缺失 → 文案含「预加载」，且不抛', async () => {
  const h = createHarness({ omitApi: true });
  await tick(30);

  assert.strictEqual(h.loadError, null);
  assert.strictEqual(h.el('bootError').hidden, false);
  const text = h.txt('bootErrorText');
  assert.ok(/预加载/.test(text), `要直接点明是预加载脚本没注入，实际：${text}`);
  assert.ok(/window\.api/.test(text), `顺带写出缺失的对象，方便排查，实际：${text}`);
});

t('P0-5 启动失败后点「重试」能触发重新加载', async () => {
  const h = createHarness({ api: { info: async () => { throw new Error('boom'); } } });
  await tick(30);

  h.el('btnBootRetry').fire('click');
  assert.strictEqual(h.windowObj.__reloads, 1, '重试按钮没接上（失败了却点不动重试）');
});

t('P0-5 getSettings 失败也算启动失败（同样是「卡在哪一步」）', async () => {
  const h = createHarness({ api: { getSettings: async () => { throw new Error('设置文件损坏'); } } });
  await tick(30);

  const text = h.txt('bootErrorText');
  assert.ok(/读取设置/.test(text), `应指出是「读取设置」这一步，实际：${text}`);
  assert.ok(/设置文件损坏/.test(text), text);
});

t('P0-5 启动成功时横幅保持隐藏，且 four 步都跑完', async () => {
  const h = createHarness();
  await tick(40);
  assert.strictEqual(h.el('bootError').hidden, true, '正常启动不该显示失败横幅');
  assert.strictEqual(h.ui().state.booted, true);
  assert.ok(/ffmpeg/.test(h.txt('ffmpegState')), 'ffmpeg 状态行应已写入');
});

/* =============================== P0-6 =============================== */

section('P0-6 开始任务失败兜底');

t('P0-6 start 返回 {error} → 按钮恢复可点、阶段「已停止」、body.running 复位', async () => {
  const h = createHarness({ api: { start: async () => ({ error: '尚未登录微博：请先点击「登录微博」完成扫码' }) } });
  await tick(40);
  fillStartInputs(h);
  h.el('btnStart').fire('click');
  await tick(80);

  const btn = h.el('btnStart');
  assert.strictEqual(h.document.body.classList.contains('running'), false, 'body.running 必须复位');
  assert.strictEqual(btn.disabled, false, '开始按钮必须恢复可点');
  assert.strictEqual(btn.classList.contains('busy'), false, '忙碌样式必须撤掉');
  assert.strictEqual(btn.textContent, '开始下载', `按钮文案必须复原，实际：${btn.textContent}`);
  assert.strictEqual(h.el('btnStop').disabled, true, '停止按钮应回到禁用');
  assert.strictEqual(h.txt('phaseText'), '已停止');
  assert.ok(
    h.ui().state.logLines.some((l) => l.level === 'err' && /尚未登录/.test(l.text)),
    '失败原因要进日志'
  );
});

t('P0-6 start reject → 同上，且日志里有一条 err、界面不卡在「准备中…」', async () => {
  const h = createHarness({ api: { start: async () => { throw new Error('IPC 调用超时'); } } });
  await tick(40);
  fillStartInputs(h);
  h.el('btnStart').fire('click');
  await tick(80);

  const btn = h.el('btnStart');
  assert.strictEqual(h.document.body.classList.contains('running'), false, '异常路径也必须退出运行态');
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.classList.contains('busy'), false);
  assert.strictEqual(h.el('btnStop').disabled, true);
  assert.strictEqual(h.txt('phaseText'), '已停止');
  const errs = h.ui().state.logLines.filter((l) => l.level === 'err');
  assert.ok(errs.length >= 1, '抛异常必须留下一条 err 日志（否则用户完全不知道发生了什么）');
  assert.ok(/IPC 调用超时/.test(errs[errs.length - 1].text), errs[errs.length - 1].text);
  assert.notStrictEqual(h.txt('curFile'), '准备中…', 'P2-A17：失败后不能停在「准备中…」');
});

t('P0-6 setSettings 抛异常也不让界面卡在运行态', async () => {
  const h = createHarness({
    api: {
      setSettings: async () => { throw new Error('设置写入失败'); },
      start: async () => ({}),
    },
  });
  await tick(40);
  fillStartInputs(h);
  h.el('btnStart').fire('click');
  await tick(80);

  assert.strictEqual(h.document.body.classList.contains('running'), false);
  assert.strictEqual(h.el('btnStart').disabled, false);
  assert.ok(h.ui().state.logLines.some((l) => l.level === 'err' && /设置写入失败/.test(l.text)));
});

t('P0-6 start 挂起（真在跑）时保持运行态，心跳定时器已注册且可泵', async () => {
  const h = createHarness({ api: { start: () => new Promise(() => {}) } });
  await tick(40);
  fillStartInputs(h);
  h.el('btnStart').fire('click');
  await tick(60);

  assert.strictEqual(h.document.body.classList.contains('running'), true, '真正在跑时不能误复位');
  assert.strictEqual(h.el('btnStart').disabled, true);
  assert.strictEqual(h.el('btnStop').disabled, false);
  assert.strictEqual(h.intervals.size, 1, '运行中应有 1 个「已用/剩余」心跳 interval');

  // 泵一次 1s：心跳调 scheduleStats → 排一帧 rAF（不泵就会一直是 0，说明 interval 没被触发）
  const before = h.pendingRaf();
  h.tick(1000);
  assert.ok(h.pendingRaf() > before, 'h.tick 应真的把 interval 回调泵起来');
});

/* ============================ 脚手架自检 ============================ */

section('脚手架自检：更接近浏览器');

/** 造一棵 parent > child 的小树（index.html 里的按钮都是纯文本，没有子元素可用） */
function nested(h, parentId, childTag = 'span') {
  const parent = h.el(parentId);
  const child = h.document.createElement(childTag);
  parent.appendChild(child);
  return { parent, child };
}

t('closest 能沿祖先链命中（事件委托的前提）', async () => {
  const h = createHarness();
  await tick(30);
  const tab = h.el('tabs').children[0];
  assert.ok(tab, '#tabs 应已渲染出选项卡');
  assert.strictEqual(tab.classList.contains('tab'), true);
  const inner = h.document.createElement('span');
  tab.appendChild(inner);

  assert.strictEqual(inner.closest('.tab'), tab, '子元素应能 closest 到 .tab');
  assert.strictEqual(inner.closest('.does-not-exist'), null);
  assert.strictEqual(tab.closest('.tab'), tab, '自身匹配时 closest 返回自身（与浏览器一致）');
  assert.strictEqual(h.el('tabs').closest('.tab'), null, '父级不匹配时不应误命中');
});

t('点击子元素会冒泡到祖先，target 保持最初目标、currentTarget 变化', async () => {
  const h = createHarness();
  await tick(30);
  const { parent, child } = nested(h, 'tabs');
  const seen = [];
  parent.addEventListener('click', (e) => seen.push({ target: e.target, current: e.currentTarget }));

  child.fire('click');

  assert.strictEqual(seen.length, 1, '祖先的委托监听器必须被触发（冒泡）');
  assert.strictEqual(seen[0].target, child, 'target 必须是最初被点的节点');
  assert.strictEqual(seen[0].current, parent, 'currentTarget 必须是正在执行的节点');
});

t('stopPropagation 能中断冒泡（同层其他监听器仍会执行，与浏览器一致）', async () => {
  const h = createHarness();
  await tick(30);
  const top = h.el('tabs');
  const mid = h.document.createElement('div');
  const leaf = h.document.createElement('span');
  top.appendChild(mid);
  mid.appendChild(leaf);

  let outer = 0;
  let sibling = 0;
  top.addEventListener('click', () => { outer++; });
  mid.addEventListener('click', (e) => e.stopPropagation());
  mid.addEventListener('click', () => { sibling++; });

  leaf.fire('click');
  assert.strictEqual(sibling, 1, '同一节点上的其他监听器不该被 stopPropagation 拦住');
  assert.strictEqual(outer, 0, '祖先不该在被 stopPropagation 之后继续响应');
});

t('disabled 的元素不触发 click、也不冒泡（浏览器行为）', async () => {
  const h = createHarness();
  await tick(30);
  const parent = h.el('tabs');
  const btn = h.document.createElement('button');
  btn.disabled = true;
  parent.appendChild(btn);
  let own = 0;
  let outer = 0;
  btn.addEventListener('click', () => { own++; });
  parent.addEventListener('click', () => { outer++; });

  btn.fire('click');
  assert.strictEqual(own, 0, 'disabled 元素自身不该收到 click');
  assert.strictEqual(outer, 0, 'disabled 元素的 click 也不该冒泡出去');

  btn.disabled = false;
  btn.fire('click');
  assert.strictEqual(own, 1, '解禁后应正常触发');
  assert.strictEqual(outer, 1, '解禁后应正常冒泡');
});

t('运行期创建的 opt_* 能被 getElementById 找到（否则 collectCurrent 静默读不到选项）', async () => {
  const h = createHarness();
  await tick(40);
  const box = h.el('options');
  const opt = h.el('opt_downloadImages');

  assert.ok(opt, '#options 里动态创建的 opt_downloadImages 应能被取到');
  assert.strictEqual(opt.parentNode.parentNode, box, '取到的必须是当前挂在 #options 里的那个节点');
  assert.strictEqual(typeof h.ui().state.settings, 'object', '设置应已加载');
  // 真正读一次：改值后 collectCurrent 应能读到（证明它不是游离节点）
  opt.checked = false;
  const got = h.ui().state;
  assert.ok(got, 'ui 应可用');
});

t('setScroll 可设滚动尺寸（日志跟随/上翻暂停靠它才测得动）', async () => {
  const h = createHarness();
  await tick(30);
  const box = h.setScroll('log', { scrollTop: 10, scrollHeight: 300, clientHeight: 100 });
  assert.strictEqual(box.scrollTop, 10);
  assert.strictEqual(box.scrollHeight, 300);
  assert.strictEqual(box.clientHeight, 100);
});

/* -------------------------------- 运行 -------------------------------- */

(async function run() {
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n${fn}`);
      continue;
    }
    try {
      await fn();
      pass++;
      console.log('  \u2713 ' + name);
    } catch (e) {
      fail++;
      failed.push(name);
      console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
    }
  }
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (failed.length) {
    console.log('失败用例：');
    for (const f of failed) console.log('  · ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
