/**
 * 单作品下载 — 边界与异常输入（第 2 轮）
 *
 * 只测 src/main/url-parse.js（纯函数、可离线单测）。它被三处同时使用：
 * 平台适配器、TaskRunner、以及界面的 input:inspect —— 一旦判错，
 * 表现是「粘贴了链接却按博主主页跑」「提示说 A 实际做 B」，用户完全看不出哪里不对。
 *
 * 本文件的重点是**真实分享文案**：三家 App 复制出来的文本里，链接后面常常**紧跟**
 * 中文标点或汉字，而不是空格。
 *
 * 跑法：node test/single-download-edge.test.js
 */

const assert = require('assert');
const {
  parseSingleUrl, parseInputList, extractUrl, isShortLink, midToId, idToMid,
} = require('../src/main/url-parse');

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
    failures.push(name);
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

/* ========================= 分享文案里的真实形态 ========================= */

console.log('\n[链接后紧跟中文标点 / 汉字]');

t('抖音分享文案：链接后紧跟「，复制打开抖音」', () => {
  const r = parseSingleUrl('https://www.douyin.com/video/7300000000000000000，复制打开抖音看看');
  assert.ok(r, '应识别出抖音单作品');
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.itemId, '7300000000000000000');
});

t('小红书分享文案：链接后紧跟「。」', () => {
  const r = parseSingleUrl('https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER。');
  assert.ok(r, '应识别出小红书单作品');
  assert.strictEqual(r.platform, 'xhs');
  assert.strictEqual(r.itemId, '65f3c2a1b1c2d3e4f5a6b7c8');
});

t('微博分享文案：链接后紧跟「【」等中文符号', () => {
  const r = parseSingleUrl('https://weibo.com/WEIBO_UID_PLACEHOLDER/P0RSAbcde【转发】');
  assert.ok(r, '应识别出微博单作品');
  assert.strictEqual(r.platform, 'weibo');
});

t('前后用中文括号 / 引号包住的链接', () => {
  for (const s of [
    '（https://www.douyin.com/video/7300000000000000000）',
    '「https://www.douyin.com/video/7300000000000000000」',
    '《https://www.douyin.com/video/7300000000000000000》',
  ]) {
    const r = parseSingleUrl(s);
    assert.ok(r, `应识别：${s}`);
    assert.strictEqual(r.itemId, '7300000000000000000');
  }
});

t('链接后紧跟中文汉字（无任何分隔符）', () => {
  const r = parseSingleUrl('https://www.douyin.com/video/7300000000000000000复制此链接');
  assert.ok(r, '汉字不该被并进 URL');
  assert.strictEqual(r.itemId, '7300000000000000000');
});

t('xsec_token 在尾部带标点时仍要完整保留', () => {
  const r = parseSingleUrl(
    'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER?xsec_token=XHS_XSEC_TOKEN_PLACEHOLDER&xsec_source=pc，快看'
  );
  assert.ok(r, '应识别');
  assert.strictEqual(r.token, 'ABnFZn2xWHrGF5kd1bP5', `token 被污染：${r.token}`);
  assert.ok(r.url.includes('xsec_token='), 'URL 里必须带着 xsec_token（不带会 403）');
});

t('短链后紧跟中文标点', () => {
  const r = parseSingleUrl('https://v.douyin.com/iAbCdEf/，复制此链接打开抖音');
  assert.ok(r, '应识别为短链');
  assert.strictEqual(r.shortLink, true);
  assert.strictEqual(r.url, 'https://v.douyin.com/iAbCdEf/', `短链地址被污染：${r.url}`);
});

console.log('\n[纯文本噪声与超长输入]');

t('一整段分享文案（含数字、表情、换行）里能准确抠出链接', () => {
  const text =
    '7.32 复制打开抖音，看看【某人的作品】超好看 https://www.douyin.com/video/7300000000000000000 复制此链接，打开Dou音搜索';
  const r = parseSingleUrl(text);
  assert.ok(r, '应识别');
  assert.strictEqual(r.itemId, '7300000000000000000');
});

t('超长噪声行（约 20 万字符）不会抛异常，也能取出链接', () => {
  const noise = '啊'.repeat(100000);
  const r = parseSingleUrl(`${noise} https://www.douyin.com/video/7300000000000000000 ${noise}`);
  assert.ok(r, '应识别');
  assert.strictEqual(r.itemId, '7300000000000000000');
});

t('10 万字符里没有链接 → 返回 null 而不是卡死或抛异常', () => {
  const r = parseSingleUrl('这是一段没有任何链接的长文本'.repeat(5000));
  assert.strictEqual(r, null);
});

console.log('\n[协议与大小写]');

t('大写协议头与大写域名', () => {
  const r = parseSingleUrl('HTTPS://WWW.DOUYIN.COM/video/7300000000000000000');
  assert.ok(r, '域名大小写不应影响识别');
  assert.strictEqual(r.platform, 'douyin');
});

t('无协议头的裸域名', () => {
  const r = parseSingleUrl('www.douyin.com/video/7300000000000000000');
  assert.ok(r, '裸域名应能识别');
  assert.strictEqual(r.itemId, '7300000000000000000');
});

t('http（非 https）链接', () => {
  const r = parseSingleUrl('http://www.douyin.com/video/7300000000000000000');
  assert.ok(r);
});

console.log('\n[不该被识别成单作品]');

t('博主主页链接一律不识别（宁可不认，也不能把主页当成单个作品）', () => {
  for (const s of [
    'https://weibo.com/u/WEIBO_UID_PLACEHOLDER',
    'https://m.weibo.cn/u/WEIBO_UID_PLACEHOLDER',
    'https://www.xiaohongshu.com/user/profile/XHS_USER_ID_PLACEHOLDER',
    'https://www.douyin.com/user/DOUYIN_SEC_UID_PLACEHOLDER',
    'https://www.douyin.com/',
  ]) {
    assert.strictEqual(parseSingleUrl(s), null, `不该识别：${s}`);
  }
});

t('主页下的子页面（/uid/profile）不识别 —— 它和 /uid/mid 只差一个保留字', () => {
  for (const s of [
    'https://weibo.com/WEIBO_UID_PLACEHOLDER/profile',
    'https://weibo.com/WEIBO_UID_PLACEHOLDER/follow',
    'https://weibo.com/WEIBO_UID_PLACEHOLDER/fans',
  ]) {
    assert.strictEqual(parseSingleUrl(s), null, `不该识别：${s}`);
  }
});

t('别的网站链接不识别', () => {
  for (const s of ['https://www.bilibili.com/video/BV1xx411c7mD', 'https://example.com/video/123456789012345']) {
    assert.strictEqual(parseSingleUrl(s), null, `不该识别：${s}`);
  }
});

t('空串 / 空白 / 乱码 / null 一律返回 null，不抛异常', () => {
  for (const s of ['', '   ', '\n\n', '\u0000\u0001', '不是链接', null, undefined]) {
    assert.strictEqual(parseSingleUrl(s), null, `不该识别：${JSON.stringify(s)}`);
  }
});

/* ============================== 批量拆分 ============================== */

console.log('\n[批量粘贴]');

t('CRLF + 空行 + 首尾空白 + 噪声行', () => {
  const input = [
    'https://www.douyin.com/video/7300000000000000001',
    '',
    '   ',
    'https://www.douyin.com/video/7300000000000000002，复制打开抖音',
    '这是一行纯噪声',
    'https://www.douyin.com/video/7300000000000000001',
    'https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER',
  ].join('\r\n');
  const r = parseInputList(input);
  assert.strictEqual(r.lines, 5, `非空行数应为 5，实际 ${r.lines}`);
  assert.strictEqual(r.targets.length, 3, `有效目标应为 3（含 1 条小红书），实际 ${r.targets.length}`);
  assert.ok(r.ignored.some((x) => /重复/.test(x.reason)), '重复行要说明是重复');
  assert.ok(r.ignored.some((x) => /不是受支持/.test(x.reason)), '噪声行要说明原因');
});

t('同一作品的不同写法算重复（video 路径 / modal_id 参数）', () => {
  const r = parseInputList(
    'https://www.douyin.com/video/7300000000000000000\n' +
      'https://www.douyin.com/?modal_id=7300000000000000000'
  );
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.ignored.length, 1);
});

t('批量里混入「主页链接」时，原因要写成「主页」而不是「不是链接」', () => {
  const r = parseInputList('https://weibo.com/u/WEIBO_UID_PLACEHOLDER');
  assert.strictEqual(r.targets.length, 0);
  assert.ok(/主页/.test(r.ignored[0].reason), r.ignored[0].reason);
});

t('全是空输入 → lines=0（调用方据此走主页流程，而不是报「没有可下载的作品」）', () => {
  for (const s of ['', '\n', '   \n  \n']) {
    const r = parseInputList(s);
    assert.strictEqual(r.lines, 0, JSON.stringify(s));
    assert.strictEqual(r.targets.length, 0);
  }
});

t('每条被跳过的行都能拿到原始文本，不会被悄悄丢掉', () => {
  const r = parseInputList('噪声一\nhttps://weibo.com/u/1\n噪声二');
  assert.strictEqual(r.ignored.length, 3, '两行噪声 + 一行主页，都应留下记录');
  assert.ok(r.ignored.every((x) => x.line && x.reason));
});

/* ============================== 序号互转 ============================== */

console.log('\n[mid 编解码]');

t('id → mid → id 往返一致', () => {
  for (const id of ['1', '1234567', '12345678', '5000000000000000', 'WEIBO_UID_PLACEHOLDER']) {
    const mid = idToMid(id);
    assert.ok(mid, `idToMid(${id}) 不应为空`);
    assert.strictEqual(midToId(mid), id, `往返不一致：${id} → ${mid} → ${midToId(mid)}`);
  }
});

t('非 base62 / 空值只返回空串，绝不抛异常', () => {
  for (const s of ['', null, undefined, '中文', 'a-b_c', '!@#$%']) {
    assert.strictEqual(midToId(s), '', JSON.stringify(s));
  }
});

/* ============================== 辅助函数 ============================== */

console.log('\n[extractUrl / isShortLink]');

t('extractUrl 不会把中文标点并进 URL', () => {
  const u = extractUrl('看这个 https://www.douyin.com/video/7300000000000000000，很有意思');
  assert.ok(!/，/.test(u), `URL 里混入了中文标点：${u}`);
  assert.ok(!/很有/.test(u), `URL 里混入了汉字：${u}`);
});

t('extractUrl 对「无协议裸链接」同样生效', () => {
  const u = extractUrl('www.douyin.com/video/7300000000000000000');
  assert.ok(/^https:\/\//.test(u), u);
  assert.ok(!/[，。]/.test(u), u);
});

t('isShortLink 只认单段短链，不认主页', () => {
  assert.ok(isShortLink('https://v.douyin.com/iAbCdEf/'));
  assert.ok(isShortLink('https://xhslink.com/aB3dEf'));
  assert.ok(!isShortLink('https://www.douyin.com/user/MS4wLjABAAAA'));
  assert.ok(!isShortLink('https://www.xiaohongshu.com/explore/XHS_NOTE_ID_PLACEHOLDER'));
});

/* ------------------------------- 汇总 ------------------------------- */

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (failures.length) {
  console.log('失败用例：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
