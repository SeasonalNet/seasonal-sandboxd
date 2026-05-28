const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

export function capOutput(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const cleaned = stripAnsi(input);
  const bytes = Buffer.byteLength(cleaned, 'utf8');
  if (bytes <= maxBytes) {
    return { text: cleaned, truncated: false };
  }
  const marker = `\n[seasonal-sandboxd: output truncated to ${maxBytes} bytes]\n`;
  const slice = Buffer.from(cleaned, 'utf8').subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker))).toString('utf8');
  return { text: `${slice}${marker}`, truncated: true };
}
