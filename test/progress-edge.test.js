/**
 * 实时下载进度 — 边界与异常输入（第 4 轮）
 *
 * 进度这块的边界几乎全部来自**真实网络**：CDN 的 content-length 与实到字节对不上、
 * 偶发事件缺字段、失败的条目里没有路径。这些不会报错，只会让界面显示一个
 * 永远不动的进度条，或者一行写着「undefined」的失败明细 —— 用户只能截图给你看。
 *
 * 跑法：node test/progress-edge.test.js
 */

const assert = require('assert');
const { createHarness } = require('./lib/renderer-harness');

const h = createHarness();
const el = h.el;
const txt = h.txt;
const ui = () => h.ui();

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const barWidth = () => el('bar').style.width;
const barPct = () => Number(String(barWidth()).replace('%', ''));
const metaText = () => el('liveMeta').allText();
const miniRows = () => el('minis').children;

function resetStats({ total = 0, item = 0 } = {}) {
  ui().state.stats = { total, done: 0, skip: 0, fail: 0, item };
  ui().state.inflight.clear();
  ui().state.failures = [];
  ui().state.speed = 0;
  ui().state.bytes = 0;
  ui().state.curFile = '';
  ui().state.curPct = null;
  ui().state.running = true;
  ui().state.startedAt = h.now() - 5000;
  ui().state.endedAt = 0;
  ui().renderStats();
}

section('数字边界');
t('total 为 0 时不出现 NaN / Infinity，进度条回到 0', () => {
  resetStats({ total: 0 });
  assert.strictEqual(barWidth(), '0.00%');
  assert.ok(/0 \/ 0/.test(metaText()), metaText());
  assert.ok(!/NaN|Infinity/.test(metaText()), metaText());
});

t('已完成数超过总数时，进度条不超过 100%', () => {
  resetStats({ total: 3 });
  h.H({ type: 'dl', event: 'done', file: 'C:\\a', stats: { bytes: 10 } });
  h.H({ type: 'dl', event: 'done', file: 'C:\\b', stats: { bytes: 20 } });
  h.H({ type: 'dl', event: 'skip', file: 'C:\\c', stats: { bytes: 20 } });
  h.H({ type: 'dl', event: 'fail', file: 'C:\\d', error: 'x', stats: { bytes: 20 } });
  h.pumpFrames();
  assert.strictEqual(ui().state.stats.done + ui().state.stats.skip + ui().state.stats.fail, 4);
  assert.ok(barPct() <= 100, `进度条超过了 100%：${barWidth()}`);
  assert.strictEqual(barWidth(), '100.00%');
});

t('当前文件百分比被夹在 0–100（CDN 报的字节数会超过 content-length）', () => {
  resetStats({ total: 2 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\big.mp4', written: 150, total: 100, stats: { bytes: 150 } });
  h.pumpFrames();
  const m = metaText().match(/当前文件 (\d+)%/);
  assert.ok(m, `没有渲染出「当前文件 N%」：${metaText()}`);
  assert.strictEqual(Number(m[1]), 100, `150/100 应夹成 100%，实际 ${m[1]}%`);
});

t('已下字节为 0 时不渲染「当前文件 0%」这种没信息量的数字', () => {
  resetStats({ total: 2 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\x.jpg', written: 0, total: 100, stats: { bytes: 0 } });
  h.pumpFrames();
  assert.ok(!/当前文件/.test(metaText()), metaText());
  assert.strictEqual(ui().state.curPct, null);
});

t('字节数用人类可读单位，且不会出现 NaN', () => {
  resetStats({ total: 4 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\01.jpg', written: 1536, total: 3072, stats: { bytes: 1536 } });
  h.pumpFrames();
  const row = miniRows()[0];
  assert.ok(row, '应有细进度条');
  const pctText = row.children[2].textContent;
  assert.strictEqual(pctText, '50% · 1.5 KB / 3.0 KB', pctText);
});

t('总长未知的 CDN（total=0）不显示 0%，而是显示已下字节', () => {
  resetStats({ total: 3 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\unknown.bin', written: 2048, total: 0, stats: { bytes: 2048 } });
  h.pumpFrames();
  const row = miniRows()[0];
  assert.strictEqual(row.children[2].textContent, '2.0 KB', row.children[2].textContent);
  assert.ok(barPct() > 0, '总长未知时主进度条也该体现出有推进');
});

section('异常事件');
t('progress 事件缺少 file 时不产生幽灵细进度条', () => {
  resetStats({ total: 3 });
  h.H({ type: 'dl', event: 'progress', written: 1, total: 2, stats: { bytes: 1 } });
  h.pumpFrames();
  assert.strictEqual(ui().state.inflight.size, 0, '没有文件路径就不该记进行中的任务');
  assert.strictEqual(miniRows().length, 0, `细进度条里出现了 ${miniRows().length} 行幽灵记录`);
});

t('fail 事件缺少 file / error 时明细里显示可读占位，而不是 undefined', () => {
  resetStats({ total: 3 });
  h.H({ type: 'dl', event: 'fail', stats: { bytes: 0 } });
  h.pumpFrames();
  assert.strictEqual(txt('failCount'), '1');
  const row = el('failList').children[0];
  const name = row.children[0].textContent;
  const why = row.children[1].textContent;
  assert.ok(!/undefined|null/.test(name), `文件名占位不可读：${name}`);
  assert.ok(name.length > 0, '文件名占位不能是空串');
  assert.ok(!/undefined/.test(why), `失败原因不可读：${why}`);
});

t('dl 事件整体缺少 stats 字段时不抛异常', () => {
  resetStats({ total: 2 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\x.jpg', written: 1, total: 2 });
  h.H({ type: 'dl', event: 'done', file: 'C:\\a\\x.jpg' });
  h.H({ type: 'dl', event: 'fail', file: 'C:\\a\\y.jpg' });
  h.H({ type: 'dl', event: 'skip', file: 'C:\\a\\z.jpg' });
  h.pumpFrames();
  assert.strictEqual(txt('stDone'), '1');
  assert.strictEqual(txt('stFail'), '1');
  assert.strictEqual(txt('stSkip'), '1');
  assert.strictEqual(ui().state.bytes, 0, '没有 bytes 时不应把字节数写成 NaN');
  assert.ok(!/NaN/.test(metaText()), metaText());
});

t('stats.bytes 变小（服务端重试）时速度不会变成负数', () => {
  resetStats({ total: 5 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\x.jpg', written: 5000, total: 9000, stats: { bytes: 5000 } });
  h.pumpFrames();
  h.advance(500);
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\x.jpg', written: 100, total: 9000, stats: { bytes: 100 } });
  h.pumpFrames();
  assert.ok(ui().state.speed >= 0, `速度为负：${ui().state.speed}`);
  assert.ok(!/NaN|-/.test(txt('speedText')), txt('speedText'));
});

section('失败明细');
t('失败很多时列出前 60 条并概括其余，全量仍在 state 里', () => {
  resetStats({ total: 100 });
  for (let i = 0; i < 70; i++) {
    h.H({ type: 'dl', event: 'fail', file: `C:\\out\\f${i}.jpg`, error: `错误 ${i}`, stats: { bytes: 0 } });
  }
  h.pumpFrames();
  assert.strictEqual(ui().state.failures.length, 70);
  assert.strictEqual(txt('failCount'), '70');
  const rows = el('failList').children;
  assert.strictEqual(rows.length, 61, `应为 60 条明细 + 1 行概括，实际 ${rows.length}`);
  assert.ok(/另有 10 条/.test(rows[rows.length - 1].textContent), rows[rows.length - 1].textContent);
  assert.ok(/f69\.jpg/.test(ui().failuresText()), '复制清单里要有最新的那条');
});

section('汇总与阶段');
t('作品数取「几个作品」，不能等于「几个文件」', () => {
  resetStats();
  h.H({ type: 'summary', total: 12, items: 3, images: 10, videos: 2, live: 0, rootDir: 'C:\\out' });
  h.pumpFrames();
  assert.strictEqual(txt('stTotal'), '12', '总文件数');
  assert.strictEqual(txt('stItem'), '3', '作品数应是 3，而不是被文件数覆盖成 12');
});

t('summary 缺少 items 字段时保留采集阶段已上报的作品数', () => {
  resetStats();
  h.H({ type: 'harvest-progress', total: 7 });
  h.pumpFrames();
  assert.strictEqual(txt('stItem'), '7');
  h.H({ type: 'summary', total: 20, images: 20, videos: 0, live: 0, rootDir: 'C:\\out' });
  h.pumpFrames();
  assert.strictEqual(txt('stItem'), '7', '没给 items 就不该把作品数改成文件数');
  assert.strictEqual(txt('stTotal'), '20');
});

t('剩余时间：刚开始不猜，进度过半后给出估算', () => {
  resetStats({ total: 10 });
  ui().state.startedAt = h.now();
  ui().renderStats();
  assert.strictEqual(txt('etaText'), '—', '刚开始 0 秒不该给估算');

  // 20 秒做完 5 个 → 0.25 个/秒 → 还剩 5 个 → 约 20 秒
  ui().state.startedAt = h.now() - 20000;
  ui().state.stats.done = 5;
  ui().renderStats();
  assert.ok(/^约 0:2\d$/.test(txt('etaText')), `估算不合理：${txt('etaText')}`);
});

t('任务已全部完成时不显示负的剩余时间', () => {
  resetStats({ total: 10 });
  ui().state.startedAt = h.now() - 30000;
  ui().state.stats.done = 10;
  ui().renderStats();
  assert.ok(!/-/.test(txt('etaText')), txt('etaText'));
  assert.ok(/^约 0:0\d$/.test(txt('etaText')), txt('etaText'));
});

t('转换阶段与结束阶段把阶段文案与按钮状态带对', () => {
  resetStats({ total: 2 });
  h.H({ type: 'convert-progress', done: 1, total: 3, ok: 1, failed: 0 });
  assert.ok(/转换中… 1\/3/.test(el('phaseText').textContent), el('phaseText').textContent);

  h.H({ type: 'phase', phase: 'done', message: '全部完成', rootDir: 'C:\\out' });
  assert.strictEqual(el('btnStop').disabled, true, '结束后「停止」应禁用');
  assert.strictEqual(el('btnOpen').disabled, false, '结束后「打开保存目录」应可用');
  assert.strictEqual(ui().state.running, false);
  assert.strictEqual(txt('etaText'), '—', '结束后不该继续显示剩余时间');
});

section('细进度条生命周期');
t('并发多文件各自一行；某个完成后只移除它那一行', () => {
  resetStats({ total: 8 });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\01.jpg', written: 10, total: 100, stats: { bytes: 10 } });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\02.jpg', written: 20, total: 100, stats: { bytes: 30 } });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\03.mp4', written: 30, total: 100, stats: { bytes: 60 } });
  h.pumpFrames();
  assert.strictEqual(miniRows().length, 3);

  h.H({ type: 'dl', event: 'done', file: 'C:\\a\\02.jpg', stats: { bytes: 60 } });
  h.pumpFrames();
  assert.strictEqual(miniRows().length, 2, '只应移除已完成的那一行');
  assert.strictEqual(ui().state.inflight.size, 2);
  assert.ok(el('minis').classList.contains('on'));

  h.H({ type: 'dl', event: 'done', file: 'C:\\a\\01.jpg', stats: { bytes: 60 } });
  h.H({ type: 'dl', event: 'done', file: 'C:\\a\\03.mp4', stats: { bytes: 60 } });
  h.pumpFrames();
  assert.strictEqual(miniRows().length, 0);
  assert.ok(!el('minis').classList.contains('on'), '全部结束后细进度条应收起');
});

t('同一个文件重复上报 progress 只占一行，且原地更新', () => {
  resetStats({ total: 2 });
  for (let i = 1; i <= 5; i++) {
    h.H({ type: 'dl', event: 'progress', file: 'C:\\a\\same.jpg', written: i * 20, total: 100, stats: { bytes: i * 20 } });
  }
  h.pumpFrames();
  assert.strictEqual(miniRows().length, 1);
  assert.strictEqual(miniRows()[0].children[2].textContent, '100% · 100 B / 100 B', miniRows()[0].children[2].textContent);
});

t('文件名很长时只影响展示宽度，不截断数据', () => {
  resetStats({ total: 2 });
  const long = 'C:\\out\\' + '很长的目录名'.repeat(20) + '\\file.jpg';
  h.H({ type: 'dl', event: 'progress', file: long, written: 1, total: 2, stats: { bytes: 1 } });
  h.pumpFrames();
  assert.strictEqual(miniRows()[0].children[0].title, long, '完整路径要留在 title 上');
  assert.strictEqual(ui().state.curFile, 'file.jpg');
});

/* ------------------------------- 运行 ------------------------------- */

(async function main() {
  await new Promise((r) => setTimeout(r, 40));
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
