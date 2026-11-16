// App versions (PLAN.md §3.2 `minAppVersion`): semantic versions, compared by their numbers. A pre-release sorts before
// its release (1.4.0-beta.1 < 1.4.0); build metadata is ignored.

export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = '', pre] = version.split('+')[0]?.split(/-(.*)/s) ?? [];
    return { numbers: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const difference = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

function comparePre(a: string, b: string): number {
  const xs = a.split('.');
  const ys = b.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const difference = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
