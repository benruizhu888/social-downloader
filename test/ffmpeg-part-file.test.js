/**
 * 转 MOV 的半成品文件（P0-3）
 *
 * 复现的缺陷：`convertToMOV` 直接把目标路径交给 ffmpeg。中途失败 / 被 kill
 * （用户按停止、进程被杀、ffmpeg 自己崩）都会留下一个**半截的 .mov**；
 * 下一轮 runner 用 `exists(movDest)` 判断「已转过」→ 跳过；
 * Live 图更惨，连源视频都不会再下载（用户永远得不到能播的 mov）。
 *
 * 修法：先写 `<output>.part-<pid>-<ts>`，成功才 rename；任何失败路径都删半成品。
 * 这里用打桩的 `child_process.spawn` 精确控制 ffmpeg 的行为（成功 / 失败 / 被 kill），
 * 不依赖机器上真的装了 ffmpeg，也不会真的跑转码。
 *
 * ⚠️ 打桩必须在 require ffmpeg 模块**之前**：ffmpeg.js 在模块顶层做了
 *    `const { execFile, spawn } = require('child_process')`，之后再改就无效了。
 *
 * 跑法：node test/ffmpeg-part-file.test.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- 打桩 child_process --------------------------- */

/** 每次 spawn 的行为由它决定；测试里逐条替换 */
let plan = () => ({ code: 0, write: 'MOV', delay: 0 });
/** 记录每次调用，用来断言「ffmpeg 拿到的是半成品名，不是最终目标名」 */
let calls = [];

cp.spawn = (bin, args, opts = {}) => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  const out = args[args.length - 1];
  const p = plan({ bin, args, out, opts }) || {};
  calls.push({ bin, args, out });
  setTimeout(async () => {
    try {
      if (p.write !== null && p.write !== undefined) await fsp.writeFile(out, p.write);
    } catch (err) {
      child.emit('error', err);
      return;
    }
    child.stderr.emit('data', Buffer.from('模拟的 ffmpeg 报错'));
    // 被 kill 的进程没有正常退出码（null），runFFmpeg 会当成失败
    child.emit('close', child.killed ? null : p.code === undefined ? 0 : p.code);
  }, p.delay || 0);
  return child;
};

const { convertToMOV } = require('../src/main/core/ffmpeg');

/* -------------------------------- 工具 -------------------------------- */

let tmpRoot = '';

function newDir(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 目录里残留的半成品文件（正常情况下应该一个都没有） */
async function partFiles(dir) {
  const list = await fsp.readdir(dir);
  return list.filter((f) => f.includes('.part-'));
}

const INPUT = 'in.mp4';

function setup(tag) {
  const dir = newDir(tag);
  fs.writeFileSync(path.join(dir, INPUT), 'SRC');
  return { dir, input: path.join(dir, INPUT), output: path.join(dir, 'out.mov') };
}

/* -------------------------------- 用例 -------------------------------- */

section('成功路径');

t('成功后产出目标文件，且 ffmpeg 写的是半成品名', async () => {
  const { dir, input, output } = setup('ok');
  plan = () => ({ code: 0, write: 'MOVDATA' });
  calls = [];

  const r = await convertToMOV({ input, output, ffmpegBin: 'fake-ffmpeg' });

  assert.deepStrictEqual(r, { mode: 'copy' }, '返回结构必须保持兼容（调用方只用 mode）');
  assert.strictEqual(await fsp.readFile(output, 'utf8'), 'MOVDATA');
  assert.strictEqual(calls.length, 1);
  assert.notStrictEqual(calls[0].out, output, 'ffmpeg 绝不能直接写最终目标（失败会留下半截文件）');
  assert.ok(
    calls[0].out.startsWith(`${output}.part-`),
    `应先写半成品：实际写的是 ${calls[0].out}`
  );
  assert.deepStrictEqual(await partFiles(dir), [], '成功后不该留下半成品');
});

t('封装失败回落到重编码，成功后同样只剩目标文件', async () => {
  const { dir, input, output } = setup('copy-fail-encode-ok');
  // 带 libx264 的那次是重编码：成功；其余（-c:v copy）失败
  plan = ({ args }) => (args.includes('libx264') ? { code: 0, write: 'ENCODED' } : { code: 1, write: 'PARTIAL' });

  const r = await convertToMOV({ input, output, ffmpegBin: 'fake-ffmpeg' });

  assert.deepStrictEqual(r, { mode: 'encode' });
  assert.strictEqual(await fsp.readFile(output, 'utf8'), 'ENCODED');
  assert.deepStrictEqual(await partFiles(dir), [], '回落路径也不能留半成品');
});

section('失败路径');

t('两次都失败时抛错，也不留下任何目标文件或半成品（原始缺陷）', async () => {
  const { dir, input, output } = setup('both-fail');
  // 每次都在写了一段之后才失败 —— 最接近真机上「被 kill / 中途崩」的形态
  plan = () => ({ code: 1, write: 'HALF' });

  await assert.rejects(
    () => convertToMOV({ input, output, ffmpegBin: 'fake-ffmpeg' }),
    /ffmpeg 退出码 1/,
    '应以 ffmpeg 失败结束'
  );

  assert.strictEqual(fs.existsSync(output), false, `目标文件不该存在（否则下一轮会被判为「已转过」）`);
  assert.deepStrictEqual(await partFiles(dir), [], '失败后必须删掉半成品');
});

t('被停止（kill）时同样不留下目标文件', async () => {
  const { dir, input, output } = setup('killed');
  plan = () => ({ code: 0, write: 'HALF', delay: 80 });
  const ac = new AbortController();

  // 用 reencode:true 把尝试次数收敛到一次：否则「封装失败 → 回落重编码」
  // 会再起一个进程，而 signal 已经 abort（事件不会重放），第二次会正常跑完
  const running = convertToMOV({ input, output, reencode: true, ffmpegBin: 'fake-ffmpeg', signal: ac.signal });
  setTimeout(() => ac.abort(), 20);

  await assert.rejects(running);
  assert.strictEqual(fs.existsSync(output), false);
  assert.deepStrictEqual(await partFiles(dir), [], '被 kill 后也要清理半成品');
});

t('转换失败不能损坏上一轮已成功的目标文件', async () => {
  const { input, output } = setup('keep-old');
  fs.writeFileSync(output, 'GOOD');
  plan = () => ({ code: 1, write: 'HALF' });

  await assert.rejects(() => convertToMOV({ input, output, ffmpegBin: 'fake-ffmpeg' }));
  assert.strictEqual(await fsp.readFile(output, 'utf8'), 'GOOD', '好文件不该被半成品覆盖');
});

section('参数与兼容性');

t('reencode=true 时只走重编码一次，mode 为 encode', async () => {
  const { input, output } = setup('reencode');
  plan = () => ({ code: 0, write: 'ENCODED' });
  calls = [];

  const r = await convertToMOV({ input, output, reencode: true, ffmpegBin: 'fake-ffmpeg' });

  assert.deepStrictEqual(r, { mode: 'encode' });
  assert.strictEqual(calls.length, 1, '强制重编码不该先试无损封装');
  assert.ok(calls[0].args.includes('libx264'), '应带重编码参数');
});

t('带 contentId 时元数据参数仍完整（没被半成品改造碰掉）', async () => {
  const { input, output } = setup('meta');
  plan = () => ({ code: 0, write: 'MOV' });
  calls = [];

  await convertToMOV({ input, output, contentId: 'ABC-123', ffmpegBin: 'fake-ffmpeg' });

  const args = calls[0].args;
  assert.ok(args.includes('com.apple.quicktime.content.identifier=ABC-123'), '应写入 Live Photo 内容标识');
  assert.ok(args.includes('+faststart+use_metadata_tags'), '应启用 use_metadata_tags');
  assert.strictEqual(args[args.length - 1].startsWith(`${output}.part-`), true);
});

/* -------------------------------- 运行 -------------------------------- */

(async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-part-'));
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
