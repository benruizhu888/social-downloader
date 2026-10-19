#!/usr/bin/env node
/**
 * 把打包好的 app.asar 安装到已安装的应用目录（**自动备份，可一键回滚**）
 *
 * ⚠️ 目标目录**没有默认值** —— 应用装在哪台机器的哪个盘因人而异，
 *    仓库里不该出现任何具体机器的路径。必须显式指定，否则脚本直接报错退出。
 *
 * 取值顺序（先到先得）：
 *   1. 环境变量 SD_INSTALL_DIR
 *   2. 仓库根目录 .env 里的 SD_INSTALL_DIR（把 .env.example 复制成 .env 后填写）
 *   3. 命令行参数
 *
 * 用法（把 `<你的应用安装目录>` 换成本机实际位置）：
 *   # ① 环境变量 · Windows CMD
 *   set SD_INSTALL_DIR=<你的应用安装目录>\resources
 *   node tools/install-asar.js
 *
 *   # ① 环境变量 · Windows PowerShell
 *   $env:SD_INSTALL_DIR = "<你的应用安装目录>\resources"
 *   node tools/install-asar.js
 *
 *   # ① 环境变量 · macOS / Linux
 *   SD_INSTALL_DIR="/path/to/<你的应用安装目录>/resources" node tools/install-asar.js
 *
 *   # ③ 命令行参数
 *   node tools/install-asar.js "<你的应用安装目录>/resources"
 *
 * 做了什么：
 *   1. 检查目标目录里确实有 app.asar（确认没指错地方）
 *   2. 把原 app.asar 复制成 app.asar.bak-<时间戳> —— **备份失败就中止，绝不覆盖**
 *   3. 用 dist/app.asar 覆盖上去
 *   4. 打印回滚命令
 *
 * ⚠️ 安装前必须完全退出应用：Windows 上正在运行的 Electron 会锁住 asar，
 *    覆盖会直接 EBUSY/EPERM 失败（脚本会捕获并提示，不会留下半截文件）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.resolve(__dirname, '..', 'dist', 'app.asar');

/**
 * 极简 `.env` 读取器（只支持一行一个 `KEY=VALUE`，`#` 开头为注释）。
 *
 * 为什么手写而不用 dotenv：本项目运行时零依赖（只依赖 ffmpeg-static），
 * 为一个安装脚本引入依赖不划算 —— 读 20 行文本用不上一个包。
 *
 * @param {string} key 变量名
 * @returns {string} 变量值；`.env` 不存在或没配这一项时返回 ''
 */
function readEnvFile(key) {
  const file = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    if (s.slice(0, eq).trim() !== key) continue;
    return s
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return '';
}

const USAGE =
  '没有指定安装目录 —— 请先给出「已安装应用的 resources 目录」，任选一种方式：\n' +
  '  1) 环境变量：SD_INSTALL_DIR=<你的应用安装目录>/resources\n' +
  '     Windows CMD:     set SD_INSTALL_DIR=<你的应用安装目录>\\resources\n' +
  '     Windows PowerShell: $env:SD_INSTALL_DIR = "<你的应用安装目录>\\resources"\n' +
  '  2) .env 文件：把仓库根目录的 .env.example 复制成 .env，填 SD_INSTALL_DIR=<你的应用安装目录>/resources\n' +
  '  3) 命令行参数：node tools/install-asar.js "<你的应用安装目录>/resources"\n' +
  '\n目标目录里必须已经存在 app.asar（脚本用它确认你没指错地方）。';

/**
 * 解析安装目标目录：环境变量 / .env > 命令行参数；都没有就报错退出，绝不留机器相关的默认值。
 *
 * @returns {string} 绝对路径
 */
function resolveTargetDir() {
  const fromEnv = (process.env.SD_INSTALL_DIR || '').trim() || readEnvFile('SD_INSTALL_DIR');
  if (fromEnv) return path.resolve(fromEnv);
  const fromArg = (process.argv[2] || '').trim();
  if (fromArg) return path.resolve(fromArg);
  console.error(USAGE);
  process.exit(1);
}

const TARGET_DIR = resolveTargetDir();
const TARGET = path.join(TARGET_DIR, 'app.asar');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** sha1（备份与安装后的完整性都靠它；只比大小发现不了「内容坏了」的拷贝） */
function sha1(p) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到待安装的包：${SRC}\n请先执行：node tools/pack-asar.js`);
    process.exit(1);
  }
  if (!fs.existsSync(TARGET)) {
    console.error(`目标位置没有 app.asar：${TARGET}\n` + `请确认路径是否正确（应指向应用的 resources 目录）。`);
    process.exit(1);
  }

  const backup = `${TARGET}.bak-${stamp()}`;
  try {
    fs.copyFileSync(TARGET, backup);
  } catch (err) {
    console.error(`备份失败，已中止（未做任何修改）：${err.message}`);
    process.exit(1);
  }
  if (!fs.existsSync(backup) || fs.statSync(backup).size !== fs.statSync(TARGET).size) {
    console.error('备份校验未通过（大小不一致），已中止（未做任何修改）');
    process.exit(1);
  }
  const srcSha = sha1(SRC);
  if (sha1(backup) !== sha1(TARGET)) {
    console.error('备份校验未通过（内容不一致），已中止（未做任何修改）');
    process.exit(1);
  }

  try {
    fs.copyFileSync(SRC, TARGET);
  } catch (err) {
    const busy = /EBUSY|EPERM|EACCES/i.test(err.code || '');
    console.error(
      busy
        ? `写入被拒绝：应用可能仍在运行，请先**完全退出**「社交平台作品下载器」再执行本脚本。\n原始包已备份在：${backup}`
        : `写入失败：${err.message}\n原始包已备份在：${backup}`
    );
    process.exit(1);
  }

  if (sha1(TARGET) !== srcSha) {
    console.error('安装校验未通过（写入后内容与 dist 不一致），原始包已备份在：' + backup);
    process.exit(1);
  }

  console.log('安装完成 ✓');
  console.log(`  新包：${TARGET}（${(fs.statSync(TARGET).size / 1024).toFixed(1)} KB，sha1 一致）`);
  console.log(`  备份：${backup}`);
  console.log('');
  console.log('回滚（如需）：');
  console.log(`  copy /Y "${backup}" "${TARGET}"`);
}

main();
