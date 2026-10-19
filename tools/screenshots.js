#!/usr/bin/env node
/**
 * 生成 README 用的界面截图（桌面端 + 窄屏各四个场景，共八张）。
 *
 * 为什么单独写一个编排脚本，而不是手写八条命令：
 *   ① 每张图要一套 `--window-size` + `--smoke-scene` + 各自的 `--user-data-dir`，
 *      手敲八遍迟早有一条敲错 —— 而敲错的后果不是报错，是「悄悄用了默认参数」，
 *      产出的图看着没问题，其实是错的（比如窗口没换尺寸、跑的还是 progress 场景）。
 *   ② 每张都**必须验证**载体 JSON 的 errors 为空才算成功：截图本身看不出界面是不是真的坏了
 *      （拿黑屏也能存成 PNG）。Makefile 式的「跑完就算赢」在这里不成立。
 *
 * 两种启动方式都支持（按 exe 旁边有没有 `resources/app.asar` 自动判断）：
 *   · 开发模式：exe 是 electron.exe → 传源码目录，截图反映**当前源码**；
 *   · 打包模式：exe 是已安装的应用 → 不传目录，截图反映**已安装的 asar**。
 *     后者会额外核对 asar 是否比源码旧，旧了就告警（否则 README 的图会落后一轮）。
 *
 * Electron 可执行文件在哪台机器的哪个盘因人而异 —— **不猜、不写死**：
 *   环境变量 SD_ELECTRON_EXE=<绝对路径>，或 --electron=<绝对路径>
 *   （例如把 .env.example 复制成 .env 后填 SD_ELECTRON_EXE=…）
 *
 * 用法：
 *   set SD_ELECTRON_EXE=<你的 Electron 可执行文件路径>
 *   node tools/screenshots.js                    # 全部八张
 *   node tools/screenshots.js 02                 # 只跑名字含 02 的那张（调试用）
 *
 * 产物（docs/screenshots/）：
 *   desktop-01-idle.png          桌面端干净首屏
 *   desktop-02-progress.png      下载进行中
 *   desktop-03-cookie-modal.png  手动 Cookie 弹窗
 *   desktop-04-logs.png          日志区（级别筛选 + 关键字检索）
 *   mobile-01-idle.png           窄屏首屏（单栏）
 *   mobile-02-progress.png       窄屏下载中
 *   mobile-03-cookie-modal.png   窄屏弹窗
 *   mobile-04-logs.png           窄屏日志
 * 中间产物（JSON / 临时登录目录）一律落在 work/screenshots/ 下 —— 它被 .gitignore 排除，
 * 尤其这些目录是 **Chromium 的用户数据目录**，会带上 Preferences / Local State / Session Storage。
 *
 * 退出码：全部成功 0，否则 1。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/**
 * 直接把**源码目录**当 app 交给 Electron 加载，而不是去动 resources/app.asar 里的旧包：
 * 截图必须反映当前代码，否则 README 上的图会是几轮改造之前的样子。
 */
const APP_DIR = ROOT;
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const WORK_DIR = path.join(ROOT, 'work', 'screenshots');

const DESKTOP = '1427x900';
const MOBILE = '527x700';

const SHOTS = [
  { name: 'desktop-01-idle', scene: 'idle', size: DESKTOP, desc: '干净首屏（默认平台 / 空输入 / 未开始）' },
  { name: 'desktop-02-progress', scene: 'progress', size: DESKTOP, desc: '下载进行中（进度条 + 并发细条 + 失败明细）' },
  { name: 'desktop-03-cookie-modal', scene: 'modal', size: DESKTOP, desc: '手动 Cookie 弹窗（微博）' },
  { name: 'desktop-04-logs', scene: 'logs', size: DESKTOP, desc: '日志区（级别筛选 + 关键字检索）' },
  { name: 'mobile-01-idle', scene: 'idle', size: MOBILE, desc: '窄屏首屏（单栏布局）' },
  { name: 'mobile-02-progress', scene: 'progress', size: MOBILE, desc: '窄屏下载中' },
  { name: 'mobile-03-cookie-modal', scene: 'modal', size: MOBILE, desc: '窄屏弹窗' },
  { name: 'mobile-04-logs', scene: 'logs', size: MOBILE, desc: '窄屏日志' },
];

/**
 * 单场景超时（毫秒）。
 *
 * 一次启动在这台机器上约 8~20 秒（含 1.8s 定帧等待与 rAF 合批），给 3 倍余量。
 * 超时按**失败**处理而不是跳过：卡住的窗口会把整批挂死，而挂死比报错难查得多。
 */
const PER_SCENE_TIMEOUT_MS = 90000;

const USAGE =
  '没有指定 Electron 可执行文件 —— 请先给出本机 Electron 的绝对路径，任选一种方式：\n' +
  '  1) 环境变量：SD_ELECTRON_EXE=<你的 Electron 可执行文件路径>\n' +
  '     Windows CMD:       set SD_ELECTRON_EXE=<路径>\\electron.exe\n' +
  '     Windows PowerShell: $env:SD_ELECTRON_EXE = "<路径>\\electron.exe"\n' +
  '  2) .env 文件：把仓库根目录的 .env.example 复制成 .env，填 SD_ELECTRON_EXE=…\n' +
  '  3) 命令行参数：node tools/screenshots.js --electron="<你的 Electron 可执行文件路径>"\n' +
  '\n本机路径不写进仓库 —— 它因人而异，写死只是把安装位置泄露出去。';

/**
 * Electron 可执行文件的路径：命令行参数 > 环境变量 > .env，都没有就报错退出。
 *
 * 取值顺序（与 tools/install-asar.js 的 SD_INSTALL_DIR 同一套约定）：
 *   1. 命令行参数 --electron=
 *   2. 环境变量 SD_ELECTRON_EXE
 *   3. 仓库根目录 .env 里的 SD_ELECTRON_EXE
 * 三者都没有就报错退出。
 *
 * @param {string[]} argv process.argv
 * @returns {string}
 */
function resolveElectronExe(argv) {
  const fromArg = (argv.find((a) => a.startsWith('--electron=')) || '')
    .slice('--electron='.length)
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2');
  const fromEnv = (process.env.SD_ELECTRON_EXE || '').trim() || readEnvFile('SD_ELECTRON_EXE');
  const exe = fromArg || fromEnv;
  if (exe) return path.resolve(exe);
  console.error(USAGE);
  process.exit(1);
}

/** 极简 .env 读取器（与 tools/install-asar.js 同一套约定：`KEY=VALUE`，`#` 为注释） */
function readEnvFile(key) {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    if (s.slice(0, eq).trim() !== key) continue;
    return s.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return '';
}

/**
 * 读 PNG 的宽高（只解 IHDR 前 8 字节，不引第三方库）。
 *
 * @param {string} file
 * @returns {{width:number, height:number}|null}
 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
  if (!isPng) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 这个 exe 是不是「已打包安装的应用」。
 *
 * 判据：同级目录下有 `resources/app.asar`。是的话它就是独立的 Electron 应用，
 * 传源码目录会被当成未知参数；不是的话（electron.exe）就必须把源码目录作为第一个参数。
 */
function isPackagedApp(exe) {
  try {
    return fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'));
  } catch {
    return false;
  }
}

/** 目录树里最新的修改时间；取不到就返回 0 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let items = [];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(d, it.name);
      if (it.isDirectory()) walk(abs);
      else {
        try {
          newest = Math.max(newest, fs.statSync(abs).mtimeMs);
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * 起一次 Electron，把界面摆成 item.scene 那个状态，取回截图与自检 JSON。
 *
 * 三个必须遵守的开关（都是踩过的坑）：
 *   · `ELECTRON_RUN_AS_NODE` 与 `NODE_OPTIONS` 必须**从环境里删掉**，否则 Electron 会
 *     以纯 Node 模式启动、把自己当成 `node app.js`，既不认 --window-size 也弹不出窗口。
 *   · `--disable-gpu --no-sandbox --disable-dev-shm-usage`：无 GPU / 受限容器里 capturePage
 *     要么全黑要么直接失败。
 *   · `--user-data-dir` 必须指向临时目录：否则会读到（并写脏）本机真实登录态。
 *
 * @param {string} exe Electron 可执行文件路径
 * @param {object} item SHOTS 里的一项
 * @param {boolean} packaged exe 是否已是打包好的应用
 * @returns {{ok:boolean, ms:number, detail:string, size?:{width:number,height:number}, bytes?:number}}
 */
function shoot(exe, item, packaged) {
  const started = Date.now();
  const jsonPath = path.join(WORK_DIR, `${item.name}.json`);
  const pngPath = path.join(WORK_DIR, `${item.name}.png`);
  const userData = path.join(WORK_DIR, `ud-${item.name}`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  /** 打包模式不能传目录：那是 electron.exe 的入口参数，独立应用会把它当未知参数 */
  const entry = packaged ? [] : [APP_DIR];
  const r = spawnSync(
    exe,
    [
      ...entry,
      `--smoke-out=${jsonPath}`,
      `--smoke-scene=${item.scene}`,
      `--user-data-dir=${userData}`,
      `--window-size=${item.size}`,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    { encoding: 'utf8', timeout: PER_SCENE_TIMEOUT_MS, windowsHide: true, env }
  );

  const timedOut = r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT');
  if (timedOut) {
    return { ok: false, ms: Date.now() - started, detail: `超过 ${PER_SCENE_TIMEOUT_MS / 1000}s 未结束` };
  }
  if (r.error) {
    return { ok: false, ms: Date.now() - started, detail: `启动失败：${r.error.message}` };
  }
  if (!fs.existsSync(jsonPath)) {
    const tail = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter(Boolean).slice(-3).join(' | ');
    return { ok: false, ms: Date.now() - started, detail: `没有产出自检 JSON（${tail}）` };
  }
  if (!fs.existsSync(pngPath)) {
    return { ok: false, ms: Date.now() - started, detail: '没有产出截图 PNG' };
  }

  /** 界面自检才是成败判据 —— 黑屏/半截界面也能存成一张 PNG */
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const errors = report.errors || [];
  const failedChecks = (report.probe && report.probe.checks ? report.probe.checks : []).filter((c) => !c.ok);
  const problems = [];
  if (errors.length) problems.push(...errors.map((e) => `[console] ${e}`));
  if (failedChecks.length) problems.push(...failedChecks.map((c) => `[check] ${c.name} —— 实测：${c.actual}`));
  if ((report.probe && report.probe.scene) !== item.scene) {
    problems.push(`场景不对：期望 ${item.scene}，实际 ${report.probe && report.probe.scene}`);
  }
  const size = pngSize(pngPath);
  if (!size) problems.push('产出文件不是合法 PNG');
  if (problems.length) {
    return { ok: false, ms: Date.now() - started, detail: problems.slice(0, 3).join('；') };
  }

  const dest = path.join(OUT_DIR, `${item.name}.png`);
  fs.copyFileSync(pngPath, dest);
  return {
    ok: true,
    ms: Date.now() - started,
    detail: `checks ${(report.probe.checks || []).length} 项全过`,
    size,
    bytes: fs.statSync(dest).size,
    viewport: report.probe.viewport,
  };
}

function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const exe = resolveElectronExe(process.argv);
  if (!fs.existsSync(exe)) {
    console.error(`Electron 可执行文件不存在：${exe}\n${USAGE}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const todo = SHOTS.filter((s) => !positional.length || positional.some((p) => s.name.includes(p)));
  if (!todo.length) {
    console.error(`没有匹配 ${positional.join(' / ')} 的截图（可用：${SHOTS.map((s) => s.name).join(', ')}）`);
    process.exit(1);
  }

  const packaged = isPackagedApp(exe);
  console.log(`Electron：${exe}`);
  console.log(`模式：${packaged ? '打包应用（截图取自已安装的 app.asar）' : '开发模式（截图取自当前源码）'}`);
  console.log(`工作目录：${WORK_DIR}`);
  console.log(`产物目录：${OUT_DIR}\n`);

  /**
   * 打包模式下 asar 可能落后于源码 —— 那样截出来的是上一轮的界面，
   * 而图看着完全正常，最难发现。这里直接比对修改时间并告警。
   */
  if (packaged) {
    const asar = path.join(path.dirname(exe), 'resources', 'app.asar');
    const srcNewest = newestMtime(path.join(ROOT, 'src'));
    const asarTime = fs.statSync(asar).mtimeMs;
    if (srcNewest > asarTime) {
      console.warn(
        '⚠ 已安装的 app.asar 比源码旧 —— 截图会反映旧界面。\n' +
          '  先执行 npm run pack 并安装（npm run install-asar -- "<resources 目录>"），再重跑本脚本。\n'
      );
    }
  }

  const rows = [];
  for (const item of todo) {
    process.stdout.write(`→ ${item.name}（${item.scene} @ ${item.size}）… `);
    const r = shoot(exe, item, packaged);
    rows.push({ item, r });
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.ms}ms  ${r.detail}`);
    if (r.ok) console.log(`      ${r.size.width}×${r.size.height}px  ${(r.bytes / 1024).toFixed(1)} KB  —— ${item.desc}`);
  }

  console.log('');
  for (const { item, r } of rows) {
    if (r.ok) console.log(`  ${item.name}.png  ${r.size.width}×${r.size.height}  ${(r.bytes / 1024).toFixed(1)} KB`);
  }
  const bad = rows.filter((x) => !x.r.ok);
  console.log('-'.repeat(52));
  console.log(`完成 ${rows.length - bad.length} / ${rows.length}${bad.length ? '   ★ 有失败' : '   全部成功'}`);
  process.exit(bad.length ? 1 : 0);
}

main();
