// The guard's entry roots (IMPLEMENTATION.md §2.10): the link engine's exact paths and the originals of imported
// skills (Step 13). The guard keeps a lookup per array and asks for its roots at every file operation, so the joined
// list stays the same array until one of its parts changes.
export function entriesJoiner(): (entries: readonly string[], originals: readonly string[]) => readonly string[] {
  let joined: { entries: readonly string[]; originals: readonly string[]; value: readonly string[] } | undefined;
  return (entries, originals) => {
    if (originals.length === 0) return entries;
    if (joined?.entries !== entries || joined.originals !== originals) {
      joined = { entries, originals, value: [...entries, ...originals] };
    }
    return joined.value;
  };
}
