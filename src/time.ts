export function nowIso(): string {
  return new Date().toISOString();
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function partitionForDate(date: Date = new Date()): { year: string; month: string } {
  const year = String(date.getUTCFullYear());
  const monthNumber = String(date.getUTCMonth() + 1).padStart(2, '0');
  const monthName = MONTH_NAMES[date.getUTCMonth()];
  return { year, month: `${monthNumber}-${monthName}` };
}
