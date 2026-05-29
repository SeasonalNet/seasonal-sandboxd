interface ParsedIp {
  family: 4 | 6;
  value: bigint;
  bits: 32 | 128;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}

function parseIpv6Part(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  const tokens = part.split(':');
  for (const token of tokens) {
    if (token === '') return null;
    if (token.includes('.')) {
      const ipv4 = ipv4ToBigInt(token);
      if (ipv4 === null) return null;
      groups.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes('%')) return null;
  const compressed = ip.includes('::');
  const split = ip.split('::');
  if (split.length > 2) return null;
  const left = parseIpv6Part(split[0] ?? '');
  const right = parseIpv6Part(split[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (compressed) {
    if (missing < 1) return null;
  } else if (missing !== 0) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8 || groups.some((group) => group < 0 || group > 0xffff)) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n);
}

function parseIp(input: string): ParsedIp | null {
  const ip = input.trim().toLowerCase();
  if (!ip) return null;
  const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (ipv4Mapped) {
    const value = ipv4ToBigInt(ipv4Mapped[1]);
    return value === null ? null : { family: 4, value, bits: 32 };
  }
  if (!ip.includes(':')) {
    const value = ipv4ToBigInt(ip);
    return value === null ? null : { family: 4, value, bits: 32 };
  }
  const value = ipv6ToBigInt(ip);
  return value === null ? null : { family: 6, value, bits: 128 };
}

function parseCidr(cidr: string): { ip: ParsedIp; prefix: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const ip = parseIp(parts[0]);
  const prefix = Number(parts[1]);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return null;
  return { ip, prefix };
}

function networkMask(bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) return 0n;
  const totalBits = BigInt(bits);
  const hostBits = BigInt(bits - prefix);
  return ((1n << totalBits) - 1n) ^ ((1n << hostBits) - 1n);
}

export function assertValidAllowedCidrs(cidrs: string[]): void {
  for (const raw of cidrs) {
    const cidr = raw.trim();
    if (!cidr) throw new Error('allowed CIDR entries cannot be empty');
    if (cidr.includes('/')) {
      if (!parseCidr(cidr)) throw new Error(`Invalid allowed CIDR: ${raw}`);
    } else if (!parseIp(cidr)) {
      throw new Error(`Invalid allowed IP address: ${raw}`);
    }
  }
}

export function ipAllowedByCidrs(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  const parsedIp = parseIp(ip);
  if (!parsedIp) return false;
  return cidrs.some((rawCidr) => {
    const cidr = rawCidr.trim();
    if (!cidr.includes('/')) {
      const allowedIp = parseIp(cidr);
      return !!allowedIp && allowedIp.family === parsedIp.family && allowedIp.value === parsedIp.value;
    }
    const parsedCidr = parseCidr(cidr);
    if (!parsedCidr || parsedCidr.ip.family !== parsedIp.family) return false;
    const mask = networkMask(parsedIp.bits, parsedCidr.prefix);
    return (parsedIp.value & mask) === (parsedCidr.ip.value & mask);
  });
}
