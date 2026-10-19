/**
 * url-parse / harvest-match 的离线单测（纯 Node，不依赖 Electron）
 *
 * 为什么这两块必须先有测试再交付：
 *   · url-parse 决定「走博主主页流程还是单作品流程」。它误判的两种后果
 *     （批量变单个、单个变批量）在界面上都看不出来，只会表现为「下少了/下多了」。
 *   · harvest-match 的判定函数是 toString() 后穿过 IPC 送进沙箱 preload 的，
 *     一旦拼出来不是合法函数，症状是**采集永远 0 条**而不是报错 —— 必须锁死。
 *
 * 跑法：node test/single-download.test.js
 */

const assert = require('assert');
const path = require('path');

const {
  parseSingleUrl,
  parseInputList,
  describeSingle,
  extractUrl,
  isShortLink,
  midToId,
  idToMid,
} = require('../src/main/url-parse');
const {
  matches,
  matchesSingle,
  harvestArguments,
  MATCH_SOURCE,
  SINGLE_SOURCE,
} = require('../src/preload/harvest-match');
const { SSR_BUNDLE_JS } = require('../src/main/core/ssr-walk');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' -> ' + e.message);
    console.log('  \u2717 ' + name + '\n      ' + e.message);
  }
}

/* ------------------------------ 微博识别 ------------------------------ */

console.log('\n[微博]');
t('weibo.com/<uid>/<mid> 识别为单作品', () => {
  const r = parseSingleUrl('https://weibo.com/1234567890/P0RSTabcde');
  assert.strictEqual(r.platform, 'weibo');
  assert.strictEqual(r.itemId, 'P0RSTabcde');
});
t('带查询串与锚点不影响识别', () => {
  const r = parseSingleUrl('https://weibo.com/1234567890/P0RSTabcde?type=comment#_rnd1');
  assert.strictEqual(r.itemId, 'P0RSTabcde');
});
t('m.weibo.cn/status/<mid> 识别为单作品', () => {
  const r = parseSingleUrl('https://m.weibo.cn/status/P0RSTabcde');
  assert.strictEqual(r.platform, 'weibo');
  assert.strictEqual(r.itemId, 'P0RSTabcde');
});
t('m.weibo.cn/detail/<数字 id> 识别为单作品', () => {
  const r = parseSingleUrl('https://m.weibo.cn/detail/5000000000000000');
  assert.strictEqual(r.itemId, '5000000000000000');
});
t('mid 会带出一个十进制备选 id', () => {
  const r = parseSingleUrl('https://m.weibo.cn/status/P0RSTabcde');
  assert.ok(r.altIds.length === 1 && /^\d+$/.test(r.altIds[0]), 'altIds 应含数字 id');
  assert.notStrictEqual(r.altIds[0], r.itemId);
});
t('主页链接：weibo.com/1234567890 → 不是单作品', () => {
  assert.strictEqual(parseSingleUrl('https://weibo.com/1234567890'), null);
});
t('主页链接：weibo.com/u/1234567890 → 不是单作品', () => {
  assert.strictEqual(parseSingleUrl('https://weibo.com/u/1234567890'), null);
});
t('保留字路径不被误判（/1234567890/profile）', () => {
  assert.strictEqual(parseSingleUrl('https://weibo.com/1234567890/profile'), null);
});
t('分享文案里夹着的链接能被抠出来', () => {
  const r = parseSingleUrl('分享图片 https://weibo.com/1234567890/P0RSTabcde 快来看');
  assert.strictEqual(r.itemId, 'P0RSTabcde');
});

/* ----------------------------- 小红书识别 ----------------------------- */

console.log('\n[小红书]');
t('explore 链接 + xsec_token 保留', () => {
  const r = parseSingleUrl(
    'https://www.xiaohongshu.com/explore/EXAMPLE0000000000000000?xsec_token=ABCdef&xsec_source=pc_user'
  );
  assert.strictEqual(r.platform, 'xhs');
  assert.strictEqual(r.itemId, 'EXAMPLE0000000000000000');
  assert.strictEqual(r.token, 'ABCdef');
  // url 必须原样带上令牌：详情页没它就返回空壳
  assert.ok(r.url.includes('xsec_token=ABCdef'));
});
t('discovery/item 形态', () => {
  const r = parseSingleUrl('https://www.xiaohongshu.com/discovery/item/EXAMPLE0000000000000000');
  assert.strictEqual(r.itemId, 'EXAMPLE0000000000000000');
});
t('user/profile 主页 → 不是单作品', () => {
  assert.strictEqual(parseSingleUrl('https://www.xiaohongshu.com/user/profile/EXAMPLE0000000000000001'), null);
});
t('user/profile/<uid>/<noteId> 识别为单作品', () => {
  const r = parseSingleUrl('https://www.xiaohongshu.com/user/profile/EXAMPLE0000000000000001/EXAMPLE0000000000000000');
  assert.strictEqual(r.itemId, 'EXAMPLE0000000000000000');
});

/* ------------------------------ 抖音识别 ------------------------------ */

console.log('\n[抖音]');
t('douyin.com/video/<id>', () => {
  const r = parseSingleUrl('https://www.douyin.com/video/7300000000000000000');
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.itemId, '7300000000000000000');
  assert.strictEqual(r.url, 'https://www.douyin.com/video/7300000000000000000');
});
t('douyin.com/note/<id>', () => {
  const r = parseSingleUrl('https://www.douyin.com/note/7300000000000000000');
  assert.strictEqual(r.itemId, '7300000000000000000');
});
t('?modal_id= 形态', () => {
  const r = parseSingleUrl('https://www.douyin.com/discover?modal_id=7300000000000000000');
  assert.strictEqual(r.itemId, '7300000000000000000');
});
t('iesdouyin 分享页', () => {
  const r = parseSingleUrl('https://www.iesdouyin.com/share/video/7300000000000000000/?region=CN');
  assert.strictEqual(r.itemId, '7300000000000000000');
});
t('博主主页 → 不是单作品', () => {
  assert.strictEqual(parseSingleUrl('https://www.douyin.com/user/MS4wLjABAAAAxxxx'), null);
});

/* ------------------------------- 短链 ------------------------------- */

console.log('\n[短链]');
t('v.douyin.com 识别为待展开的短链', () => {
  const r = parseSingleUrl('https://v.douyin.com/iRNBho6/');
  assert.strictEqual(r.shortLink, true);
  assert.strictEqual(r.itemId, '');
});
t('xhslink.com/a/xxx 识别为待展开的短链', () => {
  const r = parseSingleUrl('https://xhslink.com/a/AbCd1234');
  assert.strictEqual(r.shortLink, true);
});
t('isShortLink 对长链返回 false', () => {
  assert.strictEqual(isShortLink('https://www.douyin.com/video/7300000000000000000'), false);
});

/* ---------------------------- 兜底与边界 ---------------------------- */

console.log('\n[边界]');
t('空串 / 乱码 / 非三平台链接 → null（退回主页流程）', () => {
  assert.strictEqual(parseSingleUrl(''), null);
  assert.strictEqual(parseSingleUrl('随便写点什么'), null);
  assert.strictEqual(parseSingleUrl('https://www.bilibili.com/video/BV1xx'), null);
});
t('extractUrl 能从纯文本里取出 URL', () => {
  assert.strictEqual(extractUrl('看这个 https://weibo.com/1/abc 好'), 'https://weibo.com/1/abc');
  assert.strictEqual(extractUrl('https://weibo.com/1/abc'), 'https://weibo.com/1/abc');
  assert.strictEqual(extractUrl('没有链接'), '');
});

/* ---------------------------- 批量粘贴拆分 ---------------------------- */

console.log('\n[parseInputList 批量拆分]');
t('多行各自识别，lines 数如实反映用户粘了几行', () => {
  const r = parseInputList(
    [
      'https://www.douyin.com/video/7300000000000000000',
      'https://www.xiaohongshu.com/explore/EXAMPLE0000000000000000',
      'https://weibo.com/1234567890/P0RSTabcde',
    ].join('\n')
  );
  assert.strictEqual(r.lines, 3);
  assert.strictEqual(r.targets.length, 3);
  assert.strictEqual(r.ignored.length, 0);
  assert.deepStrictEqual(
    r.targets.map((x) => x.platform),
    ['douyin', 'xhs', 'weibo']
  );
});
t('空行与首尾空白被忽略，不影响 lines', () => {
  const r = parseInputList('\n\n   \nhttps://www.douyin.com/video/7300000000000000000\n\n   \n');
  assert.strictEqual(r.lines, 1);
  assert.strictEqual(r.targets.length, 1);
});
t('只按换行拆 —— 分享文案里的空格和逗号不能把一条链接切碎', () => {
  // 这一行的空格/逗号很多，若按它们拆会碎成一堆碎片
  const line = '3.14 复制打开抖音，看看【某人的作品】 https://www.douyin.com/video/7300000000000000000 真好看';
  const r = parseInputList(line);
  assert.strictEqual(r.lines, 1);
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.targets[0].itemId, '7300000000000000000');
});
t('同一作品出现两次 → 只保留一条，另一条说明「重复」', () => {
  const r = parseInputList(
    'https://www.douyin.com/video/7300000000000000000\nhttps://www.douyin.com/video/7300000000000000000'
  );
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.ignored.length, 1);
  assert.match(r.ignored[0].reason, /重复/);
});
t('同一作品的不同写法（video 与 modal_id）算重复', () => {
  const r = parseInputList(
    'https://www.douyin.com/video/7300000000000000000\nhttps://www.douyin.com/discover?modal_id=7300000000000000000'
  );
  assert.strictEqual(r.targets.length, 1, '同一 id 应判为重复');
  assert.strictEqual(r.ignored.length, 1);
});
t('短链只按地址本身去重（它还没有 id）', () => {
  const r = parseInputList('https://v.douyin.com/iRNBho6/\nhttps://v.douyin.com/iRNBho7/');
  assert.strictEqual(r.targets.length, 2, '不同短链不能当成重复');
  assert.ok(r.targets.every((t) => t.shortLink === true));
});
t('主页链接被跳过，且原因写明是「主页」而不是「不是链接」', () => {
  const r = parseInputList(
    'https://www.douyin.com/user/MS4wLjABAAAAxxxx\nhttps://www.douyin.com/video/7300000000000000000'
  );
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.ignored.length, 1);
  assert.match(r.ignored[0].reason, /主页/);
});
t('别的网站链接被跳过，原因是「不是受支持的作品链接」', () => {
  const r = parseInputList('https://www.bilibili.com/video/BV1xx');
  assert.strictEqual(r.targets.length, 0);
  assert.strictEqual(r.ignored.length, 1);
  assert.match(r.ignored[0].reason, /不是受支持/);
});
t('乱码行有原因，不会被悄悄丢掉', () => {
  const r = parseInputList('随便写点什么');
  assert.strictEqual(r.lines, 1);
  assert.strictEqual(r.ignored.length, 1);
  assert.ok(r.ignored[0].reason.length > 0);
});
t('空输入 → 0 行 0 目标（调用方据此走主页流程）', () => {
  assert.strictEqual(parseInputList('').lines, 0);
  assert.strictEqual(parseInputList('   \n  \n').lines, 0);
  assert.strictEqual(parseInputList(null).targets.length, 0);
});
t('混合输入：好的进 targets，坏的进 ignored，数量对得上', () => {
  const r = parseInputList(
    [
      'https://www.douyin.com/video/7300000000000000000',
      'https://www.douyin.com/user/MS4wLjABAAAAxxxx',
      'https://www.xiaohongshu.com/explore/EXAMPLE0000000000000000',
      'https://example.com/nope',
    ].join('\n')
  );
  assert.strictEqual(r.lines, 4);
  assert.strictEqual(r.targets.length, 2);
  assert.strictEqual(r.ignored.length, 2);
});
t('CRLF 换行（Windows 复制粘贴）也能正确拆分', () => {
  const r = parseInputList(
    'https://www.douyin.com/video/7300000000000000000\r\nhttps://www.xiaohongshu.com/explore/EXAMPLE0000000000000000'
  );
  assert.strictEqual(r.lines, 2);
  assert.strictEqual(r.targets.length, 2);
});
t('describeSingle 对短链与长链给出不同提示', () => {
  assert.match(describeSingle(parseSingleUrl('https://v.douyin.com/iRNBho6/'), '抖音'), /短链/);
  assert.match(describeSingle(parseSingleUrl('https://www.douyin.com/video/7300000000000000000'), '抖音'), /抖音/);
});

/* --------------------------- mid ↔ id 互验 --------------------------- */

console.log('\n[mid 编解码]');
t('十进制 id 原样返回', () => {
  assert.strictEqual(midToId('5000000000000000'), '5000000000000000');
});
t('非法 base62 字符返回空串', () => {
  assert.strictEqual(midToId('abc/def'), '');
});
t('id → mid → id 往返一致（多组）', () => {
  for (const id of ['5000000000000000', '1234567890123456', '4999999999999999', '12345678']) {
    const mid = idToMid(id);
    assert.ok(mid, `idToMid(${id}) 不应为空`);
    assert.strictEqual(midToId(mid), id, `${id} → ${mid} → ${midToId(mid)}`);
  }
});
t('midToId 对任意 base62 串都只返回数字（或空串），不抛异常', () => {
  for (const mid of ['P0RSTabcde', 'KqLMHyZ1x', 'O00000000']) {
    const id = midToId(mid);
    assert.ok(id === '' || /^\d+$/.test(id), `${mid} → ${id}`);
  }
});
/**
 * 这条断言锁的是「可逆性的适用范围」：只有由十进制 id 生成的**合法 mid**
 * 才能无损往返。随手编的 base62 串解出的段可能超过 7 位十进制，idToMid
 * 再切段就错位 —— 属于数学上的信息损失，不是实现缺陷（详见 url-parse.js 注释）。
 * 写出来是为了避免后人误以为「任意 mid 都能往返」而去依赖这个假性质。
 */
t('非法 mid 不保证往返（显式确认这是已知边界）', () => {
  const mid = 'P0RSTabcde';
  const id = midToId(mid);
  assert.ok(id.length > 17, '该串解出的 id 明显长于合法 mid 对应的 16~17 位');
  assert.notStrictEqual(idToMid(id), mid);
});
t('mid 给出的备选 id 是纯数字（接口兜底用）', () => {
  const r = parseSingleUrl('https://m.weibo.cn/status/P0RSTabcde');
  assert.strictEqual(r.altIds.length, 1);
  assert.ok(/^\d{10,}$/.test(r.altIds[0]), `期望得到较长数字 id，实际 ${r.altIds[0]}`);
});

/* --------------------------- 响应白名单 --------------------------- */

console.log('\n[harvest-match]');
t('主页模式：放行抖音 post，拉黑 detail（原有行为不变）', () => {
  assert.strictEqual(matches('https://www.douyin.com/aweme/v1/web/aweme/post/?x=1'), true);
  assert.strictEqual(matches('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1'), false);
});
t('单作品模式：放行抖音 detail', () => {
  assert.strictEqual(matchesSingle('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1'), true);
});
t('两种模式都拦住 favorite（「喜欢」列表那个坑不能复活）', () => {
  const u = 'https://www.douyin.com/aweme/v1/web/aweme/favorite/?count=10';
  assert.strictEqual(matches(u), false);
  assert.strictEqual(matchesSingle(u), false);
});
t('两种模式都拦住 related / tab feed', () => {
  assert.strictEqual(matchesSingle('https://www.douyin.com/aweme/v1/web/aweme/related/?x=1'), false);
  assert.strictEqual(matchesSingle('https://www.douyin.com/aweme/v1/web/tab/feed/?x=1'), false);
});
t('单作品模式：放行小红书笔记详情 feed', () => {
  assert.strictEqual(matchesSingle('https://edith.xiaohongshu.com/api/sns/web/v1/feed'), true);
});
t('单作品模式：仍放行主页作品接口', () => {
  assert.strictEqual(matchesSingle('https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?x=1'), true);
});
t('harvestArguments 在两种模式下给出不同的判定源码', () => {
  const a = harvestArguments();
  const b = harvestArguments({ single: true });
  assert.notStrictEqual(a[0], b[0]);
  assert.ok(a[0].includes('NOT_POST'), '主页模式应带噪声黑名单');
  assert.ok(!b[0].includes('NOT_POST'), '单作品模式应换成另一份判定');
});
t('两份判定源码都是自包含的（能编译成可调用函数）', () => {
  for (const src of [MATCH_SOURCE, SINGLE_SOURCE]) {
    const fn = new Function('return (' + src + ')')();
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(typeof fn('https://www.douyin.com/aweme/v1/web/aweme/post/'), 'boolean');
  }
});
t('SSR 注入脚本拼装后语法合法', () => {
  // 只编译不执行：脚本里要访问 window/document，纯 Node 下跑不了
  assert.doesNotThrow(() => new Function(SSR_BUNDLE_JS));
  assert.ok(SSR_BUNDLE_JS.includes('__INITIAL_STATE__'));
});

/* ------------------------------ 结果 ------------------------------ */

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
