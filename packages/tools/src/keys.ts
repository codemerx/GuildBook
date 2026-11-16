// The public keys the app trusts for a refreshed tool catalog (ADR 0026). The private keys never come near the app:
// the release key lives only in the release pipeline (Step 18). The development key signs catalogs for development and
// test builds; production builds don't trust it.
export interface CatalogKey {
  readonly id: string;
  /** SPKI, PEM. */
  readonly publicKey: string;
  /** Trusted only by development and test builds. */
  readonly development: boolean;
}

export const catalogKeys: readonly CatalogKey[] = [
  {
    id: 'dev-2026-10',
    publicKey:
      '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/xBYRkSum0yZWsv+0XnkO4VM5jfKqGKhwymI1/ylzYg=\n-----END PUBLIC KEY-----\n',
    development: true,
  },
];

/** The keys a build trusts: production builds only the release keys, which Step 18 adds. */
export function trustedCatalogKeys(build: { readonly development: boolean }): CatalogKey[] {
  return catalogKeys.filter((key) => build.development || !key.development);
}
