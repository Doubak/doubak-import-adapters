/**
 * 适配器：**its-my-data/doubak**（前代的 Go 抓取工具）。
 *
 * <https://github.com/its-my-data/doubak>
 *
 * 它把每个响应的**正文**按一个自造的文件名写到 `output/collector/` 下，别的什么
 * 都没留：没有响应头，没有状态码，没有请求 URL，没有 verdict，没有 coverage。
 *
 * ```
 * collector/
 *   20240811.1216_broadcast_p143.html          广播时间线第 143 页
 *   20240811.1246_movie_watched_l0-15.html     看过的影视，第 0–15 条
 *   items/20221227.1107_book_10484692.html     作品详情页
 * ```
 *
 * ## 这个文件里没有 I/O
 *
 * 全是纯函数：文件名 → 这次捕获是什么。**读目录、读字节在 `src/scan.js`。**
 * 分开的理由很实在——判定「`movie_watched` 是哪条路线、URL 长什么样」这件事
 * 要能在没有那 782 MB 的机器上测。
 *
 * ## 文件名里带着 intent，这是运气，不是设计
 *
 * 规范 §5.1 把 `intent` 列为三个「丢了就永远补不回来」的字段之一，理由是
 * **一份标记列表的第 7 页，事后无法区分它当初是「看过」还是「想看」的第 7 页**。
 * 这个工具恰好把状态写进了文件名，于是这里能重建出来。换一个工具就不一定
 * ——所以写新适配器时，第一个要回答的问题就是「intent 从哪儿来」，答不出来
 * 的话那批数据的价值会低很多，而且这一点必须说出来，不能糊过去。
 */

/**
 * 老工具的状态词 → 豆瓣自己的状态词。
 *
 * 右边这三个是**豆瓣 URL 里的那三个词**（`/people/x/collect`），也是 canonical
 * 的封闭词表所依据的东西。左边是老工具自己起的名字，每种媒介还不一样。
 */
const STATUS_WORDS = {
  watched: 'collect', watching: 'do', towatch: 'wish', // 影视
  played: 'collect', playing: 'do', toplay: 'wish', // 游戏
  read: 'collect', reading: 'do', toread: 'wish', // 书
  listened: 'collect', // 音乐：老工具只抓了「听过」
};

/** 认得的媒介。不在这里面的文件名一律不猜——认不出来要说出来，不能静静跳过。 */
const MEDIA = new Set(['movie', 'book', 'music', 'game', 'drama']);

const enc = encodeURIComponent;

/**
 * 标记列表页的 URL。
 *
 * **这几个模板不是编的，是量出来的**：真实页面里的翻页条给出了豆瓣自己发的
 * 链接，参数与顺序与这里逐字一致（`test/url-shapes.test.js` 拿真实 fixture
 * 对着比）。它们也与 `doubak-extension` 的 `crawl/routes.js` 是同一份形状——
 * 两边写出来的 URL 不一样的话，同一个页面在两份档案里会有两个 `url_key`，
 * 而那是去重用的键。
 */
const LIST_URL = {
  movie: (u, status, start) =>
    `https://movie.douban.com/people/${enc(u)}/${status}?start=${start}`
    + '&sort=time&rating=all&mode=grid&type=all&filter=all',
  book: (u, status, start) =>
    `https://book.douban.com/people/${enc(u)}/${status}?start=${start}`
    + '&sort=time&rating=all&filter=all&mode=grid',
  music: (u, status, start) =>
    `https://music.douban.com/people/${enc(u)}/${status}?start=${start}`
    + '&sort=time&rating=all&filter=all&mode=grid',
  game: (u, status, start) =>
    `https://www.douban.com/people/${enc(u)}/games?action=${status}&start=${start}`,
  drama: (u, status, start) =>
    `https://www.douban.com/location/people/${enc(u)}/drama/${status}`
    + `?sort=time&start=${start}&filter=all&mode=grid&tags_sort=count`,
};

/** 作品详情页的 URL。与解析器 `subjectRefOf()` 认的那五种形态一一对应。 */
const SUBJECT_URL = {
  movie: (id) => `https://movie.douban.com/subject/${id}/`,
  book: (id) => `https://book.douban.com/subject/${id}/`,
  music: (id) => `https://music.douban.com/subject/${id}/`,
  game: (id) => `https://www.douban.com/game/${id}/`,
  drama: (id) => `https://www.douban.com/location/drama/${id}/`,
};

export const ADAPTER = {
  id: 'its-my-data/doubak',
  url: 'https://github.com/its-my-data/doubak',
  /** 目录里出现这些东西就认为是它的产物。 */
  probe: ['collector'],
};

/**
 * 文件名 → 这次捕获是什么。认不出来返回 null（**调用方必须把认不出的数出来**，
 * 静静跳过等于宣布「这个目录里就这么多」，而那是不可检测的丢失）。
 *
 * @param {string} name 文件名，不含目录
 * @param {boolean} inItems 是不是在 `items/` 下
 * @returns {null | {
 *   stamp: string, day: string, hhmm: string,
 *   kind: 'interest_list' | 'interest_item' | 'broadcast',
 *   medium?: string, status?: string, legacyStatus?: string,
 *   start?: number, page?: number, subjectId?: string,
 * }}
 */
export function parseName(name, inItems = false) {
  const stamp = /^(\d{8})\.(\d{4})_/.exec(name);
  if (!stamp) return null;
  const base = { stamp: `${stamp[1]}.${stamp[2]}`, day: stamp[1], hhmm: stamp[2] };
  const rest = name.slice(stamp[0].length);

  if (inItems) {
    const m = /^(\w+)_(\d+)\.html$/.exec(rest);
    if (!m || !MEDIA.has(m[1])) return null;
    return { ...base, kind: 'interest_item', medium: m[1], subjectId: m[2] };
  }

  const bc = /^broadcast_p(\d+)\.html$/.exec(rest);
  if (bc) return { ...base, kind: 'broadcast', page: Number(bc[1]) };

  // `l<起>-<止>`：老工具按「第几条到第几条」命名，每页 15 条。**取的是起点**，
  // 因为豆瓣的 URL 参数就是 start；止点是它自己算出来的，不参与任何判断。
  const li = /^(\w+?)_(\w+)_l(\d+)-(\d+)\.html$/.exec(rest);
  if (li && MEDIA.has(li[1]) && STATUS_WORDS[li[2]]) {
    return {
      ...base,
      kind: 'interest_list',
      medium: li[1],
      legacyStatus: li[2],
      status: STATUS_WORDS[li[2]],
      start: Number(li[3]),
    };
  }
  return null;
}

/**
 * 这次捕获属于哪条路线。
 *
 * `kind` 是**留存等级**而不是媒体类型（规范 §2.1）：作品详情页进 `catalog-`，
 * 因为源站还在就能重抓，所以整批 `rm` 是允许的操作；用户自己的标记与广播进
 * `data-`，那些没了就是没了。
 *
 * @param {ReturnType<typeof parseName>} d
 */
export function routeOf(d) {
  switch (d.kind) {
    case 'broadcast':
      return {
        routeKey: 'broadcast.timeline', intent: 'broadcast.timeline',
        kind: 'data', surface: 'html', profile: 'broadcast.timeline',
        cursor: { kind: 'page', value: d.page },
      };
    case 'interest_list':
      return {
        routeKey: `interest.${d.medium}.${d.status}`,
        intent: `interest.list.${d.medium}.${d.status}`,
        kind: 'data', surface: 'html', profile: 'interest.list',
        cursor: { kind: 'start', value: d.start },
      };
    case 'interest_item':
      return {
        routeKey: 'interest.item', intent: 'interest.item',
        kind: 'catalog', surface: 'html', profile: 'interest.item',
        cursor: null,
      };
    default:
      throw new Error(`未知的捕获类型: ${d.kind}`);
  }
}

/**
 * 重建这次捕获的 URL。
 *
 * **这是重建，不是记录。** 老工具没存 URL，所以这里拼出来的是「豆瓣当时会为
 * 这一页发出的那个链接」，而不是它当年真的请求了什么（它很可能少带几个查询
 * 参数）。重建规则写进档案的 `README.txt` 与 `manifest.notes`，让读者能自己
 * 判断这些值是怎么来的——规范 §6.4.1 要求的就是这个。
 *
 * @param {ReturnType<typeof parseName>} d
 * @param {string} username 个人页的域名（不是数字 ID）
 */
export function urlOf(d, username) {
  if (!username) throw new Error('重建 URL 需要 username');
  switch (d.kind) {
    case 'broadcast':
      return `https://www.douban.com/people/${enc(username)}/statuses?p=${d.page}`;
    case 'interest_list':
      return LIST_URL[d.medium](username, d.status, d.start);
    case 'interest_item':
      return SUBJECT_URL[d.medium](d.subjectId);
    default:
      throw new Error(`未知的捕获类型: ${d.kind}`);
  }
}

/**
 * 个人页域名。取 `db-usr-profile`（个人页头）里的那个链接——**那是页面主人**。
 *
 * 不用别的两个看起来也行的东西：
 * - 整页找 `douban.com/people/<x>/` 会取到别人（广播页上到处是别人的链接）。
 * - `nav-user-account` 是**看的人**，不是页面主人；未登录时它根本不在。
 *
 * 实测 1012 个列表页命中 1010，漏掉的 2 个是登录页（那两页本来就该被判成 login）。
 *
 * @param {string} html @returns {string | null}
 */
export function usernameFrom(html) {
  const m = /db-usr-profile[\s\S]{0,600}?douban\.com\/people\/([\w-]+)\//.exec(html);
  return m ? m[1] : null;
}

/**
 * 看这个页面的人的数字 ID。
 *
 * **注意它是「看的人」而不是「页面主人」。** 自己抓自己的档案时两者相同，这也是
 * 唯一能拿它当 `account.user_id` 的前提。所以调用方必须交叉验证（见 `identity.js`），
 * 不能单凭这一个就写进 manifest。
 *
 * `USER_ID: 0` 是「没登录」，**不是一个用户 ID**。当成 ID 写进去的话，
 * `account.user_id` 会变成 `"0"`——实测这批档案里有 36 个页面是这样。
 *
 * @param {string} html @returns {string | null}
 */
export function viewerIdFrom(html) {
  const m = /USER_ID\s*[:=]\s*['"]?(\d+)/.exec(html);
  if (!m || m[1] === '0') return null;
  return m[1];
}

/**
 * 广播页上出现最多的那个 `data-uid`，就是这条时间线的主人。
 *
 * 时间线上会混进别人（转发、@），但压倒性多数是主人自己——实测前 40 页里
 * 主人出现 1526 次，第二名 2 次。
 *
 * @param {string} html @returns {Map<string, number>}
 */
export function uidCounts(html) {
  const out = new Map();
  for (const m of html.matchAll(/data-uid="(\d+)"/g)) out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  return out;
}

/**
 * 按**自然日**切分成一次次抓取。
 *
 * 为什么是按天，而不是按时间戳、也不是按「间隔多久算一批」：**一条路线的页面
 * 从来没有跨过一个自然日**（实测，`test/its-my-data.test.js` 把这条钉住了）。
 * 而这正是切分唯一必须满足的性质——一条路线被劈进两份档案，它的连续性证明
 * 就在两边都不成立，于是一次完整的枚举会被记成两次不完整的。
 *
 * 按时间戳切会劈开广播（实测一次广播抓取横跨 `1815` 与 `1826` 两个戳）；
 * 按「间隔小时数」切要引入一个谁也说不清该取多少的阈值，而且 2022-12 那次
 * campaign 里最大的戳间间隔是 22 小时，离「一次抓取」的直觉相当远。
 *
 * @param {Array<{day: string}>} entries
 * @returns {string[]} 有序的日期，升序
 */
export function daysOf(entries) {
  return [...new Set(entries.map((e) => e.day))].sort();
}
