/**
 * 档案里的 `README.txt`。
 *
 * 规范 §2.2 要求它必须在、必须中英双语、必须说明这是什么与怎么打开。理由是
 * **目标读者包括「2040 年偶然拿到这个目录的陌生人」**，那时这个项目可能早已不在。
 *
 * 导入档案要多说一件事：**这份不是抓取工具直接写的**。哪些字段是重建的、按什么
 * 规则重建，必须写在这里——规范 §6.4.1 明确要求（「重建规则必须写进 manifest.notes
 * 与档案的 README.txt」）。一个只看得懂英文的人也该看得出这份档案的成色。
 */

/** @param {{manifest: object, specVersion: string}} o */
export function bundleReadme({ manifest, specVersion }) {
  const m = manifest;
  const from = m.producer?.imported_from ?? {};
  return `doubak bundle — ${m.bundle_id}
${'='.repeat(60)}

【中文】

这是一份「豆备 (Doubak)」档案，规范版本 ${specVersion}。

  manifest.json                这份档案的元数据：属于谁、抓了哪些路线、覆盖到什么程度
  index-*.ndjson               每行一次捕获：URL、为什么抓、什么时候抓、可不可信
  data-*.warc.gz               用户自己的页面（广播、标记列表）。没了就是没了
  catalog-*.warc.gz            作品条目详情页。属于缓存，源站还在就能重抓，可以整批删

WARC 是标准的网页存档格式，用 pywb 或 ReplayWeb.page (https://replayweb.page/)
可以直接打开，不需要本项目的任何工具。每条记录单独压成一个 gzip member，所以
index 里的 offset/length 可以直接定位到某一条。

### 这一份是【导入】来的，不是抓取工具直接写的

原始页面由 ${from.tool ?? '第三方工具'} 抓取并保存
${from.url ? `(${from.url})\n` : ''}
那个工具只把 HTTP 响应的【正文】写到了磁盘，别的什么都没留。所以下面这些字段
是本工具事后【重建】的：

  url          由原文件名里的媒介/状态/偏移量拼出豆瓣当时会发的链接。
               原工具实际请求了什么，无从得知。
  observed_at  取自原文件名的时间戳，只精确到分钟。
               时区是【假定】的：${m.timezone_assumption}（见 manifest.timezone_assumption）。
  intent       同样由文件名重建。
  HTTP 响应头  【是编的】。WARC 的 response 记录结构上必须有响应头，而原工具
               一个都没留下。index 里的 capture_fidelity 一律写着
               "decoded_body+synthesized_headers"，意思正是：
               ★ 正文是真的，响应头是编的。★

  → 因此 index 里【没有】http_status 字段：编一个状态码进去毫无必要。

不在此列的是 verdict（可不可信）。它读的是正文，而正文是真的，所以照常判定：
这批页面里真实存在未登录状态下抓到的列表页与零字节的详情页，它们在这份档案里
分别是 login 与非 ok，不会被当成抓成功了。

完整规范：https://spec.doubak.com/bundle/v1/
项目主页：https://doubak.com

${'='.repeat(60)}

[English]

This is a "Doubak" personal archive, spec version ${specVersion}.

  manifest.json      Metadata: whose archive, which routes, how complete
  index-*.ndjson     One line per capture: URL, why fetched, when, and a verdict
  data-*.warc.gz     The user's own pages. Irreplaceable
  catalog-*.warc.gz  Catalog (work detail) pages. A cache; safe to delete wholesale

WARC is the standard web-archive format. Open these with pywb or ReplayWeb.page
(https://replayweb.page/) — no Doubak-specific software required. Each record is
its own gzip member, so index offsets address records individually.

### This bundle was IMPORTED, not written by a crawler

The pages were captured and stored by ${from.tool ?? 'a third-party tool'}.
That tool wrote only the HTTP response BODY to disk. Everything else was
reconstructed after the fact by this importer:

  url          Rebuilt from the original filename (medium / status / offset).
               What the original tool actually requested is unknowable.
  observed_at  From the original filename; minute precision only.
               The timezone is an ASSUMPTION: ${m.timezone_assumption}.
  intent       Also rebuilt from the filename.
  HTTP headers ARE FABRICATED. A WARC response record structurally requires
               them; the original tool preserved none. Every index row therefore
               carries capture_fidelity "decoded_body+synthesized_headers":
               ★ the body is real, the headers are invented. ★

  → For the same reason there is no http_status field in the index.

The verdict field is NOT in that list. It is computed from the body, which is
real. Logged-out list pages and zero-byte detail pages really do occur in this
data, and they are recorded as "login" / not-ok rather than as successes.

Full spec: https://spec.doubak.com/bundle/v1/
Project:   https://doubak.com
`;
}
