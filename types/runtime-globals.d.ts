// The few runtime globals that pure packages (core, ipc, schemas, tools, brand, editor) may use. They exist in Node,
// Electron's utility processes and the renderer alike. Pure packages get no DOM or Node types, so timers, the file
// system, the network, `process` and `console` stay out of reach: those go through ports (IMPLEMENTATION.md §2.3).

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

declare var AbortSignal: {
  prototype: AbortSignal;
  abort(reason?: unknown): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare var AbortController: {
  prototype: AbortController;
  new (): AbortController;
};

interface TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare var TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};

interface TextDecoder {
  decode(input?: Uint8Array): string;
}

declare var TextDecoder: {
  prototype: TextDecoder;
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};

declare function structuredClone<T>(value: T): T;
declare function queueMicrotask(callback: () => void): void;

/** Reading URLs (WHATWG URL): only the parts pure code needs. */
interface URL {
  readonly protocol: string;
  readonly origin: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly href: string;
}

declare var URL: {
  prototype: URL;
  new (url: string, base?: string): URL;
};

/** Base64 of a string whose characters are all below 256 (encode text to bytes first). */
declare function btoa(data: string): string;
