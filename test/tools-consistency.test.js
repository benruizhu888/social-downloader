/**
 * 工程工具与脚本清单的一致性（纯 Node，静态断言）
 *
 * 这三条都是「工具自己坏了，但测试全绿」的坑：
 *
 *   ① `npm run test:list` 是一份**手写**的测试文件清单 —— 加了新测试文件却忘了
 *      往里补一行，CI/别人机器上就少跑一整个文件，而 run-tests.js 全量扫描是绿的，
 *      两边谁也不会提醒谁。这里强制两边集合相等。
 *   ② `tools/run-tests.js` 靠「通过 N / M」这一行汇总判定成败；谁要是把测试文件的
 *      输出格式改了，所有失败都会被误判成通过。这里用真实测试文件跑一遍验证解析。
 *   ③ `tools/pack-asar.js` 的 INCLUDE 少了一项（例如以后新增 `locales/`），
 *      打出来的包照样能装、能启动，缺的东西只会在运行时才暴露。这里核对打包产物
 *      的 header 与源码目录一致。
 *
 * 跑法：node test/tools-consistency.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(__dirname);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failed = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (name) => tests.push([null, name]);

section('清单一致性');

t('package.json 的 test:list 与 test/ 下的 .test.js 文件一一对应', () => {
  const onDisk = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  const listed = (PKG.scripts['test:list'] || '')
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cmd) => {
      const m = cmd.match(/node\s+test\/([\w.-]+\.test\.js)$/);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();

  const missing = onDisk.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !onDisk.includes(f));
  const problems = [];
  if (missing.length) problems.push(`磁盘上有、test:list 里没有：${missing.join(', ')}`);
  if (extra.length) problems.push(`test:list 里有、磁盘上没有：${extra.join(', ')}`);
  assert.deepStrictEqual(
    problems,
    [],
    [`${PKG.scripts['test:list']} 与 test/ 不一致`, ...problems].join('\n')
  );
});

t('scripts 引用的工具脚本都真实存在', () => {
  for (const cmd of [PKG.scripts.test, PKG.scripts.pack, PKG.scripts['install-asar']]) {
    const m = String(cmd).match(/node\s+(tools\/[\w.-]+\.js)/);
    assert.ok(m, `脚本不是 node tools/*.js 形式：${cmd}`);
    assert.ok(
      fs.existsSync(path.join(ROOT, m[1])),
      `脚本引用的文件不存在：${m[1]}`
    );
  }
});

section('run-tests.js 的成败解析');

t('汇总行「通过 N / M」仍是判定依据（格式改了必须同步改解析）', () => {
  // 拿一个已知的小测试文件真跑一遍：解析逻辑与真实输出必须对得上
  const out = execFileSync(process.execPath, [path.join(TEST_DIR, 'url-guard-coalesce.test.js')], {
    encoding: 'utf8',
  });
  const m = out.match(/通过 (\d+) \/ (\d+)/);
  assert.ok(m, '测试输出里找不到「通过 N / M」汇总行 —— run-tests.js 会把所有文件判成失败');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) === Number(m[2]), '该文件应全部通过');
});

t('run-tests.js 有单文件超时（死循环不会把整轮挂死）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'run-tests.js'), 'utf8');
  assert.ok(/spawnSync\(/.test(src), '找不到 spawnSync 调用');
  assert.ok(/timeout:/.test(src), 'spawnSync 没有传 timeout：一个死循环测试会挂死整轮');
});

section('pack-asar.js 的打包完整性');

t('INCLUDE 覆盖了 src/ 与 package.json（少一项 = 运行时才暴露）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'pack-asar.js'), 'utf8');
  const m = src.match(/const\s+INCLUDE\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '找不到 INCLUDE 常量');
  const items = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  for (const need of ['package.json', 'src', 'node_modules']) {
    assert.ok(items.includes(need), `INCLUDE 缺少 ${need}`);
  }
});

t('真实打包一次，header 与磁盘文件集合一致（在临时目录里做，不碰 dist）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-pack-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'pack-asar.js'), ROOT, path.join(tmp, 'app.asar')], {
      encoding: 'utf8',
    });
    const buf = fs.readFileSync(path.join(tmp, 'app.asar'));
    const jsonLen = buf.readUInt32LE(12);
    const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));

    // 收集 header 里的文件集合
    const inHeader = [];
    const visit = (node, prefix) => {
      for (const [name, item] of Object.entries(node.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (item.files) visit(item, rel);
        else inHeader.push(rel);
      }
    };
    visit(header, '');

    // 磁盘上的文件集合（INCLUDE 三块）
    const onDisk = [];
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child);
        else if (e.isFile()) onDisk.push(child);
      }
    };
    walk('src');
    onDisk.push('package.json');
    if (fs.existsSync(path.join(ROOT, 'node_modules'))) walk('node_modules');

    const setA = new Set(inHeader);
    const setB = new Set(onDisk);
    const missing = onDisk.filter((f) => !setA.has(f));
    const extra = inHeader.filter((f) => !setB.has(f));
    const problems = [];
    if (missing.length) problems.push(`磁盘上有、包里没有：${missing.slice(0, 8).join(', ')}`);
    if (extra.length) problems.push(`包里有、磁盘上没有：${extra.slice(0, 8).join(', ')}`);
    assert.deepStrictEqual(problems, [], problems.join('\n'));
    assert.ok(setA.size > 100, `包里的文件数异常：${setA.size}`);
    assert.ok(
      inHeader.some((f) => f === 'node_modules/ffmpeg-static/ffmpeg.exe'),
      'ffmpeg.exe 的 unpacked 条目必须保留（asar 里的可执行文件跑不起来）'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

t('install-asar.js 的备份用内容校验（只比大小发现不了坏拷贝）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'install-asar.js'), 'utf8');
  assert.ok(/createHash|sha1|sha256/i.test(src), '备份应做内容哈希校验');
});

/* ============================== 执行 ============================== */

(async () => {
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n── ${fn} ──`);
      continue;
    }
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail++;
      failed.push(name);
      console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
})();
