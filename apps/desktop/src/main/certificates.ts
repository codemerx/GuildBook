// Settings → Extra certificates (PLAN.md §3.19 "Proxies and certificates", ADR 0015): a company's certificate
// authority that the OS doesn't trust. The user picks a PEM file; each certificate in it is checked and kept in
// device.json, and the app's certificate bundle (the OS store plus these) is written again for git and the API calls.
import { X509Certificate } from 'node:crypto';
import type { CertificateView } from '@app/ipc';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
/** A PEM file of a few certificate authorities is far smaller. */
export const CERTIFICATE_FILE_MAX = 1024 * 1024;

export interface ParsedCertificate extends CertificateView {
  /** The PEM text, as device.json keeps it. */
  readonly pem: string;
}

/** Every certificate in a PEM text that parses; anything else is left out. */
export function parseCertificates(text: string): ParsedCertificate[] {
  const out: ParsedCertificate[] = [];
  for (const match of text.matchAll(PEM_BLOCK)) {
    const pem = `${match[0].trim()}\n`;
    try {
      const certificate = new X509Certificate(pem);
      out.push({
        pem,
        fingerprint: certificate.fingerprint256,
        subject: certificate.subject.replace(/\n/g, ', '),
        validTo: new Date(certificate.validTo).toISOString(),
      });
    } catch {
      // Not a certificate: left out.
    }
  }
  return out;
}

/** What Settings lists: one row per kept certificate. */
export function certificateViews(pems: readonly string[]): CertificateView[] {
  return pems.flatMap((pem) =>
    parseCertificates(pem).map(({ fingerprint, subject, validTo }) => ({
      fingerprint,
      subject,
      validTo,
    })),
  );
}
