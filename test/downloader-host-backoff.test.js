/**
 * 下载器「同主机失败冷却」（第 7 轮：来自真机日志）
 *
 * 用户 2026-10-15 的一次任务里：小红书 50 个文件失败 9 个，全是
 * `net::ERR_CONNECTION_RESET`；而同一时段微博 198/198、抖音 88/88 全过。
 * 结论是同一个 CDN 按请求频率主动断连（限流），而原来的处置只有
 * 「重试这一个文件」—— 另外 3 个 worker 仍在猛打同一主机，
 * 于是失败被摊到 9 个不同文件上，谁重试都救不回来。
 *
 * 这里测冷却机制本身。冷却时长是固定常量（3s 起、30s 封顶），
 * 所以断言用容差区间，不去 sleep 满冷却（那样测试要跑几十秒）。
 *
 * 跑法：node test/downloader-host-backoff.test.js
 */

const assert = require('assert');
const { Downloader } = require('../src/main/core/downloader');

let pass = 0;
let fail = 0;
const failed = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDownloader() {
  const logs = [];
  const dl = new Downloader({ logger: (m) => logs.push(m), fetchImpl: async () => { throw new Error('未使用'); } });
  return { dl, logs };
}

const A = 'https://sns-img-qc.xhscdn.com/a/live01.jpg';
const B = 'https://f.video.weibocdn.com/b/video.mp4';
const hostA = 'sns-img-qc.xhscdn.com';

function cooldownLeft(dl, host) {
  const st = dl._hostState.get(host);
  return st ? Math.max(0, st.until - Date.now()) : 0;
}

section('主机识别');

t('_hostOf 取主机名；非法地址返回空串而不是抛异常', () => {
  const { dl } = makeDownloader();
  assert.strictEqual(dl._hostOf(A), hostA);
  assert.strictEqual(dl._hostOf(B), 'f.video.weibocdn.com');
  for (const bad of ['', null, undefined, '不是地址', '://x']) {
    assert.strictEqual(dl._hostOf(bad), '', String(bad));
  }
});

section('冷却触发与升级');

t('零星失败不冷却（正常任务零成本，自调优）', () => {
  const { dl } = makeDownloader();
  dl._noteHostFail(A);
  dl._noteHostFail(B);
  assert.strictEqual(cooldownLeft(dl, hostA), 0, '只失败 1 次不该冷却');
  assert.strictEqual(cooldownLeft(dl, 'f.video.weibocdn.com'), 0);
});

t('同一主机 30 秒内失败 3 次 → 冷却约 3 秒', () => {
  const { dl } = makeDownloader();
  for (let i = 0; i < 3; i++) dl._noteHostFail(A);
  const left = cooldownLeft(dl, hostA);
  assert.ok(left > 2500 && left <= 3000, `冷却应为约 3 秒，实际 ${left}ms`);
});

t('继续失败则冷却翻倍升级（4 次 6 秒、5 次 9 秒）', () => {
  const { dl } = makeDownloader();
  for (let i = 0; i < 4; i++) dl._noteHostFail(A);
  assert.ok(cooldownLeft(dl, hostA) > 5500, `4 次应约 6 秒，实际 ${cooldownLeft(dl, hostA)}ms`);
  for (let i = 0; i < 1; i++) dl._noteHostFail(A);
  assert.ok(cooldownLeft(dl, hostA) > 8500, `5 次应约 9 秒，实际 ${cooldownLeft(dl, hostA)}ms`);
});

t('冷却封顶 30 秒，不会无限增长', () => {
  const { dl } = makeDownloader();
  for (let i = 0; i < 200; i++) dl._noteHostFail(A);
  const left = cooldownLeft(dl, hostA);
  assert.ok(left <= 30000, `冷却应封顶 30 秒，实际 ${left}ms`);
  assert.ok(left > 29000, `已远超阈值，应顶到上限，实际 ${left}ms`);
});

t('冷却只影响失败的那个主机，别的主机照常跑', () => {
  const { dl } = makeDownloader();
  for (let i = 0; i < 5; i++) dl._noteHostFail(A);
  assert.ok(cooldownLeft(dl, hostA) > 0);
  assert.strictEqual(cooldownLeft(dl, 'f.video.weibocdn.com'), 0, '微博 CDN 不该被牵连');
});

section('滑动窗口');

t('超出窗口的旧失败不再计入（30 秒前的不算数）', () => {
  const { dl } = makeDownloader();
  dl._noteHostFail(A);
  dl._noteHostFail(A);
  const st = dl._hostState.get(hostA);
  st.times = st.times.map(() => Date.now() - 31000); // 把两次失败挪到窗口外
  dl._noteHostFail(A);
  assert.strictEqual(cooldownLeft(dl, hostA), 0, '只剩 1 次有效失败，不该冷却');
  assert.strictEqual(dl._hostState.get(hostA).times.length, 1, '窗口外的记录应被清掉');
});

t('「失败被成功冲淡」的情况也会被发现（成功不清窗口，窗口靠时间自然过期）', () => {
  const { dl } = makeDownloader();
  // 模拟真机那种交错：失败、成功、失败、成功、失败 —— 成功不做任何记录
  dl._noteHostFail(A);
  dl._noteHostFail(A);
  dl._noteHostFail(A);
  assert.ok(cooldownLeft(dl, hostA) > 0, '三次失败即使中间夹着成功，也应触发冷却');
});

section('等待行为');

t('没有冷却时 _respectCooldown 立即返回', async () => {
  const { dl } = makeDownloader();
  const t0 = Date.now();
  await dl._respectCooldown(A);
  assert.ok(Date.now() - t0 < 60, '不该有任何等待');
});

t('stop() 后 _respectCooldown 立刻返回，不会把「停止」卡在冷却里', async () => {
  const { dl } = makeDownloader();
  dl._hostState.set(hostA, { times: [], until: Date.now() + 30000, lastLogAt: 0 });
  dl.stop();
  const t0 = Date.now();
  await dl._respectCooldown(A);
  assert.ok(Date.now() - t0 < 300, `停止后应立刻返回，实际等了 ${Date.now() - t0}ms`);
});

t('冷却期间确实会等待（用 300ms 的冷却验证）', async () => {
  const { dl } = makeDownloader();
  dl._hostState.set(hostA, { times: [], until: Date.now() + 300, lastLogAt: 0 });
  const t0 = Date.now();
  await dl._respectCooldown(A);
  const used = Date.now() - t0;
  assert.ok(used >= 250 && used < 900, `应等待约 300ms，实际 ${used}ms`);
});

section('日志不能变成新的刷屏源');

t('三次失败只提醒一次；紧接着继续失败不再重复提醒', () => {
  const { dl, logs } = makeDownloader();
  for (let i = 0; i < 8; i++) dl._noteHostFail(A);
  assert.strictEqual(logs.length, 1, `8 次失败应只提醒 1 次，实际 ${logs.length} 条：\n${logs.join('\n')}`);
  assert.ok(/失败 3 次/.test(logs[0]), logs[0]);
  assert.ok(/暂停 3 秒/.test(logs[0]), logs[0]);
  assert.ok(/限流/.test(logs[0]), '应说明这是限流，而不是让用户以为链接失效');
});

t('超过半个窗口后再失败会再提醒一次（长时间挂机也看得见）', () => {
  const { dl, logs } = makeDownloader();
  for (let i = 0; i < 3; i++) dl._noteHostFail(A);
  const st = dl._hostState.get(hostA);
  st.lastLogAt = Date.now() - 20000; // 假装上次提醒已过去 20 秒（> 半个窗口）
  dl._noteHostFail(A);
  assert.strictEqual(logs.length, 2, `应再提醒一次，实际 ${logs.length} 条`);
});

t('提醒文案里带具体主机名，方便直接判断是不是某个 CDN', () => {
  const { dl, logs } = makeDownloader();
  for (let i = 0; i < 3; i++) dl._noteHostFail(A);
  assert.ok(logs[0].includes(hostA), logs[0]);
});

/* ------------------------------- 运行 ------------------------------- */

(async function main() {
  await sleep(10);
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
