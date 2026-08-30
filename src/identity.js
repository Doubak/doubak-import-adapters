/**
 * 这份档案是谁的。
 *
 * ## 为什么值得单独一个文件
 *
 * `manifest.account.user_id` 是**一个 bundle 只能属于一个账号**这条规则的载体，
 * 而解析器会据此拦下「一个目录里混了两个人的档案」——那是它唯一一条不允许
 * 继续的错误，理由是合并过的 canonical 事后拆不开。
 *
 * 所以这里宁可停下来问人，也不猜。
 */

import { usernameFrom, viewerIdFrom, uidCounts } from './adapters/its-my-data-doubak.js';

/**
 * 从一批页面里认出账号。
 *
 * 两个来源，**必须互相印证**：
 *
 * | 来源 | 是什么 | 陷阱 |
 * |---|---|---|
 * | `db-usr-profile` 里的 `/people/<x>/` | 个人页头 → **页面主人**的域名 | 未登录页上也有，所以它可靠 |
 * | `USER_ID` 这个 JS 全局 | **看页面的人**的数字 ID | 自己看自己时才等于主人 |
 *
 * 第二行是关键：`USER_ID` 严格来说是「看的人」。抓自己的档案时两者相同，这也是
 * 唯一能拿它当 `account.user_id` 的前提。所以再拿广播页上占压倒多数的 `data-uid`
 * （那是**时间线主人**）来对一次——两者一致才写进 manifest。
 *
 * 不一致就**停下来**，让人用 `--user-id` 说清楚。把一份档案安到错的账号上，
 * 后果是它和别人的档案在同一个目录里合并，而合并过的 canonical 拆不开。
 *
 * @param {Array<{path: string, kind: string}>} entries
 * @param {(path: string) => string} readText
 * @param {{userId?: string, username?: string}} [override]
 */
export function resolveAccount(entries, readText, override = {}) {
  const notes = [];
  const usernames = new Map();
  const viewerIds = new Map();
  const timelineUids = new Map();

  // 全量扫会读几百 MB。身份是全档案一致的东西，取样就够——**但要跨类型取**，
  // 因为不同类型的页面带的标志不一样（详情页没有个人页头）。
  for (const e of sample(entries, 40)) {
    const html = readText(e.path);
    const u = usernameFrom(html);
    if (u) usernames.set(u, (usernames.get(u) ?? 0) + 1);
    const v = viewerIdFrom(html);
    if (v) viewerIds.set(v, (viewerIds.get(v) ?? 0) + 1);
    if (e.kind === 'broadcast') {
      for (const [uid, n] of uidCounts(html)) timelineUids.set(uid, (timelineUids.get(uid) ?? 0) + n);
    }
  }

  const username = override.username ?? top(usernames);
  const viewer = top(viewerIds);
  const owner = top(timelineUids);

  let userId = override.userId ?? null;
  if (!userId) {
    if (viewer && owner && viewer !== owner) {
      throw new Error(
        `认不准这份档案是谁的：页面里的 USER_ID 是 ${viewer}，而广播时间线上出现最多的 `
        + `data-uid 是 ${owner}。两者本该相同（自己抓自己）。请用 --user-id=<数字ID> 说清楚。\n`
        + '  为什么不猜：一个 bundle 只能属于一个账号，而安错账号的后果是它会跟别人的\n'
        + '  档案在同一个目录里被合并，合并过的 canonical 事后拆不开。',
      );
    }
    userId = viewer ?? owner;
    if (viewer && owner) notes.push(`账号数字 ID ${userId}：USER_ID 与广播时间线的 data-uid 一致`);
    else if (userId) notes.push(`账号数字 ID ${userId}：只有一个来源（${viewer ? 'USER_ID' : '广播 data-uid'}），未能交叉印证`);
  } else {
    notes.push(`账号数字 ID ${userId}：由 --user-id 指定`);
  }

  if (!userId) {
    throw new Error(
      '这批页面里找不到账号的数字 ID。抓取时没登录的档案会是这样（未登录页上 USER_ID 是 0，'
      + '那是「没人登录」而不是一个用户 ID）。请用 --user-id=<数字ID> 指定。',
    );
  }
  if (!username) {
    throw new Error('这批页面里找不到个人页域名（个人页头 db-usr-profile）。请用 --username 指定。');
  }
  if (usernames.size > 1) {
    notes.push(`取样里出现过不止一个个人页域名：${[...usernames.keys()].join(' / ')}，取用出现最多的 ${username}`);
  }
  return { userId, username, notes };
}

/** 跨类型取样：每种 kind 各取若干，而不是把前 N 个都取成同一类。 */
function sample(entries, n) {
  const byKind = new Map();
  for (const e of entries) {
    const list = byKind.get(e.kind) ?? [];
    if (list.length < n) list.push(e);
    byKind.set(e.kind, list);
  }
  return [...byKind.values()].flat();
}

function top(counter) {
  let best = null;
  let n = -1;
  for (const [k, v] of counter) if (v > n) { best = k; n = v; }
  return best;
}
