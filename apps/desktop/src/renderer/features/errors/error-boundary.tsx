// Errors the renderer didn't expect: shown plainly and reported to main's log (IMPLEMENTATION.md §2.12).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { connection } from '../../rpc/connection.ts';

export function reportError(error: unknown, extra?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? `${error.stack ?? ''}${extra ?? ''}` : extra;
  void connection
    .device()
    .then((client) => client.command.reportRendererError(stack === undefined ? { message } : { message, stack }))
    .catch(() => undefined);
}

export function ErrorPanel({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-start gap-3 pt-16">
      <h1 className="text-xl font-semibold">{t('errorBoundary.title')}</h1>
      <p className="text-muted-foreground">{t('errorBoundary.body')}</p>
      <Button variant="secondary" onClick={onRetry}>
        {t('errorBoundary.retry')}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, info.componentStack ?? '');
  }

  override render(): ReactNode {
    if (this.state.failed) return <ErrorPanel onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}
