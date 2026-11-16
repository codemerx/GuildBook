// Settings → Extra certificates (PLAN.md §3.19 "Proxies and certificates", Step 18): a company's certificate
// authority that this computer doesn't trust. [Add certificate…] picks a PEM file through main; each certificate is
// listed with its subject and expiry, and can be removed.
import { brand } from '@app/brand';
import type { CertificateView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { FilePlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EventTime } from '../links/activity-page.tsx';

export interface CertificateActions {
  add(): Promise<{ added: number }>;
  remove(fingerprint: string): Promise<unknown>;
}

const deviceActions: CertificateActions = {
  add: () => callDevice('addCertificate', {}),
  remove: (fingerprint) => callDevice('removeCertificate', { fingerprint }),
};

/** The subject's common name, else the whole subject. */
const commonName = (subject: string) => /(?:^|, )CN=([^,]+)/.exec(subject)?.[1] ?? subject;

export function CertificatesCard({
  count,
  certificates,
  actions = deviceActions,
}: {
  count: number;
  /** Left out (an older view): only the count shows. */
  certificates?: readonly CertificateView[] | undefined;
  actions?: CertificateActions;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const add = () => {
    setError(null);
    setResult(null);
    actions
      .add()
      .then(({ added }) => setResult(added))
      .catch((e: unknown) => setError(e as ErrorView));
  };
  return (
    <Card aria-labelledby="certificates-title">
      <CardHeader>
        <CardTitle id="certificates-title">{t('settings.certificates')}</CardTitle>
        <CardDescription>{t('settings.certificatesBody', { appName: brand.displayName })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('settings.certificatesCount', { count })}</p>
        {certificates && certificates.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {certificates.map((certificate) => (
              <li key={certificate.fingerprint} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium" title={certificate.subject}>
                    {commonName(certificate.subject)}
                  </span>
                  <span className="text-muted-foreground">
                    {t('settings.certificateValidTo')} <EventTime ms={Date.parse(certificate.validTo)} />
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('settings.certificateRemoveLabel', { subject: commonName(certificate.subject) })}
                  onClick={() =>
                    void actions.remove(certificate.fingerprint).catch((e: unknown) => setError(e as ErrorView))
                  }
                >
                  <Trash2 aria-hidden="true" />
                  {t('settings.certificateRemove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button variant="outline" size="sm" onClick={add}>
            <FilePlus aria-hidden="true" />
            {t('settings.certificateAdd')}
          </Button>
        </div>
        {result !== null && (
          <p role="status" className="text-sm">
            {t('settings.certificatesAdded', { count: result })}
          </p>
        )}
        {error && <ErrorMessage error={error} />}
      </CardContent>
    </Card>
  );
}
