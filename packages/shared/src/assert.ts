/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
