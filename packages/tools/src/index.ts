import { type Catalog, CatalogSchema } from './catalog.ts';
import data from './catalog.json' with { type: 'json' };

export * from './catalog.ts';

/**
 * The catalog bundled with the app (PLAN.md §3.4): one entry per tool, from the tools' documentation as PLAN.md §1.2
 * records it. No entry is `verified` yet: the tool lab (research R1, before Step 5) fills those in.
 */
export const bundledCatalog: Catalog = CatalogSchema.parse(data);
