/**
 * 第三方工具的目录 → 一份份合规的 bundle。
 *
 * ## 这不是「解析老 HTML」
 *
 * 页面本身不用动——它们是真的字节。要补的是**那批工具没有记录的元数据**：
 * 这一页是为什么抓的、URL 是什么、什么时候抓的、抓到的东西可不可信、
 * 这条路线枚举完整了没有。补完之后，解析器一行都不用改就能读它们。
 *
 * ## 补出来的东西必须标明是补的
 *
 * `capture_fidelity: decoded_body+synthesized_headers`（bundle/1.3）说的正是
 * 这件事：**正文是真的，头部是编的**。规范 §6.4.1 明令不许把它降级成
 * `filtered_headers`——那个取值宣称头部来自服务器，而「被过滤的真头部」和
 * 「凭空造的假头部」之间的区别，恰恰是取证时唯一要问的那个问题。
 *
 * 同理：
 * - `http_status` **不写**。WARC 的 response 记录结构上必须有个状态行，那没办法；
 *   但 index 里那个字段是可选的，编一个 200 进去毫无必要。**能不写就不写。**
 * - `url` 与 `observed_at` 是重建的，重建规则写进 `README.txt` 与 `manifest.notes`。
 *
 * ## verdict 照判不误
 *
 * 头部可以编，判定不可以。判定读的是**正文**，而正文是真的。一份老档案里的
 * 登录页就是 `login`，不因为「原工具当年以为成功了」而变成 `ok`——那正是
 * 规范 §6.5 那三条要拦下的东西，也是这批数据里真实存在的情况：
 * 实测 149 个列表页与 2 个广播页是未登录状态下抓的，7 个作品详情页是 0 字节。
 */

import { SegmentWriter } from './vendor/bundle/segment-writer.js';
import { IndexWriter } from './vendor/bundle/index-writer.js';
import { ManifestBuilder, coverageEntry, crawlStateEntry } from './vendor/bundle/manifest-builder.js';
import { captureId, indexFilename, bundleDirName, newWarcRecordId } from './vendor/core/ids.js';
import { buildWarcRecord, buildHttpResponseBlock } from './vendor/core/warc.js';
import { sha256Hex } from './vendor/core/digest.js';
import { SPEC_VERSION } from './vendor/core/spec-constants.js';
import {
  classifyResponse, ROUTE_PROFILES, extractItemIds, extractClaimedCount,
} from './vendor/crawl/classifier.js';

import { ADAPTER, routeOf, urlOf, daysOf } from './adapters/its-my-data-doubak.js';
import { readBytes } from './scan.js';
import { NodeFileStore } from './file-store.js';
import { stampToRfc3339, dayToUtcDate } from './time.js';
import { bundleReadme } from './bundle-readme.js';

export const IMPORTER_VERSION = '0.1.0';

/** 正文是真的，头部是编的。规范 §6.4.1。 */
const FIDELITY = 'decoded_body+synthesized_headers';

const decoder = new TextDecoder('utf-8');

/**
 * 一天一份 bundle。
 *
 * **为什么按自然日切**：一条路线的页面从来没有跨过一个自然日（实测，测试钉住了）。
 * 而这正是切分必须满足的唯一性质——一条路线被劈进两份档案，它的连续性证明在两边
 * 都不成立，于是一次完整的枚举会被记成两次不完整的。
 *
 * 按时间戳切会劈开广播（一次抓取横跨 `1815` 与 `1826` 两个戳）；按「间隔几小时」
 * 切要引入一个谁也说不清该取多少的阈值。
 *
 * @param {object} opts
 * @param {object[]} opts.entries          `scan()` 的产物
 * @param {string} opts.outDir
 * @param {{userId: string, username: string}} opts.account
 * @param {string} opts.timezone
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function convert({ entries, outDir, account, timezone, onProgress = () => {} }) {
  const days = daysOf(entries);
  const bundles = [];
  let previous = null;

  for (const day of days) {
    const dayEntries = entries.filter((e) => e.day === day);
    const bundleId = await deterministicBundleId(day, dayEntries);
    const result = await writeBundle({
      bundleId, previousBundleId: previous, day, entries: dayEntries,
      outDir, account, timezone, onProgress,
    });
    bundles.push(result);
    previous = bundleId;
  }
  return bundles;
}

/**
 * bundle_id 由 (适配器, 日期) 决定，**不用随机数**。
 *
 * 抓取工具用随机后缀是对的——每次抓取都是一次新的观测。但导入不是观测，它是对
 * 同一批冻结字节的一次转换：同一个目录导两遍，应当得到同一份档案。随机后缀会让
 * 第二次导入产出一份 id 不同、内容相同的 bundle，而解析器会把它当成**又一批观测**
 * 收下——虽然不会伪造修订（内容一样），但档案目录里会多出一份谁也说不清是什么的
 * 副本，链也分了叉。
 *
 * 时间戳部分取当天最早的那次捕获（转成 UTC），所以 bundle_id 仍然按时间排序。
 */
async function deterministicBundleId(day, dayEntries) {
  const earliest = dayEntries.reduce((a, e) => (e.hhmm < a ? e.hhmm : a), '2359');
  const stamp = dayToUtcDate(day, earliest).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const seed = new TextEncoder().encode(`${ADAPTER.id}|${day}`);
  const suffix = (await sha256Hex(seed)).slice(0, 6);
  return `${stamp}-${suffix}`;
}

async function writeBundle({
  bundleId, previousBundleId, day, entries, outDir, account, timezone, onProgress,
}) {
  const dir = `${outDir}/${bundleDirName(bundleId)}`;
  const store = new NodeFileStore(dir);
  const software = `doubak-import-adapters/${IMPORTER_VERSION}`;

  const writers = {
    data: new SegmentWriter({ store, bundleId, kind: 'data', software }),
    catalog: new SegmentWriter({ store, bundleId, kind: 'catalog', software }),
  };
  const index = new IndexWriter({ store, filename: indexFilename(bundleId) });

  /** routeKey → 这条路线在这一天的观测汇总 */
  const routes = new Map();
  let seq = 0;

  for (const e of entries) {
    const route = routeOf(e);
    const profile = ROUTE_PROFILES[route.profile];
    if (!profile) throw new Error(`分类器里没有这条路线的 profile: ${route.profile}`);

    const bytes = readBytes(e.path);
    const text = decoder.decode(bytes);
    const url = urlOf(e, account.username);
    const observedAt = stampToRfc3339(e.stamp, timezone);

    // **状态码是编的，所以只喂给分类器一个 200，且不写进 index。**
    // 分类器的主力信号本来就是页面框架而不是状态码——豆瓣以 200 返回封锁页，
    // 这条路线上「只看状态码等于完全没有检测」。
    const verdict = classifyResponse({ finalUrl: url, status: 200, bodyText: text, route: profile });

    const cid = captureId(bundleId, ++seq);
    const recordId = newWarcRecordId();
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      // 只放构成一条合法记录所必需的两行。多编一行就是多一分假。
      headers: [['Content-Type', 'text/html; charset=utf-8'], ['Content-Length', String(bytes.length)]],
      body: bytes,
    });
    const record = buildWarcRecord({
      type: 'response',
      recordId,
      date: new Date(observedAt),
      block,
      contentType: 'application/http;msgtype=response',
      targetUri: url,
    });

    const where = await writers[route.kind].append(record, cid);
    const row = {
      capture_id: cid,
      warc_record_id: recordId,
      segment: where.segment,
      offset: where.offset,
      length: where.length,
      url,
      intent: route.intent,
      route_key: route.routeKey,
      surface: route.surface,
      verdict: verdict.verdict ?? 'unknown',
      capture_fidelity: FIDELITY,
      observed_at: observedAt,
      content_sha256: await sha256Hex(bytes),
    };
    // `verdict: null` 是分类器说「判不出来」。规范 1.2 起这有专门的取值，
    // 而且**必须**配一个原因——光一个 unknown 只是把问题换了个说法。
    if (!verdict.verdict) row.verdict_reason = verdict.reasons?.[0] ?? 'unclassified';
    if (route.cursor) row.cursor = route.cursor;
    if (verdict.itemCount !== null && verdict.itemCount !== undefined) row.item_count = verdict.itemCount;

    await index.append(row);
    tally(routes, route, e, cid, text, profile, verdict, observedAt);
    if (seq % 500 === 0) onProgress(`${day}：已写入 ${seq} / ${entries.length}`);
  }

  const segments = (await Promise.all([writers.data.finalize(), writers.catalog.finalize()])).flat();
  const createdAt = stampToRfc3339(`${day}.${entries[0].hhmm}`, timezone);
  const completedAt = stampToRfc3339(`${day}.${entries[entries.length - 1].hhmm}`, timezone);

  const mb = new ManifestBuilder({
    bundleId,
    previousBundleId,
    account: { user_id: account.userId, username: account.username, profile_url: `https://www.douban.com/people/${account.username}/` },
    producer: {
      name: 'doubak-import-adapters',
      version: IMPORTER_VERSION,
      // 规范允许额外字段。**导入档案必须说出原始工具是谁**，否则读者无从判断
      // 这些补出来的元数据是照什么规则补的。
      imported_from: { tool: ADAPTER.id, url: ADAPTER.url },
    },
    timezoneAssumption: timezone,
    createdAt,
  });

  for (const r of routes.values()) {
    mb.addCoverage(coverageEntry({
      routeKey: r.routeKey,
      intent: r.intent,
      claimedCount: r.claimed?.count ?? null,
      claimedRaw: r.claimed?.raw ?? null,
      claimedSource: r.claimed?.captureId ?? null,
      claimedObservedAt: r.claimed?.observedAt ?? null,
      capturedCount: r.ids.size,
    }));
    mb.addCrawlState(crawlStateEntry({ ...enumerationOf(r), routeKey: r.routeKey, intent: r.intent, bundleId }));
  }

  const manifest = mb.build({
    status: 'complete',
    completedAt,
    segments,
    index: { filename: index.filename, sha256: await sha256Hex(await store.read(index.filename)), line_count: index.lineCount },
    counts: index.counts(),
    perSegmentIndexCounts: index.perSegmentCounts(),
    notes: NOTES(timezone),
  });

  await store.replace('manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  await store.replace('README.txt', new TextEncoder().encode(bundleReadme({ manifest, specVersion: SPEC_VERSION })));

  return { bundleId, dir, day, captures: seq, segments, manifest };
}

const NOTES = (tz) => [
  `本档案由 doubak-import-adapters 从 ${ADAPTER.id}（${ADAPTER.url}）的产出转换而来，不是抓取工具直接写的。`,
  '原工具只把响应正文写到磁盘，因此下列元数据是【重建】的，重建规则如下：',
  '  url        —— 由文件名里的媒介/状态/偏移量拼出豆瓣当时会发的链接。原工具实际请求了什么无从得知。',
  `  observed_at —— 取自文件名的时间戳（精确到分钟），时区按 ${tz} 假定（见 timezone_assumption）。`,
  '  intent / route_key —— 由文件名重建。原工具恰好把状态写进了文件名，换一个工具就不一定有。',
  '  http 响应头 —— 【是编的】。WARC 的 response 记录必须有响应头，而原工具一个都没留。见 capture_fidelity。',
  'verdict 不在此列：它读的是正文，而正文是真的，因此照常判定（未登录页仍然是 login）。',
].join('\n');

/** 把一条捕获归并进它那条路线的汇总里。 */
function tally(routes, route, entry, cid, text, profile, verdict, observedAt) {
  let r = routes.get(route.routeKey);
  if (!r) {
    r = { routeKey: route.routeKey, intent: route.intent, ids: new Set(), starts: [], pages: [], claimed: null, okPages: 0, total: 0 };
    routes.set(route.routeKey, r);
  }
  r.total += 1;
  // **只有判定为 ok 的页面才算数。** 一个未登录页上也有条目，把它算进
  // captured_count 会让一条其实没抓成的路线看起来抓成了。
  if (verdict.verdict !== 'ok') return;
  r.okPages += 1;
  for (const id of extractItemIds(text, profile)) r.ids.add(id);
  if (entry.kind === 'interest_list') r.starts.push(entry.start);
  if (entry.kind === 'broadcast') r.pages.push(entry.page);
  // 声明数量取**第一张**读到的页面，并记下是哪一条捕获——校验器要顺着这个
  // 指针回到 WARC 里那张页面，取不到来源的数字等于没记。
  if (!r.claimed) {
    const c = extractClaimedCount(text, profile);
    if (c) r.claimed = { ...c, captureId: cid, observedAt };
  }
}

/**
 * 这条路线在这一天算不算「整份枚举过了」。
 *
 * ## 三条一起决定，而且宁严勿宽
 *
 * 规范 §5.4.3 与解析器的 `absenceAuthority()` 都靠 `enumeration` 判断下游有没有
 * 资格推断删除，而**授予要严、否定要宽**：多否一次只是少一个删除信号，多授一次
 * 是凭空捏造删除。
 *
 * - **标记列表**：页面按 `start=0,15,30,…` 连续无缺口，且最后一页确实是最后一页
 *   （抓到的条目数少于一页的容量，说明我们看见了列表的尽头）→ `full`。
 * - **广播**：一律 `bounded`。它是按时间倒序翻的，「翻到了尽头」这件事没有一个
 *   像列表那样干脆的判据，而广播恰恰是最不能误判的一条线（发布即冻结、可静默删除）。
 * - **作品详情页**：`interest.item` 不是一份可枚举的列表，它是从列表页派生出来的
 *   一组 URL。`bounded`。
 *
 * `advanced` **恒为 false**。水位线是给下一次增量抓取用的下界，而一份导入档案
 * 不该给任何一次未来的抓取设下界——那会让下一次增量从 2024 年开始，中间几年的
 * 页面再也不会被读。同理 `floor_time` 恒为 null：这些页面不是「从某个下界往上抓」
 * 得来的。
 */
function enumerationOf(r) {
  const base = {
    highWaterTime: null, floorTime: null, floorFromBundleId: null,
    contiguous: false, gaps: [], advanced: false,
  };
  if (r.routeKey.startsWith('interest.') && r.starts.length) {
    const starts = [...r.starts].sort((a, b) => a - b);
    const expected = starts.map((_, i) => i * 15);
    const contiguous = starts[0] === 0 && starts.every((s, i) => s === expected[i]);
    // 抓到的条目数少于「页数 × 每页 15」，说明最后一页没满——我们看见了尽头。
    const sawEnd = r.ids.size < starts.length * 15;
    return { ...base, contiguous, enumeration: contiguous && sawEnd ? 'full' : 'bounded' };
  }
  if (r.routeKey === 'broadcast.timeline' && r.pages.length) {
    const pages = [...new Set(r.pages)].sort((a, b) => a - b);
    const contiguous = pages[0] === 1 && pages.every((p, i) => p === i + 1);
    return { ...base, contiguous, enumeration: 'bounded' };
  }
  return { ...base, enumeration: 'bounded' };
}
