// The shape of a client of the test API (TESTING.md §6). A world uses it to set an app up. The end-to-end harness builds
// one from Playwright. It is a type only, so the worlds need no end-to-end code.
import type { TestApi } from '@app/ipc/test-api';
import type { z } from 'zod';

type Queries = TestApi['queries'];
type Commands = TestApi['commands'];

export interface TestApiClient {
  query<K extends keyof Queries>(
    name: K,
    input?: z.input<Queries[K]['input']>,
  ): Promise<z.output<Queries[K]['output']>>;
  command<K extends keyof Commands>(
    name: K,
    input?: z.input<Commands[K]['input']>,
  ): Promise<z.output<Commands[K]['output']>>;
}
