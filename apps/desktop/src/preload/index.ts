// The sandboxed preload (IMPLEMENTATION.md §2.1): it hands the ports main creates to the page, and passes the page's
// hello on so main sends fresh ports after a reload. Nothing else crosses: no Node, no other APIs.
import { ipcRenderer } from 'electron';
import { HELLO_CHANNEL, PAGE_HELLO, PORT_CHANNEL, type PortDescription } from '../shared/ports-protocol.ts';

ipcRenderer.on(PORT_CHANNEL, (event, description: PortDescription) => {
  window.postMessage({ type: PORT_CHANNEL, port: description }, '*', event.ports);
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === PAGE_HELLO) {
    ipcRenderer.send(HELLO_CHANNEL);
  }
});
