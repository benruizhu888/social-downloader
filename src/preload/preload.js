const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 所有凭证相关调用都带上 platform，三个平台的登录态互不干扰
  authStatus: (platform) => ipcRenderer.invoke('auth:status', platform),
  openLogin: (platform) => ipcRenderer.invoke('auth:openLogin', platform),
  setCookie: (platform, str) => ipcRenderer.invoke('auth:setCookie', platform, str),
  logout: (platform) => ipcRenderer.invoke('auth:logout', platform),

  // 复制/打开链接
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openSite: (platform) => ipcRenderer.invoke('shell:openSite', platform),
  loginUrl: (platform) => ipcRenderer.invoke('login:url', platform),

  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  checkFFmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  /**
   * 输入框里粘的是「博主主页」还是「单个作品」。
   * 判定逻辑只有主进程一份（与真正决定流程的那份代码同源），界面只负责展示结论。
   */
  inspectInput: (payload) => ipcRenderer.invoke('input:inspect', payload),
  start: (payload) => ipcRenderer.invoke('task:start', payload),
  stop: () => ipcRenderer.invoke('task:stop'),
  openFolder: (dir) => ipcRenderer.invoke('shell:open', dir),
  exportLog: (text) => ipcRenderer.invoke('log:export', text),
  onEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('task:event', handler);
    return () => ipcRenderer.removeListener('task:event', handler);
  },
});
