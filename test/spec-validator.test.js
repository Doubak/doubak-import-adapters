/**
 * 拿**规范仓库自己的参考校验器**验一遍产出。
 *
 * ## 为什么这条不能用本仓库的断言代替
 *
 * 校验器查的是**跨文件的一致性**，而那正是自己写的测试最容易漏掉的一层：
 * 偏移量真的指向一个 gzip member 吗？`claimed_source` 真的指向一条存在的捕获吗？
 * 段的 `record_count` 与 index 行数对得上吗？
 *
 * 更要紧的是它是**另一边**写的。本仓库的写入器与本仓库的测试出自同一套理解，
 * 一个理解错了，两边会一起错而且一起绿。校验器是外部裁判。
 *
 * 本地没有规范仓库时带原因跳过；CI 里必须在场——跳过在 CI 里等于没测。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scan } from '../src/scan.js';
import { resolveAccount } from '../src/identity.js';
import { convert } from '../src/convert.js';

const FIX = new URL('./fixtures/its-my-data', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

function findValidator() {
  for (const d of [process.env.DOUBAK_SPECS_DIR, join(ROOT, '..', 'doubak-data-specs')].filter(Boolean)) {
    const p = join(d, 'bundle', 'v1', 'validate.py');
    if (existsSync(p)) return p;
  }
  return null;
}

describe('规范仓库的参考校验器', () => {
  const validator = findValidator();
  const skip = validator ? false : '找不到 doubak-data-specs —— 单独 clone 这一个仓库时这是正常的';

  test('导出来的每一份档案都通过', { skip }, async () => {
    if (process.env.CI && !validator) assert.fail('CI 里必须有规范仓库：跳过等于没测');

    const out = mkdtempSync(join(tmpdir(), 'doubak-import-validate-'));
    try {
      const { entries } = scan(FIX);
      const account = resolveAccount(entries, (p) => readFileSync(p, 'utf-8'));
      const bundles = await convert({ entries, outDir: out, account, timezone: 'Asia/Shanghai' });
      assert.ok(bundles.length >= 3, `只导出了 ${bundles.length} 份，fixture 大概坏了`);

      for (const b of bundles) {
        let output;
        try {
          output = execFileSync('python3', [validator, b.dir], { encoding: 'utf-8' });
        } catch (err) {
          assert.fail(`${b.bundleId} 没通过参考校验器：\n${err.stdout ?? ''}${err.stderr ?? ''}`);
        }
        assert.match(output, /通过/, `${b.bundleId}:\n${output}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
