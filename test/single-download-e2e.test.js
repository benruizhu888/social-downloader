/**
 * 作品链接下载的端到端冒烟（纯 Node，不依赖 Electron）
 *
 * 验的是「编排层真的按输入类型分了路，并且文件真的落到了磁盘上」——
 * 单测里 url-parse 的识别正确、适配器的采集正确，都不能保证 TaskRunner
 * 把它们接对了。这一层是唯一能同时覆盖两者的地方。
 *
 * 覆盖：
 *   ① 粘单条作品链接 → 走 collectSingleItem，且**不碰** collectItems（主页流程）
 *   ② 文件路径符合既有命名规则（outDir/<platform>_<id>/<id>/img01.jpg）
 *   ③ 粘博主主页链接 → 仍然走 collectItems（旧行为一字未变）
 *   ④ 批量粘多条 → 逐条采集、一条失败不拖垮整批、跨平台链接被跳过、
 *      重复行去重、全是无效行时给出可操作报错
 *
 * HTTP 用假的 fetch 打桩：只回一块已知字节，不发任何真实请求。
 *
 * 跑法：node test/single-download-e2e.test.js
 */

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { TaskRunner } = require('../src/main/core/runner');

const JPEG = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex'); // 一小段「JPEG」字节

/** 打桩的 fetch：HEAD 给总长，GET 给内容 —— 覆盖 downloader 的两条探测路径 */
function fakeFetch() {
  return async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(JPEG.length) } });
    }
    return new Response(JPEG, { status: 200, headers: { 'content-length': String(JPEG.length) } });
  };
}

/**
 * @param {{failIds?:string[], id?:string, name?:string}} [opts]
 *        failIds：这些作品 id 在采集时抛错 —— 用来验「一条失败不拖垮整批」
 */
function makeAdapter(opts = {}) {
  const calls = { items: 0, single: 0, singleArgs: null, singleIds: [] };
  const failIds = new Set(opts.failIds || []);
  return {
    calls,
    id: opts.id || 'douyin',
    name: opts.name || '抖音',
    referer: 'https://www.douyin.com/',
    supportsOnlyOriginal: false,
    siteURL: 'https://www.douyin.com',
    partition: 'persist:douyin',
    async collectItems() {
      calls.items++;
      throw new Error('主页流程不应被单作品输入触发');
    },
    async collectSingleItem(args) {
      calls.single++;
      calls.singleArgs = args;
      calls.singleIds.push(args.itemId);
      if (failIds.has(args.itemId)) throw new Error(`打桩失败：${args.itemId}`);
      return {
        items: [
          {
            id: args.itemId,
            title: '一条测试作品',
            dateHint: '',
            filePrefix: '',
            folderTitle: '',
            author: '',
            likeCount: null,
            medias: [{ kind: 'image', url: 'https://p3-sign.douyinpic.com/fake.jpg', candidates: [], ext: 'jpg' }],
          },
        ],
        rootId: args.itemId,
      };
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' -> ' + e.message);
    console.log('  \u2717 ' + name + '\n      ' + e.message);
  }
}

async function run(input, adapter, outDir) {
  const events = [];
  const runner = new TaskRunner({
    adapter,
    ctx: { fetchImpl: fakeFetch() },
    emit: (e) => events.push(e),
    getSettings: () => ({ downloadImages: true, downloadVideos: true, concurrency: 2 }),
  });
  const result = await runner.run({ input, outDir, options: { outDir } });
  return { result, events };
}

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-single-'));

  console.log('\n[单作品链接 → 单作品流程]');
  const adapter = makeAdapter();
  const ID = '7300000000000000000';
  let res = null;
  await t('文件真的落盘，且路径符合既有命名规则', async () => {
    const r = await run(`https://www.douyin.com/video/${ID}`, adapter, tmp);
    res = r;
    const dest = path.join(tmp, `douyin_${ID}`, ID, 'img01.jpg');
    const st = await fsp.stat(dest);
    assert.ok(st.size === JPEG.length, `期望 ${JPEG.length} 字节，实际 ${st.size}`);
  });
  await t('走的是 collectSingleItem，没有碰主页流程', () => {
    assert.strictEqual(adapter.calls.single, 1);
    assert.strictEqual(adapter.calls.items, 0);
  });
  await t('采集参数对：itemId 与作品页地址都传到了适配器', () => {
    const a = adapter.calls.singleArgs;
    assert.strictEqual(a.itemId, ID);
    assert.strictEqual(a.url, `https://www.douyin.com/video/${ID}`);
  });
  await t('下载统计正确（1 成功 / 0 失败）', () => {
    assert.strictEqual(res.result.done, 1);
    assert.strictEqual(res.result.failed, 0);
  });
  await t('最后发出的是 done 阶段事件', () => {
    const phases = res.events.filter((e) => e.type === 'phase').map((e) => e.phase);
    assert.strictEqual(phases[phases.length - 1], 'done');
  });

  console.log('\n[平台不匹配]');
  await t('微博链接给到抖音适配器时明确报错', async () => {
    const a2 = makeAdapter();
    await assert.rejects(
      () => run('https://weibo.com/1234567890/P0RSTabcde', a2, tmp),
      /属于微博.*当前选的是抖音/s
    );
    assert.strictEqual(a2.calls.single, 0);
  });

  console.log('\n[博主主页链接 → 原流程不变]');
  await t('主页链接仍然走 collectItems（旧行为一字未变）', async () => {
    const a3 = makeAdapter();
    await assert.rejects(
      () => run('https://www.douyin.com/user/MS4wLjABAAAAxxxx', a3, tmp),
      /主页流程不应被单作品输入触发/
    );
    assert.strictEqual(a3.calls.items, 1);
    assert.strictEqual(a3.calls.single, 0);
  });

  console.log('\n[适配器未实现单作品]');
  await t('给出人话，而不是 TypeError', async () => {
    const a4 = makeAdapter();
    delete a4.collectSingleItem;
    await assert.rejects(
      () => run('https://www.douyin.com/video/7300000000000000000', a4, tmp),
      /暂不支持单作品下载/
    );
  });

  /* ------------------------------ 批量粘贴 ------------------------------ */

  const A = '7300000000000000001';
  const B = '7300000000000000002';
  const C = '7300000000000000003';
  const link = (id) => `https://www.douyin.com/video/${id}`;

  console.log('\n[批量粘贴多条链接]');
  await t('三条链接 → 逐个采集，各自落盘到同一个批次目录', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    const r = await run([link(A), link(B), link(C)].join('\n'), a, dir);
    for (const id of [A, B, C]) {
      const st = await fsp.stat(path.join(dir, 'douyin_batch', id, 'img01.jpg'));
      assert.strictEqual(st.size, JPEG.length, `${id} 未落盘`);
    }
    assert.strictEqual(a.calls.single, 3, '三条应各采集一次');
    assert.strictEqual(a.calls.items, 0, '批量不该走主页流程');
    assert.strictEqual(r.result.done, 3);
    assert.strictEqual(r.result.failed, 0);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('批次目录名固定为 batch（重跑同一批可跳过已下文件）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    await run([link(A), link(B)].join('\n'), a, dir);
    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ['douyin_batch']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('单条链接时目录名仍是作品 id（与单作品功能完全一致）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    await run(link(A), a, dir);
    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, [`douyin_${A}`]);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  console.log('\n[批量：一条失败不拖垮整批]');
  await t('中间一条失败，其余照常下载，失败有日志', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter({ failIds: [B] });
    const r = await run([link(A), link(B), link(C)].join('\n'), a, dir);
    assert.strictEqual(a.calls.single, 3, '失败的那条也要被尝试');
    for (const id of [A, C]) {
      const st = await fsp.stat(path.join(dir, 'douyin_batch', id, 'img01.jpg'));
      assert.strictEqual(st.size, JPEG.length, `${id} 本应成功却未落盘`);
    }
    await assert.rejects(() => fsp.stat(path.join(dir, 'douyin_batch', B, 'img01.jpg')));
    assert.strictEqual(r.result.done, 2);
    const logs = r.events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');
    assert.match(logs, /第 2 条失败/, '失败必须写进日志，不能静默');
    assert.match(logs, /1 条读取失败/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('全部失败时才报错，并把每条原因带出来', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter({ failIds: [A, B] });
    await assert.rejects(
      () => run([link(A), link(B)].join('\n'), a, dir),
      /都没能读取到内容[\s\S]*打桩失败/
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });

  console.log('\n[批量：混入其它平台]');
  await t('别的平台链接被跳过并提示，本平台照常下载', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter(); // 抖音面板
    const r = await run([link(A), link(B), 'https://weibo.com/1234567890/P0RSTabcde'].join('\n'), a, dir);
    assert.strictEqual(a.calls.single, 2, '只应采集属于抖音的两条');
    const logs = r.events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');
    assert.match(logs, /跳过 1 条其它平台的链接/);
    // 过滤后确实有 2 条 → 归到批次目录
    for (const id of [A, B]) {
      const st = await fsp.stat(path.join(dir, 'douyin_batch', id, 'img01.jpg'));
      assert.strictEqual(st.size, JPEG.length);
    }
    assert.strictEqual(r.result.done, 2);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('过滤后只剩一条时，目录名回落到作品 id（与单作品一致）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    await run([link(A), 'https://weibo.com/1234567890/P0RSTabcde'].join('\n'), a, dir);
    // 目录名取决于**实际下载了几个**，而不是粘了几行 —— 这样重跑同一批
    // 总能命中同一目录，skipExisting 才生效
    const st = await fsp.stat(path.join(dir, `douyin_${A}`, A, 'img01.jpg'));
    assert.strictEqual(st.size, JPEG.length);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('全部属于其它平台时，报错并说清是哪家', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter(); // 抖音面板
    await assert.rejects(
      () => run('https://weibo.com/1234567890/P0RSTabcde', a, dir),
      /属于微博.*当前选的是抖音/s
    );
    assert.strictEqual(a.calls.single, 0);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  console.log('\n[批量：重复与噪声行]');
  await t('重复链接只下一次，重复行有日志说明', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    const r = await run([link(A), link(A), link(B)].join('\n'), a, dir);
    assert.strictEqual(a.calls.single, 2, '重复的那条不应被采集第二次');
    const logs = r.events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');
    assert.match(logs, /已跳过：与前面的链接重复/);
    assert.strictEqual(r.result.done, 2);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('无效行被跳过但仍下载有效行（不因一行噪声整批报错）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    const r = await run([link(A), '这不是链接', 'https://www.douyin.com/user/MS4wLjABAAAAxxxx'].join('\n'), a, dir);
    assert.strictEqual(a.calls.single, 1);
    assert.strictEqual(r.result.done, 1);
    const logs = r.events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');
    assert.match(logs, /已跳过/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  console.log('\n[批量：全是无效行]');
  await t('一行作品链接都没有时，报错并列出被跳过的内容', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a = makeAdapter();
    await assert.rejects(
      () => run(['https://www.douyin.com/user/MS4wLjABAAAAxxxx', '随便写点什么'].join('\n'), a, dir),
      /没有识别到可下载的作品链接[\s\S]*被跳过的内容/
    );
    assert.strictEqual(a.calls.single, 0);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  console.log('\n[短链展开失败时的提示]');
  await t('展开失败给出可操作的报错（不静默失败）', async () => {
    const a5 = makeAdapter();
    const runner = new TaskRunner({
      adapter: a5,
      // 打桩成「跟随跳转后仍然是短链」→ 展开失败
      ctx: { fetchImpl: async () => new Response('', { status: 200, headers: {} }) },
      emit: () => {},
      getSettings: () => ({}),
    });
    await assert.rejects(
      () => runner.run({ input: 'https://v.douyin.com/iRNBho6/', outDir: tmp, options: {} }),
      /短链展开失败/
    );
  });
  /**
   * 这一条锁的是「报错原因必须是真原因」：短链全部展开失败时，
   * 不能落到「这些链接属于 X，但当前选的是 Y」那句 —— 那句会把人引到
   * 去反复切换平台，而问题其实出在网络/短链本身。
   */
  await t('短链全失败时报的是短链原因，而不是「平台不匹配」', async () => {
    const a6 = makeAdapter();
    const runner = new TaskRunner({
      adapter: a6,
      ctx: { fetchImpl: async () => new Response('', { status: 200, headers: {} }) },
      emit: () => {},
      getSettings: () => ({}),
    });
    await assert.rejects(
      () =>
        runner.run({
          input: 'https://v.douyin.com/iRNBho6/\nhttps://v.douyin.com/iRNBho7/',
          outDir: tmp,
          options: {},
        }),
      (err) => {
        assert.match(err.message, /短链展开失败/);
        assert.ok(!/当前选的是/.test(err.message), '不该误报成平台不匹配');
        return true;
      }
    );
  });
  await t('短链失败但还有正常链接时，整批不受影响', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-batch-'));
    const a7 = makeAdapter();
    const runner = new TaskRunner({
      adapter: a7,
      // 短链 → 空响应（展开失败）；正常图片 → 假 JPEG
      ctx: {
        fetchImpl: async (url, init = {}) => {
          if (String(url).includes('v.douyin.com')) return new Response('', { status: 200, headers: {} });
          if (init.method === 'HEAD') {
            return new Response(null, { status: 200, headers: { 'content-length': String(JPEG.length) } });
          }
          return new Response(JPEG, { status: 200, headers: { 'content-length': String(JPEG.length) } });
        },
      },
      emit: () => {},
      getSettings: () => ({ downloadImages: true, concurrency: 2 }),
    });
    await runner.run({
      input: [`https://v.douyin.com/iRNBho6/`, link(A)].join('\n'),
      outDir: dir,
      options: {},
    });
    const st = await fsp.stat(path.join(dir, `douyin_${A}`, A, 'img01.jpg'));
    assert.strictEqual(st.size, JPEG.length);
    assert.strictEqual(a7.calls.single, 1, '只有正常那条被采集');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
