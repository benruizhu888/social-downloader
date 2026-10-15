/**
 * 采集窗口的注入脚本（页面 JS 之前执行）
 *
 * 思路：小红书的 x-s、抖音的 a_bogus 都由页面自身的混淆 JS 实时生成，
 * 逆向代价极高且随时失效。与其破解签名，不如让页面自己发请求，
 * 我们在 fetch / XHR 层把响应复制一份出来 —— 签名问题被彻底绕开。
 */
const { ipcRenderer } = require('electron');

/**
 * 判定函数由主进程通过 `additionalArguments` 传进来。
 *
 * 为什么不 `require('./harvest-match')`：采集窗是 sandbox 化的，
 * 沙箱 preload 里的 `require` 只认 electron / events / timers / url，
 * 相对路径直接 `module not found`（真机实测），而 preload 一挂，
 * 症状是**采集永远 0 个作品**，不是任何看得见的报错。
 * 详见 src/preload/harvest-match.js 的模块注释。
 */
const ARG_MATCH = '--harvest-match=';
const ARG_COARSE = '--harvest-coarse=';

function sourceOf(name) {
  try {
    const argv = process.argv || [];
    for (const a of argv) {
      if (typeof a === 'string' && a.indexOf(name) === 0) return a.slice(name.length);
    }
  } catch {
    /* 取不到就当没传 */
  }
  return '';
}

function compile(name) {
  const src = sourceOf(name);
  if (!src) return null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (' + src + ')')();
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

const exact = compile(ARG_MATCH);
const coarse = compile(ARG_COARSE);
/**
 * 用的是哪一档判定：
 *   injected 主进程传下来的精确判定（正常情况）
 *   coarse   只传了粗筛（接线半通）
 *   all      什么都没传（不该发生）：退化成「全截」
 * 后两种都要在主进程里报出来 —— 否则「喜欢被一起下载」这种问题
 * 会以「日志一切正常」的形态复发。
 */
const MATCH_MODE = exact ? 'injected' : coarse ? 'coarse' : 'all';
const matches = exact || coarse || (() => true);
try {
  ipcRenderer.send('harvest:match-mode', MATCH_MODE);
} catch {
  /* 通道不可用时静默 */
}

function emit(url, data) {
  try {
    ipcRenderer.send('harvest:data', { url: String(url || ''), data });
  } catch {
    /* 通道不可用时静默 */
  }
}

/* ------------------------------- fetch ------------------------------- */
const origFetch = window.fetch;
if (typeof origFetch === 'function') {
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((res) => {
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        if (matches(url) && res && res.ok) {
          res
            .clone()
            .json()
            .then((data) => emit(url, data))
            .catch(() => {});
        }
      } catch {
        /* 忽略，绝不能影响页面正常逻辑 */
      }
      return res;
    });
  };
}

/* --------------------------- XMLHttpRequest --------------------------- */
const Proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
if (Proto) {
  const origOpen = Proto.open;
  const origSend = Proto.send;

  Proto.open = function (method, url, ...rest) {
    try {
      this.__harvestUrl = String(url || '');
    } catch {
      /* 忽略 */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  Proto.send = function (...args) {
    try {
      if (matches(this.__harvestUrl)) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              emit(this.__harvestUrl, JSON.parse(this.responseText));
            }
          } catch {
            /* 非 JSON 或已失效，忽略 */
          }
        });
      }
    } catch {
      /* 忽略 */
    }
    return origSend.apply(this, args);
  };
}
