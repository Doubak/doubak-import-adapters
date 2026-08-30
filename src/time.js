/**
 * 文件名上的裸时间 → 带时区偏移的 RFC 3339。
 *
 * ## 为什么这件事非做不可，而且必须说出来
 *
 * 老工具的文件名是 `20240811.1216`——**没有时区**。而规范禁止无时区的裸时间
 * （`common.schema.json` 的 `timestamp`），理由很直接：档案会被带到别的时区去读，
 * 丢掉偏移量会让整条水位线整体错几个小时。
 *
 * 所以这里必须**假定**一个时区，并且把假定记进 `manifest.timezone_assumption`
 * ——那个字段存在的全部理由就是这个：将来假定被推翻时，可以对存量重新解析。
 *
 * 默认 `Asia/Shanghai`：老工具跑在抓豆瓣的人手上，而这批数据的时间戳与页面上
 * 豆瓣自己的时间是同一个钟。**但这是假定，不是事实**，所以 CLI 上有 `--timezone`。
 */

/**
 * 某个时区在某个**本地墙上时间**处的偏移量（分钟）。
 *
 * 做法是标准的两步：先把墙上时间当成 UTC 得到一个试探值，看它在目标时区里
 * 显示成几点，差多少就是偏移量；再用修正后的瞬间复算一次，处理夏令时切换那
 * 一小时的边界。上海没有夏令时，但这个函数不该只对上海是对的。
 *
 * @param {string} timeZone IANA 时区名
 * @param {number[]} parts [年, 月(1-12), 日, 时, 分]
 * @returns {number} 分钟，东为正
 */
export function offsetMinutesAt(timeZone, [y, mo, d, h, mi]) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const shown = wallClockInZone(timeZone, new Date(guess));
    guess = wall + (guess - shown);
  }
  return Math.round((wall - guess) / 60000);
}

/** 一个瞬间在某时区里显示成的墙上时间，表示成「把它当 UTC」的毫秒数。 */
function wallClockInZone(timeZone, date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  // Intl 在午夜会给出 24，Date.UTC 收 24 会顺延到第二天 0 点——正是想要的语义。
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

/** @param {number} min @returns {string} 形如 `+08:00` */
export function formatOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  const p = (n) => String(n).padStart(2, '0');
  return `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/**
 * `20240811.1216` → `2024-08-11T12:16:00+08:00`。
 *
 * 秒位补 0：文件名只到分钟。**这不是精度损失被掩盖了**——同一分钟里的多次
 * 捕获会拿到同一个 `observed_at`，而 `observed_at` 本来就不是排序的唯一键
 * （`capture_id` 才是）。真正要紧的是不许假装有秒级精度。
 *
 * @param {string} stamp 形如 `20240811.1216`
 * @param {string} timeZone
 * @returns {string} RFC 3339，带显式偏移
 */
export function stampToRfc3339(stamp, timeZone) {
  const m = /^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})$/.exec(stamp);
  if (!m) throw new Error(`认不出这个时间戳: ${stamp}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  const off = offsetMinutesAt(timeZone, [y, mo, d, h, mi]);
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${formatOffset(off)}`;
}

/** `20240811` → 那一天 00:00 的 UTC Date，用来生成 bundle_id。 */
export function dayToUtcDate(day, hhmm = '0000') {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(day);
  if (!m) throw new Error(`认不出这个日期: ${day}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +hhmm.slice(0, 2), +hhmm.slice(2), 0));
}
