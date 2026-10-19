/**
 * 抖音输入守门（第 20 轮，用户 2026-10-16 的日志直接促成）
 *
 * 日志事实：连续三次「任务开始（博主主页）」的输入其实是抖音的搜索/精选结果页
 * （`douyin.com/jingxuan/search/爱心代码?aid=…&type=general`）。解析层认不出作品 id
 * 就返回 null，而 null 的语义是「按博主主页处理」，于是这些链接被静默降级成主页采集：
 * 打开搜索页 → 截获 0 个响应 → 重载一次再等 20~40 秒 → 抛出一句把原因指向
 * 「① 已登录 ② 链接正确 ③ 页面能显示作品」的错。用户看到的是「抖音这条视频下不了」。
 *
 * 这个文件锁三件事：
 *   ① 链接判定：哪些链接一定不能当主页处理、哪些必须继续当主页处理（**尤其别把主页降级成单作品**）
 *   ② 适配器守门：抖音适配器要在**开浏览器之前**就拒绝，而不是白跑一次采集
 *   ③ 界面提示：主进程判定为 invalid 时，界面要提前把话说清楚（且不擅自禁掉开始按钮）
 *
 * 跑法：node test/douyin-input-guard.test.js
 */

const assert = require('assert');
const Module = require('module');

/** 让 require('electron') 解析到测试桩（三平台适配器在模块顶层就要 BrowserWindow） */
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
const douyin = registry.get('douyin');
const {
  parseSingleUrl,
  parseInputList,
  classifyDouyinUrl,
  douyinInputProblem,
  extractUrl,
} = require('../src/main/url-parse');

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
    failures.push(name + ' -> ' + (e && e.message));
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

const SECTION = (name) => console.log(`\n${name}`);

/** 判定的简写：给原始文本，回 kind */
function kindOf(text) {
  return classifyDouyinUrl(new URL(extractUrl(text) || text)).kind;
}

/* ---------------------------- ① 链接判定 ---------------------------- */

// 示例值：`aid` 用全零 UUID —— 原值是从真实日志里截的请求标识，仓库里一律不写真值
const LOG_URL =
  'https://www.douyin.com/jingxuan/search/%E7%88%B1%E5%BF%83%E4%BB%A3%E7%A0%81?aid=00000000-0000-0000-0000-000000000000&type=general';

/**
 * 示例值，非真实账号。
 *
 * 抖音 sec_uid 的字符集是 `[A-Za-z0-9_-]`（见 url-parse.js 的 `/user/<sec_uid>` 判定），
 * 所以占位串只能用肉眼可辨的字母串，不能带 `<>` —— 带了就会掉出「主页」分支。
 */
const PROFILE_URL =
  'https://www.douyin.com/user/MS4wLjABAAAAexampleSecUidPLACEHOLDER00';

/** 示例值：19 位纯数字（抖音作品 id 的形状），非真实作品 */
const ITEM_ID = '1234567890123456789';

(async function main() {
  SECTION('[链接判定]');

  await t('日志里那条搜索页链接被判成 search，并给出「怎么粘链接」的说明', () => {
    assert.strictEqual(kindOf(LOG_URL), 'search');
    const problem = douyinInputProblem(LOG_URL);
    assert.ok(/搜索/.test(problem), problem);
    assert.ok(/\/video\/|modal_id/.test(problem), '说明里要写清正确的链接长什么样');
  });

  await t('搜索页的几种形态（/search、/jingxuan/search）都被拦', () => {
    for (const u of [
      'https://www.douyin.com/search/%E7%88%B1%E5%BF%83%E4%BB%A3%E7%A0%81?type=video',
      'https://www.douyin.com/jingxuan/search/abc?type=general',
      'https://www.douyin.com/hashtag/12345',
    ]) {
      assert.strictEqual(kindOf(u), 'search', u);
      assert.ok(douyinInputProblem(u), `应给出说明：${u}`);
    }
  });

  await t('信息流页（首页 / 精选 / 发现 / 热门 / 直播）都被拦', () => {
    for (const u of [
      'https://www.douyin.com/',
      'https://www.douyin.com/jingxuan',
      'https://www.douyin.com/discover',
      'https://www.douyin.com/hot',
      'https://www.douyin.com/live/123',
    ]) {
      assert.strictEqual(kindOf(u), 'feed', u);
      assert.match(douyinInputProblem(u), /信息流|精选/, u);
    }
  });

  await t('看着像作品页但 id 不完整（被截断）→ 单独一句话，提示重新复制', () => {
    assert.strictEqual(kindOf('https://www.douyin.com/video/123'), 'workNoId');
    assert.match(douyinInputProblem('https://www.douyin.com/video/123'), /作品 id/);
    assert.strictEqual(parseSingleUrl('https://www.douyin.com/video/123'), null);
  });

  await t('博主主页链接一律不拦（含主页下的子页）', () => {
    for (const u of [PROFILE_URL, `${PROFILE_URL}/video`, `${PROFILE_URL}/fans`]) {
      assert.strictEqual(kindOf(u), 'profile', u);
      assert.strictEqual(douyinInputProblem(u), '', u);
      assert.strictEqual(parseSingleUrl(u), null, `${u} 必须继续走博主主页流程`);
    }
  });

  await t('主页链接带 vid= 出处参数时**仍然是主页**（绝不能被降级成单作品）', () => {
    // 这就是日志最后一行那个形态：从某条视频点进博主主页，地址上会留下 from_gid/vid
    const u =
      `${PROFILE_URL}?enter_from=author_card&from_gid=${ITEM_ID}` +
      `&from_tab_name=main&tab_name=discover&vid=${ITEM_ID}`;
    assert.strictEqual(kindOf(u), 'profile');
    assert.strictEqual(parseSingleUrl(u), null, '把它当成单作品 = 用户要下整个主页，结果只下了一条');
    assert.strictEqual(douyinInputProblem(u), '');
  });

  await t('信息流页带 vid= 时算作品（「正在播放的那条」可以下）', () => {
    for (const u of [
      `https://www.douyin.com/?vid=${ITEM_ID}`,
      `https://www.douyin.com/discover?vid=${ITEM_ID}`,
      `https://www.douyin.com/jingxuan?vid=${ITEM_ID}`,
    ]) {
      const r = parseSingleUrl(u);
      assert.ok(r, `应识别为单作品：${u}`);
      assert.strictEqual(r.itemId, ITEM_ID, u);
      assert.strictEqual(r.url, `https://www.douyin.com/video/${ITEM_ID}`, u);
      assert.strictEqual(douyinInputProblem(u), '', u);
    }
  });

  await t('路径里的 id 优先于 vid / modal_id（不能把指定作品换掉）', () => {
    assert.strictEqual(
      parseSingleUrl(`https://www.douyin.com/video/${ITEM_ID}?vid=7300000000000000000`).itemId,
      ITEM_ID
    );
    assert.strictEqual(
      parseSingleUrl(`https://www.douyin.com/user/MS4wLjABAAAAxxxx?modal_id=${ITEM_ID}`).itemId,
      ITEM_ID,
      '/user/<uid>?modal_id= 是「主页里点开的那条作品」，旧行为必须保留'
    );
  });

  await t('认不出来的形态一律放行（宁可多跑一次，也不误拦主页）', () => {
    for (const u of [
      'https://www.iesdouyin.com/share/user/MS4wLjABAAAAxxxx',
      'https://www.douyin.com/share/user/MS4wLjABAAAAxxxx',
      'https://www.douyin.com/some/new/page',
    ]) {
      assert.strictEqual(kindOf(u), 'unknown', u);
      assert.strictEqual(douyinInputProblem(u), '', u);
    }
  });

  await t('别家平台与短链完全不受影响', () => {
    for (const u of [
      'https://weibo.com/1234567890/P0RSTabcde',
      'https://www.xiaohongshu.com/explore/EXAMPLE0000000000000000', // 示例值，非真实笔记
      'https://v.douyin.com/iRNBho6/',
    ]) {
      assert.strictEqual(douyinInputProblem(u), '', u);
    }
  });

  await t('批量模式下跳过搜索页时，原因不能写成「这是博主主页链接」', () => {
    const r = parseInputList(`https://www.douyin.com/video/${ITEM_ID}\n${LOG_URL}`);
    assert.strictEqual(r.targets.length, 1, '作品链接要留下');
    assert.strictEqual(r.ignored.length, 1, '搜索页要被跳过并说明原因');
    assert.ok(/搜索结果/.test(r.ignored[0].reason), r.ignored[0].reason);
    assert.ok(!/主页/.test(r.ignored[0].reason), `别把搜索页说成主页链接：${r.ignored[0].reason}`);
  });

  SECTION('[适配器守门]');

  await t('douyin.inspectInput：搜索页给说明，主页返回 null', () => {
    const bad = douyin.inspectInput(LOG_URL);
    assert.ok(bad && /搜索/.test(bad.problem), JSON.stringify(bad));
    assert.strictEqual(douyin.inspectInput(PROFILE_URL), null);
    assert.strictEqual(douyin.inspectInput(`https://www.douyin.com/video/${ITEM_ID}`), null);
  });

  await t('collectItems 在**开浏览器之前**就拒绝（不白跑那 20~40 秒）', async () => {
    const args = {
      input: LOG_URL,
      ctx: { partition: 'persist:douyin' },
      emit: () => {},
      log: () => {},
      setCollector: () => {},
    };
    await assert.rejects(
      () => douyin.collectItems(args),
      (err) => {
        // 守门在构造 Harvester 之前 —— 所以绝不该出现「采集失败：…」（那是走完流程才可能有的包壳）
        assert.ok(!/采集失败/.test(err.message), `守门位置不对，已经开过采集了：${err.message}`);
        assert.ok(/搜索/.test(err.message), err.message);
        return true;
      }
    );
  });

  await t('collectItems 不会误拦主页链接（继续往下走，不是被守门拒绝）', async () => {
    // 主页链接会真的去开浏览器（纯 Node 下必然失败），关键是**失败原因不能是守门那句话**
    let message = '';
    try {
      await douyin.collectItems({
        input: PROFILE_URL,
        ctx: { partition: 'persist:douyin' },
        emit: () => {},
        log: () => {},
        setCollector: () => {},
      });
    } catch (err) {
      message = err.message;
    }
    assert.ok(!/搜索结果|信息流页|作品 id/.test(message), `主页链接不该被守门拒绝：${message}`);
  });

  SECTION('[界面提示]');

  const { createHarness } = require('./lib/renderer-harness');
  let started = 0;
  const h = createHarness({ api: { start: async () => { started++; return {}; } } });
  const el = h.el;
  const ui = () => h.ui();
  const tick = (ms = 320) => new Promise((r) => setTimeout(r, ms));
  await tick(60); // 等 init() 走完

  await t('判定为 invalid 时：提示条可见、warn 样式、文案原样透传', async () => {
    h.setInspect({
      mode: 'invalid',
      currentName: '抖音',
      text: '这条链接是抖音的搜索结果 / 话题页，里面没有作品 id，没法下载。',
    });
    el('inputUid').value = LOG_URL;
    el('inputUid').fire('input');
    await tick();
    h.pumpFrames();

    assert.strictEqual(el('inputMode').hidden, false, '提前说了才有意义，不能藏起来');
    assert.strictEqual(el('inputMode').classList.contains('warn'), true, '要按警告样式展示');
    assert.ok(el('inputModeText').textContent.includes('搜索结果'), el('inputModeText').textContent);
    assert.strictEqual(el('btnSwitchPlatform').hidden, true, '这条链接不属于别家平台，不该给切换按钮');
  });

  await t('invalid 不禁用开始按钮，用户仍然能跑（判定错了也不会被拦死）', async () => {
    el('inputDir').value = 'D:\\out';
    el('btnStart').fire('click');
    await tick(60);
    assert.strictEqual(started, 1, '按钮被禁用或没接线，用户就没有退路了');
    // 收尾，免得影响后续用例
    h.H({ type: 'phase', phase: 'done', message: '收尾', rootDir: 'D:\\out' });
  });

  await t('回到正常主页链接后，invalid 的提示要收回去', async () => {
    h.setInspect({ mode: 'profile', currentName: '抖音' });
    el('inputUid').value = PROFILE_URL;
    el('inputUid').fire('input');
    await tick();
    assert.strictEqual(el('inputMode').hidden, true, '旧警告残留会让人以为这条链接也有问题');
    assert.strictEqual(ui().state.inputMode, 'profile');
  });

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
