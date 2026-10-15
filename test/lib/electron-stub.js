/**
 * 极简 electron 桩（仅供纯 Node 单测使用）
 *
 * 采集器与平台适配器在模块顶层就 `const { BrowserWindow } = require('electron')`，
 * 于是纯 Node 里 require 不到三平台注册表，也就没法验证「三平台契约」。
 * 这里只补上加载期真正会被解构到的那几个名字 —— 不模拟任何行为，
 * 需要行为的地方一律由测试自己注入替身。
 */

class BrowserWindow {}

module.exports = {
  BrowserWindow,
  app: {},
  ipcMain: {},
  dialog: {},
  session: {},
  shell: {},
  safeStorage: {},
  clipboard: {},
  webContents: { getAllWebContents: () => [] },
};
