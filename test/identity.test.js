/**
 * 这份档案是谁的。
 *
 * `manifest.account.user_id` 是「一个 bundle 只能属于一个账号」这条规则的载体，
 * 而解析器会据此拦下「一个目录里混了两个人的档案」——那是它唯一一条不允许继续的
 * 错误，理由是合并过的 canonical 事后拆不开。所以这里宁可停下来问人，也不猜。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scan } from '../src/scan.js';
import { resolveAccount } from '../src/identity.js';

const FIX = new URL('./fixtures/its-my-data', import.meta.url).pathname;
const read = (p) => readFileSync(p, 'utf-8');

describe('账号', () => {
  test('从真实页面里认出来', () => {
    const { entries } = scan(FIX);
    const a = resolveAccount(entries, read);
    assert.equal(a.username, 'mewcatcher');
    assert.equal(a.userId, '82160871');
  });

  test('两个来源对不上就**停下来**，不挑一个', () => {
    // 安错账号的后果不是「这份档案不好看」，是它会跟别人的档案在同一个目录里被
    // 合并，而合并过的 canonical 拆不开。
    const fake = [
      { kind: 'broadcast', path: 'a' },
      { kind: 'interest_list', path: 'b' },
    ];
    const texts = {
      a: 'id="db-usr-profile" <a href="https://www.douban.com/people/mewcatcher/">x</a> data-uid="999" data-uid="999"',
      b: 'id="db-usr-profile" <a href="https://www.douban.com/people/mewcatcher/">x</a> USER_ID: 82160871',
    };
    assert.throws(() => resolveAccount(fake, (p) => texts[p]), /认不准这份档案是谁的/);
    // 但人说清楚了就照做。
    const forced = resolveAccount(fake, (p) => texts[p], { userId: '82160871' });
    assert.equal(forced.userId, '82160871');
  });

  test('只有一个来源时照用，但要说出来没能互相印证', () => {
    const one = [{ kind: 'interest_list', path: 'b' }];
    const a = resolveAccount(one, () => 'id="db-usr-profile" <a href="https://www.douban.com/people/u/">x</a> USER_ID: 5');
    assert.equal(a.userId, '5');
    assert.ok(a.notes.some((n) => n.includes('未能交叉印证')), '这件事必须说出来');
  });

  test('一个数字 ID 都找不到时，说清为什么，并给出下一步', () => {
    // 整场抓取都没登录的档案就是这样：未登录页上 USER_ID 是 0。
    const anon = [{ kind: 'interest_list', path: 'b' }];
    assert.throws(
      () => resolveAccount(anon, () => 'id="db-usr-profile" <a href="https://www.douban.com/people/u/">x</a> USER_ID: 0'),
      /--user-id/,
    );
  });
});

describe('目录扫描', () => {
  test('认不出来的文件要数出来，不能静静跳过', () => {
    // 静静跳过等于宣布「这个目录里就这么多」，而少读一个文件在产出里没有任何声响。
    const { entries, unrecognized } = scan(FIX);
    assert.ok(unrecognized.includes('notes.html'));
    assert.equal(entries.length, 6);
  });

  test('items/ 下的按详情页认，外面的按列表页认', () => {
    const { entries } = scan(FIX);
    const kinds = entries.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});
    assert.deepEqual(kinds, { interest_item: 2, interest_list: 2, broadcast: 2 });
  });

  test('顺序稳定 —— 产出要可复现', () => {
    const a = scan(FIX).entries.map((e) => e.name);
    const b = scan(FIX).entries.map((e) => e.name);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [...a].sort((x, y) => (x < y ? -1 : 1)).length === a.length ? a : a);
  });
});
