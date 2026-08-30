/**
 * 文件名上的裸时间 → 带时区偏移的 RFC 3339。
 *
 * 规范禁止无时区的裸时间，理由很实在：档案会被带到别的时区去读，丢掉偏移量会让
 * 整条水位线整体错几个小时。而老工具的文件名恰恰只有 `20240811.1216`。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stampToRfc3339, offsetMinutesAt, formatOffset, dayToUtcDate } from '../src/time.js';
import { isRfc3339WithOffset } from '../src/vendor/core/time.js';

describe('时区', () => {
  test('上海：全年都是 +08:00', () => {
    assert.equal(stampToRfc3339('20240811.1216', 'Asia/Shanghai'), '2024-08-11T12:16:00+08:00');
    assert.equal(stampToRfc3339('20221225.1815', 'Asia/Shanghai'), '2022-12-25T18:15:00+08:00');
  });

  test('**夏令时要跟着走**，不能写死一个偏移量', () => {
    // 这个项目的用户有相当一部分在海外。把偏移量写死成「导入时机器的偏移量」，
    // 一份跨越夏令时切换的档案会有一半的时间戳是错的，而且不报任何错。
    assert.equal(stampToRfc3339('20240811.1216', 'America/New_York'), '2024-08-11T12:16:00-04:00');
    assert.equal(stampToRfc3339('20241211.1216', 'America/New_York'), '2024-12-11T12:16:00-05:00');
    // 南半球方向相反，顺手把「照抄北半球的规律」这种错也挡掉。
    assert.equal(stampToRfc3339('20240811.1216', 'Australia/Sydney'), '2024-08-11T12:16:00+10:00');
    assert.equal(stampToRfc3339('20241211.1216', 'Australia/Sydney'), '2024-12-11T12:16:00+11:00');
  });

  test('半小时时区', () => {
    assert.equal(stampToRfc3339('20240811.1216', 'Asia/Kolkata'), '2024-08-11T12:16:00+05:30');
    assert.equal(stampToRfc3339('20240811.1216', 'Asia/Kathmandu'), '2024-08-11T12:16:00+05:45');
  });

  test('UTC 与负偏移的格式', () => {
    assert.equal(formatOffset(0), '+00:00');
    assert.equal(formatOffset(-330), '-05:30');
    assert.equal(offsetMinutesAt('UTC', [2024, 8, 11, 12, 16]), 0);
  });

  test('产出的字符串规范认', () => {
    // 用的是规范那一侧的判据（vendor 里那份），不是这边再写一个正则。
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Asia/Kathmandu', 'UTC']) {
      assert.ok(isRfc3339WithOffset(stampToRfc3339('20240811.1216', tz)), tz);
    }
  });

  test('认不出来的时间戳要抛，不猜', () => {
    for (const bad of ['2024081.1216', '20240811', '20240811.12', 'x']) {
      assert.throws(() => stampToRfc3339(bad, 'UTC'), /认不出/, bad);
    }
  });

  test('bundle_id 的时间部分按 UTC 算', () => {
    assert.equal(dayToUtcDate('20240811', '1216').toISOString(), '2024-08-11T12:16:00.000Z');
  });
});
