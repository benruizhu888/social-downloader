/**
 * 平台注册表
 *
 * 三个平台各自是一个独立模块，只暴露统一的适配器接口。
 * 主进程与渲染层都只认这个接口，不感知平台内部实现，
 * 因此互不影响 —— 微博的接口直连逻辑不会碰到小红书/抖音的浏览器采集逻辑，反之亦然。
 */
const weibo = require('./weibo');
const xhs = require('./xhs');
const douyin = require('./douyin');

const list = [weibo, xhs, douyin];
const byId = Object.create(null);
for (const p of list) byId[p.id] = p;

const DEFAULT_PLATFORM = 'weibo';

function get(id) {
  return byId[id] || null;
}

/** 只把可序列化的元信息发给渲染层（函数不能过 IPC） */
function describe(p) {
  return {
    id: p.id,
    name: p.name,
    siteURL: p.siteURL,
    /** 登录页地址：界面要在「还没打开登录窗」时就显示出来供复制 */
    loginURL: p.loginURL,
    partition: p.partition,
    inputMeta: p.inputMeta,
    optionsSchema: p.optionsSchema,
    defaultOptions: p.defaultOptions,
    supportsManualCookie: !!p.supportsManualCookie,
    supportsOnlyOriginal: !!p.supportsOnlyOriginal,
    // 能力位而不是平台 id：渲染层据此显示徽章，不需要认识任何具体平台
    supportsOriginalImage: !!p.supportsOriginalImage,
    supportsLivePhoto: !!p.supportsLivePhoto,
    needsBrowserHarvest: !!p.needsBrowserHarvest,
    /** 接口直连型平台：主进程要把分区 Cookie 注入 fetch（主进程据此分支，而不是认平台 id） */
    injectCookieIntoFetch: !!p.injectCookieIntoFetch,
    /** 关键 Cookie 存在即等价于已登录（该 Cookie 不会匿名下发时才能开） */
    trustKeyCookie: !!p.trustKeyCookie,
  };
}

function all() {
  return list.map(describe);
}

module.exports = { list, byId, get, all, describe, DEFAULT_PLATFORM };
