/**
 * 走一遍第三方工具的产出目录。**这个文件是本仓库唯一读输入的地方。**
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseName } from './adapters/its-my-data-doubak.js';

/**
 * @param {string} root `output/` 或 `output/collector/` 都认
 * @returns {{collector: string, entries: object[], unrecognized: string[]}}
 */
export function scan(root) {
  const collector = statSync(join(root, 'collector'), { throwIfNoEntry: false })?.isDirectory()
    ? join(root, 'collector')
    : root;

  const entries = [];
  const unrecognized = [];

  /** @param {string} dir @param {boolean} inItems */
  const walk = (dir, inItems) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) {
        if (!inItems && e.name === 'items') walk(join(dir, e.name), true);
        else unrecognized.push(`${e.name}/`);
        continue;
      }
      if (!e.name.endsWith('.html')) continue;
      const desc = parseName(e.name, inItems);
      // **认不出来的要数出来。** 静静跳过等于宣布「这个目录里就这么多」，
      // 而少读一个文件在产出里没有任何声响。
      if (!desc) { unrecognized.push(inItems ? `items/${e.name}` : e.name); continue; }
      entries.push({ ...desc, name: e.name, path: join(dir, e.name) });
    }
  };
  walk(collector, false);

  // 时间戳升序，同一戳内按文件名——**产出必须可复现**，同一个输入目录跑两遍
  // 要得到逐字节相同的档案，否则「重跑一遍看看变了什么」这件事就没法做。
  entries.sort((a, b) => (a.stamp + a.name < b.stamp + b.name ? -1 : 1));
  return { collector, entries, unrecognized };
}

/** @param {string} path @returns {Uint8Array} */
export function readBytes(path) {
  const b = readFileSync(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
