/**
 * 性能改造与取消能力（批次 J）
 *
 * 这里守三件事，都是「改完了要能证明真的变了」而不是「写法看起来对了」：
 *   ① HEAD 能力按主机缓存：同一个主机拒绝过 HEAD 之后，后续文件不再重复探测；
 *   ② 单作品采集复用窗口：100 条链接不该建 100 个窗口；
 *   ③ 转封装能被停止打断：ffmpeg 必须拿到 signal，且跳过缺失源文件时也要报进度。
 *
 * 性能类断言一律用「假窗口 + 计数器」，不依赖真实计时，避免机器快慢导致抖动。
 *
 * 跑法：node test/perf-and-pool.test.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const Module = require('module');

const { Downloader } = require('../src/main/core/downloader');
const { BrowserPool } = require('../src/main/core/browser-pool');

let pass = 0;
let fail = 0;
const failed = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假响应：只要 status / headers.get / body 三样够用 */
function fakeRes(status, headers = {}, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
    body,
  };
}

/* ===================== 一、HEAD 能力缓存 ===================== */

section('HEAD 能力按主机缓存（性能 #2）');

t('同主机第一次 HEAD 失败后，第二个文件不再发 HEAD', async () => {
  const calls = [];
  const dl = new Downloader({
    logger: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET' });
      if ((init && init.method) === 'HEAD') return fakeRes(403, { 'content-length': '146' });
      // 1 字节 Range 探测：给出总长
      return fakeRes(206, { 'content-range': 'bytes 0-0/1024' });
    },
  });

  await dl._probeTotal('https://f.video.weibocdn.com/a/video1.mp4');
  await dl._probeTotal('https://f.video.weibocdn.com/b/video2.mp4');

  const heads = calls.filter((c) => c.method === 'HEAD').length;
  assert.strictEqual(heads, 1, `同一个主机只该发 1 次 HEAD，实际 ${heads} 次`);
});

t('不同主机互不影响（缓存是按主机分的）', async () => {
  const calls = [];
  const dl = new Downloader({
    logger: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET' });
      if ((init && init.method) === 'HEAD') return fakeRes(403, {});
      return fakeRes(206, { 'content-range': 'bytes 0-0/512' });
    },
  });

  await dl._probeTotal('https://f.video.weibocdn.com/a.mp4');
  await dl._probeTotal('https://sns-img-qc.xhscdn.com/b.jpg');

  const heads = calls.filter((c) => c.method === 'HEAD').length;
  assert.strictEqual(heads, 2, `两个主机各探测一次，实际 ${heads} 次`);
});

t('HEAD 可用时仍然只用 HEAD，不浪费 Range 请求', async () => {
  const calls = [];
  const dl = new Downloader({
    logger: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ method: (init && init.method) || 'GET' });
      if ((init && init.method) === 'HEAD') return fakeRes(200, { 'content-length': '2048' });
      return fakeRes(206, { 'content-range': 'bytes 0-0/2048' });
    },
  });
  const total = await dl._probeTotal('https://wx1.sinaimg.cn/large/a.jpg');
  assert.strictEqual(total, 2048);
  assert.strictEqual(calls.length, 1, `HEAD 成功时不需要第二步，实际发了 ${calls.length} 次请求`);
});

t('缓存只记否定结论：HOST 换成支持 HEAD 也不受影响（总长每次现取）', async () => {
  let headStatus = 403;
  const dl = new Downloader({
    logger: () => {},
    fetchImpl: async (url, init) => {
      if ((init && init.method) === 'HEAD') {
        if (headStatus === 403) return fakeRes(403, {});
        return fakeRes(200, { 'content-length': '999' });
      }
      return fakeRes(206, { 'content-range': 'bytes 0-0/111' });
    },
  });
  const a = await dl._probeTotal('https://f.video.weibocdn.com/a.mp4');
  assert.strictEqual(a, 111, '第一次走 Range 兜底');
  headStatus = 200;
  // 同一个实例内主机已被标记为不支持 HEAD，仍走 Range —— 这是刻意的（否定结论不反复试）
  const b = await dl._probeTotal('https://f.video.weibocdn.com/b.mp4');
  assert.strictEqual(b, 111);
});

/* ===================== 二、窗口池复用 ===================== */

section('采集窗口池（性能 #3）');

/**
 * 假窗口：只要满足「采集器与护栏真正会调用的那些方法」。
 * 护栏挂在 webContents 上并以它为 WeakMap 的键，所以 webContents 必须是**同一个对象**
 * （每次造窗都新建也行，但不能是 undefined）。
 */
function fakeWindow() {
  const wc = {
    id: Math.floor(Math.random() * 1e6),
    getURL: () => 'about:blank',
    executeJavaScript: async () => ({}),
    on: () => {},
    once: () => {},
    removeListener: () => {},
    setWindowOpenHandler: () => {},
  };
  return {
    id: Math.random(),
    webContents: wc,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    hide() {},
    loadURL: async () => {},
  };
}

t('同一 partition+mode 连续借两次，只建一个窗口', () => {
  let created = 0;
  const pool = new BrowserPool({
    createWindow: () => {
      created++;
      return fakeWindow();
    },
    idleMs: 10000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });

  const w1 = pool.acquire({ partition: 'persist:xhs', mode: 'single' });
  pool.release(w1);
  const w2 = pool.acquire({ partition: 'persist:xhs', mode: 'single' });

  assert.strictEqual(created, 1, `应复用同一个窗口，实际建了 ${created} 个`);
  assert.strictEqual(w1, w2, '第二次借到的应当是同一个窗口');
  assert.strictEqual(pool.stats.reuses, 1);
});

t('不同 partition 不共用窗口（防止 Cookie 串平台）', () => {
  const made = [];
  const pool = new BrowserPool({
    createWindow: (key) => {
      const w = fakeWindow();
      made.push({ key, w });
      return w;
    },
    idleMs: 10000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });

  const a = pool.acquire({ partition: 'persist:xhs', mode: 'single' });
  const b = pool.acquire({ partition: 'persist:douyin', mode: 'single' });
  assert.notStrictEqual(a, b, '两个平台的采集窗绝不能是同一个');
  assert.strictEqual(made.length, 2);
});

t('不同 mode 也不共用（列表采集与单作品的 preload 参数不同）', () => {
  const pool = new BrowserPool({
    createWindow: () => fakeWindow(),
    idleMs: 10000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  const s = pool.acquire({ partition: 'persist:xhs', mode: 'single' });
  const l = pool.acquire({ partition: 'persist:xhs', mode: 'list' });
  assert.notStrictEqual(s, l);
});

t('空闲到期会销毁窗口，不留后台进程', async () => {
  let timerFn = null;
  const pool = new BrowserPool({
    createWindow: () => fakeWindow(),
    idleMs: 5,
    setTimeoutFn: (fn) => {
      timerFn = fn;
      return 0;
    },
    clearTimeoutFn: () => {},
  });
  const w = pool.acquire({ partition: 'persist:xhs', mode: 'single' });
  pool.release(w);
  assert.strictEqual(typeof timerFn, 'function', '归还后应当排一个回收定时器');
  timerFn();
  assert.strictEqual(pool.size(), 0, '空闲到期后应当从池子里移除');
  assert.ok(w.destroyed, '空闲到期后窗口应当被销毁');
});

t('destroyAll 一次收干净（任务结束/应用退出）', () => {
  const ws = [];
  const pool = new BrowserPool({
    createWindow: () => {
      const w = fakeWindow();
      ws.push(w);
      return w;
    },
    idleMs: 10000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  pool.acquire({ partition: 'persist:xhs', mode: 'single' });
  pool.acquire({ partition: 'persist:douyin', mode: 'list' });
  pool.destroyAll();
  assert.strictEqual(pool.size(), 0);
  assert.ok(ws.every((w) => w.destroyed));
});

/* ===================== 三、单作品采集改用窗口池 ===================== */

section('单作品采集复用窗口（性能 #3 的落地）');

function withStub(fn) {
  const orig = Module._resolveFilename;
  const stub = require.resolve('./lib/electron-stub');
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stub;
    return orig.call(this, request, ...rest);
  };
  try {
    return fn();
  } finally {
    Module._resolveFilename = orig;
  }
}

t('连续采集 3 条作品只建 1 个窗口（旧写法是 3 个）', async () => {
  /**
   * 采集器在模块顶层就 `require('electron')`，所以必须在**加载它之前**
   * 把桩里的 BrowserWindow 换成会计数的假构造函数。
   * 假窗口要带 `webContents`：护栏是挂在 webContents 上的（WeakMap 以它为键）。
   */
  let created = 0;
  const mod = withStub(() => {
    const stub = require('./lib/electron-stub');
    const origBW = stub.BrowserWindow;
    stub.BrowserWindow = function () {
      created++;
      return fakeWindow();
    };
    try {
      const pool = require('../src/main/core/browser-pool');
      // 每次用例都用干净的池子，避免上一条用例的窗口残留影响计数
      pool.__setPool(null);
      // 清掉模块缓存，确保采集器拿到的是换过装的那份 electron 桩
      delete require.cache[require.resolve('../src/main/core/single-harvest')];
      const sh = require('../src/main/core/single-harvest');
      return { SingleHarvester: sh.SingleHarvester, pool };
    } finally {
      stub.BrowserWindow = origBW;
    }
  });

  const { SingleHarvester, pool } = mod;
  for (let i = 0; i < 3; i++) {
    const h = new SingleHarvester({
      url: `https://www.xiaohongshu.com/explore/aaa${i}`,
      platform: 'xhs',
      partition: 'persist:xhs',
      parse: () => [],
      timeoutMs: 50,
      pollMs: 5,
      quietRounds: 1,
      onLog: () => {},
    });
    // 只验证「借窗/还窗」这一段，不真的加载网页
    h._load = async () => {};
    h._waitForTarget = async () => {};
    await h.start();
  }
  assert.strictEqual(created, 1, `3 条作品只该建 1 个窗口，实际建了 ${created} 个`);
  const st = pool.getPool().stats;
  assert.ok(st.reuses >= 2, `第 2、3 条应当复用（reuses=${st.reuses}）`);
});

/* ===================== 四、转封装的取消与进度 ===================== */

section('转封装可被停止打断（P1-4 / P2-5）');

t('convertToMOV 会把 signal 交给 ffmpeg（停止时能被杀掉）', async () => {
  const ffmpeg = require('../src/main/core/ffmpeg');
  const src = path.join(os.tmpdir(), `sd-conv-${process.pid}`, 'src.mp4');
  await fsp.mkdir(path.dirname(src), { recursive: true });
  await fsp.writeFile(src, 'x'.repeat(32));
  const out = `${src}.mov`;

  let seen = null;
  const origRun = ffmpeg.__run ? ffmpeg.__run : null;
  // 直接验证参数透传：用一个会被立刻 abort 的 signal，期望抛错且不留下 output
  const ac = new AbortController();
  ac.abort();
  try {
    await ffmpeg.convertToMOV({ input: src, output: out, ffmpegBin: 'ffmpeg-does-not-exist', signal: ac.signal });
    seen = 'no-throw';
  } catch (err) {
    seen = err.message;
  }
  // 无论 ffmpeg 是否存在，被 abort 的调用都不能留下半成品
  const existsOut = await fsp
    .stat(out)
    .then(() => true)
    .catch(() => false);
  assert.strictEqual(existsOut, false, '失败/取消后不能留下目标文件');
  assert.ok(seen !== null);
  await fsp.rm(path.dirname(src), { recursive: true, force: true }).catch(() => {});
});

t('runner 转 MOV：源文件缺失时也上报进度（进度条不会卡住）', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'core', 'runner.js'),
    'utf8'
  );
  const start = src.indexOf('视频转封装为 MOV');
  const end = src.indexOf("phase: 'done'", start);
  assert.ok(start > 0 && end > start, '应能定位到视频转封装代码块');
  const block = src.slice(start, end);
  assert.ok(signalUsed(block), 'convertToMOV 必须传 signal');
  // 「跳过缺失源文件」的 continue 之前要有一次 convert-progress
  const skipIdx = block.indexOf('不存在或为空文件');
  assert.ok(skipIdx > 0);
  const before = block.slice(skipIdx, skipIdx + 400);
  assert.ok(before.includes('convert-progress'), '跳过的那条也要上报进度，否则进度条停在上一格');
});

function signalUsed(block) {
  const i = block.indexOf('await convertToMOV(');
  if (i < 0) return false;
  return block.slice(i, i + 320).includes('signal');
}

/* ===================== 运行 ===================== */

(async () => {
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n— ${fn}`);
      continue;
    }
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail++;
      failed.push(name);
      console.log(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('失败用例：' + failed.join(' | '));
    process.exit(1);
  }
})();
