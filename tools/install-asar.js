#!/usr/bin/env node
/**
 * 把打包好的 app.asar 安装到已安装的应用目录（**自动备份，可一键回滚**）
 *
 * 用法：
 *   node tools/install-asar.js                       # 默认装到 D:\Path\To\YourApp\resources
 *   node tools/install-asar.js "D:\某处\resources"    # 指定目标（推荐）
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

const SRC = path.resolve(__dirname, '..', 'dist', 'app.asar');
// 默认目标是一个通用占位路径 —— 不含任何本机信息。
// 实际使用时几乎总要传参：node tools/install-asar.js "C:/Apps/YourApp/resources"
const TARGET_DIR = path.resolve(process.argv[2] || 'D:/Path/To/YourApp/resources');
const TARGET = path.join(TARGET_DIR, 'app.asar');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

  console.log('安装完成 ✓');
  console.log(`  新包：${TARGET}（${(fs.statSync(TARGET).size / 1024).toFixed(1)} KB）`);
  console.log(`  备份：${backup}`);
  console.log('');
  console.log('回滚（如需）：');
  console.log(`  copy /Y "${backup}" "${TARGET}"`);
}

main();
