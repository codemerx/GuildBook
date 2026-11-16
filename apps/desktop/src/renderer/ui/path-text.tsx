// A path as people read it: inside the home folder it starts with ~ (PLAN.md §3.0 shows paths this way). Text that
// differs from run to run, like a temporary folder, carries data-volatile, and the screenshot tour masks it
// (TESTING.md §7.2).
import { cn } from './cn.ts';

export function displayPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const separator = path.includes('\\') ? '\\' : '/';
  if (path === home) return '~';
  return path.startsWith(home + separator) ? `~${path.slice(home.length)}` : path;
}

export function PathText({ path, home, className }: { path: string; home: string | undefined; className?: string }) {
  const shown = displayPath(path, home);
  return (
    <span
      className={cn('break-all font-mono text-xs leading-5', className)}
      data-volatile={shown === path ? '' : undefined}
    >
      {shown}
    </span>
  );
}
