// A list that renders only the rows in view (IMPLEMENTATION.md Step 6: "virtualized from the start for the `large`
// world"). Rows have one fixed height; spacers keep the scroll height, so 1,000 rows cost as much as the 15 in view.
import { useState } from 'react';
import type React from 'react';

export function VirtualRows<T>({
  rows,
  rowHeight,
  height,
  overscan = 8,
  render,
  className,
}: {
  rows: readonly T[];
  rowHeight: number;
  /** The visible height in pixels. */
  height: number;
  overscan?: number;
  render: (row: T, index: number) => React.ReactNode;
  className?: string;
}) {
  const [top, setTop] = useState(0);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((top + height) / rowHeight) + overscan);
  return (
    <div
      className={className}
      style={{ maxHeight: height, overflowY: 'auto' }}
      onScroll={(event) => setTop((event.target as HTMLElement).scrollTop)}
    >
      <div style={{ height: first * rowHeight }} aria-hidden="true" />
      {rows.slice(first, last).map((row, offset) => render(row, first + offset))}
      <div style={{ height: (rows.length - last) * rowHeight }} aria-hidden="true" />
    </div>
  );
}
