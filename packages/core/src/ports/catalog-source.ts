// Where the tool catalog comes from: bundled, plus a signed refresh (ADR 0026). Step 2 adds the loader.
import type { Catalog } from '@app/tools';

export interface CatalogSource {
  load(): Promise<Catalog>;
}
