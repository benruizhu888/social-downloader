/**
 * 功能间交互 + 单作品模式的界面行为（第 6 轮）
 *
 * 前三轮分别盯着三块功能看，这一轮看它们**放在一起**时会不会互相踩：
 * 新任务是否干净地清掉上一轮的残留、筛选状态下失败能不能立刻看见、
 * 以及「单作品模式隐藏主页专属选项」这条界面行为是不是真的生效
 * （静态断言只能证明代码里有 hidden 赋值，证明不了选项真的藏起来了）。
 *
 * 跑法：node test/feature-interaction.test.js
 */

const assert = require('assert');
const { createHarness } = require('./lib/renderer-harness');

let started = 0;
const h = createHarness({
  api: { start: async () => { started++; return {}; } },
});

const el = h.el;
const txt = h.txt;
const ui = () => h.ui();
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const logRows = () => el('log').children.filter((c) => !c.classList.contains('log-empty') && !c.classList.contains('log-cut'));
const optNodes = () => el('options').children;

async function startTask() {
  // 上一轮可能还停在「运行中」：真实流程靠 phase done 收尾，测试里手动补一下，
  // 否则 onStart 会在 `if (state.running) return;` 那里直接返回，用例变得毫无意义
  if (ui().state.running) h.H({ type: 'phase', phase: 'done', message: '收尾', rootDir: 'D:\\out' });
  el('inputUid').value = 'https://weibo.com/1234567890';
  el('inputDir').value = 'D:\\out';
  el('btnStart').fire('click');
  await tick(60);
}

section('新任务的干净启动');

t('开始新任务会清空上一轮的失败明细与进度统计', async () => {
  // 先制造一轮「有失败、有进度」的残留
  h.H({ type: 'summary', total: 10, items: 3, images: 10, videos: 0, live: 0, rootDir: 'D:\\out' });
  h.H({ type: 'dl', event: 'done', file: 'C:\\o\\a.jpg', stats: { bytes: 100 } });
  h.H({ type: 'dl', event: 'fail', file: 'C:\\o\\b.jpg', error: '连接被拒绝', stats: { bytes: 100 } });
  h.pumpFrames();
  assert.strictEqual(ui().state.failures.length, 1);
  assert.strictEqual(txt('stFail'), '1');
  assert.strictEqual(el('failBox').hidden, false);

  await startTask();

  assert.strictEqual(ui().state.failures.length, 0, '新任务应清空失败明细');
  assert.strictEqual(el('failBox').hidden, true, '失败明细面板应收起');
  assert.strictEqual(txt('stTotal'), '0');
  assert.strictEqual(txt('stDone'), '0');
  assert.strictEqual(txt('stFail'), '0');
  assert.strictEqual(txt('stItem'), '0');
  assert.strictEqual(ui().state.inflight.size, 0);
  assert.strictEqual(ui().state.bytes, 0);
  assert.strictEqual(ui().state.eta, null);
  assert.strictEqual(started, 1, '应真的调用了主进程的 task:start');
});

t('新任务的首行日志写清了「哪种模式 + 粘了什么」（事后排查全靠它）', async () => {
  el('btnClearLog').fire('click');
  await startTask();
  h.pumpFrames();
  const first = ui().state.logLines[0];
  assert.ok(first, '应有日志');
  assert.ok(/任务开始/.test(first.text), first.text);
  assert.ok(/博主主页|单个作品|批量作品/.test(first.text), `日志没有说明模式：${first.text}`);
  assert.ok(/weibo\.com/.test(first.text), `日志没有带上输入内容：${first.text}`);
});

t('跑第二次任务不会把上一轮的统计累加进去', async () => {
  h.H({ type: 'phase', phase: 'done', message: '全部完成', rootDir: 'D:\\out' });
  h.H({ type: 'dl', event: 'fail', file: 'C:\\o\\c.jpg', error: '超时', stats: { bytes: 0 } });
  h.pumpFrames();
  assert.strictEqual(txt('stFail'), '1');

  await startTask();
  assert.strictEqual(txt('stFail'), '0', '第二轮不应带着上一轮的失败数');
});

section('日志与失败明细互不干扰');

t('筛到「只看错误」时，新发生的失败立刻可见', () => {
  el('btnClearLog').fire('click');
  ui().log('普通信息', 'info');
  h.pumpFrames();
  ui().setLogFilter('err');
  assert.strictEqual(logRows().length, 0, '筛选后应没有错误行');

  h.H({ type: 'dl', event: 'fail', file: 'C:\\o\\d.jpg', error: 'HTTP 403', stats: { bytes: 0 } });
  h.pumpFrames();
  assert.strictEqual(logRows().length, 1, '失败行应立刻出现在「错误」筛选下');
  assert.ok(/403/.test(logRows()[0].allText()));
  assert.strictEqual(ui().state.failures.length, 1);
  ui().setLogFilter('all');
});

t('失败明细里的文件名与日志里的文件名一致（方便对照定位）', () => {
  const fromList = ui().state.failures[0].name;
  const fromLog = ui().state.logLines.find((l) => /下载失败/.test(l.text)).text;
  assert.ok(fromLog.includes(fromList), `日志「${fromLog}」与明细「${fromList}」对不上`);
});

t('清空日志不影响失败明细；清空失败明细不影响日志', () => {
  const fails = ui().state.failures.length;
  el('btnClearLog').fire('click');
  assert.strictEqual(ui().state.failures.length, fails, '清空日志不该连带清掉失败明细');
  assert.strictEqual(el('failCount').textContent, String(fails));

  const lines = ui().state.logLines.length;
  el('btnClearFail').fire('click');
  assert.strictEqual(ui().state.logLines.length, lines, '清空失败明细不该连带清掉日志');
  assert.strictEqual(ui().state.failures.length, 0);
});

t('日志被裁剪到上限后，进度统计与失败明细完全不受影响', () => {
  el('btnClearLog').fire('click');
  h.H({ type: 'summary', total: 5, items: 2, images: 5, videos: 0, live: 0, rootDir: 'D:\\out' });
  h.H({ type: 'dl', event: 'done', file: 'C:\\o\\x.jpg', stats: { bytes: 1 } });
  h.H({ type: 'dl', event: 'fail', file: 'C:\\o\\y.jpg', error: '失败', stats: { bytes: 1 } });
  h.pumpFrames();
  const doneBefore = txt('stDone');
  const failBefore = txt('stFail');
  const logBase = ui().state.logLines.length; // H 事件本身也会写日志，基线要算进去

  for (let i = 0; i < 3000; i++) {
    ui().log(`灌日志 ${i}`);
    if (i % 25 === 0) h.pumpFrames();
  }
  h.pumpFrames();

  assert.ok(el('log').childElementCount <= 501, `日志区节点失控：${el('log').childElementCount}`);
  assert.strictEqual(ui().state.logLines.length, logBase + 3000);
  assert.strictEqual(txt('stDone'), doneBefore, '裁剪日志不该影响进度统计');
  assert.strictEqual(txt('stFail'), failBefore);
  assert.strictEqual(ui().state.failures.length, 1);
});

t('结束任务后失败明细仍保留（用户要能看到到底哪些没下来）', () => {
  assert.ok(ui().state.failures.length > 0, '前置条件：应有失败明细');
  h.H({ type: 'phase', phase: 'done', message: '全部完成', rootDir: 'D:\\out' });
  h.pumpFrames();
  assert.strictEqual(ui().state.running, false);
  assert.strictEqual(el('failBox').hidden, false, '结束后失败明细不该被收起');
  assert.strictEqual(ui().state.failures.length, 1);
});

section('单作品模式：主页专属选项真的藏起来了');

t('粘单个作品链接后，只对博主主页生效的选项被隐藏并有提示', async () => {
  h.setInspect({
    mode: 'single', platform: 'weibo', platformName: '微博', itemId: 'P0RSAbcde',
    shortLink: false, mismatch: false, currentName: '微博',
  });
  el('inputUid').value = 'https://weibo.com/1234567890/P0RSAbcde';
  el('inputUid').fire('input');
  await tick(320);

  const all = optNodes();
  assert.ok(all.length > 0, '选项区应有内容');
  const profileOnly = all.filter((o) => o.dataset.scope === 'profile');
  assert.ok(profileOnly.length > 0, '微博应有 scope=profile 的选项（maxItems / maxPages / onlyOriginal）');
  assert.ok(
    profileOnly.every((o) => o.hidden === true),
    '单作品模式下这些选项必须真的隐藏（只设了 dataset 没设 hidden 是没用的）'
  );
  const shared = all.filter((o) => o.dataset.scope !== 'profile');
  assert.ok(shared.every((o) => o.hidden === false), '通用选项不该被藏着');
  assert.strictEqual(el('optionScopeTip').hidden, false, '应说明隐藏了几个选项');
  assert.ok(/隐藏/.test(el('optionScopeTip').textContent), el('optionScopeTip').textContent);
  assert.ok(/单个\/多个作品/.test(el('optionScopeTip').textContent));
});

t('选项只是 hidden，不是删掉 —— 切回主页模式时值还在', async () => {
  const before = optNodes()
    .filter((o) => o.dataset.scope === 'profile')
    .map((o) => {
      const input = o.children.find((c) => c.tagName === 'INPUT');
      return input ? input.value : null;
    });
  assert.ok(before.some((v) => v !== null), '数值选项应还在 DOM 里');

  h.setInspect({ mode: 'profile' });
  el('inputUid').value = 'https://weibo.com/1234567890';
  el('inputUid').fire('input');
  await tick(320);

  const after = optNodes().filter((o) => o.dataset.scope === 'profile');
  assert.strictEqual(after.length, before.length, '切回主页模式后选项仍在');
  assert.ok(after.every((o) => o.hidden === false), '这些选项应重新显示');
  assert.strictEqual(el('optionScopeTip').hidden, true, '没有隐藏项时提示应消失');
});

t('切平台会按新平台的 schema 重建选项，并重新套用当前模式的显隐', async () => {
  h.setInspect({ mode: 'single', platform: 'weibo', platformName: '微博', itemId: 'x', mismatch: false, currentName: '微博' });
  el('inputUid').value = 'https://weibo.com/1234567890/P0RSAbcde';
  el('inputUid').fire('input');
  await tick(320);

  const dirValue = 'D:\\keep';
  el('inputDir').value = dirValue;
  const xhsTab = el('tabs').children.find((c) => c.dataset.platform === 'xhs');
  el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? xhsTab : null) } });
  await tick(80);

  assert.strictEqual(ui().state.platform, 'xhs');
  const rebuilt = optNodes();
  assert.ok(rebuilt.length > 0, '新平台的选项应被渲染出来');
  // 单作品模式仍然生效：新平台里若有 profile 专属选项也必须藏着
  assert.ok(rebuilt.filter((o) => o.dataset.scope === 'profile').every((o) => o.hidden === true));
});

section('单条作品的落盘位置要在界面上说清');

t('单条模式：提示里给出 {保存目录}\\{平台}_{作品id}\\', async () => {
  const weiboTab = el('tabs').children.find((c) => c.dataset.platform === 'weibo');
  el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? weiboTab : null) } });
  await tick(80);
  el('inputDir').value = 'D:\\下载';
  h.setInspect({
    mode: 'single', platform: 'weibo', platformName: '微博', itemId: 'P0RSAbcde',
    shortLink: false, mismatch: false, currentName: '微博',
  });
  el('inputUid').value = 'https://weibo.com/1234567890/P0RSAbcde';
  el('inputUid').fire('input');
  await tick(320);

  const tip = el('inputModeText').textContent;
  assert.ok(tip.includes('D:\\下载\\weibo_P0RSAbcde\\'), `提示里没有落盘路径：${tip}`);
  // 用的是主进程判定出来的 platform id，而不是当前选项卡的显示名
  assert.ok(!/微博_P0RSAbcde/.test(tip), `应写平台 id 而不是中文名：${tip}`);
});

t('保存目录为空时不编造路径，而是说明还没选', async () => {
  el('inputDir').value = '';
  h.setInspect({
    mode: 'single', platform: 'douyin', platformName: '抖音', itemId: '7300000000000000000',
    shortLink: false, mismatch: false, currentName: '抖音',
  });
  el('inputUid').value = 'https://www.douyin.com/video/7300000000000000000';
  el('inputUid').fire('input');
  await tick(320);

  const tip = el('inputModeText').textContent;
  assert.ok(!/undefined|null/.test(tip), `提示里出现了占位符：${tip}`);
  assert.ok(/保存目录还没选/.test(tip), `应说明保存目录未选：${tip}`);
  assert.ok(!/\\\\/.test(tip), `不该出现空路径拼接：${tip}`);
});

t('批量模式：提示里给出批次目录，并说明每个作品一个子目录', async () => {
  el('inputDir').value = 'D:\\下载';
  h.setInspect({
    mode: 'batch', total: 3, count: 3, alienCount: 0, ignoredCount: 0,
    hasShortLink: false, mismatch: false, otherPlatforms: '', otherPlatformIds: [], currentName: '抖音',
  });
  el('inputUid').value = 'a\nb\nc';
  el('inputUid').fire('input');
  await tick(320);

  const tip = el('inputModeText').textContent;
  assert.ok(
    tip.includes(`D:\\下载\\${ui().state.platform}_batch\\`),
    `提示里没有批次目录（当前平台 ${ui().state.platform}）：${tip}`
  );
  assert.ok(/每个作品一个子目录/.test(tip), `应说明子目录规则：${tip}`);
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
