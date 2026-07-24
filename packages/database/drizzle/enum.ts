/**
 * Converts a TypeScript enum to the non-empty tuple drizzle's `pgEnum`
 * expects — so a TS enum can be the single source of truth for a pg enum.
 */
export function tsEnumToPgEnum<T extends Record<string, string>>(
  myEnum: T,
): [T[keyof T], ...T[keyof T][]] {
  return Object.values(myEnum) as [T[keyof T], ...T[keyof T][]];
}
