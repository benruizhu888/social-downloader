#!/usr/bin/env node
/**
 * 把源码目录打包成 Electron 的 app.asar
 *
 * 为什么自己实现而不装 `asar` 包：这个工程的要求是「零依赖改动」——
 * 原包运行时依赖只有 ffmpeg-static，为了改一个功能去引一个打包工具（及其依赖树）
 * 不划算。asar 的格式本身很简单，就是「16 字节 pickle 头 + JSON 头 + 依次排列的文件数据」，
 * 本文件 100 行就写完了，而且打完之后**自己回读校验一遍**（见 verify）。
 *
 * 格式（与官方 asar 实现一致，逐字节对齐）：
 *   [0..3]   uint32 = 4                    ← 后面那个 size 字段本身的长度
 *   [4..7]   uint32 = jsonLen + 8          ← header 块（pickle 内层）总长
 *   [8..11]  uint32 = jsonLen + 4          ← 字符串区的总长
 *   [12..15] uint32 = jsonLen              ← JSON 文本长度（UTF-8 字节数）
 *   [16..]   JSON 文本
 *   [16+jsonLen..]  文件数据（按 header 里的 offset 依次排列）
 *
 * header JSON 形如：
 *   { "files": { "package.json": { "size": 123, "offset": "0" },
 *                "src": { "files": { ... } },
 *                "node_modules/ffmpeg-static/ffmpeg.exe": { "size": 82797568, "unpacked": true } } }
 *
 * 用法：node tools/pack-asar.js [源码目录] [输出文件]
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'dist', 'app.asar'));

/**
 * 只打包这三块 —— 与原始包的构成一致。
 * test/ 与 tools/ 是本工程自己加的，发布包里不需要（原包也没有测试目录）。
 */
const INCLUDE = ['package.json', 'src', 'node_modules'];

/**
 * 不内联进 asar、只留条目的文件。
 *
 * 关键原因：**asar 内的可执行文件无法执行**。Electron 的约定是把这类文件放到
 * 同级的 `app.asar.unpacked/` 目录，header 里标 `unpacked: true` 指过去。
 * 原包已经把 ffmpeg.exe 解包在外了（resources/app.asar.unpacked/...），
 * 所以这里只需要保留条目、不需要那份 82MB 的二进制参与打包。
 *
 * size 取自原包 header（源码目录里没有这个二进制）。
 */
const UNPACKED = new Map([['node_modules/ffmpeg-static/ffmpeg.exe', 82797568]]);

/**
 * --ffmpeg-size=N：显式覆盖 ffmpeg.exe 的 header 大小。
 *
 * UNPACKED 里的数字来自**原包**。一旦 ffmpeg-static 升级、或换了一个安装目录，
 * 这个数字就会过期 —— 而 asar 对 unpacked 条目的 size 直接用于 fs.stat，
 * 差一字节读出来的就是截断/补零的二进制，ffmpeg 会以「文件损坏」的方式失败，
 * 且打包时毫无征兆。所以允许覆盖，并在能找到参考文件时强制核对（见 main）。
 */
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--ffmpeg-size=(\d+)$/);
  if (m) UNPACKED.set('node_modules/ffmpeg-static/ffmpeg.exe', Number(m[1]));
}

/** 找一份真实的 ffmpeg.exe 作参照（找不到返回 null，此时跳过核对） */
function referenceFfmpegSize() {
  const rel = ['node_modules', 'ffmpeg-static', 'ffmpeg.exe'].join(path.sep);
  const candidates = [
    process.env.SD_FFMPEG_EXE,
    path.join(path.dirname(OUT), 'app.asar.unpacked', rel),
    path.join(SRC, '..', 'social-downloader', 'resources', 'app.asar.unpacked', rel),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return st.size;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

const files = {};
const blocks = [];
let offset = 0;

function insertFile(rel, size, absPath) {
  const parts = rel.split('/');
  let node = files;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!node[key] || !node[key].files) node[key] = { files: {} };
    node = node[key].files;
  }
  const key = parts[parts.length - 1];

  if (UNPACKED.has(rel)) {
    node[key] = { size: UNPACKED.get(rel), unpacked: true };
    return;
  }
  node[key] = { size, offset: String(offset) };
  blocks.push({ abs: absPath, size });
  // ⚠️ offset 的分配顺序必须与下面「写数据」的顺序完全一致
  offset += size;
}

function walk(rel) {
  const abs = path.join(SRC, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    const childAbs = path.join(SRC, childRel);
    if (ent.isDirectory()) walk(childRel);
    else if (ent.isFile()) {
      const st = fs.statSync(childAbs);
      insertFile(childRel, st.size, childAbs);
    }
  }
}

/**
 * 补上「源码目录里根本不存在」的外置条目。
 *
 * ⚠️ 这一条不能省。ffmpeg.exe 是 82MB 的二进制，源码工程里没有它
 * （复制解包结果时就去掉了），所以上面的 walk 永远遍历不到它 →
 * 生成出来的 header 里没有这个文件 → 虽然项目当前是靠 `resources/ffmpeg.exe`
 * 找到 ffmpeg 的（见 core/ffmpeg.js 的查找顺序），但包与原包的行为就对不上了。
 * 少一个条目不会立刻报错，属于那种「以后某天突然发现」的问题，所以在这里补齐。
 */
function ensureUnpackedEntry(rel, size) {
  const parts = rel.split('/');
  let node = files;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!node[key] || !node[key].files) node[key] = { files: {} };
    node = node[key].files;
  }
  const key = parts[parts.length - 1];
  if (!node[key]) node[key] = { size, unpacked: true };
}

function main() {
  for (const item of INCLUDE) {
    const abs = path.join(SRC, item);
    if (!fs.existsSync(abs)) throw new Error(`缺少必要路径：${abs}`);
    if (fs.statSync(abs).isDirectory()) walk(item);
    else insertFile(item, fs.statSync(abs).size, abs);
  }
  // 补齐源码目录里不存在的二进制条目（见 ensureUnpackedEntry 的注释）
  for (const [rel, size] of UNPACKED) ensureUnpackedEntry(rel, size);

  // 外置条目的大小必须与磁盘上的真实文件一致（差一字节，ffmpeg 就是「文件损坏」）
  const ffmpegKey = 'node_modules/ffmpeg-static/ffmpeg.exe';
  const ref = referenceFfmpegSize();
  if (ref !== null && ref !== UNPACKED.get(ffmpegKey)) {
    console.error(
      `✗ ffmpeg.exe 大小对不上：header 里写的是 ${UNPACKED.get(ffmpegKey)}，` +
        `实际文件是 ${ref} 字节。\n` +
        `  用 --ffmpeg-size=${ref} 重新打包，否则运行时读到的会是截断的二进制。`
    );
    process.exit(1);
  }

  const json = JSON.stringify({ files });
  const jsonLen = Buffer.byteLength(json, 'utf8');

  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(jsonLen + 8, 4);
  head.writeUInt32LE(jsonLen + 4, 8);
  head.writeUInt32LE(jsonLen, 12);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const fd = fs.openSync(OUT, 'w');
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, Buffer.from(json, 'utf8'));
    for (const b of blocks) {
      const buf = fs.readFileSync(b.abs);
      // 打包期间文件被改过 → offset 全乱。宁可直接失败，也不要产出一个坏包
      if (buf.length !== b.size) {
        throw new Error(`文件在打包过程中大小发生了变化：${b.abs}（${b.size} → ${buf.length}）`);
      }
      fs.writeSync(fd, buf);
    }
  } finally {
    fs.closeSync(fd);
  }

  const st = fs.statSync(OUT);
  console.log(`已生成：${OUT}`);
  console.log(`  内联文件 ${blocks.length} 个，数据 ${(offset / 1024).toFixed(1)} KB`);
  console.log(`  外置条目 ${UNPACKED.size} 个（unpacked: true）`);
  console.log(`  文件总大小 ${(st.size / 1024).toFixed(1)} KB`);

  return verify();
}

/**
 * 回读校验：把刚写出去的文件按 asar 格式重新解一遍，与磁盘上的源码逐个比对。
 *
 * 为什么必须做这一步：asar 的头是手写的 pickle 结构，字段错一个字节
 * （比如 JSON 长度用了字符数而不是 UTF-8 字节数）产出的就是一个**Electron 打不开的包**，
 * 而那种失败在打包时毫无征兆。这里当场验，比装到应用上再发现问题便宜得多。
 */
function verify() {
  const buf = fs.readFileSync(OUT);
  const jsonLen = buf.readUInt32LE(12);
  const headerJson = buf.slice(16, 16 + jsonLen).toString('utf8');
  const header = JSON.parse(headerJson);
  const dataStart = 16 + jsonLen;

  let checked = 0;
  let mismatch = 0;

  const visit = (node, prefix) => {
    for (const [name, item] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (item.files) {
        visit(item, rel);
        continue;
      }
      if (item.unpacked) continue;
      const start = dataStart + Number(item.offset);
      const got = buf.slice(start, start + item.size);
      const want = fs.readFileSync(path.join(SRC, rel));
      checked++;
      if (!got.equals(want)) {
        mismatch++;
        console.error(`  ✗ 内容不一致：${rel}`);
      }
    }
  };
  visit(header, '');

  if (mismatch) {
    console.error(`校验失败：${mismatch} / ${checked} 个文件对不上`);
    process.exit(1);
  }
  console.log(`  ✓ 回读校验通过（${checked} 个文件与源码逐字节一致）`);
  return true;
}

main();
