/**
 * 端到端：一个目录 → 几份合规的 bundle。
 *
 * fixture 是**真实页面**，而且是特意挑的六种形态：登录状态下抓的正常列表页、
 * 未登录状态下抓的列表页、整页就是登录页的、翻过头的终止页、被当成数据存下来的
 * 豆瓣 404、以及一个 0 字节文件。这六种在那 782 MB 里全都真实存在，而它们**全都
 * 曾经以「数据文件」的身份躺在磁盘上，没有任何标记**——这个仓库存在的理由就是
 * 给它们各自贴上标签。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { scan } from '../src/scan.js';
import { resolveAccount } from '../src/identity.js';
import { convert } from '../src/convert.js';
import { REQUIRED_INDEX_FIELDS } from '../src/vendor/core/spec-constants.js';

const FIX = new URL('./fixtures/its-my-data', import.meta.url).pathname;

let out; let bundles; let rows; let manifests;

before(async () => {
  out = mkdtempSync(join(tmpdir(), 'doubak-import-'));
  const { entries } = scan(FIX);
  const account = resolveAccount(entries, (p) => readFileSync(p, 'utf-8'));
  bundles = await convert({ entries, outDir: out, account, timezone: 'Asia/Shanghai' });
  manifests = bundles.map((b) => b.manifest);
  rows = bundles.flatMap((b) => readFileSync(join(b.dir, b.manifest.index.filename), 'utf-8')
    .split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), _dir: b.dir })));
});

describe('产出的形状', () => {
  test('一天一份档案，串成一条链', () => {
    assert.deepEqual(bundles.map((b) => b.day), ['20230127', '20231218', '20240811']);
    assert.equal(manifests[0].previous_bundle_id, null, '第一份是链的起点');
    for (let i = 1; i < manifests.length; i++) {
      assert.equal(manifests[i].previous_bundle_id, manifests[i - 1].bundle_id);
    }
  });

  test('每一行都带齐规范要求的必填字段', () => {
    // 这几个字段**事后不可恢复**，所以规范把它们列为必填。
    for (const r of rows) {
      for (const f of REQUIRED_INDEX_FIELDS) {
        assert.ok(r[f] !== undefined && r[f] !== null, `${r.capture_id} 缺 ${f}`);
      }
    }
    assert.ok(rows.length >= 6, `只有 ${rows.length} 行，fixture 大概坏了`);
  });

  test('偏移量真的指向一个能解开的 WARC 记录', () => {
    // 校验器查的就是这条。offset/length 对不上的话，档案看起来完好，
    // 而任何一个读者都取不出内容。
    for (const r of rows) {
      const seg = readFileSync(join(r._dir, r.segment));
      const member = seg.subarray(r.offset, r.offset + r.length);
      const raw = gunzipSync(member).toString('utf-8');
      assert.ok(raw.startsWith('WARC/1.1'), `${r.capture_id} 解出来的不是 WARC 记录`);
      assert.ok(raw.includes(`<${r.warc_record_id}>`), `${r.capture_id} 记录 ID 对不上`);
      assert.ok(raw.includes(`WARC-Target-URI: ${r.url}`), `${r.capture_id} 目标 URL 对不上`);
    }
  });

  test('留存等级分段：作品详情页单独成段，可以整批 rm', () => {
    const kinds = new Map(rows.map((r) => [r.segment.split('-')[0], r.intent]));
    assert.equal([...new Set(rows.filter((r) => r.intent === 'interest.item').map((r) => r.segment.split('-')[0]))][0], 'catalog');
    assert.ok([...kinds.keys()].includes('data'), '用户自己的页面要进 data-');
  });
});

describe('诚实：补出来的东西必须标明是补的', () => {
  test('**每一行都写着「正文是真的，头部是编的」**', () => {
    // 规范 §6.4.1：不许降级成 filtered_headers——那个取值宣称头部来自服务器。
    // 「被过滤的真头部」与「凭空造的假头部」的区别，恰恰是取证时唯一要问的问题。
    for (const r of rows) {
      assert.equal(r.capture_fidelity, 'decoded_body+synthesized_headers', r.capture_id);
    }
  });

  test('**不写 http_status**：能不编就不编', () => {
    // WARC 的 response 记录结构上必须有个状态行，那没办法；但 index 里这个字段
    // 是可选的，编一个 200 进去毫无必要，而且读者会拿它当真。
    for (const r of rows) assert.ok(!('http_status' in r), `${r.capture_id} 写了 http_status`);
  });

  test('重建规则写进了 manifest.notes 与 README.txt', () => {
    for (const b of bundles) {
      const readme = readFileSync(join(b.dir, 'README.txt'), 'utf-8');
      assert.match(b.manifest.notes, /url\s+——/, 'notes 要说清 url 是怎么重建的');
      assert.match(b.manifest.notes, /observed_at/);
      assert.match(b.manifest.notes, /是编的/, 'notes 要说清响应头是编的');
      // README 是给 2040 年那个陌生人看的，中英都要有。
      assert.match(readme, /WARC/);
      assert.ok(readme.includes(b.manifest.spec_version), 'README 要写明规范版本，且与 manifest 一致');
      assert.match(readme, /ARE FABRICATED/, 'README 的英文部分也要说清响应头是编的');
      assert.match(readme, /imported|IMPORTED/i);
    }
  });

  test('producer 里说清原始工具是谁', () => {
    for (const m of manifests) {
      assert.equal(m.producer.name, 'doubak-import-adapters');
      assert.equal(m.producer.imported_from.tool, 'its-my-data/doubak');
      assert.match(m.producer.imported_from.url, /^https:\/\/github\.com\//);
    }
  });

  test('时区是【假定】，而且记下来了', () => {
    for (const m of manifests) assert.equal(m.timezone_assumption, 'Asia/Shanghai');
    for (const r of rows) {
      assert.match(r.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,
        'observed_at 必须带显式偏移 —— 丢了它，海外时区读出来整体差几小时');
    }
  });
});

describe('verdict 照判不误 —— 头部可以编，判定不可以', () => {
  const of = (name) => rows.find((r) => r.capture_id && r.url && matchName(r, name));
  const matchName = (r, name) => {
    if (name === 'anon-list') return r.route_key === 'interest.game.collect' && r.observed_at.startsWith('2023-01');
    if (name === 'login-page') return r.route_key === 'broadcast.timeline' && r.observed_at.startsWith('2023-12');
    if (name === 'empty') return r.intent === 'interest.item' && r.observed_at.startsWith('2023-12');
    if (name === 'soft404') return r.intent === 'interest.item' && r.observed_at.startsWith('2023-01');
    if (name === 'good') return r.route_key === 'interest.game.collect' && r.observed_at.startsWith('2024-08');
    return false;
  };

  test('未登录抓到的列表页 → login，不是 ok', () => {
    // 这是整个仓库最要紧的一条。照单全收的话，实测会凭空造出 2856 条
    // 「用户把标签全删了、又加回来」的修订——而档案里一个字都没改过。
    assert.equal(of('anon-list').verdict, 'login');
  });

  test('整页是登录页的 → login', () => {
    assert.equal(of('login-page').verdict, 'login');
  });

  test('0 字节的文件 → 不许是 ok，而且要说清是哪一种判不出来', () => {
    // 规范 §6.5.2。真实档案里有 7 个这样的文件，与一次会话失效同批产生，
    // 磁盘上没有任何失败痕迹——下游只会看到「文件在」。
    const r = of('empty');
    assert.notEqual(r.verdict, 'ok');
    if (r.verdict === 'unknown') {
      assert.ok(r.verdict_reason, '光一个 unknown 只是把问题换了个说法，必须配原因');
    }
  });

  test('被当成数据存下来的豆瓣 404 → soft404', () => {
    assert.equal(of('soft404').verdict, 'soft404');
  });

  test('真正抓到的页面 → ok，而且带上条目数与游标', () => {
    const r = of('good');
    assert.equal(r.verdict, 'ok');
    assert.ok(r.item_count > 0, '抓到的列表页要记下渲染出来的条目数');
    assert.deepEqual(r.cursor, { kind: 'start', value: 285 });
  });
});

describe('coverage 与 crawl_state：授予要严', () => {
  test('声明数量必须有出处，且出处是一条真的捕获', () => {
    const ids = new Set(rows.map((r) => r.capture_id));
    for (const m of manifests) {
      for (const c of m.coverage) {
        if (c.claimed_count === null) { assert.equal(c.claimed_source, null); continue; }
        assert.ok(ids.has(c.claimed_source), `${c.route_key} 的 claimed_source 不存在`);
        assert.equal(c.delta, c.captured_count - c.claimed_count);
      }
    }
  });

  test('未登录那一天，captured_count 是 0 —— 不把没抓成的算成抓成了', () => {
    const jan = manifests.find((m) => m.bundle_id.startsWith('20230127'));
    for (const c of jan.coverage) {
      assert.equal(c.captured_count, 0, `${c.route_key}：这一天所有页面都不是 ok`);
      assert.equal(c.claimed_count, null, '声明数量也只从 ok 的页面上取');
    }
  });

  test('**一份导入档案不给任何未来的抓取设下界**', () => {
    // advanced=true 会让下一次增量从 2024 年开始，中间几年的页面再也不会被读。
    // 而这些页面本来就不是「从某个下界往上抓」得来的，所以 floor_time 也是 null。
    for (const m of manifests) {
      for (const cs of m.crawl_state) {
        assert.equal(cs.advanced, false, `${cs.route_key} 不该推进水位线`);
        assert.equal(cs.floor_time, null);
        assert.equal(cs.floor_from_bundle_id, null);
      }
    }
  });

  test('广播一律 bounded —— 它最不能误判', () => {
    for (const m of manifests) {
      const bc = m.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
      if (bc) assert.equal(bc.enumeration, 'bounded');
    }
  });

  test('段的 record_count 等于指向它的 index 行数', () => {
    for (const b of bundles) {
      const per = new Map();
      for (const r of rows.filter((x) => x._dir === b.dir)) per.set(r.segment, (per.get(r.segment) ?? 0) + 1);
      for (const s of b.manifest.segments) assert.equal(s.record_count, per.get(s.filename) ?? 0, s.filename);
    }
  });
});

describe('可复现', () => {
  test('同一个目录导两遍，档案身份与内容完全一致', async () => {
    // 导入不是观测，是对同一批冻结字节的一次转换。bundle_id 若用随机后缀，第二次
    // 导入会产出一份 id 不同、内容相同的档案，而目录里从此多一份谁也说不清是什么
    // 的副本，链也分了叉。所以 bundle_id 由 (适配器, 日期) 算出来。
    //
    // **但逐字节相同是做不到的，而且不该假装做得到**：WARC 规范要求
    // `WARC-Record-ID` 全局唯一，我们照办用了随机 uuid。uuid 不同 → gzip member
    // 的压缩结果长度不同 → 后面每一条记录的 offset 都会挪几个字节。
    //
    // 所以这里断言的是**语义**层面的可复现：同样的档案、同样的捕获、同样的
    // URL / 判定 / 内容摘要。那才是「重导一遍看看变了什么」真正要比的东西。
    const out2 = mkdtempSync(join(tmpdir(), 'doubak-import-2-'));
    const { entries } = scan(FIX);
    const account = resolveAccount(entries, (p) => readFileSync(p, 'utf-8'));
    const again = await convert({ entries, outDir: out2, account, timezone: 'Asia/Shanghai' });

    assert.deepEqual(again.map((b) => b.bundleId), bundles.map((b) => b.bundleId));

    const meaning = (dir, m) => readFileSync(join(dir, m.index.filename), 'utf-8')
      .split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l);
        // 这三个跟着 uuid 走，别的都必须一样。
        delete r.warc_record_id; delete r.offset; delete r.length;
        return r;
      });

    for (let i = 0; i < again.length; i++) {
      assert.deepEqual(
        meaning(again[i].dir, again[i].manifest),
        meaning(bundles[i].dir, bundles[i].manifest),
        `第 ${i} 份档案的内容不可复现`,
      );
    }
    rmSync(out2, { recursive: true, force: true });
  });

  test('index 里那三个会变的字段，确实只有那三个', () => {
    // 上面那条测试靠「删掉三个字段再比」成立。**万一将来又多出一个随机字段，
    // 那条测试会继续绿，而可复现性已经悄悄没了。** 所以在这里把字段全集钉住。
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    keys.delete('_dir');
    assert.deepEqual([...keys].sort(), [
      'capture_id', 'capture_fidelity', 'content_sha256', 'cursor', 'intent',
      'item_count', 'length', 'observed_at', 'offset', 'route_key', 'segment',
      'surface', 'url', 'verdict', 'verdict_reason', 'warc_record_id',
    ].sort(), '本仓库写出的 index 字段集变了 —— 顺带确认新字段是不是可复现的');
  });
});
