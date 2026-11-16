// The guard's roots as arrays (IMPLEMENTATION.md §2.10): the guarded file system keeps a lookup per array and asks
// for the roots at every file operation, so a service hands out the same array while its set of paths is unchanged.

/** A growing set's paths as an array: the same array again while the set has the same size. */
export function setList(): (set: ReadonlySet<string>) => string[] {
  let last: { size: number; value: string[] } | undefined;
  return (set) => {
    if (last?.size !== set.size) last = { size: set.size, value: [...set] };
    return last.value;
  };
}
