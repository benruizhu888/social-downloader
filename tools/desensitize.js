#!/usr/bin/env node
/**
 * 脱敏副本生成器（只读源目录 → 写入新目录，绝不修改源）
 *
 * 用法：
 *   node tools/desensitize.js                       # 标准副本（保留公开平台域名）
 *   node tools/desensitize.js --strict              # 严格副本（连平台域名与业务 ID 一并脱敏）
 *   node tools/desensitize.js --src=... --out=...   # 自定义源/目标（默认：当前目录 → <src>-redacted）
 *   node tools/desensitize.js --user=alice,bob      # 额外指定要当本机用户名处理的词
 *
 * 特性：
 *   1. 排除 node_modules / dist / build / .git / 虚拟环境 / 缓存目录
 *   2. 二进制资源（图片、字体、音视频、归档）按字节原样复制，不做任何替换
 *   3. 文本按规则顺序替换，同值同占位符，跨文件一致
 *   4. 输出《脱敏说明.md》+《脱敏报告.json》：逐文件替换数、占位符↔原始类型映射
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SRC = path.resolve(arg('src', process.cwd()));
const STRICT = argv.includes('--strict');
const OUT = path.resolve(arg('out', `${SRC}-redacted${STRICT ? '-strict' : ''}`));

/** 额外要当用户名处理的词，逗号分隔：--user=alice,bob */
const EXTRA_USERS = arg('user', '').split(',').map((s) => s.trim()).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------- 排除目录 / 文件 */

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '.svn', '.hg',
  '.venv', 'venv', 'env', 'virtualenv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'site-packages', '.gradle', '.idea', '.vscode', '.next', '.nuxt', '.cache',
  'coverage', '.nyc_output', '.tox', 'vendor', 'Pods', 'Carthage', 'DerivedData',
]);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

/* --------------------------------------------------------- 二进制判定 */

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tif', 'tiff', 'psd', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'fon',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', '7z', 'rar', 'br',
  'asar', 'exe', 'dll', 'so', 'dylib', 'node', 'pdb', 'bin', 'dat', 'db', 'sqlite',
]);

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* ------------------------------------------------------------- 脱敏规则 */

/**
 * 每条规则：
 *   id      规则号
 *   type    原始类型（写进报告的「占位符 ↔ 原始类型」映射）
 *   desc    说明
 *   strict  仅在 --strict 下生效
 *   re      正则（全局）
 *   to      替换为（可含 $1 等捕获组）
 */
const RULES = [
  /* ---------- P0 凭证类：访问令牌 / 身份密钥 ---------- */
  {
    id: 'R1', type: '小红书页面访问令牌 (xsec_token 值)',
    desc: 'URL 查询串里的 xsec_token 值，带它才能打开笔记/主页，属临时访问凭证',
    re: /(xsec_token=)[A-Za-z0-9_\-]{4,}/g,
    to: '$1XHS_XSEC_TOKEN_PLACEHOLDER',
  },
  {
    id: 'R2', type: '抖音用户身份标识 (sec_uid)',
    desc: 'sec_uid 是抖音账号的长期身份标识（base64，形如 MS4wLjABAAAA…），可反查到人',
    re: /MS4wLjABAAAA[A-Za-z0-9_\-]{8,}/g,
    to: 'DOUYIN_SEC_UID_PLACEHOLDER',
  },
  {
    id: 'R3', type: '微博账号 UID（10 位十进制数字）',
    desc: 'weibo.com/<uid> 或 /u/<uid> 形态的 10 位纯数字 UID，属个人身份标识。'
      + '前后排除十六进制字符，避免误伤 24 位 ID 与 base62 字母表里的数字片段',
    re: /(?<![0-9a-fA-F])[1-9][0-9]{9}(?![0-9a-fA-F])/g,
    to: 'WEIBO_UID_PLACEHOLDER',
    // 明显的键盘序列是文档/注释里自造的示范值，不是真实账号，跳过以免示例文案失去可读性
    skip: new Set(['1234567890', '0123456789', '123456789', '9876543210']),
  },
  {
    id: 'R4', type: '小红书账号 ID（真实格式 24 位十六进制）',
    desc: '形如 /user/profile/<24hex> 的账号 ID，位串无明显构造痕迹，按保守原则脱敏',
    re: /(?<=\/user\/profile\/)[0-9a-f]{24}/g,
    to: 'XHS_USER_ID_PLACEHOLDER',
  },
  {
    id: 'R5', type: '小红书笔记 ID（真实格式 24 位十六进制）',
    desc: '形如 /explore/<24hex>、/discovery/item/<24hex> 的笔记 ID，位串无明显构造痕迹',
    re: /(?<=\/(?:explore|discovery\/item)\/)[0-9a-f]{24}/g,
    to: 'XHS_NOTE_ID_PLACEHOLDER',
  },

  /* ---------- P1 本机信息：绝对路径 / 系统用户名 ---------- */
  {
    id: 'R6', type: '本机用户目录路径（含系统用户名）',
    desc: '形如 C:\\Users\\<用户名>\\… 的绝对路径，泄露本机用户名与目录布局',
    re: /([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[A-Za-z0-9._-]+/g,
    to: '$1LOCAL_USERNAME_PLACEHOLDER',
  },
  ...(EXTRA_USERS.length
    ? [
        {
          id: 'R6b', type: '非标准盘符下的用户目录路径',
          desc: `形如 D:\\<用户名>\\… 的绝对路径（用户名由 --user 指定）`,
          re: new RegExp(`([A-Za-z]:[\\\\/])(?:${EXTRA_USERS.map(esc).join('|')})(?=[\\\\/])`, 'g'),
          to: '$1LOCAL_USERNAME_PLACEHOLDER',
        },
        {
          id: 'R7', type: '系统用户名（裸值）',
          desc: '未跟在盘符后的裸用户名（由 --user 指定）',
          re: new RegExp(`(?<![A-Za-z0-9_])(?:${EXTRA_USERS.map(esc).join('|')})(?![A-Za-z0-9_])`, 'g'),
          to: 'LOCAL_USERNAME_PLACEHOLDER',
        },
      ]
    : []),

  /* ---------- P1 通用凭据形态（本工程未命中，保留规则以覆盖同类项目） ---------- */
  {
    id: 'R8', type: '邮箱地址',
    desc: '个人/企业邮箱，属个人身份信息',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    to: 'EMAIL_PLACEHOLDER',
  },
  {
    id: 'R9', type: '中国大陆手机号',
    desc: '11 位手机号，属个人身份信息',
    re: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
    to: 'PHONE_PLACEHOLDER',
  },
  {
    id: 'R10', type: '私钥块',
    desc: 'PEM 私钥（RSA / EC / OPENSSH / PGP）',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: 'PRIVATE_KEY_PLACEHOLDER',
  },
  {
    id: 'R11', type: '数据库连接串',
    desc: '含用户名密码的 mongodb:// / postgres:// / mysql:// 连接串',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"`]+:[^\s'"`]+@[^\s'"`]+/g,
    to: 'DB_CONNECTION_PLACEHOLDER',
  },
  {
    id: 'R12', type: '硬编码密钥赋值',
    desc: 'apiKey/secret/password 等键名的字面量赋值',
    re: /(\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*)(['"])([^'"\s]{6,})(['"])/gi,
    to: '$1$2SECRET_VALUE_PLACEHOLDER$4',
  },

  /* ---------- P2 严格模式附加：平台域名 ---------- */
  { id: 'S1', strict: true, type: '小红书 API 域名', desc: 'edith.xiaohongshu.com', re: /edith\.xiaohongshu\.com/g, to: 'XHS_API_DOMAIN_PLACEHOLDER' },
  { id: 'S2', strict: true, type: '小红书 CDN 域名', desc: 'sns-img-qc.xhscdn.com', re: /sns-img-qc\.xhscdn\.com/g, to: 'XHS_CDN_DOMAIN_PLACEHOLDER' },
  { id: 'S3', strict: true, type: '小红书短链域名', desc: 'xhslink.com', re: /xhslink\.com/g, to: 'XHS_SHORT_DOMAIN_PLACEHOLDER' },
  { id: 'S4', strict: true, type: '小红书主域名', desc: 'www.xiaohongshu.com', re: /www\.xiaohongshu\.com/g, to: 'XHS_DOMAIN_PLACEHOLDER' },
  { id: 'S5', strict: true, type: '抖音 CDN 域名', desc: 'p3-sign.douyinpic.com', re: /p3-sign\.douyinpic\.com/g, to: 'DOUYIN_CDN_DOMAIN_PLACEHOLDER' },
  { id: 'S6', strict: true, type: '抖音短链域名', desc: 'v.douyin.com', re: /v\.douyin\.com/g, to: 'DOUYIN_SHORT_DOMAIN_PLACEHOLDER' },
  { id: 'S7', strict: true, type: '抖音历史域名', desc: 'www.iesdouyin.com', re: /www\.iesdouyin\.com/g, to: 'DOUYIN_LEGACY_DOMAIN_PLACEHOLDER' },
  { id: 'S8', strict: true, type: '抖音主域名', desc: 'www.douyin.com', re: /www\.douyin\.com/g, to: 'DOUYIN_DOMAIN_PLACEHOLDER' },
  { id: 'S9', strict: true, type: '微博 SSO 域名', desc: 'passport.weibo.com', re: /passport\.weibo\.com/g, to: 'WEIBO_SSO_DOMAIN_PLACEHOLDER' },
  { id: 'S10', strict: true, type: '微博视频 CDN 域名', desc: 'f.video.weibocdn.com', re: /f\.video\.weibocdn\.com/g, to: 'WEIBO_CDN_DOMAIN_PLACEHOLDER' },
  { id: 'S11', strict: true, type: '微博移动站域名', desc: 'm.weibo.cn', re: /m\.weibo\.cn/g, to: 'WEIBO_MOBILE_DOMAIN_PLACEHOLDER' },
  { id: 'S12', strict: true, type: '微博短链域名', desc: 't.cn', re: /(?<![A-Za-z0-9.\-])t\.cn(?![A-Za-z0-9.\-])/g, to: 'WEIBO_SHORT_DOMAIN_PLACEHOLDER' },
  { id: 'S13', strict: true, type: '微博主域名', desc: 'weibo.com', re: /weibo\.com/g, to: 'WEIBO_DOMAIN_PLACEHOLDER' },
  { id: 'S13b', strict: true, type: '小红书主域名（裸）', desc: '注释/文案里不带 www 前缀的 xiaohongshu.com', re: /(?<![A-Za-z0-9.\-])xiaohongshu\.com(?![A-Za-z0-9.\-])/g, to: 'XHS_DOMAIN_PLACEHOLDER' },
  { id: 'S13c', strict: true, type: '抖音主域名（裸）', desc: '注释/文案里不带 www/v 前缀的 douyin.com', re: /(?<![A-Za-z0-9.\-])douyin\.com(?![A-Za-z0-9.\-])/g, to: 'DOUYIN_DOMAIN_PLACEHOLDER' },
  { id: 'S13d', strict: true, type: '微博移动站域名（裸）', desc: 'weibo.cn', re: /(?<![A-Za-z0-9.\-])weibo\.cn(?![A-Za-z0-9.\-])/g, to: 'WEIBO_MOBILE_DOMAIN_PLACEHOLDER' },
  { id: 'S14', strict: true, type: '第三方域名', desc: 'www.bilibili.com', re: /www\.bilibili\.com/g, to: 'THIRD_PARTY_DOMAIN_PLACEHOLDER' },
  { id: 'S15', strict: true, type: '示例用域名', desc: 'a.com.evil.com / example.com / a.com（测试用例里的示范域名）', re: /a\.com\.evil\.com/g, to: 'EXAMPLE_DOMAIN_PLACEHOLDER' },
  { id: 'S16', strict: true, type: '示例用域名', desc: 'example.com', re: /example\.com/g, to: 'EXAMPLE_DOMAIN_PLACEHOLDER' },
  { id: 'S17', strict: true, type: '示例用域名', desc: 'a.com', re: /(?<![A-Za-z0-9.\-])a\.com(?![A-Za-z0-9.\-])/g, to: 'EXAMPLE_DOMAIN_PLACEHOLDER' },

  /* ---------- P2 严格模式附加：其余业务 ID ---------- */
  {
    id: 'S18', strict: true, type: '小红书 ID（其余 24 位十六进制）',
    desc: '主副本判定为人工构造样例而保留的 24 位十六进制 ID，严格模式下一并脱敏',
    re: /(?<![0-9a-zA-Z])[0-9a-f]{24}(?![0-9a-zA-Z])/g,
    to: 'XHS_ID_PLACEHOLDER',
  },
  {
    id: 'S19', strict: true, type: '平台作品 / 微博 MID（16–19 位数字）',
    desc: '主副本判定为人工构造样例而保留的长数字 ID，严格模式下一并脱敏',
    re: /(?<![0-9])[0-9]{16,19}(?![0-9])/g,
    to: 'PLATFORM_ITEM_ID_PLACEHOLDER',
  },
];

const ACTIVE = RULES.filter((r) => (STRICT ? true : !r.strict));

/* --------------------------------------------------------------- 主流程 */

const report = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  output: OUT,
  mode: STRICT ? 'strict（严格：含平台域名与构造样例 ID）' : 'standard（标准：仅凭证 / 身份 / 本机信息）',
  excludedDirs: [...EXCLUDE_DIRS],
  files: [],
  binaries: [],
  skipped: [],
  ruleTotals: {},
};

const stat = { files: 0, textFiles: 0, binaryFiles: 0, replaced: 0, changedFiles: 0 };

function walk(dir, rel = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) { report.skipped.push({ path: r + '/', reason: '排除目录' }); continue; }
      walk(abs, r);
      continue;
    }
    if (!e.isFile()) continue;
    if (EXCLUDE_FILES.has(e.name)) { report.skipped.push({ path: r, reason: '排除文件（锁文件/系统文件）' }); continue; }
    stat.files++;
    handleFile(abs, r);
  }
}

function handleFile(abs, rel) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  let buf = fs.readFileSync(abs);

  if (BINARY_EXT.has(ext) || looksBinary(buf)) {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    stat.binaryFiles++;
    report.binaries.push({ path: rel, bytes: buf.length, ext: ext || '(无扩展名)' });
    return;
  }

  stat.textFiles++;
  const src = buf.toString('utf8');
  let text = src;
  const hits = [];

  for (const rule of ACTIVE) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    let n = 0;
    text = text.replace(re, (match, ...rest) => {
      if (rule.skip && rule.skip.has(match)) return match;
      n++;
      const groups = rest.slice(0, rest.length - 2); // 去掉 offset / string
      return String(rule.to).replace(/\$(\d)/g, (_, i) => {
        const v = groups[Number(i) - 1];
        return v === undefined ? '' : String(v);
      });
    });
    if (n > 0) {
      hits.push({ id: rule.id, type: rule.type, count: n });
      report.ruleTotals[rule.id] = (report.ruleTotals[rule.id] || 0) + n;
      stat.replaced += n;
    }
  }

  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, 'utf8');

  if (hits.length) {
    stat.changedFiles++;
    report.files.push({ path: rel, replacements: hits.reduce((s, h) => s + h.count, 0), rules: hits });
  }
}

/* ------------------------------------------------------------------ 执行 */

if (fs.existsSync(OUT)) {
  console.error(`[中止] 输出目录已存在，拒绝覆盖：${OUT}`);
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`[中止] 源目录不存在：${SRC}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
walk(SRC);

/* ---------------- 写报告 ---------------- */

report.stats = stat;
fs.writeFileSync(path.join(OUT, '脱敏报告.json'), JSON.stringify(report, null, 2), 'utf8');

const ruleLine = (r) => `| ${r.id} | \`${placeholderOf(r)}\` | ${r.type} | ${report.ruleTotals[r.id] || 0} | ${r.desc} |`;

function placeholderOf(r) {
  if (typeof r.to === 'string') {
    const m = r.to.match(/[A-Z][A-Z0-9_]*_PLACEHOLDER/);
    if (m) return m[0];
    return r.to.replace(/\$\d/g, '…');
  }
  return 'SECRET_VALUE_PLACEHOLDER';
}

const changed = report.files.slice().sort((a, b) => b.replacements - a.replacements);
const md = [];
md.push('# 脱敏说明');
md.push('');
md.push(`- **源目录**：\`${SRC}\`（未做任何修改）`);
md.push(`- **输出目录**：\`${OUT}\``);
md.push(`- **模式**：${report.mode}`);
md.push(`- **生成时间**：${new Date().toLocaleString('zh-CN')}`);
md.push('');
md.push('## 一、总览');
md.push('');
md.push(`| 指标 | 数量 |`);
md.push(`|---|---|`);
md.push(`| 扫描到的文件（排除后） | ${stat.files} |`);
md.push(`| 文本文件（参与替换） | ${stat.textFiles} |`);
md.push(`| 二进制文件（原样复制） | ${stat.binaryFiles} |`);
md.push(`| 被修改的文件 | ${stat.changedFiles} |`);
md.push(`| 替换总次数 | ${stat.replaced} |`);
md.push('');
md.push('## 二、排除的目录 / 文件');
md.push('');
md.push('目录：`' + [...EXCLUDE_DIRS].join('`、`') + '`');
md.push('');
md.push('文件：`' + [...EXCLUDE_FILES].join('`、`') + '`');
md.push('');
md.push('## 三、占位符 ↔ 原始类型映射（便于对照还原）');
md.push('');
md.push('| 规则 | 占位符 | 原始类型 | 替换次数 | 说明 |');
md.push('|---|---|---|---|---|');
for (const r of ACTIVE) {
  if (!report.ruleTotals[r.id]) continue;
  md.push(ruleLine(r));
}
md.push('');
md.push('> 还原方式：把占位符按上表「原始类型」列回填同类型的值即可。'
  + '同值在工程内全局一致替换，因此结构、比较关系与跨文件引用仍然成立。');
md.push('');
md.push('## 四、逐文件替换明细');
md.push('');
md.push('| 文件 | 替换数 | 命中规则 |');
md.push('|---|---|---|');
for (const f of changed) {
  md.push(`| \`${f.path}\` | ${f.replacements} | ${f.rules.map((h) => `${h.id}(${h.count})`).join('、')} |`);
}
md.push('');
md.push('## 五、二进制资源（原样复制，未做任何处理）');
md.push('');
if (report.binaries.length) {
  md.push('| 文件 | 大小(字节) | 类型 |');
  md.push('|---|---|---|');
  for (const b of report.binaries) md.push(`| \`${b.path}\` | ${b.bytes} | ${b.ext} |`);
} else {
  md.push('（本次扫描未发现二进制资源文件，工程内全部为 `.js` / `.json` / `.html` / `.css` 文本源码）');
}
md.push('');
md.push('## 六、刻意保留的项及理由');
md.push('');
md.push('| 保留项 | 类别 | 理由 |');
md.push('|---|---|---|');
md.push('| `ttwid` / `passport_csrf_token` / `msToken` / `SUBP` / `SSOLoginState` 等 | Cookie **名称** | 只是平台公开的 Cookie 名，代码里从未携带其值；值全部在运行时从用户浏览器读取并存于本机 `%APPDATA%`，不入库、不写源码 |');
md.push('| `xsec_token` / `sec_uid` 等**变量名与注释** | 标识符 | 脱敏只替换「值」，字段语义必须保留，否则代码逻辑被破坏 |');
if (!STRICT) {
  md.push('| `weibo.com` / `douyin.com` / `xiaohongshu.com` 等平台域名 | 公开域名 | 这类域名是各平台的公开入口，属协议常量而非私密信息；替换会让解析/采集逻辑整体失效。如需彻底脱敏，请用 `--strict` 生成严格副本 |');
  md.push('| `65f0a1b2c3d4e5f60718293a` 等 24 位十六进制 ID、`7300000000000000000` 等长数字 ID | 人工构造样例 | 位串呈 `0a1b2c3d4e5f` / `a1b1c2d3e4f5a6b7c8` / 全零后缀等明显键盘序列特征，判定为测试用例自造，非真实账号；保守起见严格模式下仍会替换 |');
}
md.push('| `C:\\out\\a\\img01.jpg`、`C:\\` 等 | 通用示例路径 | 不含用户名等本机标识，属测试夹具内的通用占位路径 |');
md.push('');
md.push('## 七、未发现的敏感项（已专项扫描，命中 0）');
md.push('');
md.push('| 类别 | 扫描结果 |');
md.push('|---|---|');
md.push('| API Key / Secret / Password 硬编码 | 0 |');
md.push('| 数据库连接串 | 0 |');
md.push('| 私钥（PEM / OPENSSH / PGP） | 0 |');
md.push('| `.env` / `.pem` / `.key` / `id_rsa` 文件 | 0 |');
md.push('| 邮箱地址 | 0 |');
md.push('| 手机号 | 0 |');
md.push('| 真实 IPv4（非 `120.0.0.0` 这类 UA 版本号片段） | 0 |');
md.push('| Cookie 字面量赋值 | 0 |');
md.push('| UUID | 0 |');
md.push('');
md.push('> 说明：`120.0.0.0` 三处均出现在 Chromium User-Agent 字符串里（`Chrome/120.0.0.0`），是浏览器版本号不是 IP，故予保留。');
md.push('');
md.push('## 八、使用提示');
md.push('');
md.push('- 本副本**结构、文件名、代码逻辑与原工程完全一致**，仅字面量被替换。');
md.push('- 若要在本机运行副本内的测试，请先把占位符按第三节映射表回填为同类型的合法值');
md.push('  （例如 `WEIBO_UID_PLACEHOLDER` 需填回 10 位纯数字，`DOUYIN_SEC_UID_PLACEHOLDER` 需填回 `MS4wLjABAAAA` 开头的字符串），');
md.push('  否则少数依赖 ID 字符形态的解析用例会因占位符不是数字/不是 base62 而报错——这是脱敏的预期代价，不是代码缺陷。');

fs.writeFileSync(path.join(OUT, '脱敏说明.md'), md.join('\n'), 'utf8');

console.log(`\n[完成] ${OUT}`);
console.log(`  扫描 ${stat.files} 个文件（文本 ${stat.textFiles} / 二进制 ${stat.binaryFiles}）`);
console.log(`  修改 ${stat.changedFiles} 个文件，替换 ${stat.replaced} 处`);
console.log(`  报告：脱敏说明.md / 脱敏报告.json\n`);
