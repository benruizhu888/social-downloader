/**
 * 界面事件接线（第 5 轮）
 *
 * 前四轮里我大多是**直接调用**渲染层的函数（`ui().setLogFilter('err')`），
 * 这验证了逻辑，却没验证「按钮真的接上了」。接线断了的表现是：
 * 逻辑测试全绿，用户点下去毫无反应 —— 静态断言也查不出来。
 * 这里全部走真实的 `addEventListener` 回调（fire 派发合成事件）。
 *
 * 跑法：node test/renderer-events.test.js
 */

const assert = require('assert');
const { createHarness } = require('./lib/renderer-harness');

const calls = { exportLog: [], openFolder: [], chooseDir: 0, copy: [], setSettings: [] };

const h = createHarness({
  api: {
    exportLog: async (text) => {
      calls.exportLog.push(text);
      return { filePath: 'D:\\logs\\run.log' };
    },
    openFolder: (dir) => { calls.openFolder.push(dir); },
    chooseDir: async () => { calls.chooseDir++; return 'D:\\out2'; },
    copyText: async (t) => { calls.copy.push(t); },
    setSettings: async (patch) => { calls.setSettings.push(patch); return h.settings; },
  },
});

const el = h.el;
const txt = h.txt;
const ui = () => h.ui();
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const segs = () => el('logFilter').children;
const segItem = (level) => segs().find((c) => c.dataset.level === level);
const logRows = () => el('log').children.filter((c) => !c.classList.contains('log-empty') && !c.classList.contains('log-cut'));
const hasClass = (n, c) => n && n.classList && n.classList.contains(c);
/** 造一个 click 事件：target.closest 由调用方决定命中谁 */
const clickOn = (target) => ({ target: { closest: (sel) => (target && target.__match === sel ? target : null) } });

section('日志工具栏');

t('点「错误」段真的会切换筛选（不是只有函数能跑）', () => {
  el('btnClearLog').fire('click');
  ui().log('普通信息一');
  ui().log('下载失败：a.jpg', 'err');
  ui().log('普通信息二');
  h.pumpFrames();

  const target = segItem('err');
  target.__match = '.seg-item';
  el('logFilter').fire('click', clickOn(target));

  assert.strictEqual(ui().state.logFilter, 'err', '筛选没有切过去 —— 事件可能没接上');
  assert.strictEqual(logRows().length, 1);
  assert.ok(hasClass(segItem('err'), 'active'), '被选中的段应有 active 样式');
  assert.ok(!hasClass(segItem('all'), 'active'));
});

t('点「全部」段恢复全部日志', () => {
  const target = segItem('all');
  target.__match = '.seg-item';
  el('logFilter').fire('click', clickOn(target));
  assert.strictEqual(ui().state.logFilter, 'all');
  assert.strictEqual(logRows().length, 3);
});

t('点击段的空白处（没有命中任何 seg-item）不应改变筛选', () => {
  const target = { __match: '不是这个选择器' };
  el('logFilter').fire('click', clickOn(target));
  assert.strictEqual(ui().state.logFilter, 'all');
});

t('在搜索框输入会实时过滤（走真实 input 事件）', () => {
  el('logSearch').value = 'a.jpg';
  el('logSearch').fire('input');
  assert.strictEqual(ui().state.logQuery, 'a.jpg');
  assert.strictEqual(logRows().length, 1);
  assert.ok(/a\.jpg/.test(logRows()[0].allText()));

  el('logSearch').value = '   ';
  el('logSearch').fire('input');
  assert.strictEqual(ui().state.logQuery, '', '只有空格应视为清空');
  assert.strictEqual(logRows().length, 3);
});

t('「跟随最新」按钮能开关，文案同步', () => {
  el('btnLogFollow').fire('click');
  assert.strictEqual(ui().state.logFollow, false);
  assert.ok(/关/.test(el('btnLogFollow').textContent), el('btnLogFollow').textContent);
  el('btnLogFollow').fire('click');
  assert.strictEqual(ui().state.logFollow, true);
  assert.ok(/开/.test(el('btnLogFollow').textContent), el('btnLogFollow').textContent);
});

t('「复制全部」把全量日志送进剪贴板', () => {
  const before = calls.copy.length;
  el('btnCopyLog').fire('click');
  return tick().then(() => {
    assert.strictEqual(calls.copy.length, before + 1, '复制按钮没有接上');
    assert.ok(/运行日志/.test(calls.copy[calls.copy.length - 1]));
  });
});

t('「导出日志」调用主进程导出并把结果写进日志', async () => {
  el('btnExportLog').fire('click');
  await tick();
  assert.strictEqual(calls.exportLog.length, 1, '导出按钮没有接上');
  assert.ok(/运行日志/.test(calls.exportLog[0]));
  h.pumpFrames();
  assert.ok(
    ui().state.logLines.some((l) => /日志已导出/.test(l.text)),
    '导出后应留一条日志，用户回头能在文件里看到这个动作'
  );
});

t('日志为空时点复制 / 导出只提示，不发请求', async () => {
  el('btnClearLog').fire('click');
  const c0 = calls.copy.length;
  const e0 = calls.exportLog.length;
  el('btnCopyLog').fire('click');
  el('btnExportLog').fire('click');
  await tick();
  assert.strictEqual(calls.copy.length, c0, '空日志不该真的去复制');
  assert.strictEqual(calls.exportLog.length, e0, '空日志不该真的去导出');
});

section('平台与目录');

t('点平台选项卡会切换平台', async () => {
  const tabs = el('tabs').children;
  assert.ok(tabs.length >= 3, '应渲染出三个平台选项卡');
  const xhsTab = tabs.find((c) => c.dataset.platform === 'xhs');
  assert.ok(xhsTab, '没有小红书选项卡');
  xhsTab.__match = '.tab';
  el('tabs').fire('click', clickOn(xhsTab));
  await tick(60);
  assert.strictEqual(ui().state.platform, 'xhs', '选项卡点击没有接上');
});

t('任务运行中不允许切换平台（避免把半途的任务切到别的平台）', async () => {
  const cur = ui().state.platform;
  ui().state.running = true;
  const weiboTab = el('tabs').children.find((c) => c.dataset.platform === 'weibo');
  weiboTab.__match = '.tab';
  el('tabs').fire('click', clickOn(weiboTab));
  await tick(60);
  assert.strictEqual(ui().state.platform, cur, '运行中不应切换平台');
  ui().state.running = false;
});

t('「打开保存目录」把当前保存目录交给主进程', async () => {
  const n = calls.openFolder.length;
  el('btnOpen').fire('click');
  await tick();
  assert.strictEqual(calls.openFolder.length, n + 1, '打开目录按钮没有接上');
});

t('「浏览…」选完目录后写进输入框并持久化', async () => {
  const n = calls.setSettings.length;
  el('btnDir').fire('click');
  await tick(80);
  assert.strictEqual(calls.chooseDir, 1, '浏览按钮没有接上');
  assert.strictEqual(el('inputDir').value, 'D:\\out2');
  assert.ok(calls.setSettings.length > n, '选完目录应写回设置');
});

section('停止按钮');

t('「停止」会调用主进程的 task:stop', async () => {
  let stopped = 0;
  const h2 = createHarness({ api: { stop: async () => { stopped++; } } });
  await tick(40);
  h2.el('btnStop').disabled = false;
  h2.el('btnStop').fire('click');
  await tick();
  assert.strictEqual(stopped, 1, '停止按钮没有接上');
});

/* ------------------------------- 运行 ------------------------------- */

(async function main() {
  await tick(40);
  let pass = 0;
  let fail = 0;
  const failed = [];
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
