/**
 * `src/vendor/` 是 `doubak-extension` 里那几个文件的**同一份**拷贝。
 *
 * ## 为什么抄而不是自己写
 *
 * 这个仓库要产出的东西，和扩展产出的东西**必须是同一种格式**——不是「都符合
 * 规范」，是同一份实现。规范里有一批约束根本不在 JSON Schema 里，而在写入器的
 * 代码里：段轮转不许劈开一条记录、偏移量取自写入前的文件长度、`advanced=true`
 * 必须连续无缺口、`floor_time` 非 null 就不许写 `enumeration=full`。
 *
 * 分类器更是如此：`classifyResponse()` 的每一个判据都是量出来的，而且**相当一
 * 部分就是对着这个仓库要导入的那批老页面量的**。
 *
 * ## 这组测试守三件事
 *
 * **① 没漂。** 与上游逐字节相同（上游不在场时带原因跳过；CI 里必须在场）。
 * **② 名单两头对齐。** 只查目录的话，名单里加一项却忘了同步，测试照样绿。
 * **③ 真能用。** 只比对文本挡不住「语法没问题但少了个依赖」——那种文件文本
 * 比对全绿，跑起来才炸。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { SOURCES, findDir, renderOne, listJs } from '../tools/sync-vendor.mjs';
import { SPEC_VERSION, CAPTURE_FIDELITIES, VERDICTS } from '../src/vendor/core/spec-constants.js';
import { captureId, segmentFilename, indexFilename } from '../src/vendor/core/ids.js';
import { buildWarcRecord, buildHttpResponseBlock, gzipMember, gunzip } from '../src/vendor/core/warc.js';
import { classifyResponse, ROUTE_PROFILES } from '../src/vendor/crawl/classifier.js';
import { crawlStateEntry, coverageEntry } from '../src/vendor/bundle/manifest-builder.js';

const VENDOR = new URL('../src/vendor/', import.meta.url).pathname;

describe('vendor 与上游的一致性', () => {
  for (const source of SOURCES) {
    const dir = findDir(source);
    const skip = dir ? false : `找不到 ${source.repo} —— 单独 clone 这一个仓库时这是正常的`;

    test(`${source.repo}：**与上游逐字节相同**`, { skip }, () => {
      const want = renderOne(source, dir);
      const diff = [];
      for (const [name, text] of want) {
        const p = join(VENDOR, name);
        if (!existsSync(p)) { diff.push(`${name}（缺）`); continue; }
        if (readFileSync(p, 'utf-8') !== text) diff.push(`${name}（不一致）`);
      }
      assert.deepEqual(diff, [], `vendor 过期了，请运行 node tools/sync-vendor.mjs：\n${diff.join('\n')}`);
    });

    test(`${source.repo}：名单与目录两头对齐`, () => {
      // 两个方向都要查：上游删了文件这边还留着（多），名单里加了一项忘了同步（少）。
      assert.deepEqual(listJs(VENDOR).sort(), [...source.files].sort());
    });
  }

  test('上游一个都不能漏', () => {
    // SOURCES 被误删一项时，上面那些 test 会跟着一起消失——而消失的测试是绿的。
    assert.deepEqual(SOURCES.map((s) => s.repo), ['doubak-extension']);
  });
});

describe('搬过来的东西真的跑得动', () => {
  test('规范的投影：本仓库按 bundle/1.3 写，而且新那个成色取值在', () => {
    // 这个取值是这个仓库存在的前提：正文是真的、头部是编的，规范里必须有话说。
    // 少了它，`assertValidEntry` 会把每一行都拒掉。
    assert.match(SPEC_VERSION, /^bundle\/1\.\d+$/);
    assert.ok(CAPTURE_FIDELITIES.includes('decoded_body+synthesized_headers'),
      'capture_fidelity 里没有 decoded_body+synthesized_headers —— 先把规范那边的改动合了');
    assert.ok(VERDICTS.includes('login'), '未登录页要判成 login，这批数据里真的有');
  });

  test('标识符：格式与规范一致', () => {
    const b = '20240811T121600Z-4983ef';
    assert.equal(captureId(b, 42), `${b}#000042`);
    assert.equal(segmentFilename('catalog', b, 1), `catalog-${b}-00001.warc.gz`);
    assert.equal(indexFilename(b), `index-${b}.ndjson`);
    assert.throws(() => captureId('不是个 bundle id', 1));
  });

  test('WARC：写出来的记录能原样读回去', async () => {
    const body = new TextEncoder().encode('<html>正文有中文，Content-Length 必须按字节数算</html>');
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      body,
    });
    const rec = buildWarcRecord({
      type: 'response', recordId: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      date: new Date('2024-08-11T04:16:00Z'), block,
      contentType: 'application/http;msgtype=response',
      targetUri: 'https://www.douban.com/people/x/statuses?p=1',
    });
    const text = new TextDecoder().decode(await gunzip(await gzipMember(rec)));
    assert.ok(text.startsWith('WARC/1.1\r\n'));
    // 尖括号是 WARC 规范要求的；index.ndjson 里存的是不带尖括号的裸 URI。
    assert.match(text, /WARC-Record-ID: <urn:uuid:11111111-2222-3333-4444-555555555555>/);
    assert.match(text, /Content-Length: \d+/);
  });

  test('分类器：未登录页判成 login，而不是 ok', () => {
    // 这条是整个仓库最要紧的一条判定。前代工具把登录页按数据文件名写在磁盘上，
    // 没有任何标记；照单全收的话，会凭空造出一大批「用户把标签全删了」的修订。
    const login = readFileSync(
      new URL('./fixtures/its-my-data/collector/20231218.1022_broadcast_p1.html', import.meta.url), 'utf-8');
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/people/mewcatcher/statuses?p=1',
      status: 200, bodyText: login, route: ROUTE_PROFILES['broadcast.timeline'],
    });
    assert.equal(r.verdict, 'login');
  });

  test('写入器的不变量确实会拦人', () => {
    // 这几条是规范写在散文里、schema 表达不了的东西。搬过来之后必须还在拦。
    assert.throws(
      () => crawlStateEntry({
        routeKey: 'x', intent: 'x', highWaterTime: '2024-08-11T12:00:00+08:00',
        floorTime: '2024-01-01T00:00:00+08:00', enumeration: 'full',
        contiguous: true, advanced: false, bundleId: '20240811T121600Z-4983ef',
      }),
      /floor_time.*enumeration=full/s,
      '有下界还写 full —— 下游据此会把没删的当成删了',
    );
    assert.throws(
      () => coverageEntry({ routeKey: 'x', intent: 'x', claimedCount: 100, capturedCount: 1 }),
      /claimed_source/,
      '声明数量没有出处等于没记 —— 校验器要顺着它回到 WARC 里那张页面',
    );
  });
});
