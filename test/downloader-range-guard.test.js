/**
 * 断点续传的响应校验（P0-1）
 *
 * 复现的缺陷：发过 `Range: bytes=<start>-` 之后只看 `!res.ok && res.status !== 206`。
 * 服务端或中间代理忽略 Range、回 `200` + **整份文件**时，代码把它当成续传，
 * 以追加模式写在第 start 字节之后 —— 得到一个「内容重复」的损坏文件
 * （能打开、播到一半又从开头开始），并且计为成功。
 *
 * 这里用假 fetch 精确控制三种响应（206 / 200 / 416），断言三件事：
 *   ① 校验通过时才追加，内容与远端逐字节一致；
 *   ② 校验不通过时**丢弃旧前缀**从 0 重下，不留下重复内容；
 *   ③ 统计口径正确（bytes 不因重下而重复累加，done 只加一）。
 *
 * 跑法：node test/downloader-range-guard.test.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { Downloader } = require('../src/main/core/downloader');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 假 fetch ------------------------------ */

/** 大小写不敏感的 headers.get（WHATWG Headers 的最小替身） */
function fakeHeaders(map = {}) {
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(map)) lower[String(k).toLowerCase()] = v;
  return {
    get(name) {
      const v = lower[String(name).toLowerCase()];
      return v === undefined ? null : String(v);
    },
  };
}

function toArrayBuffer(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * 造一个「一次读完的 WHATWG 流」。
 *
 * 为什么不用 `body: null` 的退化路径：真机上 Electron 的 ses.fetch 返回的是
 * WHATWG 流（见 src/main/core/downloader.js 的注释），走的是 getReader() 那条分支；
 * 用流才能覆盖真正在跑的那条代码路（包括 stats.bytes 的累加）。
 */
function bodyOf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  return new ReadableStream({
    start(controller) {
      if (buf.length) controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

/**
 * 造一个响应。
 */
function makeRes({ status, bytes = '', headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://cdn.example.com/x',
    headers: fakeHeaders(headers),
    body: bodyOf(bytes),
    arrayBuffer: async () => toArrayBuffer(bytes),
    text: async () => String(bytes),
  };
}

/**
 * 按「HEAD 探测 + GET（可能带 Range）」两段逻辑造一个假 fetch。
 * @param {object} spec
 * @param {number} spec.total            远端文件总长度
 * @param {Buffer} spec.full             远端文件内容
 * @param {Function} spec.onGet          (rangeHeader|null) => 响应
 */
function makeFetch({ full, onGet }) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    if (method === 'HEAD') {
      calls.push({ method, range: headers.Range || null });
      return makeRes({ status: 200, headers: { 'content-length': full.length } });
    }
    calls.push({ method, range: headers.Range || null });
    return onGet(headers.Range || null);
  };
  impl.calls = calls;
  return impl;
}

/* ------------------------------ 测试装置 ------------------------------ */

const FULL = Buffer.from('0123456789ABCDEFGHIJ', 'utf8'); // 20 字节
const prefix = (n) => FULL.subarray(0, n);

let tmpRoot = '';

function newDir(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 造一个「上次会话已经写了 n 字节」的下载器。
 * `_written` 是会话内的集合：只有本次会话写过的文件才允许 Range 续传，
 * 所以这里要手动登记，模拟「同一个下载器、同一个文件、断线重来」。
 */
function resumable({ fetchImpl, dest, existingBytes, logger }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, prefix(existingBytes));
  const dl = new Downloader({
    fetchImpl,
    concurrency: 1,
    maxRetry: 0,
    skipExisting: true,
    logger: logger || (() => {}),
  });
  dl._written.add(dest);
  return dl;
}

const taskOf = (dest) => ({ url: 'https://cdn.example.com/x.jpg', dest, kind: 'image' });

/* -------------------------------- 用例 -------------------------------- */

section('206：真续传');

t('206 且 Content-Range 起点正确时追加写入，内容与远端逐字节一致', async () => {
  const dest = path.join(newDir('ok206'), 'a.jpg');
  const logs = [];
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: (range) =>
      range
        ? makeRes({
            status: 206,
            bytes: FULL.subarray(5),
            headers: { 'content-range': `bytes 5-19/${FULL.length}` },
          })
        : makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5, logger: (m) => logs.push(m) });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL, '续传结果必须与远端完全一致');
  assert.strictEqual(dl.stats.done, 1);
  assert.strictEqual(dl.stats.bytes, FULL.length - 5, 'bytes 只应统计本次真正写入的字节');
  assert.ok(!logs.some((m) => /不支持断点续传/.test(m)), '正常续传不该出现重下提示');
  assert.strictEqual(fetchImpl.calls.filter((c) => c.method === 'GET')[0].range, 'bytes=5-');
});

section('200：服务端忽略 Range（P0-1 的原始缺陷）');

t('服务端回 200 + 整份文件时丢弃旧前缀从头重下，不会写出重复内容', async () => {
  const dest = path.join(newDir('ignore200'), 'a.jpg');
  const logs = [];
  const fetchImpl = makeFetch({
    full: FULL,
    // 无论有没有 Range，都回 200 + 整份 —— 典型的 CDN/代理行为
    onGet: () => makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5, logger: (m) => logs.push(m) });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  const got = await fsp.readFile(dest);
  assert.deepStrictEqual(
    got,
    FULL,
    `文件应为 ${FULL.length} 字节；若出现 ${got.length} 字节说明旧前缀被保留成了重复内容`
  );
  assert.strictEqual(dl.stats.done, 1);
  assert.strictEqual(dl.stats.bytes, FULL.length, '重下只写一次，不该把旧前缀也算进 bytes');
  assert.ok(
    logs.some((m) => /服务端不支持断点续传/.test(m) && /已从头重下/.test(m)),
    `应提示已从头重下，实际日志：\n${logs.join('\n')}`
  );
});

t('重下时确实不带 Range（否则又会绕回同一个坑）', async () => {
  const dest = path.join(newDir('ignore200-range'), 'a.jpg');
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: () => makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5 });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  const gets = fetchImpl.calls.filter((c) => c.method === 'GET');
  assert.strictEqual(gets.length, 2, '应该是「先试续传、失败后重下一次」两次 GET');
  assert.strictEqual(gets[0].range, 'bytes=5-', '第一次应带 Range');
  assert.strictEqual(gets[1].range, null, '第二次必须不带 Range，从头下');
});

section('206 但区间对不上');

t('Content-Range 起点与本地已有字节数不一致时，按「从头重下」处理', async () => {
  const dest = path.join(newDir('badrange'), 'a.jpg');
  const logs = [];
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: (range) =>
      range
        ? // 服务端错误地从 0 开始给（或被中间层改写），若直接追加就会重复
          makeRes({
            status: 206,
            bytes: FULL,
            headers: { 'content-range': `bytes 0-19/${FULL.length}` },
          })
        : makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5, logger: (m) => logs.push(m) });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL);
  assert.strictEqual(dl.stats.bytes, FULL.length);
  assert.ok(
    logs.some((m) => /Content-Range 起点 0 与本地已有 5 不一致/.test(m)),
    `日志应说清是谁对不上，实际：\n${logs.join('\n')}`
  );
});

t('206 但没有 Content-Range 时无法确认，宁可整份重下', async () => {
  const dest = path.join(newDir('norc'), 'a.jpg');
  const logs = [];
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: (range) =>
      range
        ? makeRes({ status: 206, bytes: FULL.subarray(5) }) // 没有 content-range
        : makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5, logger: (m) => logs.push(m) });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL);
  assert.ok(
    logs.some((m) => /Content-Range 起点 缺失/.test(m)),
    `应说明 Content-Range 缺失，实际：\n${logs.join('\n')}`
  );
});

section('416：本地文件与远端不一致');

t('416 时删除本地文件并从头重下，而不是直接判失败', async () => {
  const dest = path.join(newDir('r416'), 'a.jpg');
  const logs = [];
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: (range) =>
      range
        ? makeRes({ status: 416, headers: { 'content-range': `bytes */${FULL.length}` } })
        : makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = resumable({ fetchImpl, dest, existingBytes: 5, logger: (m) => logs.push(m) });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL);
  assert.strictEqual(dl.stats.done, 1);
  assert.strictEqual(dl.stats.failed, 0);
  assert.ok(logs.some((m) => /416/.test(m)), `日志应点明 416，实际：\n${logs.join('\n')}`);
});

section('不能破坏既有行为');

t('全新下载（无本地文件）不发 Range，一次 200 即完成', async () => {
  const dest = path.join(newDir('fresh'), 'a.jpg');
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: () => makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } }),
  });
  const dl = new Downloader({ fetchImpl, concurrency: 1, maxRetry: 0, logger: () => {} });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL);
  const gets = fetchImpl.calls.filter((c) => c.method === 'GET');
  assert.strictEqual(gets.length, 1);
  assert.strictEqual(gets[0].range, null);
  assert.strictEqual(dl.stats.done, 1);
});

t('空响应体仍判失败，且不留下空文件（旧行为）', async () => {
  const dest = path.join(newDir('empty'), 'a.jpg');
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: () => makeRes({ status: 200, bytes: '', headers: { 'content-length': 0 } }),
  });
  const dl = new Downloader({ fetchImpl, concurrency: 1, maxRetry: 0, logger: () => {} });

  await assert.rejects(
    () => dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest)),
    /下载结果为空/
  );
  assert.strictEqual(fs.existsSync(dest), false, '没写进任何字节时不该留下空文件');
  assert.strictEqual(dl.stats.done, 0);
});

/**
 * 退化分支：响应只有 `arrayBuffer()`、没有可读的 body 流。
 *
 * 真机上少见（Electron 的 ses.fetch 一般都给 WHATWG 流），但一旦发生就必须按真实
 * 字节数记账。早先这条分支只顾着写盘，`stats.bytes` 不涨、进度也不报 ——
 * 表现是「界面上的总字节数少了几个文件」且进度条全程不动，看起来像卡死。
 */
t('无 body 但有 arrayBuffer 的响应仍计入 stats.bytes 并至少上报一次进度', async () => {
  const dest = path.join(newDir('nobody'), 'a.jpg');
  const events = [];
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: () => {
      const res = makeRes({ status: 200, bytes: FULL, headers: { 'content-length': FULL.length } });
      res.body = null; // 只有 arrayBuffer() 可用
      return res;
    },
  });
  const dl = new Downloader({
    fetchImpl,
    concurrency: 1,
    maxRetry: 0,
    logger: () => {},
    onProgress: (e) => events.push(e),
  });

  await dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest));

  assert.deepStrictEqual(await fsp.readFile(dest), FULL, '内容必须完整落盘');
  assert.strictEqual(dl.stats.bytes, FULL.length, '退化分支同样要把字节数记进 stats.bytes');
  const progress = events.filter((e) => e.event === 'progress');
  assert.ok(progress.length >= 1, '至少要上报一次进度，否则进度条全程不动');
  assert.strictEqual(progress[progress.length - 1].written, FULL.length, '最后一次进度应是完整长度');
  assert.strictEqual(dl.stats.done, 1);
});

t('404 仍是永久失败（不应被续传校验吞掉）', async () => {  const dest = path.join(newDir('e404'), 'a.jpg');
  const fetchImpl = makeFetch({
    full: FULL,
    onGet: () => makeRes({ status: 404 }),
  });
  const dl = new Downloader({ fetchImpl, concurrency: 1, maxRetry: 0, logger: () => {} });

  await assert.rejects(
    () => dl._downloadFrom('https://cdn.example.com/x.jpg', taskOf(dest)),
    (err) => err.fatal === true && /404/.test(err.message)
  );
});

section('P1-8：停止时未执行的任务不计为失败');

t('停止时正在冷却中的任务、以及队列里剩下的任务，都计入 aborted', async () => {
  const dir = newDir('aborted');
  const logs = [];
  const events = [];
  const dl = new Downloader({
    concurrency: 1,
    logger: (m) => logs.push(m),
    onProgress: (e) => events.push(e),
    fetchImpl: async () => {
      throw new Error('停止后不该再发请求');
    },
  });
  const t1 = { url: 'https://cdn.example.com/a.jpg', dest: path.join(dir, 'a.jpg'), kind: 'image' };
  const t2 = { url: 'https://cdn.example.com/b.jpg', dest: path.join(dir, 'b.jpg'), kind: 'image' };
  dl.push(t1);
  dl.push(t2);
  // 让第一个任务卡在主机冷却里，好在「已经取到任务、但一个字节都没下」的状态下按停止
  dl._hostState.set('cdn.example.com', { times: [], until: Date.now() + 500, lastLogAt: 0 });

  const running = dl.run();
  await sleep(80);
  dl.stop();
  const stats = await running;

  assert.strictEqual(stats.failed, 0, `停止不该产生任何「失败」，实际 ${stats.failed}`);
  assert.strictEqual(stats.aborted, 2, `两个都没执行，aborted 应为 2，实际 ${stats.aborted}`);
  assert.strictEqual(stats.done, 0);
  assert.ok(
    logs.some((m) => /已停止，未执行的 2 个文件未下载/.test(m)),
    `应汇总说明有几个没下，实际日志：\n${logs.join('\n')}`
  );
  assert.ok(
    !logs.some((m) => /失败：/.test(m)),
    `停止动作不该污染失败日志，实际：\n${logs.join('\n')}`
  );
  assert.strictEqual(
    events.filter((e) => e.event === 'fail').length,
    0,
    '界面失败明细不应被停止动作污染'
  );
});

t('真失败仍照旧计入 failed（停止与失败必须分得开）', async () => {
  const dir = newDir('real-fail');
  const logs = [];
  const dl = new Downloader({
    concurrency: 1,
    maxRetry: 0,
    logger: (m) => logs.push(m),
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  dl.push({ url: 'https://cdn.example.com/a.jpg', dest: path.join(dir, 'a.jpg'), kind: 'image' });
  const stats = await dl.run();

  assert.strictEqual(stats.failed, 1);
  assert.strictEqual(stats.aborted, 0);
  assert.ok(logs.some((m) => /失败：a\.jpg/.test(m)));
});

/* -------------------------------- 运行 -------------------------------- */

(async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-range-'));
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
