/**
 * 落盘的那一半：`SegmentWriter` / `IndexWriter` 需要的 store，用 node:fs 实现。
 *
 * ## 为什么这个文件不在 vendor 名单里
 *
 * 「字节从哪儿来、往哪儿去」是**宿主差异**，本来就该各写各的：扩展写 OPFS，
 * 这边写文件系统。而「字节是什么意思」——段怎么轮转、偏移量怎么算、index 行
 * 合不合规——只能有一份实现，那一份在 `src/vendor/` 里抄过来。
 *
 * 这条线与解析器那边的 `bundle-source.js`、导出适配器那边的 `canonical.js`
 * 是同一条。
 *
 * ## 只追加
 *
 * `SegmentWriter` 的偏移量取自「写入前的文件长度」（见它的抬头），这要求存储
 * **只在末尾追加**。所以这里没有随机写，也不打算有。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class NodeFileStore {
  /** @param {string} dir 档案目录，不存在会建出来 */
  constructor(dir) {
    if (!dir) throw new Error('缺少目录');
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
  }

  /** @param {string} name */
  _path(name) {
    // 只收纯文件名。段文件名与 index 文件名都由 vendor 里的 ids.js 生成，
    // 不该出现路径分隔符；出现了就是别处算错了，早点炸比写到档案外面好。
    if (name.includes('/') || name.includes('\\') || name === '..') {
      throw new Error(`store 只接受纯文件名: ${name}`);
    }
    return join(this.dir, name);
  }

  /** @param {string} name @param {Uint8Array} bytes */
  async append(name, bytes) {
    appendFileSync(this._path(name), bytes);
  }

  /** @param {string} name @param {Uint8Array} bytes */
  async replace(name, bytes) {
    writeFileSync(this._path(name), bytes);
  }

  /** @param {string} name @returns {Promise<number>} 不存在时是 0 */
  async size(name) {
    const p = this._path(name);
    return existsSync(p) ? statSync(p).size : 0;
  }

  /**
   * @param {string} name
   * @param {number} [offset] @param {number} [length]
   * @returns {Promise<Uint8Array>}
   */
  async read(name, offset, length) {
    const buf = readFileSync(this._path(name));
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (offset === undefined) return bytes;
    return bytes.slice(offset, length === undefined ? undefined : offset + length);
  }

  /** @param {string} name */
  async exists(name) {
    return existsSync(this._path(name));
  }
}
