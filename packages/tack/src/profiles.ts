/** Tack profile template rules. Pure: no runtime imports. */

/** Earlier Tack bundle names and the bundle that replaces each. */
export const LEGACY_BUNDLES: Readonly<Record<string, string>> = {
  "@tack/bundle-default": "@tack/base",
};

/**
 * The bundle list a Tack-template profile should have: the template's bundles
 * first, in template order, then every user-added bundle in its existing order.
 * Legacy Tack bundle names are dropped (their successor is in the template).
 * @returns the reconciled list, or `undefined` when `current` is already correct.
 */
export function reconcileTemplateBundles(
  current: readonly string[],
  template: readonly string[],
  legacy: Readonly<Record<string, string>> = LEGACY_BUNDLES,
): string[] | undefined {
  const extras: string[] = [];
  for (const bundle of current) {
    if (template.includes(bundle) || Object.hasOwn(legacy, bundle) || extras.includes(bundle)) continue;
    extras.push(bundle);
  }
  const next = [...template, ...extras];
  const same = next.length === current.length && next.every((bundle, index) => bundle === current[index]);
  return same ? undefined : next;
}
