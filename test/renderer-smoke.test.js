/**
 * 渲染层冒烟测试（第 1 轮：正常路径）
 *
 * 目标不是「测遍所有分支」，而是回答一个静态断言回答不了的问题：
 * **app.js 整份在真实 DOM 契约下跑得起来吗？**
 * 全覆盖在 test/log-edge.test.js 与 test/progress-edge.test.js；
 * 单作品链接解析在 test/single-download*.test.js。
 *
 * 跑法：node test/renderer-smoke.test.js
 */

const assert = require('assert');
const { createHarness } = require('./lib/renderer-harness');

const h = createHarness();
const el = h.el;
const txt = h.txt;
const ui = () => h.ui();

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

section('加载');
t('app.js 能在按 index.html 建出的 DOM 上完整执行（无 $() 拿到 null、无绑定期异常）', () => {
  assert.ok(!h.loadError, h.loadError && `${h.loadError.name}: ${h.loadError.message}\n${h.loadError.stack}`);
  assert.ok(ui(), 'app.js 应暴露 window.__ui');
  assert.strictEqual(typeof h.windowObj.__handler, 'function', 'init() 应完成并注册事件回调');
});

t('初始界面：提示条与失败明细都是收起的', () => {
  assert.strictEqual(el('inputMode').hidden, true);
  assert.strictEqual(el('failBox').hidden, true);
  assert.strictEqual(el('btnLogNew').hidden, true);
});

section('日志：写入 / 分级 / 筛选');
t('写日志后计数按级别归位', () => {
  const L = ui().log;
  L('共读取 128 条微博');
  L('下载失败：a.jpg HTTP 403', 'err');
  L('已跳过 3 条其它平台的链接');
  L('视频转 MOV 完成：成功 3，失败 0');
  L('日志已导出：C:\\a.log', 'ok');
  h.pumpFrames();
  assert.strictEqual(txt('cntAll'), '5');
  assert.strictEqual(txt('cntInfo'), '1');
  assert.strictEqual(txt('cntErr'), '1');
  assert.strictEqual(txt('cntWarn'), '1');
  assert.strictEqual(txt('cntOk'), '2', '「失败 0」应算成功而不是错误');
});

t('筛选「错误」后，DOM 里只剩那一条错误行', () => {
  ui().setLogFilter('err');
  const box = el('log');
  assert.strictEqual(box.childElementCount, 1);
  assert.strictEqual(box.children[0].children[1].textContent, '下载失败：a.jpg HTTP 403');
  assert.ok(el('logCount').textContent.includes('当前筛选 1 条'));
});

t('关键字检索：大小写不敏感且能与级别叠加', () => {
  ui().setLogFilter('all');
  ui().state.logQuery = 'http 403';
  ui().rerenderLog();
  assert.strictEqual(el('log').childElementCount, 1);

  ui().state.logQuery = 'JPG';
  ui().rerenderLog();
  assert.strictEqual(el('log').childElementCount, 1, 'JPG 应命中 a.jpg 那一行');

  ui().state.logQuery = '完全不存在的内容';
  ui().rerenderLog();
  assert.strictEqual(el('log').childElementCount, 1, '无命中时只应剩空态占位');
  assert.ok(el('log').children[0].classList.contains('log-empty'));

  ui().state.logQuery = '';
  ui().rerenderLog();
  assert.strictEqual(el('log').childElementCount, 5);
});

t('清空日志：DOM 与计数一起归零，并补上空态而不是白框', () => {
  el('btnClearLog').fire('click');
  assert.strictEqual(ui().state.logLines.length, 0);
  assert.strictEqual(txt('cntAll'), '0');
  assert.strictEqual(el('log').childElementCount, 1);
  assert.ok(el('log').children[0].classList.contains('log-empty'));
});

t('跟随开关：关闭后不再滚到底，并显示「N 条新日志」', () => {
  el('log').scrollHeight = 500;
  el('log').clientHeight = 200;
  el('log').scrollTop = 0;
  ui().setLogFollow(false);
  ui().log('新的错误信息');
  h.pumpFrames();
  assert.strictEqual(el('btnLogNew').hidden, false);
  assert.ok(/1 条新日志/.test(el('btnLogNew').textContent));

  el('btnLogNew').fire('click');
  assert.strictEqual(ui().state.logFollow, true);
  assert.strictEqual(el('btnLogNew').hidden, true);
  assert.strictEqual(el('log').scrollTop, 500, '恢复跟随后应贴到底部');
});

section('进度：实时数字 / 失败明细');
t('进度事件：统计、进度条、进行中文件都对得上', () => {
  h.H({ type: 'summary', total: 4, images: 3, videos: 1, live: 0, rootDir: 'C:\\out' });
  h.H({ type: 'dl', event: 'progress', file: 'C:\\out\\a\\01.jpg', written: 50, total: 100, stats: { bytes: 50 } });
  h.pumpFrames();
  assert.strictEqual(ui().state.inflight.size, 1);
  assert.strictEqual(txt('stTotal'), '4');
  assert.strictEqual(el('bar').style.width, '12.50%', '进行中的那 0.5 个应折算进主进度条');
  assert.strictEqual(el('curFile').textContent, '01.jpg');
  assert.ok(el('minis').classList.contains('on'), '有进行中的文件时细进度条应展开');

  h.H({ type: 'dl', event: 'done', file: 'C:\\out\\a\\01.jpg', stats: { bytes: 100 } });
  h.pumpFrames();
  assert.strictEqual(ui().state.inflight.size, 0);
  assert.strictEqual(txt('stDone'), '1');
  assert.strictEqual(el('bar').style.width, '25.00%');
});

t('失败事件：计数 + 明细 + 错误日志三处都留下痕迹', () => {
  h.H({ type: 'dl', event: 'fail', file: 'C:\\out\\a\\bad.jpg', error: '连接被拒绝（ECONNREFUSED）', stats: { bytes: 0 } });
  h.pumpFrames();
  assert.strictEqual(txt('stFail'), '1');
  assert.strictEqual(el('failBox').hidden, false);
  assert.strictEqual(txt('failCount'), '1');
  assert.strictEqual(el('failList').children.length, 1);
  assert.strictEqual(el('failList').children[0].children[0].textContent, 'bad.jpg');
  assert.ok(/ECONNREFUSED/.test(el('failList').children[0].children[1].textContent));
  assert.ok(ui().state.logLines.some((l) => l.level === 'err'), '失败必须同时进日志（err 级）');
});

t('失败清单可复制为纯文本（含文件名与原因）', () => {
  const before = h.copied.length;
  el('btnCopyFail').fire('click');
  assert.strictEqual(h.copied.length, before + 1);
  assert.ok(/bad\.jpg/.test(h.copied[h.copied.length - 1]));
  assert.ok(/ECONNREFUSED/.test(h.copied[h.copied.length - 1]));
});

t('清除失败明细后盒子收起', () => {
  el('btnClearFail').fire('click');
  assert.strictEqual(ui().state.failures.length, 0);
  assert.strictEqual(el('failBox').hidden, true);
});

t('已用时间按 m:ss 渲染', () => {
  ui().state.running = true;
  ui().state.startedAt = h.now() - 65000;
  ui().state.endedAt = 0;
  ui().renderStats();
  assert.strictEqual(txt('elapsedText'), '1:05');
});

t('样本不足时剩余时间显示「—」，有样本后给出估算', () => {
  ui().state.running = false;
  ui().renderStats();
  assert.strictEqual(txt('etaText'), '—', '未运行时不应报剩余时间');

  ui().state.running = true;
  ui().state.stats = { total: 100, done: 10, skip: 0, fail: 0, item: 100 };
  ui().state.startedAt = h.now() - 10000; // 10s 完成 10 个 → 约 90s 剩余
  ui().renderStats();
  assert.ok(/^约 1:3\d$/.test(txt('etaText')), `剩余时间估算不合理：${txt('etaText')}`);
});

t('任务结束：已用时间冻结，不会随着挂机继续上涨', () => {
  ui().state.running = false;
  ui().state.endedAt = h.now();
  ui().renderStats();
  const frozen = txt('elapsedText');

  h.advance(60000); // 关掉任务后在界面上挂一分钟
  ui().renderStats();
  assert.strictEqual(txt('elapsedText'), frozen, '结束后 elapsedText 应冻结在 endedAt');
  assert.strictEqual(txt('etaText'), '—');
});

section('单作品：跨平台链接');
t('粘贴它家平台的单作品链接 → 出现「切换到 XX 并继续」按钮', async () => {
  h.setInspect({
    mode: 'single', platform: 'douyin', platformName: '抖音', itemId: '7300000000000000000',
    shortLink: false, mismatch: true, currentName: '微博',
  });
  el('inputUid').value = 'https://www.douyin.com/video/7300000000000000000';
  el('inputUid').fire('input');
  await new Promise((r) => setTimeout(r, 320)); // 等 runInspect 的 180ms 防抖
  h.pumpFrames();

  const btn = el('btnSwitchPlatform');
  assert.strictEqual(btn.hidden, false, 'mismatch 时应显示切换按钮');
  assert.strictEqual(btn.dataset.platform, 'douyin');
  assert.ok(btn.textContent.includes('抖音'), btn.textContent);
  assert.ok(el('inputModeText').textContent.includes('抖音'), '提示文案应说明是哪家的链接');
  assert.ok(el('inputMode').classList.contains('warn'));
});

t('点「切换」后平台换过去，且用户刚粘的链接不被覆盖', async () => {
  const before = el('inputUid').value;
  el('btnSwitchPlatform').fire('click');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(ui().state.platform, 'douyin');
  assert.strictEqual(el('inputUid').value, before, '切平台会换输入框内容，必须把用户粘的链接放回去');
});

t('链接属于当前平台时，切换按钮收起', async () => {
  h.setInspect({
    mode: 'single', platform: 'douyin', platformName: '抖音', itemId: '7300000000000000000',
    shortLink: false, mismatch: false, currentName: '抖音',
  });
  el('inputUid').value = 'https://www.douyin.com/video/7300000000000000000';
  el('inputUid').fire('input');
  await new Promise((r) => setTimeout(r, 320));
  assert.strictEqual(el('btnSwitchPlatform').hidden, true);
  assert.ok(el('inputModeText').textContent.includes('只下载这一个作品'));
});

section('批量作品：混入噪声与它家平台');
t('批量提示把「下几个 / 跳过几条 / 展开短链」一次说清，且不给一键切换（多家混着）', async () => {
  h.setInspect({
    mode: 'batch', total: 5, count: 0, alienCount: 5, ignoredCount: 2,
    hasShortLink: true, mismatch: true, otherPlatforms: '抖音、小红书',
    otherPlatformIds: ['douyin', 'xhs'], currentName: '微博',
  });
  el('inputUid').value = 'a\nb\nc\nd\ne';
  el('inputUid').fire('input');
  await new Promise((r) => setTimeout(r, 320));
  assert.ok(el('inputModeText').textContent.includes('抖音、小红书'));
  assert.strictEqual(el('btnSwitchPlatform').hidden, true, '多家混着时不该给「切到某一家」的按钮');

  h.setInspect({
    mode: 'batch', total: 3, count: 3, alienCount: 0, ignoredCount: 1,
    hasShortLink: true, mismatch: false, otherPlatforms: '', otherPlatformIds: [], currentName: '微博',
  });
  el('inputUid').fire('input');
  await new Promise((r) => setTimeout(r, 320));
  const msg = el('inputModeText').textContent;
  assert.ok(/识别到 3 条链接/.test(msg), msg);
  assert.ok(/1 行无法识别/.test(msg), msg);
  assert.ok(/含短链/.test(msg), msg);
  assert.strictEqual(el('btnSwitchPlatform').hidden, true);
});

section('输入类型说明：让「单条作品下载」在界面上看得见');

t('常驻显示三种输入类型，并明确写出「单个作品只下载这一条」', () => {
  const box = el('inputKinds');
  assert.ok(box, 'index.html 应有 #inputKinds —— 单条作品功能过去完全不可见，就是缺了这一块');
  const kinds = box.children.filter((c) => c.classList.contains('kind'));
  const tags = kinds.map((c) => c.children.find((x) => x.classList.contains('k-tag')).textContent);
  assert.deepStrictEqual(tags, ['博主主页', '单个作品', '多个作品']);

  const text = box.allText();
  assert.ok(/只下载这一条/.test(text), `必须明确写出单个作品的行为：${text}`);
  assert.ok(/不需要手动切换模式/.test(text), `要说明「粘贴后自动识别」，否则用户不知道该粘什么：${text}`);
});

t('示例链接随平台切换变化（渲染层不写平台判断，全靠适配器给的 inputMeta）', async () => {
  const expectHost = { weibo: 'weibo.com', xhs: 'xiaohongshu.com', douyin: 'douyin.com' };
  const tabs = el('tabs').children;
  const seen = [];
  for (const tab of tabs) {
    el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? tab : null) } });
    await new Promise((r) => setTimeout(r, 80));
    const id = ui().state.platform;
    const item = txt('egItem');
    const profile = txt('egProfile');
    assert.ok(expectHost[id], '未知平台 ' + id);
    assert.ok(
      item.includes(expectHost[id]),
      `${id} 的「单个作品」示例不是本平台域名：${item}`
    );
    assert.ok(
      profile.includes(expectHost[id]),
      `${id} 的「博主主页」示例不是本平台域名：${profile}`
    );
    assert.ok(!/^—$/.test(item) && !/^—$/.test(profile), `${id} 的示例没有渲染出来`);
    seen.push(item);
  }
  assert.strictEqual(new Set(seen).size, tabs.length, '三个平台的示例应各不相同');

  // 切回微博，避免影响后续（本文件靠后新增用例时要注意平台状态）
  const back = tabs.find((c) => c.dataset.platform === 'weibo');
  el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? back : null) } });
  await new Promise((r) => setTimeout(r, 80));
});

section('布局重排：当前网站 / 目标地址 / 选项分组');

t('登录区常驻显示当前网站域名，并随平台切换', async () => {
  const chip = el('authSite');
  assert.ok(chip, 'index.html 的登录区必须有 #authSite —— 用户要一眼看到自己正在操作哪个站点');

  // 必须在顶栏登录区内：放到页面别处就起不到「登录时说清站点」的作用
  let node = chip.parentNode;
  let inAuth = false;
  while (node) {
    if (node.classList && node.classList.contains('auth')) { inAuth = true; break; }
    node = node.parentNode;
  }
  assert.ok(inAuth, '#authSite 必须在 .auth 登录区内');

  const expect = { weibo: 'weibo.com', xhs: 'xiaohongshu.com', douyin: 'douyin.com' };
  const tabs = el('tabs').children;
  for (const tab of tabs) {
    el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? tab : null) } });
    await new Promise((r) => setTimeout(r, 80));
    const id = ui().state.platform;
    assert.ok(expect[id], '未知平台 ' + id);
    assert.strictEqual(txt('authSite'), expect[id], `${id} 的域名徽章显示不对`);
    assert.ok(
      String(chip.dataset.url || '').startsWith('https://'),
      `${id} 的徽章要带完整地址（点击复制用）：${chip.dataset.url}`
    );
  }

  // 点击即复制完整地址，不额外占一个按钮位
  h.copied.length = 0;
  chip.fire('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(h.copied.length, 1, '点域名徽章应复制当前网站地址');
  assert.ok(/^https:\/\//.test(h.copied[0]), `复制的内容应是完整 URL：${h.copied[0]}`);

  // 切回微博，避免影响后面的用例（本文件靠后的断言按微博的选项写）
  const back = tabs.find((c) => c.dataset.platform === 'weibo');
  el('tabs').fire('click', { target: { closest: (sel) => (sel === '.tab' ? back : null) } });
  await new Promise((r) => setTimeout(r, 80));
});

t('目标地址显示在输入卡片的动作行里，且与快捷键提示互斥', () => {
  const inline = el('targetInline');
  assert.ok(inline, 'index.html 必须有 #targetInline');

  let node = inline.parentNode;
  let inComposer = false;
  while (node) {
    if (node.classList && node.classList.contains('composer')) { inComposer = true; break; }
    node = node.parentNode;
  }
  assert.ok(inComposer, '#targetInline 必须在输入卡片内（它跟着「开始下载」走，不再埋在右栏底部）');

  // 空输入：只剩快捷键提示
  const box = el('inputUid');
  box.value = '';
  box.fire('input');
  assert.strictEqual(inline.hidden, true, '没有输入时不该显示一个空的目标地址');
  assert.strictEqual(el('pasteHint').hidden, false, '没有输入时应显示快捷键提示');

  // 有输入：换成目标地址
  box.value = 'https://weibo.com/u/1234567890';
  box.fire('input');
  assert.strictEqual(inline.hidden, false, '有输入时必须显示解析到的目标地址');
  assert.strictEqual(el('pasteHint').hidden, true, '两种状态互斥，不能同时占着这一行');
  assert.strictEqual(txt('targetUrl'), 'https://weibo.com/u/1234567890');

  box.value = '';
  box.fire('input');
});

t('数字项前插入了「抓取范围与并发」分组标题，且只有一个', () => {
  const box = el('options');
  const subs = box.children.filter((c) => c.classList && c.classList.contains('grid-sub'));
  assert.strictEqual(subs.length, 1, '只应有一个数字分组标题（每个数字项都插一次就错了）');
  assert.strictEqual(subs[0].textContent, '抓取范围与并发');

  const firstNum = box.children.find((c) => c.classList && c.classList.contains('num'));
  assert.ok(firstNum, '微博面板应有数字项');
  const iSub = box.children.indexOf(subs[0]);
  const iNum = box.children.indexOf(firstNum);
  assert.ok(iSub < iNum, '分组标题必须在第一个数字项之前');
  assert.strictEqual(iSub + 1, iNum, '分组标题应紧贴第一个数字项，中间不能夹着勾选项');

  // 分组标题不能干扰「只对主页模式生效」的显隐逻辑：它没有 scope，任何模式下都不隐藏
  ui().applyOptionScope('single');
  assert.strictEqual(subs[0].hidden, false, '分组标题不该被 applyOptionScope 误隐藏');
  ui().applyOptionScope('profile');
});

/* ------------------------------- 运行 ------------------------------- */

(async function main() {
  await new Promise((r) => setTimeout(r, 40)); // 等 init() 的 await 走完
  let pass = 0;
  let fail = 0;
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
      console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
    }
  }
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
