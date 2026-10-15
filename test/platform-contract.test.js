/**
 * 三平台契约（第 5 轮）—— 「单个作品下载需同时支持全部三个平台」的硬约束
 *
 * 这条需求最容易在**加平台 / 改 url-parse** 时被悄悄破坏：
 * 链接识别认得某个平台，但那个平台的适配器没实现 `collectSingleItem`，
 * 或者两边用的 id 不是同一个字符串（`xhs` vs `xiaohongshu`）。
 * 两种情况下界面都会正常显示「已识别为单个作品」，点开始才报错 —— 属于最难查的一类。
 *
 * 三平台的适配器依赖 electron（采集器要 BrowserWindow），所以这里先注入最小桩。
 *
 * 跑法：node test/platform-contract.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

/** 让 require('electron') 解析到测试桩（只影响本次调用期间） */
function withElectronStub(fn) {
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

const registry = withElectronStub(() => require('../src/main/platforms/registry'));
const { parseSingleUrl, isShortLink } = require('../src/main/url-parse');

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

const list = registry.list;

console.log('\n[平台清单]');

t('注册表里恰好是三个平台，且顺序稳定', () => {
  assert.deepStrictEqual(list.map((p) => p.id), ['weibo', 'xhs', 'douyin']);
});

t('每个平台都必须同时实现 collectItems 与 collectSingleItem', () => {
  for (const p of list) {
    assert.strictEqual(typeof p.collectItems, 'function', `${p.id} 缺少 collectItems（博主主页批量）`);
    assert.strictEqual(typeof p.collectSingleItem, 'function', `${p.id} 缺少 collectSingleItem（单个作品）`);
  }
});

t('适配器必备字段齐全（界面全靠 describe() 拿这些）', () => {
  const required = ['id', 'name', 'siteURL', 'loginURL', 'partition', 'inputMeta', 'optionsSchema', 'defaultOptions'];
  for (const p of list) {
    for (const k of required) {
      assert.ok(p[k] !== undefined && p[k] !== null, `${p.id} 缺少字段 ${k}`);
    }
    assert.ok(Array.isArray(p.optionsSchema), `${p.id}.optionsSchema 应为数组`);
    assert.ok(p.optionsSchema.length > 0, `${p.id}.optionsSchema 不应为空`);
    assert.ok(typeof p.defaultOptions === 'object', `${p.id}.defaultOptions 应为对象`);
  }
});

t('三个平台的登录分区互不相同（否则登录态会串台）', () => {
  const parts = list.map((p) => p.partition);
  assert.strictEqual(new Set(parts).size, parts.length, `partition 有重复：${parts.join(', ')}`);
});

t('optionsSchema 的每个 key 都必须有默认值（否则首次渲染拿到 undefined）', () => {
  for (const p of list) {
    for (const f of p.optionsSchema) {
      assert.ok(f.key, `${p.id}: 有选项缺少 key`);
      assert.ok(f.label, `${p.id}.${f.key}: 缺少 label`);
      assert.ok(f.type === 'bool' || f.type === 'number', `${p.id}.${f.key}: 未知类型 ${f.type}`);
      assert.notStrictEqual(p.defaultOptions[f.key], undefined, `${p.id}.${f.key}: defaultOptions 里没有默认值`);
      if (f.type === 'number') {
        assert.strictEqual(typeof p.defaultOptions[f.key], 'number', `${p.id}.${f.key}: 数值选项的默认值应为 number`);
        assert.ok(f.min !== undefined && f.max !== undefined, `${p.id}.${f.key}: 数值选项应声明 min/max`);
      }
    }
  }
});

t('describe() 的结果可安全过 IPC（不含函数、能 JSON 序列化）', () => {
  const meta = registry.all();
  assert.strictEqual(meta.length, 3);
  for (const m of meta) {
    const round = JSON.parse(JSON.stringify(m));
    assert.strictEqual(round.id, m.id);
    assert.ok(!Object.values(m).some((v) => typeof v === 'function'), `${m.id}: describe 结果里混进了函数`);
  }
  assert.deepStrictEqual(
    meta.map((m) => m.id),
    ['weibo', 'xhs', 'douyin']
  );
});

console.log('\n[url-parse ↔ 注册表 的 id 契约]');

t('parseSingleUrl 可能返回的每个 platform 都能在注册表里找到', () => {
  const samples = [
    'https://weibo.com/WEIBO_UID_PLACEHOLDER/P0RSAbcde',
    'https://m.weibo.cn/detail/5012345678901234',
    'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER',
    'https://www.xiaohongshu.com/discovery/item/XHS_NOTE_ID_PLACEHOLDER',
    'https://www.douyin.com/video/7300000000000000000',
    'https://www.douyin.com/note/7300000000000000000',
  ];
  for (const s of samples) {
    const r = parseSingleUrl(s);
    assert.ok(r, `未识别：${s}`);
    assert.ok(
      registry.get(r.platform),
      `${s} 识别成 platform="${r.platform}"，但注册表里没有这个 id（注册表有：${list.map((p) => p.id).join(', ')}）`
    );
    assert.strictEqual(typeof registry.get(r.platform).collectSingleItem, 'function', `${r.platform} 不支持单作品`);
  }
});

t('三个平台各自都能被识别到至少一种链接形态', () => {
  const seen = new Set(
    [
      'https://weibo.com/WEIBO_UID_PLACEHOLDER/P0RSAbcde',
      'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER',
      'https://www.douyin.com/video/7300000000000000000',
    ].map((s) => parseSingleUrl(s).platform)
  );
  assert.deepStrictEqual([...seen].sort(), ['douyin', 'weibo', 'xhs']);
});

t('短链域名归属正确（展开后必须还落在这三家里，否则会被重定向到别处）', () => {
  assert.ok(isShortLink('https://v.douyin.com/iAbCdEf/'));
  assert.ok(isShortLink('https://xhslink.com/aB3dEf'));
  // 微博没有短链域名，别把普通微博链接误判成待展开的短链
  assert.ok(!isShortLink('https://weibo.com/WEIBO_UID_PLACEHOLDER/P0RSAbcde'));
  assert.ok(!isShortLink('https://t.cn/abc'));
});

console.log('\n[能力位与真实实现是否自洽]');

t('走浏览器采集的平台不能开 trustKeyCookie（关键 Cookie 是匿名下发的，开了会「点登录就闪退」）', () => {
  for (const p of list) {
    if (p.needsBrowserHarvest) {
      assert.ok(!p.trustKeyCookie, `${p.id}: 采集型平台不应开启 trustKeyCookie`);
    }
  }
});

t('接口直连型平台必须声明 injectCookieIntoFetch（否则拿不到登录态数据）', () => {
  for (const p of list) {
    if (!p.needsBrowserHarvest) {
      assert.ok(p.injectCookieIntoFetch, `${p.id}: 接口直连型平台应开启 injectCookieIntoFetch`);
    }
  }
});

t('声明了 supportsLivePhoto 的平台，其 defaultOptions 里必须有对应的下载开关', () => {
  for (const p of list) {
    if (!p.supportsLivePhoto) continue;
    const keys = p.optionsSchema.map((f) => f.key);
    assert.ok(keys.includes('downloadLive'), `${p.id}: 支持实况图，却没有 downloadLive 选项`);
  }
});

t('界面语言用的 filterLabels 若有声明，必须两个键都齐全', () => {
  for (const p of list) {
    if (!p.filterLabels) continue;
    assert.ok(p.filterLabels.retweet, `${p.id}.filterLabels 缺少 retweet`);
    assert.ok(p.filterLabels.other, `${p.id}.filterLabels 缺少 other`);
  }
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (failed.length) {
  console.log('失败用例：');
  for (const f of failed) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
