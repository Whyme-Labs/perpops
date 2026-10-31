import { DomainError } from './types.ts';

export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new DomainError('invalid_precision', 'Unsupported market precision.');
  }
  if (value.length > 100 || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new DomainError('invalid_amount', 'Use a decimal number without exponents or separators.');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > decimals) {
    throw new DomainError('invalid_precision', `This market accepts at most ${decimals} decimal places.`);
  }
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return negative ? -result : result;
}

export function formatAmount(value: bigint, decimals: number): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  if (decimals === 0) return `${sign}${absolute}`;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}

export function absolute(value: bigint): bigint { return value < 0n ? -value : value; }

export function exposureBounds(position: bigint, pendingBuys: bigint, pendingSells: bigint) {
  if (pendingBuys < 0n || pendingSells < 0n) {
    throw new DomainError('invalid_snapshot', 'Pending quantities cannot be negative.');
  }
  const lower = position - pendingSells;
  const upper = position + pendingBuys;
  return { lower, upper, peak: absolute(lower) > absolute(upper) ? absolute(lower) : absolute(upper) };
}
