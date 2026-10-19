/**
 * 输入框判定 IPC
 *
 * 判定逻辑必须与「真正决定走哪条流程」的那一份**是同一份代码**（runner 里用的也是
 * url-parse）。界面自己再写一套正则，两边迟早跑偏 —— 那时用户看到的提示与
 * 实际发生的事对不上，是最难查的一类 bug。所以判定放在主进程，界面只负责展示结论。
 */
const registry = require('../../platforms/registry');
const { parseInputList, describeSingle } = require('../../url-parse');
const { normalizePlatform } = require('../auth');

const HANDLE_CHANNELS = ['input:inspect'];
const ON_CHANNELS = [];

/**
 * 依次问各平台适配器「这条输入有没有问题」，第一个给出说法的就用它。
 *
 * 为什么由适配器回答，而不是主进程自己认平台 id：三条主线（登录 / 采集 / 解析）
 * 都遵守「平台差异收敛在适配器里」这条规矩。主进程一旦开始按 id 分支，
 * 以后加平台就会漏改这里 —— 而漏改的表现是「某个平台的错误链接又白跑一次采集」。
 *
 * @param {string} input
 * @returns {string} 空串表示没人有意见
 */
function inputProblemOf(input) {
  for (const p of registry.list) {
    if (typeof p.inspectInput !== 'function') continue;
    try {
      const r = p.inspectInput(input);
      if (r && r.problem) return r.problem;
    } catch {
      /* 适配器自己的判断出错，不能让「输入检查」整体挂掉 */
    }
  }
  return '';
}

/**
 * 判定输入框里粘的是「博主主页」「单个作品」还是「一批作品链接」。
 *
 * 返回 `mode`：
 *   empty    没输入
 *   profile  不是作品链接（按原来的博主主页流程处理）
 *   invalid  是该平台的其它页面（例如抖音的搜索页/信息流页）—— 一定跑不出结果，附 `text` 说明
 *   single   一条作品链接
 *   batch    多行作品链接
 */
function inspect(ctx, payload) {
  const platform = normalizePlatform(payload?.platform);
  const cur = registry.get(platform);
  const curName = cur ? cur.name : '';
  const list = parseInputList(payload?.input);

  if (!list.lines) return { mode: 'empty' };

  const nameOf = (id) => {
    const p = id ? registry.get(id) : null;
    return p ? p.name : id || '';
  };

  // 单行 —— 保持与原行为完全一致
  if (list.lines === 1) {
    const r = list.targets[0];
    if (!r) {
      /**
       * 「不是作品链接」还有第二种可能：**它是这个平台的其它页面**
       * （抖音的搜索页 / 信息流页就是这种）。这类链接按博主主页处理只会白跑一次采集，
       * 于是先问一遍平台适配器 —— 由平台自己决定认不认得出来（见 douyin.inspectInput）。
       */
      const problem = inputProblemOf(payload?.input);
      if (problem) return { mode: 'invalid', currentName: curName, text: problem };
      return { mode: 'profile', currentName: curName };
    }
    return {
      mode: 'single',
      platform: r.platform || '',
      platformName: nameOf(r.platform),
      itemId: r.itemId || '',
      shortLink: !!r.shortLink,
      mismatch: !!r.platform && r.platform !== platform,
      currentName: curName,
      text: describeSingle(r, nameOf(r.platform)),
    };
  }

  // 多行 —— 批量。只统计**属于当前平台**的条数：混着别家平台的链接时，
  // 界面要说清楚「会下几个、会跳过几条」，而不是给一个含糊的总数。
  const total = list.targets.length;
  const mine = list.targets.filter((t) => !t.platform || t.platform === platform);
  const alien = total - mine.length;
  // 去重后的平台 id 与名字：界面在「全部属于另一家」时据此给一个一键切换的按钮
  const ownerIds = [...new Set(list.targets.map((t) => t.platform).filter(Boolean))];
  const owners = ownerIds.map((id) => nameOf(id)).join('、');

  return {
    mode: 'batch',
    total,
    count: mine.length,
    alienCount: alien,
    ignoredCount: list.ignored.length,
    hasShortLink: list.targets.some((t) => t.shortLink),
    mismatch: mine.length === 0,
    otherPlatforms: alien ? owners : '',
    otherPlatformIds: alien ? ownerIds : [],
    currentName: curName,
  };
}

function register(reg, ctx) {
  reg.handle('input:inspect', (e, payload) => inspect(ctx, payload));
}

module.exports = { register, inspect, inputProblemOf, HANDLE_CHANNELS, ON_CHANNELS };
