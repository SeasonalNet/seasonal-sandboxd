import { randomBytes } from 'node:crypto';

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv7(): string {
  const bytes = Buffer.alloc(16);
  const random = randomBytes(10);
  let timestamp = BigInt(Date.now());

  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = 0x70 | (random[0] & 0x0f);
  bytes[7] = random[1];
  bytes[8] = 0x80 | (random[2] & 0x3f);
  random.copy(bytes, 9, 3, 10);

  return formatUuid(bytes);
}

export function createJobId(): string {
  return `sandboxd_${uuidv7()}`;
}

export function createRunId(): string {
  return `run_${uuidv7()}`;
}

export function isJobId(value: string): boolean {
  return /^sandboxd_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
