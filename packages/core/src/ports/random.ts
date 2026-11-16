// Randomness (IMPLEMENTATION.md §2.12): ids, tokens and anything else random comes from here.
export interface Random {
  bytes(count: number): Uint8Array;
}
