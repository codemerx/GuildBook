// What a change in the library's folder means (PLAN.md §3.10 "Adjusting links"). A fetch, the app's own or another git
// tool's, writes only git's remote-tracking state: FETCH_HEAD and the refs under refs/remotes. They change the git
// screens (what is incoming), but neither the library's files nor its links. A fetch writes them while it runs, so a
// library refresh for them would interrupt that fetch, which would then write them again (the Step 12 stall).

/** Whether a path inside the library folder (relative, with forward slashes) is only a fetch's bookkeeping. */
export function isFetchBookkeeping(relative: string): boolean {
  return (
    relative === '.git/FETCH_HEAD' || relative === '.git/refs/remotes' || relative.startsWith('.git/refs/remotes/')
  );
}
