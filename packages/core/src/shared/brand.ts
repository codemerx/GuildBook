// Branded types: values that passed a check can't be confused with plain strings (IMPLEMENTATION.md §3.2).

declare const brandSymbol: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brandSymbol]: B };

export type InstanceId = Branded<string, 'InstanceId'>;
export type DeviceId = Branded<string, 'DeviceId'>;
export type OperationId = Branded<string, 'OperationId'>;
/** An absolute, normalized path in the device's path flavour. */
export type AbsPath = Branded<string, 'AbsPath'>;
