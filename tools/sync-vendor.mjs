#!/usr/bin/env node
/**
 * 把 `doubak-extension` 里**写 bundle 的那一半**同步进 `src/vendor/`。
 *
 *   node tools/sync-vendor.mjs           # 同步
 *   node tools/sync-vendor.mjs --check   # 只比对，不写（测试与 CI 调用）
 *
 * ## 为什么是抄一份，不是自己写一份
 *
 * 这个仓库要产出的东西和扩展产出的东西**必须是同一种格式**——不是「都符合规范」，
 * 是同一份实现。规范里有一批约束根本不在 JSON Schema 里，而在写入器的代码里：
 * 段轮转不许劈开一条记录、偏移量取自写入前的文件长度、`advanced=true` 必须
 * 连续无缺口、`floor_time` 非 null 就不许写 `enumeration=full`。另写一份浅的，
 * 结果是**能力更弱而且会漂**，而漂出来的档案照样能通过校验器。
 *
 * 更要命的是分类器。`classifyResponse()` 里每一个判据都是对着真实字节量出来的，
 * 其中相当一部分**就是对着这个仓库要导入的那批老页面量的**——它的注释里写着
 * 「旧档案里 6341 个作品详情页中有 7 个是 0 字节」「2022-12 → 2024-08 共 403 个
 * 广播页」。在这边重写一份判定逻辑，等于把那些实测结论重新猜一遍。
 *
 * ## 为什么不 import 过去，也不用 submodule
 *
 * 八个仓库各自独立，没有 monorepo，也**刻意没有构建步骤**。跨仓库的 `import`
 * 在装好的东西里根本不存在，打包器也没有。所以走既定的那条路——与扩展的
 * `tools/sync-vendor.mjs`、`tools/generate-spec-constants.mjs` 一模一样：
 * **产物提交进仓库**（本仓库单独 clone 也能跑测试），新鲜度由 `--check` 守着。
 *
 * submodule 不行的具体理由见扩展那份的抬头：`git clone` 不加 `--recursive` 会
 * 留下一个**存在但是空的**目录，于是「静静地少了东西」。
 *
 * ## 边界：搬「字节是什么意思」，不搬「字节落在哪儿」
 *
 * `SegmentWriter` / `IndexWriter` 都收一个注入的 `store`，所以它们本身是可搬的；
 * 真正的宿主差异是那个 store——扩展写 OPFS，这边写 node:fs。那一份在
 * `src/file-store.js`，**不在这个名单里**，也不该在。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCES = [
  {
    repo: 'doubak-extension',
    env: 'DOUBAK_EXTENSION_DIR',
    probe: 'src/core/warc.js',
    dest: '.',
    /**
     * 目录结构照抄，不拉平。`bundle/segment-writer.js` 里写的是
     * `import { ... } from '../core/ids.js'`——拉平就得改那行，而**改了就不再是
     * 同一份**，逐字节比对也就失去了意义。
     */
    files: [
      // 规范的投影。手抄这些取值意味着规范新增一个 verdict 之后，这边会继续
      // 按旧词表拒掉它，而没有任何东西会提醒你。
      'core/spec-constants.js',
      'core/ids.js',
      'core/time.js',
      'core/digest.js',
      'core/warc.js',
      // 写入器三件套。收注入的 store，所以是可搬的纯逻辑。
      'bundle/segment-writer.js',
      'bundle/index-writer.js',
      'bundle/manifest-builder.js',
      // 判定与页面抽取。**这个仓库存在的理由有一半在这个文件里。**
      'crawl/classifier.js',
    ],
  },
];

/** @param {typeof SOURCES[number]} source */
export function findDir(source) {
  const candidates = [process.env[source.env], join(ROOT, '..', source.repo)].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, source.probe))) ?? null;
}

/**
 * 加一行醒目的抬头。**不改任何一行代码**——改了就不再是「同一份」，
 * 而这个脚本的全部意义就是让它们是同一份。
 */
export function stamp(src, name, repo) {
  return `/* 【自动同步，请勿手改】来自 ${repo} 的 src/${name}\n`
    + ` * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。\n`
    + ` * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。\n`
    + ` */\n${src}`;
}

/** @returns {Map<string, string>} 相对 `src/vendor/` 的路径 → 内容 */
export function renderOne(source, dir) {
  const out = new Map();
  for (const name of source.files) {
    const path = join(dir, 'src', name);
    if (!existsSync(path)) {
      // **这不是「文件丢了」，多半是上游的改动还没合并。** CI 把兄弟仓库检出在
      // 各自的默认分支上，所以名单里新加的文件在上游合并之前一定不存在。
      throw new Error([
        `${source.repo} 里没有 src/${name}。`,
        '这一般不是文件丢了，而是【上游的改动还没合并】：CI 与本地默认都按各自的',
        '默认分支检出兄弟仓库，所以这份名单里新加的文件要等上游合并之后才存在。',
        `先合 ${source.repo} 那个 PR 再跑这里，或者用 ${source.env} 指到别处。`,
      ].join('\n  '));
    }
    out.set(name, stamp(readFileSync(path, 'utf-8'), name, source.repo));
  }
  return out;
}

/** 递归列出一个目录下的 .js（相对路径），不存在就是空。 */
export function listJs(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listJs(join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const missing = [];
  const plans = [];

  for (const source of SOURCES) {
    const dir = findDir(source);
    if (!dir) { missing.push(source); continue; }
    plans.push({ source, want: renderOne(source, dir) });
  }

  if (missing.length) {
    const names = missing.map((m) => `${m.repo}（试过 ${m.env} 与 ../${m.repo}）`);
    // **本地缺仓库时是「带原因跳过」，CI 里必须是失败。** 跳过在 CI 里等于没测。
    console.error(`找不到：${names.join('；')}`);
    if (process.env.CI) { console.error('CI 里这算失败：跳过等于没测'); process.exit(2); }
    if (check) console.error('本地缺仓库，跳过这几项检查');
    if (!plans.length) process.exit(check ? 0 : 2);
  }

  const stale = [];
  const extra = [];
  for (const { source, want } of plans) {
    const dest = join(ROOT, 'src', 'vendor', source.dest);
    for (const [name, text] of want) {
      const p = join(dest, name);
      if (!existsSync(p) || readFileSync(p, 'utf-8') !== text) stale.push(name);
    }
    // 上游删掉一个文件、这边还留着，也是漂。两个方向都要查。
    for (const name of listJs(dest)) if (!want.has(name)) extra.push(name);
  }

  if (check) {
    if (!stale.length && !extra.length) { console.log('vendor 与上游一致'); return; }
    console.error('vendor 过期了，请运行 node tools/sync-vendor.mjs');
    for (const n of stale) console.error(`  不一致或缺失：${n}`);
    for (const n of extra) console.error(`  上游已无此文件：${n}`);
    process.exit(1);
  }

  for (const { source, want } of plans) {
    const dest = join(ROOT, 'src', 'vendor', source.dest);
    for (const [name, text] of want) {
      const p = join(dest, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    for (const name of listJs(dest)) if (!want.has(name)) rmSync(join(dest, name));
  }
  console.log(`已同步 ${plans.reduce((n, p) => n + p.want.size, 0)} 个文件`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
