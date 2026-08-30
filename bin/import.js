#!/usr/bin/env node
/**
 * 把第三方抓取工具存下来的页面，转成 doubak 的 bundle 档案。
 *
 *   node bin/import.js <第三方工具的产出目录> <输出目录> [选项]
 *
 * 选项：
 *   --timezone=Asia/Shanghai   文件名上的裸时间按哪个时区解释（会写进 manifest）
 *   --user-id=<数字ID>          账号的数字 ID，认不准时用它说清楚
 *   --username=<域名>           个人页域名（不是数字 ID）
 *   --force                    输出目录里已有同名档案时覆盖
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { scan } from '../src/scan.js';
import { resolveAccount } from '../src/identity.js';
import { convert, IMPORTER_VERSION } from '../src/convert.js';
import { bundleDirName } from '../src/vendor/core/ids.js';

function flag(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// 用法文本写在这里，**不是从源码里按行号切出来的**。按位置切源码的写法
// 在这个项目里已经坏过好几次：重排一下注释，帮助信息就变成半句话。
const USAGE = `把第三方抓取工具存下来的页面，转成 doubak 的 bundle 档案。

  node bin/import.js <第三方工具的产出目录> <输出目录> [选项]

选项：
  --timezone=Asia/Shanghai   文件名上的裸时间按哪个时区解释（会写进 manifest）
  --user-id=<数字ID>          账号的数字 ID，认不准时用它说清楚
  --username=<域名>           个人页域名（不是数字 ID）
  --force                    输出目录里已有同名档案时覆盖

目前支持的来源：its-my-data/doubak（https://github.com/its-my-data/doubak）`;

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (positional.length < 2 || process.argv.includes('--help')) {
  console.error(USAGE);
  process.exit(2);
}

const [inDir, outDir] = positional.map((p) => resolve(p));
const timezone = flag('timezone', 'Asia/Shanghai');
const force = process.argv.includes('--force');

if (!existsSync(inDir)) { console.error(`输入目录不存在: ${inDir}`); process.exit(2); }

console.log(`doubak-import-adapters ${IMPORTER_VERSION}`);
console.log(`读取 ${inDir}`);

const { collector, entries, unrecognized } = scan(inDir);
if (!entries.length) {
  console.error(`${collector} 里一个认得出的页面都没有。这个目录是 its-my-data/doubak 的产出吗？`);
  process.exit(2);
}
console.log(`  认出 ${entries.length} 个页面`);
if (unrecognized.length) {
  // **认不出来的要说出来。** 静静跳过等于宣布「这个目录里就这么多」。
  console.log(`  认不出 ${unrecognized.length} 个（不会被导入）：${unrecognized.slice(0, 5).join(' ')}${unrecognized.length > 5 ? ' …' : ''}`);
}

const account = resolveAccount(entries, (p) => readFileSync(p, 'utf-8'),
  { userId: flag('user-id'), username: flag('username') });
console.log(`  账号 ${account.username} (${account.userId})`);
for (const n of account.notes) console.log(`    ${n}`);
console.log(`  时区假定 ${timezone}（写进 manifest.timezone_assumption）`);

mkdirSync(outDir, { recursive: true });
if (!force) {
  const clash = readdirSync(outDir).filter((n) => n.startsWith('doubak-bundle-'));
  if (clash.length) {
    console.error(`\n${outDir} 里已经有 ${clash.length} 份档案了。`);
    console.error('导入是可复现的：同一个输入目录产出同一批 bundle_id，所以重跑会撞名。');
    console.error('确认要覆盖就加 --force，否则换一个输出目录。');
    process.exit(2);
  }
} else {
  for (const n of readdirSync(outDir)) {
    if (n.startsWith('doubak-bundle-')) rmSync(`${outDir}/${n}`, { recursive: true, force: true });
  }
}

const bundles = await convert({
  entries, outDir, account, timezone,
  onProgress: (m) => console.log(`  ${m}`),
});

console.log(`\n写出 ${bundles.length} 份档案到 ${outDir}`);
let total = 0;
for (const b of bundles) {
  const v = b.manifest.counts?.by_verdict ?? {};
  const bad = Object.entries(v).filter(([k]) => k !== 'ok').map(([k, n]) => `${k} ${n}`).join(' · ');
  total += b.captures;
  console.log(`  ${bundleDirName(b.bundleId)}  ${String(b.captures).padStart(5)} 次捕获  ok ${v.ok ?? 0}${bad ? `  ⚠ ${bad}` : ''}`);
}
console.log(`  合计 ${total} 次捕获`);
console.log('\n下一步：');
console.log(`  python3 <doubak-data-specs>/bundle/v1/validate.py ${outDir}/doubak-bundle-*   # 校验`);
console.log(`  node <doubak-data-parser>/bin/parse.js ${outDir} <canonical 输出目录>          # 解析`);
