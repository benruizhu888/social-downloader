/**
 * ffmpeg 定位与 Live Photo → MOV 转换
 *
 * ffmpeg 查找顺序：
 *   1) 用户手动指定的路径
 *   2) 打包内置的 ffmpeg-static
 *   3) 系统 PATH
 * 三种都找不到时，界面会给出明确的下载指引，而不是静默失败。
 */

const { execFile, spawn } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const fs = require('fs');

let cachedPath = null;

async function findFFmpeg(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (cachedPath) return cachedPath;

  // 1) 打包后复制到 resources 目录的 ffmpeg（asar 内的二进制无法执行，必须 unpack 出来）
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg.exe');
    if (fs.existsSync(bundled)) return (cachedPath = bundled);
  }

  // 2) 内置 ffmpeg-static（开发模式直接可用）
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return (cachedPath = p);
  } catch {
    /* 未安装该包，忽略 */
  }

  // 2) 系统 PATH
  const found = await new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split(/\r?\n/).find((l) => l.trim());
      resolve(line ? line.trim() : null);
    });
  });
  if (found) return (cachedPath = found);

  // 3) 常见安装位置兜底
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe'), 'C:\\ffmpeg\\bin\\ffmpeg.exe']
      : ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return (cachedPath = c);
  }
  return null;
}

async function ffmpegVersion(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-version'], (err, stdout) => {
      if (err) return reject(err);
      const m = String(stdout).match(/ffmpeg version (\S+)/);
      resolve(m ? m[1] : 'unknown');
    });
  });
}

function runFFmpeg(bin, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.split('\n').slice(-6).join(' ')}`));
    });
  });
}

/**
 * 把 Live Photo 动态片段转封装为 .mov
 * @param {object} opts
 * @param {string} opts.input      输入文件（mp4/mov/heic 的动态部分）
 * @param {string} opts.output     输出 .mov 路径
 * @param {string} [opts.contentId] Apple Live Photo 内容标识（与静态图配对用，可选）
 * @param {boolean}[opts.reencode] 强制重编码（默认先尝试无损封装）
 */
async function convertToMOV({ input, output, contentId, reencode = false, ffmpegBin, signal }) {
  const bin = ffmpegBin || (await findFFmpeg());
  if (!bin) throw new Error('未找到 ffmpeg，请在设置中指定路径或安装后重试');

  await fsp.mkdir(path.dirname(output), { recursive: true });

  // 顺序至关重要：-i 必须紧跟输入文件，元数据只能放在输入之后、输出之前
  const inputArgs = ['-y', '-i', input];
  // 实测：ffmpeg 的 mov muxer 会过滤掉流级(-metadata:s:v:0)的未知 key，
  // 但全局(-metadata:g:0)可以写入 udta，因此以全局为主、流级为辅。
  const meta = contentId
    ? [
        '-metadata:g:0', `com.apple.quicktime.content.identifier=${contentId}`,
        '-metadata:g:0', 'com.apple.quicktime.still-image-time=0',
        '-metadata:s:v:0', `com.apple.quicktime.content.identifier=${contentId}`,
        '-metadata:s:v:0', 'com.apple.quicktime.still-image-time=0',
      ]
    : [];

  // use_metadata_tags 才会把自定义 metadata 落成 QuickTime atom，否则 ffmpeg 会丢弃
  const movFlags = contentId ? '+faststart+use_metadata_tags' : '+faststart';

  if (!reencode) {
    const copyOut = ['-c:v', 'copy', '-c:a', 'copy', '-movflags', movFlags, '-f', 'mov'];
    try {
      await runFFmpeg(bin, [...inputArgs, ...meta, ...copyOut, output], signal);
      return { mode: 'copy' };
    } catch {
      /* 封装失败（例如源是 hevc 或带特殊流），落到重编码 */
    }
  }

  const encodeOut = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', movFlags,
    '-f', 'mov',
  ];
  await runFFmpeg(bin, [...inputArgs, ...meta, ...encodeOut, output], signal);
  return { mode: 'encode' };
}

/** 从静态图提取尺寸（Live Photo 配对时用于校验，可选） */
async function probeMedia(input, ffmpegBin) {
  const bin = ffmpegBin || (await findFFmpeg());
  if (!bin) return null;
  try {
    const { promisify } = require('util');
    const pef = promisify(execFile);
    const probe = bin.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    // ffmpeg-static 只提供 ffmpeg，没有 ffprobe，此时直接放弃探测
    if (!fs.existsSync(probe)) return null;
    const { stdout } = await pef(probe, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height',
      '-of', 'csv=p=0',
      input,
    ]);
    return String(stdout).trim();
  } catch {
    return null;
  }
}

module.exports = { findFFmpeg, ffmpegVersion, convertToMOV, probeMedia };
