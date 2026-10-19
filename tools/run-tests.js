#!/usr/bin/env node
/**
 * 一次跑完全部测试并打印汇总表。
 *
 * 为什么不用 `npm test && ...` 串起来：串行链条在第一个文件失败时就断了，
 * 看不到其余文件的结果 —— 而排查时最需要的恰恰是「哪些过了、哪些没过」的全貌。
 *
 * 用法：
 *   node tools/run-tests.js             # 全部
 *   node tools/run-tests.js log         # 只跑文件名含 "log" 的
 *
 * 退出码：全部通过 0，否则 1。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.resolve(__dirname, '..', 'test');
const filter = process.argv[2] || '';

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : 'test/ 下没有测试文件');
  process.exit(1);
}

const rows = [];
let totalPass = 0;
let totalAll = 0;

/**
 * 单文件超时（毫秒）。
 *
 * 测试是子进程跑的，一个文件里的死循环（while 等 IPC 回来、rAF 没被泵）
 * 会把整轮 run-tests 挂死 —— 而且因为汇总表还没打印，你连「卡在哪个文件」都看不出来。
 * 超时按「最慢的现有文件（约 2.8s）再留 4 倍余量」取 15s：够宽裕，又能在可接受的时间内
 * 把「卡死」变成「明确指出哪个文件卡死」。
 */
const PER_FILE_TIMEOUT_MS = 15000;

for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(TEST_DIR, f)], {
    encoding: 'utf8',
    timeout: PER_FILE_TIMEOUT_MS,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // spawnSync 超时后 signal 是 SIGTERM，且 stdout 里不会有汇总行 —— 单独点名，别让它伪装成普通失败
  const timedOut = r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT';
  const m = out.match(/通过 (\d+) \/ (\d+)/);
  const pass = timedOut ? 0 : m ? Number(m[1]) : 0;
  const all = timedOut ? 1 : m ? Number(m[2]) : 0;
  totalPass += pass;
  totalAll += all;
  rows.push({
    file: f,
    pass,
    all,
    ok: !timedOut && !!m && pass === all,
    ms: Date.now() - started,
    // 没解析到汇总行 = 脚本本身崩了，把关键几行带出来，省得再跑一次
    crash: timedOut
      ? `超过 ${PER_FILE_TIMEOUT_MS / 1000}s 未结束（多半是死循环或没被泵的 rAF/时钟）`
      : m
        ? ''
        : out.split('\n').filter(Boolean).slice(-4).join('\n        '),
  });
}

const W = Math.max(...rows.map((r) => r.file.length));
console.log('');
for (const r of rows) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(W)}  ${String(r.pass).padStart(3)}/${String(r.all).padEnd(3)}  ${String(r.ms).padStart(5)}ms`
  );
  if (r.crash) console.log(`        崩溃输出：\n        ${r.crash}`);
}
console.log('-'.repeat(W + 22));
console.log(`合计 ${totalPass} / ${totalAll}${totalPass === totalAll ? '   全部通过' : '   ★ 有失败'}`);
process.exit(totalPass === totalAll ? 0 : 1);
