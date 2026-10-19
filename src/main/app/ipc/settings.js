/**
 * 设置相关 IPC
 *
 * 只有两条通道，但必须单独成文件：设置是「唯一会被频繁写盘」的地方，
 * 以后要加原子写（临时文件 + rename）或写合并时，改动应当只落在这一个文件里。
 */
const { loadSettings, saveSettings } = require('../settings');

const HANDLE_CHANNELS = ['settings:get', 'settings:set'];
const ON_CHANNELS = [];

function register(reg, ctx) {
  reg.handle('settings:get', () => loadSettings(ctx));
  // 渲染层可能传 null（清空表单时），归一成空对象，避免 saveSettings 内部解构炸掉
  reg.handle('settings:set', (e, patch) => saveSettings(ctx, patch || {}));
}

module.exports = { register, HANDLE_CHANNELS, ON_CHANNELS };
