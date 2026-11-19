import net from 'node:net';

/**
 * The key a client address is counted under. An IPv4 address stands for itself (also when it arrives IPv4-mapped,
 * `::ffff:a.b.c.d`); an IPv6 address is reduced to its /64 prefix, because one customer usually holds a whole /64 and
 * could otherwise take a fresh address for every request. Anything that is not an address shares the key "unknown".
 */
export function addressKey(ip: string | undefined): string {
  const text = (ip ?? '').trim().toLowerCase().replace(/%.*$/, '').replace(/^\[(.*)\]$/, '$1');
  if (net.isIPv4(text)) return text;
  if (!net.isIPv6(text)) return 'unknown';
  // A dotted IPv4 tail takes the place of the last two groups.
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  const hex = tail ? `${tail[1]}${((Number(tail[2]) << 8) | Number(tail[3])).toString(16)}:${((Number(tail[4]) << 8) | Number(tail[5])).toString(16)}` : text;
  const [head, rest] = hex.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = (rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]).map((g) => parseInt(g, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
