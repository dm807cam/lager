import net from 'node:net';

/** Leading 16-bit groups of an IPv6 address that name the network (a /64); the rest is chosen freely by whoever holds the prefix. */
const IPV6_PREFIX_GROUPS = 4;

/**
 * The key every per-address limiter counts under. An IPv4 address stands for itself, also when it arrives IPv4-mapped
 * (`::ffff:1.2.3.4`). An IPv6 address is cut to its /64: one customer usually holds the whole prefix, so counting
 * single addresses would hand out a fresh budget for each of its 2^64 addresses. Anything else is `unknown`.
 */
export function addressKey(ip: string | undefined): string {
  const raw = (ip ?? '').split('%')[0].toLowerCase();
  if (net.isIPv4(raw)) return raw;
  if (!net.isIPv6(raw)) return 'unknown';
  // A dotted tail (`::ffff:1.2.3.4`) is two groups in hexadecimal.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  const hex = (a: string, b: string): string => ((Number(a) << 8) | Number(b)).toString(16);
  const plain = dotted ? `${dotted[1]}${hex(dotted[2], dotted[3])}:${hex(dotted[4], dotted[5])}` : raw;
  const [head, tail] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : 8 - left.length - right.length).fill('0'), ...right]
    .map((g) => g.replace(/^0+(?=.)/, ''));
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const [hi, lo] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, IPV6_PREFIX_GROUPS).join(':')}::/64`;
}
