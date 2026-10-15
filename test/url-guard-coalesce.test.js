/**
 * 拦截日志的重复合并（第 7 轮：来自真机日志）
 *
 * 用户 2026-10-15 的抖音日志里有 46 行一模一样的
 * `[info] [抖音] 已拦截子框架导航到 bytedance:// 协议`。
 * 界面日志区只保留最近 400 行 —— 这些噪声把「采集到几个作品」「哪个文件失败」
 * 直接挤了出去，用户拿着导出日志来问问题时，关键行已经不在界面上了。
 *
 * 这里只测合并器本身（纯函数、确定性，不依赖时间窗口）。
 *
 * 跑法：node test/url-guard-coalesce.test.js
 */

const assert = require('assert');
const { createRepeatCoalescer } = require('../src/main/url-guard');

let pass = 0;
let fail = 0;
const failed = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    failed.push(name);
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

function collector(opts) {
  const lines = [];
  const c = createRepeatCoalescer(Object.assign({ step: 20, log: (m) => lines.push(m) }, opts));
  return { c, lines };
}

console.log('\n[首次与重复]');

t('第一次出现立刻原样输出（关键信息不被推迟）', () => {
  const { c, lines } = collector();
  c.push('bytedance', '已拦截子框架导航到 bytedance:// 协议');
  assert.deepStrictEqual(lines, ['已拦截子框架导航到 bytedance:// 协议']);
});

t('少量重复不额外输出（不足 step 的余数就是要被压掉的噪声）', () => {
  const { c, lines } = collector({ step: 20 });
  for (let i = 0; i < 19; i++) c.push('k', '拦了');
  assert.strictEqual(lines.length, 1, `应只有首次那一条，实际 ${lines.length}`);
});

t('重复累计到 step 次后输出一条带次数的汇总（首次那一条 + 汇总那一条）', () => {
  const { c, lines } = collector({ step: 20 });
  for (let i = 0; i < 20; i++) c.push('k', '拦了'); // 首次 1 次 + 重复 19 次
  assert.strictEqual(lines.length, 1, '重复还没到 20 次，不该出汇总');
  c.push('k', '拦了'); // 重复第 20 次
  assert.strictEqual(lines.length, 2);
  assert.ok(/累计拦截 21 次/.test(lines[1]), lines[1]);
});

t('真机那 46 条重复 → 只剩 3 行（1 条原文 + 2 条汇总）', () => {
  const { c, lines } = collector({ step: 20 });
  for (let i = 0; i < 46; i++) c.push('bytedance://', '已拦截子框架导航到 bytedance:// 协议');
  assert.strictEqual(lines.length, 3, `46 条应压成 3 条，实际 ${lines.length}：\n${lines.join('\n')}`);
  assert.ok(/累计拦截 21 次/.test(lines[1]), lines[1]);
  assert.ok(/累计拦截 41 次/.test(lines[2]), lines[2]);
});

t('超过 step 的余数不再输出，总条数不随重复次数增长', () => {
  const { c, lines } = collector({ step: 10 });
  for (let i = 0; i < 1000; i++) c.push('k', '拦了');
  // 1 次原文 + 每 10 次一条 ≈ 100 条，而不是 1000 条
  assert.ok(lines.length <= 101, `压不下来：${lines.length} 条`);
  assert.ok(lines.length >= 99, `压过头了：${lines.length} 条`);
});

console.log('\n[多个目标互不干扰]');

t('不同目标各自计数，各打各的首次', () => {
  const { c, lines } = collector({ step: 5 });
  c.push('bytedance://', '拦了 bytedance');
  c.push('snssdk://', '拦了 snssdk');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(c.countOf('bytedance://'), 1);
  assert.strictEqual(c.countOf('snssdk://'), 1);
});

t('目标 A 刷屏不会导致目标 B 的首次被吞掉', () => {
  const { c, lines } = collector({ step: 5 });
  for (let i = 0; i < 50; i++) c.push('A', '拦了 A');
  c.push('B', '拦了 B');
  assert.ok(lines.includes('拦了 B'), `B 的首次丢了：\n${lines.join('\n')}`);
});

t('countOf 能查到累计次数，未知键返回 0', () => {
  const { c } = collector();
  for (let i = 0; i < 7; i++) c.push('k', 'x');
  assert.strictEqual(c.countOf('k'), 7);
  assert.strictEqual(c.countOf('没见过的键'), 0);
});

console.log('\n[边界]');

t('step 为 1 时每个重复都输出（等于关闭合并）', () => {
  const { c, lines } = collector({ step: 1 });
  for (let i = 0; i < 3; i++) c.push('k', '拦了');
  assert.strictEqual(lines.length, 3);
});

t('默认不传 log 也不会抛异常', () => {
  const c = createRepeatCoalescer();
  for (let i = 0; i < 50; i++) c.push('k', 'x');
  assert.strictEqual(c.countOf('k'), 50);
});

t('key 与 text 不一致时以 key 去重、以 text 记录（同目标不同文案不会串）', () => {
  const { c, lines } = collector({ step: 2 });
  c.push('same-key', '文案甲');
  c.push('same-key', '文案乙');
  c.push('same-key', '文案丙');
  assert.strictEqual(lines[0], '文案甲');
  assert.ok(/文案丙.*累计拦截 3 次/.test(lines[1]), lines[1]);
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (failed.length) {
  console.log('失败用例：');
  for (const f of failed) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
