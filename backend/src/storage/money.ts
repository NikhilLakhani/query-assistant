export const SCALE = 1_000_000_000n;
const MILLION = 1_000_000n;

export function toNano(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value))
    throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(9, '0'));
}

export function fromNano(value: bigint): string {
  if (value < 0n) throw new Error('Negative amount');
  const fraction = (value % SCALE)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

const ceilDivide = (value: bigint, divisor: bigint) =>
  (value + divisor - 1n) / divisor;

export function estimateCost(
  input: number,
  output: number,
  price: {
    inputNanoUsdPerMillion: bigint;
    outputNanoUsdPerMillion: bigint;
    inrPerUsdNano: bigint;
  },
) {
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    throw new Error('Invalid token count');
  const weighted =
    BigInt(input) * price.inputNanoUsdPerMillion +
    BigInt(output) * price.outputNanoUsdPerMillion;
  return {
    nanoUsd: ceilDivide(weighted, MILLION),
    nanoInr: ceilDivide(weighted * price.inrPerUsdNano, MILLION * SCALE),
  };
}
