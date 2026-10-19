/**
 * 设置的读写与默认值补齐
 *
 * 保存在 userData/settings.json，按平台各存一份（保存目录、目标输入、全部选项互不影响）。
 *
 * 本轮（P1-11）补上两件「以前只是运气好」的事：
 *   ① **原子写**：先写临时文件再 rename。早先 `writeFile` 直接覆盖，
 *      写到一半被杀进程 / 断电就留下一个半截 JSON —— 下次启动读不出来，
 *      用户的全部设置静默清零，而且日志里什么都没有。
 *   ② **坏文件留档**：解析失败不再当成「没有设置」，而是改名成
 *      `settings.json.corrupt-<时间戳>` 留档，并记一条 warning 带到界面上。
 *      这样用户上报「设置怎么全丢了」时，我们能拿到那份坏文件看究竟。
 */
const fsp = require('fs/promises');
const path = require('path');

const registry = require('../platforms/registry');
const { addWarning } = require('./context');

const DEFAULT_SETTINGS = { activePlatform: registry.DEFAULT_PLATFORM, ffmpegPath: '', platforms: {} };

function defaultPlatformSettings(id) {
  const p = registry.get(id);
  return p ? { ...p.defaultOptions } : {};
}

/** 紧凑时间戳：20261018-174503（文件名友好，不带冒号） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

/**
 * 原子写：临时文件 + rename。
 *
 * 为什么 rename 就够了：同一分区内 rename 是原子的（NTFS / ext4 都是），
 * 要么看到旧文件、要么看到完整的新文件，不存在「半个 JSON」的中间态。
 * 临时文件名带 pid 与时间戳，避免两个进程（多开）撞在一起。
 *
 * 失败时一定要清掉临时文件，否则 userData 里会慢慢堆满 `.tmp-*` 垃圾。
 *
 * @param {string} file 目标文件
 * @param {string} text 完整内容
 */
async function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** 读取设置，并把每个平台的默认值补齐（新增选项后老配置也能用） */
async function loadSettings(ctx) {
  let raw = {};
  let text = null;

  try {
    text = await fsp.readFile(ctx.settingsPath, 'utf8');
  } catch (err) {
    // ENOENT 是「第一次启动」，完全正常；其它读取失败（权限、磁盘）要说出来
    if (err && err.code !== 'ENOENT') {
      addWarning(ctx, `读取设置失败（${err.code || err.message}），本次使用默认设置`);
    }
  }

  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      /**
       * 坏文件必须留档再重置：直接当空设置处理等于把用户那份数据扔了 ——
       * 而它往往只是尾部少了一个大括号（上次写入被杀），手工修一下就能救回来。
       */
      const bad = `${ctx.settingsPath}.corrupt-${stamp()}`;
      let kept = '';
      try {
        await fsp.rename(ctx.settingsPath, bad);
        kept = path.basename(bad);
      } catch {
        /* 改名失败（被占用）就继续用默认值，至少不能因此起不来 */
      }
      addWarning(
        ctx,
        `设置文件内容损坏（${err.message}），已恢复默认设置` +
          (kept ? `；原文件已留档为 ${kept}` : '')
      );
      raw = {};
    }
  }

  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULT_SETTINGS, ...base, platforms: {} };
  if (!registry.get(out.activePlatform)) out.activePlatform = registry.DEFAULT_PLATFORM;
  for (const p of registry.list) {
    out.platforms[p.id] = { ...defaultPlatformSettings(p.id), ...(base.platforms?.[p.id] || {}) };
  }
  return out;
}

async function saveSettings(ctx, patch) {
  const cur = await loadSettings(ctx);
  const next = {
    ...cur,
    activePlatform: patch.activePlatform || cur.activePlatform,
    ffmpegPath: patch.ffmpegPath !== undefined ? patch.ffmpegPath : cur.ffmpegPath,
    platforms: { ...cur.platforms },
  };
  if (patch.platform && patch.options) {
    next.platforms[patch.platform] = { ...next.platforms[patch.platform], ...patch.options };
  }
  // 原子写：写到一半被打断也不会毁掉已有设置（见 writeFileAtomic 的注释）
  await writeFileAtomic(ctx.settingsPath, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULT_SETTINGS, defaultPlatformSettings, loadSettings, saveSettings, writeFileAtomic };
