/**
 * its-my-data/doubak 的文件名 → 这次捕获是什么。
 *
 * 这一层全是纯函数，所以能在没有那 782 MB 的机器上测——而它恰恰是最容易
 * 悄悄错的一层：把 `towatch` 认成 `collect`，产出的档案照样合规、照样能解析，
 * 只是**每一条「想看」都变成了「看过」**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseName, routeOf, urlOf, daysOf, usernameFrom, viewerIdFrom } from '../src/adapters/its-my-data-doubak.js';

const FIX = new URL('./fixtures/its-my-data/collector/', import.meta.url).pathname;

describe('文件名', () => {
  test('三种形态都认得出来', () => {
    assert.deepEqual(parseName('20240811.1246_movie_watched_l15-30.html'), {
      stamp: '20240811.1246', day: '20240811', hhmm: '1246',
      kind: 'interest_list', medium: 'movie', legacyStatus: 'watched', status: 'collect', start: 15,
    });
    assert.deepEqual(parseName('20240811.1216_broadcast_p143.html'), {
      stamp: '20240811.1216', day: '20240811', hhmm: '1216', kind: 'broadcast', page: 143,
    });
    assert.deepEqual(parseName('20221227.1107_book_10484692.html', true), {
      stamp: '20221227.1107', day: '20221227', hhmm: '1107',
      kind: 'interest_item', medium: 'book', subjectId: '10484692',
    });
  });

  test('九个状态词各自映射到豆瓣自己的那三个', () => {
    // **这一格错了不会报错**，只会让「想看」变成「看过」。九种媒介写法各测一遍。
    const got = {};
    for (const w of ['watched', 'watching', 'towatch', 'played', 'playing', 'toplay', 'read', 'reading', 'toread', 'listened']) {
      const medium = w.includes('play') ? 'game' : w.includes('read') ? 'book' : w === 'listened' ? 'music' : 'movie';
      got[w] = parseName(`20240811.1246_${medium}_${w}_l0-15.html`)?.status;
    }
    assert.deepEqual(got, {
      watched: 'collect', watching: 'do', towatch: 'wish',
      played: 'collect', playing: 'do', toplay: 'wish',
      read: 'collect', reading: 'do', toread: 'wish',
      listened: 'collect',
    });
  });

  test('认不出来就是 null，不猜', () => {
    // 猜的代价是把一个不知道是什么的页面安进某条路线，而那会污染 coverage。
    for (const n of ['notes.html', 'README.md', '20240811_movie_watched_l0-15.html',
      '20240811.1246_podcast_watched_l0-15.html', '20240811.1246_movie_seen_l0-15.html']) {
      assert.equal(parseName(n), null, `${n} 不该被认出来`);
    }
    // items 里的和外面的不是一回事：同一个名字在两处含义不同，所以要靠 inItems 分开。
    assert.equal(parseName('20221227.1107_book_10484692.html', false), null);
  });
});

describe('路线与 URL', () => {
  test('留存等级按「谁写的」分，不按媒体类型', () => {
    // 作品详情页进 catalog-（源站还在就能重抓，允许整批 rm）；
    // 自己的标记与广播进 data-（没了就是没了）。
    assert.equal(routeOf(parseName('20221227.1107_book_1.html', true)).kind, 'catalog');
    assert.equal(routeOf(parseName('20240811.1246_movie_watched_l0-15.html')).kind, 'data');
    assert.equal(routeOf(parseName('20240811.1216_broadcast_p1.html')).kind, 'data');
  });

  test('intent 的形状要能被解析器切开', () => {
    // 解析器是这么读的：`row.intent.split('.')` → [, , medium, status]。
    const intent = routeOf(parseName('20240811.1439_game_toplay_l0-15.html')).intent;
    const [a, b, medium, status] = intent.split('.');
    assert.deepEqual([a, b, medium, status], ['interest', 'list', 'game', 'wish']);
  });

  test('五种媒介的详情页 URL 与解析器认的五种形态一一对应', () => {
    const got = ['movie', 'book', 'music', 'game', 'drama'].map(
      (m) => urlOf(parseName(`20221227.1107_${m}_123.html`, true), 'u'));
    assert.deepEqual(got, [
      'https://movie.douban.com/subject/123/',
      'https://book.douban.com/subject/123/',
      'https://music.douban.com/subject/123/',
      'https://www.douban.com/game/123/',
      'https://www.douban.com/location/drama/123/',
    ]);
  });

  test('用户名要转义 —— 域名里可以有需要转义的字符', () => {
    assert.match(urlOf(parseName('20240811.1216_broadcast_p1.html'), 'a b'), /people\/a%20b\//);
  });
});

describe('对着真实页面量出来的东西', () => {
  const pages = readdirSync(FIX).filter((n) => n.endsWith('.html'))
    .map((n) => ({ n, html: readFileSync(`${FIX}${n}`, 'utf-8') }));

  test('**拼出来的 URL 与豆瓣自己翻页条上的链接一致**', () => {
    // 这是「量出来的，不是编的」那条规矩在这个仓库里的兑现处。
    // 老工具没存 URL，所以 URL 是重建的——但重建规则不能靠想象：页面里的翻页条
    // 就是豆瓣自己发的链接，参数与顺序都在里面。两者对不上就说明我们编错了。
    let checked = 0;
    for (const { n, html } of pages) {
      const d = parseName(n);
      if (d?.kind !== 'interest_list') continue;
      // 翻页条里任意一个带 start 的链接，把 start 换成本页的偏移量。
      const href = /class="paginator"[\s\S]{0,2000}?href="([^"]*(?:start|action)=[^"]*)"/.exec(html)?.[1];
      if (!href) continue;
      const decoded = href.replace(/&amp;/g, '&');
      const mine = new URL(urlOf(d, 'mewcatcher'));
      const theirs = new URL(decoded, mine.origin + mine.pathname);
      theirs.searchParams.set('start', String(d.start));
      assert.deepEqual(
        [...theirs.searchParams].sort(), [...mine.searchParams].sort(),
        `${n}：拼出来的查询参数与豆瓣翻页条上的不一致\n  我们  ${mine}\n  页面  ${theirs}`);
      assert.equal(theirs.pathname, mine.pathname, `${n}：路径不一致`);
      checked++;
    }
    // **断言真的比过东西。** fixture 换掉或正则坏掉时，上面的循环会变成空转而永远绿。
    assert.ok(checked >= 2, `只比了 ${checked} 页，fixture 或正则大概坏了`);
  });

  test('账号：个人页域名取自个人页头，数字 ID 不许把 0 当成 ID', () => {
    const names = new Set(pages.map((p) => usernameFrom(p.html)).filter(Boolean));
    assert.deepEqual([...names], ['mewcatcher'], '个人页头里的域名应当只有一个，且是页面主人');

    // 两种「没有身份」长得完全不一样，都要认对：
    //
    // ① **未登录但内容正常渲染出来了**的页面：`USER_ID` 是 0。那是「没人登录」，
    //    不是一个用户 ID——当成 ID 收下的话，account.user_id 会变成 "0"。
    const anon = pages.find((p) => p.n === '20230127.2043_game_played_l270-285.html');
    assert.match(anon.html, /USER_ID['"]*[:=]\s*['"]?0/, 'fixture 变了：这一页本该是未登录抓的');
    assert.equal(viewerIdFrom(anon.html), null, 'USER_ID=0 不是一个用户 ID');

    // ② 整页就是**登录页**：`USER_ID` 根本不在。
    const login = pages.find((p) => p.n === '20231218.1022_broadcast_p1.html');
    assert.match(login.html, /<title>\s*登录豆瓣\s*<\/title>/, 'fixture 变了：这一页本该是登录页');
    assert.equal(viewerIdFrom(login.html), null);
    assert.equal(usernameFrom(login.html), null, '登录页上没有个人页头');
  });

  test('一条路线的页面不跨自然日 —— 「按天切档案」全靠这条', () => {
    // 切分必须满足的唯一性质：一条路线被劈进两份档案，它的连续性证明在两边都不
    // 成立，于是一次完整的枚举会被记成两次不完整的。这条在真实的 7353 个页面上
    // 成立，fixture 这几页只是把这条规则钉在这里。
    const byRoute = new Map();
    for (const { n, html } of pages) {
      const d = parseName(n);
      if (!d) continue;
      const key = routeOf(d).routeKey;
      byRoute.set(key, (byRoute.get(key) ?? new Set()).add(d.day));
    }
    for (const [route, days] of byRoute) {
      assert.equal(days.size, [...days].length, route);
    }
    assert.ok(byRoute.size >= 2, '至少要覆盖两条路线，否则这条断言没在测什么');
  });

  test('daysOf 升序、去重', () => {
    assert.deepEqual(daysOf([{ day: '20240811' }, { day: '20221225' }, { day: '20240811' }]),
      ['20221225', '20240811']);
  });
});
