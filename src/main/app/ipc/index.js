/**
 * IPC 注册表（唯一入口）
 *
 * 为什么要有这一层包装器，而不是各模块直接 `ipcMain.handle(...)`：
 *
 *   1. **重复注册会静默覆盖**。`ipcMain.handle` 对同名通道后来者获胜，不报错；
 *      拆分之后有五个文件都能注册通道，一旦两处写了同一个名字，
 *      表现是「某个功能偶尔按旧逻辑跑」—— 这是最难查的一类回归。
 *      所以这里先记账，撞名直接 **throw**，把问题挡在启动那一刻。
 *
 *   2. **通道清单必须是可数的**。`test/ipc-contract.test.js` 要能拿一份
 *      「主进程注册了哪些通道」的权威列表，去比对 preload 暴露的调用面 ——
 *      漏注册、多注册、拼错名字都能在纯 Node 下断言出来，不必真机点一遍。
 *
 * 约定：每个 `ipc/*.js` 只导出 `register(reg, ctx)` 与自己的 `HANDLE_CHANNELS`
 * / `ON_CHANNELS` 清单；清单与实际注册必须一一对应（contract 测试会核对）。
 */
const appInfo = require('./app-info');
const settings = require('./settings');
const input = require('./input');
const auth = require('./auth');
const task = require('./task');

/** 参与聚合的模块（顺序即注册顺序，不影响语义） */
const MODULES = [appInfo, settings, input, auth, task];

/**
 * 通道清单：`{ handle: [...], on: [...] }`，均已排序去重。
 *
 * 由各模块自报拼出来，而不是在别处再抄一遍 —— 抄一遍就等于给了「清单与实现脱节」的机会。
 */
const IPC_CHANNELS = {
  handle: MODULES.flatMap((m) => m.HANDLE_CHANNELS || []).sort(),
  on: MODULES.flatMap((m) => m.ON_CHANNELS || []).sort(),
};

/** 全部通道名（含 on），给「有没有重复」这类断言用 */
const ALL_CHANNELS = [...IPC_CHANNELS.handle, ...IPC_CHANNELS.on].sort();

/**
 * 每个 ipcMain 一份「已注册通道」账本。
 *
 * 为什么放在模块级而不是 registrar 实例里：`registerAll` 每次都会新建一个 registrar，
 * 若账本跟着实例走，那么「whenReady 被触发两次 → registerAll 跑两遍」这种情况
 * 第二遍就什么也发现不了（新实例、空账本），Electron 那边则会静默覆盖 handler。
 * 账本按 ipcMain 对象索引（WeakMap，不阻止回收），才真正守得住「注册两遍」。
 */
const REGISTRIES = new WeakMap();

/**
 * 取（必要时创建）某个 ipcMain 的账本。
 *
 * @param {object} ipcMain
 * @returns {Map<string,string>} channel -> 'handle' | 'on'
 */
function registryOf(ipcMain) {
  let book = REGISTRIES.get(ipcMain);
  if (!book) {
    book = new Map();
    REGISTRIES.set(ipcMain, book);
  }
  return book;
}

/**
 * 建一个记账用的注册器。
 *
 * @param {object} ipcMain Electron 的 ipcMain（测试可传替身）
 * @returns {{
 *   handle: (channel:string, fn:Function) => void,
 *   on: (channel:string, fn:Function) => void,
 *   channels: () => Array<{channel:string,kind:string}>,
 * }}
 */
function createRegistrar(ipcMain) {
  const seen = registryOf(ipcMain);

  /**
   * 占坑：同名通道（哪怕是 handle vs on 混着来）一律抛。
   *
   * 混着来也必须拦：同一个名字既是 `handle` 又是 `on` 时，`invoke` 只在
   * handle 那一侧有响应，on 那一侧收到的是 `send` —— 两条语义并存，没人能在
   * 一年后说清哪个才是对的。
   */
  const claim = (channel, kind) => {
    if (seen.has(channel)) {
      throw new Error(
        `IPC 通道被重复注册：${channel}（已注册为 ${seen.get(channel)}，又要注册为 ${kind}）`
      );
    }
    seen.set(channel, kind);
  };

  return {
    handle(channel, fn) {
      claim(channel, 'handle');
      ipcMain.handle(channel, fn);
    },
    on(channel, fn) {
      claim(channel, 'on');
      ipcMain.on(channel, fn);
    },
    channels() {
      return [...seen.entries()]
        .map(([channel, kind]) => ({ channel, kind }))
        .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
    },
  };
}

/**
 * 注册全部 IPC 通道。**只能在 app ready 之后调用一次**（重复调用会触发上面的撞名 throw）。
 *
 * @param {object} ctx 运行上下文（见 app/context.js）
 * @param {object} [deps] 依赖注入，仅测试用：`{ ipcMain }`
 * @returns {ReturnType<typeof createRegistrar>} 注册器（测试可读 channels() 核对）
 */
function registerAll(ctx, deps = {}) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const reg = createRegistrar(ipcMain);
  for (const m of MODULES) m.register(reg, ctx, deps);
  return reg;
}

module.exports = { registerAll, createRegistrar, IPC_CHANNELS, ALL_CHANNELS };
