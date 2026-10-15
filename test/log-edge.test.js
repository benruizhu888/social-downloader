/**
 * 运行日志 — 边界与异常输入（第 3 轮）
 *
 * 日志这块最容易出的不是「显示不出来」，而是**长任务下悄悄坏掉**：
 * DOM 无限增长、计数和实际条数对不上、被筛掉的行也提示「有新日志」。
 * 这些都不会报错，只会让用户觉得「这软件越跑越卡」「日志数看着不对」。
 *
 * 跑法：node test/log-edge.test.js
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

/** 模拟真实流式写入：每敲一批就让 rAF 跑一帧，而不是最后一次性 flush */
function write(n, make = (i) => `第 ${i} 条`) {
  for (let i = 0; i < n; i++) {
    ui().log(make(i));
    if (i % 25 === 0) h.pumpFrames();
  }
  h.pumpFrames();
}
const reset = () => {
  el('btnClearLog').fire('click');
  ui().setLogFilter('all');
  ui().state.logQuery = '';
  ui().rerenderLog();
};
const logChildren = () => el('log').children;
const hasClass = (node, c) => node && node.classList && node.classList.contains(c);

section('容量与裁剪');

t('长任务下 DOM 节点数必须有上限（否则越跑越卡，这正是当初加裁剪的原因）', () => {
  reset();
  write(3000);
  const n = el('log').childElementCount;
  assert.ok(
    n <= 501,
    `写入 3000 条后日志区仍有 ${n} 个节点 —— 裁剪没有生效（上限应为 400 行 + 少量提示行）`
  );
});

t('裁剪后「已省略」提示只有一条，不会越堆越多', () => {
  const cuts = logChildren().filter((c) => hasClass(c, 'log-cut'));
  assert.ok(cuts.length <= 1, `「已省略」提示出现了 ${cuts.length} 条，应最多 1 条`);
});

t('全量数组有上限（LOG_KEEP），且计数与真实条数一致', () => {
  reset();
  write(5600, (i) => `批量日志 ${i}`);
  const lines = ui().state.logLines.length;
  assert.strictEqual(lines, 5000, `全量日志应保留最近 5000 条，实际 ${lines}`);
  assert.strictEqual(txt('cntAll'), '5000', '顶部计数必须等于真实保留条数');
});

t('各级别计数之和 == 总数', () => {
  reset();
  write(30, (i) => (i % 3 === 0 ? `失败：文件 ${i}.jpg` : i % 3 === 1 ? `已跳过 ${i}` : `处理 ${i}`));
  const sum =
    Number(txt('cntInfo')) + Number(txt('cntOk')) + Number(txt('cntWarn')) + Number(txt('cntErr'));
  assert.strictEqual(sum, Number(txt('cntAll')), '四个级别的计数之和应等于总数');
});

section('异常输入');

t('非字符串消息（undefined / 数字 / 对象 / null）不抛异常且照常计数', () => {
  reset();
  ui().log(undefined);
  ui().log(123);
  ui().log({ a: 1 });
  ui().log(null);
  ui().log();
  h.pumpFrames();
  assert.strictEqual(txt('cntAll'), '5');
});

t('10 万字符的单条消息不会抛异常', () => {
  reset();
  ui().log('长消息：' + '啊'.repeat(100000));
  h.pumpFrames();
  assert.strictEqual(txt('cntAll'), '1');
  assert.strictEqual(el('log').childElementCount, 1);
});

t('消息里的 HTML 只会被当文本，不会生成元素节点（无 XSS 面）', () => {
  reset();
  ui().log('<img src=x onerror="alert(1)"><b>我是加粗</b>', 'err');
  h.pumpFrames();
  const line = logChildren()[0];
  assert.strictEqual(line.children.length, 2, '一行只应有「时间 + 正文」两个元素');
  const body = line.children[1];
  const nested = body.children.filter((c) => c.tagName !== '#TEXT');
  assert.strictEqual(nested.length, 0, `正文里不应出现元素节点，实际 ${nested.length} 个`);
  assert.ok(body.allText().includes('<img'), '尖括号应原样显示');
});

t('全部乱码 / emoji / 换行符都能安全写入', () => {
  reset();
  for (const m of ['\u0000\u0001\u0002', '🙂🀄️👨‍👩‍👧', '第一行\n第二行', '\t\t']) {
    ui().log(m);
  }
  h.pumpFrames();
  assert.strictEqual(txt('cntAll'), '4');
});

section('筛选与检索');

t('关键字含正则元字符时按字面匹配，不抛异常', () => {
  reset();
  write(10, (i) => `文件 a(${i}).jpg 处理完成`);
  for (const q of ['(', ')', '[', ']', '*', '+', '?', '\\', '$', '^', '.*', 'a(1)']) {
    ui().state.logQuery = q;
    ui().rerenderLog();
    assert.ok(el('log').childElementCount >= 1, `关键字 ${JSON.stringify(q)} 把结果全过滤空了`);
  }
  ui().state.logQuery = 'a(1)';
  ui().rerenderLog();
  assert.strictEqual(logChildren().filter((c) => !hasClass(c, 'log-empty')).length, 1);
});

t('关键字首尾空格被忽略（用户从别处复制粘贴常见）', () => {
  reset();
  ui().log('下载失败：abc.jpg');
  h.pumpFrames();
  ui().state.logQuery = 'abc.jpg'.trim();
  ui().rerenderLog();
  assert.ok(logChildren().every((c) => !hasClass(c, 'log-empty')), '应命中');
});

t('设置非法级别被忽略，不会把界面筛成空白', () => {
  reset();
  ui().log('一条信息');
  h.pumpFrames();
  const before = ui().state.logFilter;
  ui().setLogFilter('不是级别');
  ui().setLogFilter(undefined);
  ui().setLogFilter(null);
  assert.strictEqual(ui().state.logFilter, before, '非法级别不应改变当前筛选');
  assert.strictEqual(el('log').childElementCount, 1);
});

t('重复点同一个级别不会丢内容', () => {
  reset();
  write(5);
  ui().setLogFilter('err');
  ui().setLogFilter('err');
  ui().setLogFilter('err');
  ui().setLogFilter('all');
  assert.strictEqual(el('log').childElementCount, 5, '切回「全部」应恢复全部 5 条');
});

t('筛到 0 条时显示空态；重新写入匹配的行后空态消失', () => {
  reset();
  ui().log('普通信息');
  h.pumpFrames();
  ui().setLogFilter('err');
  assert.strictEqual(el('log').childElementCount, 1);
  assert.ok(hasClass(logChildren()[0], 'log-empty'), '应为空态占位');

  ui().log('下载失败：x.jpg', 'err');
  h.pumpFrames();
  const kids = logChildren();
  assert.ok(!kids.some((c) => hasClass(c, 'log-empty')), '有新行后空态应被移除');
  assert.strictEqual(kids.length, 1);
});

section('跟随与新增提示');

t('被筛选条件排除掉的新行，不该提示「有新日志」（提示了却点不出东西是最招人烦的）', () => {
  reset();
  ui().setLogFilter('err');
  ui().setLogFollow(false);
  el('log').scrollHeight = 900;
  el('log').clientHeight = 200;
  el('log').scrollTop = 0;

  // 注意文案里不能出现「失败 / 错误 / 异常」等词 —— 级别是按关键词判定的，
  // 写进去了这条就会被判成 err，用例本身就失去意义了
  ui().log('这只是一条普通信息，会被级别筛选挡掉');
  h.pumpFrames();
  assert.strictEqual(
    el('btnLogNew').hidden,
    true,
    '被筛掉的行不该让「N 条新日志」亮起来'
  );
  assert.strictEqual(el('log').childElementCount, 1, '被筛掉时 DOM 里只应有空态占位');
});

t('确实可见的新行才提示「N 条新日志」，且计数准确', () => {
  reset();
  ui().setLogFilter('err');
  ui().setLogFollow(false);
  el('log').scrollHeight = 900;
  el('log').clientHeight = 200;
  el('log').scrollTop = 0;

  ui().log('失败一', 'err');
  ui().log('普通信息（会被挡掉）');
  ui().log('失败二', 'err');
  h.pumpFrames();
  assert.strictEqual(el('btnLogNew').hidden, false);
  assert.ok(/2 条新日志/.test(el('btnLogNew').textContent), el('btnLogNew').textContent);
});

t('清空后写入：空态占位被移除，不会和新日志并存', () => {
  reset();
  assert.ok(hasClass(logChildren()[0], 'log-empty'), '清空后应显示空态');
  ui().log('新的一条');
  h.pumpFrames();
  assert.ok(!logChildren().some((c) => hasClass(c, 'log-empty')), '空态应被移除');
  assert.strictEqual(logChildren().length, 1);
});

section('导出');

t('导出始终是全量（不受界面筛选影响），且带上分级统计', () => {
  reset();
  write(20, (i) => (i % 4 === 0 ? `失败：${i}.jpg` : `处理 ${i}`));
  ui().setLogFilter('err');
  const text = ui().exportLogText();
  assert.ok(/日志分级：/.test(text), '导出头部应含分级统计');
  assert.ok(/\[info\]/.test(text), '导出里应能看见 info 级别的行（即被界面筛掉的那些）');
  assert.ok(/\[err\]/.test(text), '导出里应能看见 err 级别的行');
  assert.ok(text.split('\n').length >= Number(txt('cntAll')), '导出行数不应少于日志条数');
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
