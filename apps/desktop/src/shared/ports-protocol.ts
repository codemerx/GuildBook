// How ports reach the page (IMPLEMENTATION.md §2.1): main posts each port to the preload over IPC with a short
// description, and the preload hands it to the page with window.postMessage. The page asks for ports by saying hello.

export const PORT_CHANNEL = 'app:port';
export const HELLO_CHANNEL = 'app:hello';
export const PAGE_HELLO = 'app:page-hello';

export type PortDescription =
  { readonly kind: 'device' } | { readonly kind: 'instance'; readonly instanceId: string; readonly generation: number };

export interface PortMessage {
  readonly type: typeof PORT_CHANNEL;
  readonly port: PortDescription;
}
