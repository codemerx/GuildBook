// A modal dialog on Radix (IMPLEMENTATION.md §2.11): a title, a description, the body and the buttons. Focus stays
// inside while it's open, Escape closes it, and the focus then goes back to where it was (Step 17, A17.5).
import { Dialog } from 'radix-ui';
import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Where the focus goes back to when a dialog closes. Radix gives it back only to a Dialog.Trigger, and the app's
 * dialogs open from their own state: so the element that had the focus as the dialog opened is kept, before Radix
 * moves the focus into the dialog, and focused again on close (WCAG 2.4.3).
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  // State adjusted while rendering (React's pattern for state that follows a prop): it changes before the dialog's
  // own effects move the focus into it.
  const [kept, setKept] = useState<{ open: boolean; returnTo: HTMLElement | null }>({ open: false, returnTo: null });
  if (open !== kept.open) {
    const active = open ? document.activeElement : null;
    setKept({ open, returnTo: active instanceof HTMLElement && active !== document.body ? active : kept.returnTo });
  }
  return (event) => {
    const target = kept.returnTo;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
}

/**
 * Whether the dialog is taller than the window lets it be, so that it scrolls. Measured after every render and whenever
 * a part of the dialog changes its size (a part can change by itself, without the dialog rendering again).
 */
function useScrolls(content: React.RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setScrolls(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return scrolls;
}

export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer: React.ReactNode;
}) {
  const returnFocus = useReturnFocus(open);
  const content = useRef<HTMLDivElement>(null);
  const scrolls = useScrolls(content);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          ref={content}
          onCloseAutoFocus={returnFocus}
          className="fixed left-1/2 top-1/2 flex max-h-[85vh] w-[34rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="text-sm text-muted-foreground">{description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          {children}
          {/* A dialog that is taller than the window scrolls as a whole, and its buttons stay at the bottom edge in
              view. Only then: a sticky row is its own layer, which changes how Linux smooths its text, so every other
              dialog keeps the plain row. The negative margins and the padding put the row's box over the dialog's own
              padding and over most of the gap above it, so that what scrolls underneath is covered; it starts 4 px
              below the control above it, so that a focus ring (up to 3 px) is not cut. Chromium measures a sticky
              `bottom` from the content edge of the scroll box, not from its padding edge: `-bottom-6` is the padding. */}
          <div
            className={
              scrolls
                ? 'sticky -bottom-6 -mx-6 -mb-6 -mt-3 flex flex-wrap justify-end gap-3 bg-background px-6 pb-6 pt-3'
                : 'flex flex-wrap justify-end gap-3'
            }
          >
            {footer}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DialogClose = Dialog.Close;
