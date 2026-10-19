/**
 * 作品落盘目录的命名与边界（P0-2 / P1-12）
 *
 * 复现的缺陷：目录名是 `${date}_${标题}_${id}` 再整体 `slice(0,60)`。
 * 标题一长，末尾的 id 就被截掉 → 同一天、同文案的两篇作品共用同一个目录 →
 * 目标路径完全相同 → 被 `taskMap` 当成重复任务去重 → **整条作品的媒体一个都没下**，
 * 日志里连一条失败都看不到（用户只会觉得「软件漏了东西」）。
 * 兜底分支 `|| String(item.id)` 还没过滤，`id = '..'` 能把文件写到上级目录。
 *
 * 顺带覆盖 P0-3 的 runner 一侧：`exists(movDest)` 会把 0 字节的半截 mov
 * 当成「已转过」，导致 Live 图连源视频都不再下载。
 *
 * 跑法：node test/runner-folder-naming.test.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { TaskRunner, safeName, assertInside } = require('../src/main/core/runner');

let pass = 0;
let fail = 0;
const failed = [];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

/* --------------------------- 假 fetch（只为下载） --------------------------- */

const BYTES = Buffer.from('JPEGDATA-0123456789', 'utf8');

function bodyOf(buf) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(buf));
      c.close();
    },
  });
}

function headers(map) {
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = String(v);
  return { get: (n) => (lower[String(n).toLowerCase()] ?? null) };
}

/** 所有地址都回同一份字节，长度固定 —— 够用来验证「有没有落盘」 */
async function fakeFetch(url, opts = {}) {
  if ((opts.method || 'GET').toUpperCase() === 'HEAD') {
    return { ok: true, status: 200, headers: headers({ 'content-length': BYTES.length }), body: null };
  }
  return {
    ok: true,
    status: 200,
    url,
    headers: headers({ 'content-length': BYTES.length }),
    body: bodyOf(BYTES),
    arrayBuffer: async () => BYTES,
  };
}

/* -------------------------------- 工具 -------------------------------- */

let tmpRoot = '';

function newOutDir(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRunner({ fetchImpl = fakeFetch } = {}) {
  const logs = [];
  const events = [];
  const runner = new TaskRunner({
    adapter: { id: 'weibo', name: '微博', referer: 'https://weibo.com/' },
    ctx: { fetchImpl },
    emit: (e) => {
      events.push(e);
      if (e.type === 'log') logs.push(e.message);
    },
    getSettings: () => ({}),
  });
  return { runner, logs, events };
}

const imageItem = (id, folderTitle, dateHint = '2024-05-01') => ({
  id,
  title: folderTitle,
  folderTitle,
  dateHint,
  medias: [{ kind: 'image', url: 'https://cdn.example.com/a.jpg', ext: 'jpg' }],
});

/** 递归列出目录下的文件（相对路径，排序后便于断言） */
async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const list = await fsp.readdir(dir, { withFileTypes: true });
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

/* -------------------------------- 用例 -------------------------------- */

section('目录名：id 必须前置且完整');

t('长标题 + 同一天的两篇作品必须落在不同目录（否则整条作品会被去重丢掉）', async () => {
  const outDir = newOutDir('long-title');
  // 长度必须超过旧的 60 字符上限：那才是「id 被截掉」的触发条件
  const title = '今天的天气真不错我们一起去公园散步'.repeat(4);
  assert.ok(title.length > 60, '用例前提：标题本身就超过旧的长度上限');
  const a = imageItem('7000000000000000001', title);
  const b = imageItem('7000000000000000002', title);
  const { runner, events } = makeRunner();

  const result = await runner._downloadItems([a, b], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: true },
  });

  const files = await listFiles(result.rootDir);
  const imgs = files.filter((f) => f.endsWith('img01.jpg'));
  assert.strictEqual(imgs.length, 2, `两篇作品应各下一张图，实际文件：\n${files.join('\n')}`);
  const summary = events.find((e) => e.type === 'summary');
  assert.strictEqual(summary.total, 2, `任务数应为 2（被去重就会变成 1），实际 ${summary && summary.total}`);
});

t('目录名以作品 id 开头，标题只影响自己那一段', async () => {
  const outDir = newOutDir('prefix');
  const longTitle = 'T'.repeat(80);
  const { runner } = makeRunner();

  const result = await runner._downloadItems([imageItem('abc123', longTitle)], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: true },
  });

  const dirs = await fsp.readdir(result.rootDir);
  assert.strictEqual(dirs.length, 1);
  assert.ok(
    dirs[0].startsWith('abc123_2024-05-01'),
    `目录名应以 id 开头（实际：${dirs[0]}）`
  );
  assert.ok(dirs[0].length <= 40 + 1 + 10 + 1 + 40, `标题段应被单独截断（实际 ${dirs[0].length} 字符）`);
});

t('不开「按日期分目录」时目录名是 id + 标题，仍以 id 开头', async () => {
  const outDir = newOutDir('no-date');
  const { runner } = makeRunner();

  const result = await runner._downloadItems([imageItem('item42', '标题')], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: false },
  });

  const dirs = await fsp.readdir(result.rootDir);
  assert.deepStrictEqual(dirs, ['item42_标题']);
});

t('没有标题时目录名就是 id（保持简洁与可读）', async () => {
  const outDir = newOutDir('no-title');
  const { runner } = makeRunner();

  const result = await runner._downloadItems([imageItem('only-id', '')], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: false },
  });

  assert.deepStrictEqual(await fsp.readdir(result.rootDir), ['only-id']);
});

section('目录逃逸（P1-12）');

t('id 为 ".." 时不会写到上级目录，而是落到 unknown 目录', async () => {
  const outDir = newOutDir('dotdot');
  const { runner } = makeRunner();

  const result = await runner._downloadItems([imageItem('..', '')], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: false },
  });

  const files = await listFiles(result.rootDir);
  assert.deepStrictEqual(files, ['unknown/img01.jpg'], `实际落到：\n${files.join('\n')}`);
  // 上级目录（也就是 outDir 本身）里不该多出任何东西
  const upLevel = (await fsp.readdir(outDir)).sort();
  assert.deepStrictEqual(upLevel, ['weibo_batch'], '文件不能被写到保存目录的上级/同级');
});

t('id 里的分隔符被过滤掉，不会形成多级目录', async () => {
  const outDir = newOutDir('slash');
  const { runner } = makeRunner();

  const result = await runner._downloadItems([imageItem('../evil/x', '')], {
    outDir,
    rootId: 'batch',
    merged: { organizeByDate: false },
  });

  const dirs = await fsp.readdir(result.rootDir);
  assert.strictEqual(dirs.length, 1);
  assert.ok(!dirs[0].includes('/') && !dirs[0].includes('\\'), `目录名不能含分隔符：${dirs[0]}`);
  // 落点仍在根目录之下（这才是「没逃逸」的判据；名字里带点本身无害）
  assert.doesNotThrow(() => assertInside(path.resolve(result.rootDir) + path.sep, path.join(result.rootDir, dirs[0], 'img01.jpg'), 'x'));
});

t('assertInside 对越界路径直接抛错（不静默继续）', () => {
  const root = path.resolve(tmpRoot, 'guard-root') + path.sep;
  // 合法：根目录内的子目录
  assert.doesNotThrow(() => assertInside(root, path.join(root, 'a', 'b.jpg'), 'a'));
  // 越界：上级目录
  assert.throws(() => assertInside(root, path.join(root, '..', 'x.jpg'), 'evil'), /目录越界/);
  // 越界：仅前缀相同的**兄弟**目录（guard-root-bc 不是 guard-root 的子目录）
  const sibling = path.join(path.resolve(root), '..', 'guard-root-bc', 'x.jpg');
  assert.throws(() => assertInside(root, sibling, 'sibling'), /目录越界/);
});

section('0 字节的 mov 不算「已转过」（P0-3 runner 一侧）');

const liveItem = (id) => ({
  id,
  folderTitle: '',
  dateHint: '',
  medias: [
    {
      kind: 'livephoto',
      url: 'https://cdn.example.com/live.mp4',
      ext: 'mp4',
      cover: 'https://cdn.example.com/cover.jpg',
    },
  ],
});

t('mov 是 0 字节时仍要下载源视频（否则这条 Live 永远修不好）', async () => {
  const outDir = newOutDir('empty-mov');
  const { runner } = makeRunner();
  const postDir = path.join(outDir, 'weibo_batch', 'live1');
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, 'live01.mov'), ''); // 历史遗留的半截文件

  await runner._downloadItems([liveItem('live1')], {
    outDir,
    rootId: 'batch',
    merged: { downloadImages: false, downloadLive: true, convertLiveToMov: false },
  });

  const files = await listFiles(path.join(outDir, 'weibo_batch'));
  // 静态帧（cover）在勾了「下载 Live」时也会保存，这是既有行为
  assert.deepStrictEqual(
    files,
    ['live1/live01.jpg', 'live1/live01.mov', 'live1/live01_src.mp4'],
    `实际文件：\n${files.join('\n')}`
  );
  const st = await fsp.stat(path.join(postDir, 'live01_src.mp4'));
  assert.ok(st.size > 0, '源视频应有内容');
});

t('mov 有内容时仍然跳过源视频下载（幂等/省流量行为不变）', async () => {
  const outDir = newOutDir('good-mov');
  const { runner } = makeRunner();
  const postDir = path.join(outDir, 'weibo_batch', 'live2');
  fs.mkdirSync(postDir, { recursive: true });
  // 目录里的中转文件名是 live01（按该作品内 Live 的序号），不是 live02
  fs.writeFileSync(path.join(postDir, 'live01.mov'), 'REAL-MOV-BYTES');

  await runner._downloadItems([liveItem('live2')], {
    outDir,
    rootId: 'batch',
    merged: { downloadImages: false, downloadLive: true, convertLiveToMov: false },
  });

  const files = await listFiles(path.join(outDir, 'weibo_batch'));
  assert.deepStrictEqual(
    files,
    ['live2/live01.jpg', 'live2/live01.mov'],
    `不该再拉源文件，实际：\n${files.join('\n')}`
  );
});

/* -------------------------------- 运行 -------------------------------- */

(async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runner-folder-'));
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
