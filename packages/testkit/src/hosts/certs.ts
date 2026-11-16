// The test certificate authority (TESTING.md §5): it signs the fake host server's certificate, so a client that adds
// the authority to its trusted certificates exercises the same path as a company certificate authority (ADR 0015).
// Proven in Step 0's spike 4.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export interface Authority {
  readonly name: string;
  /** The authority's certificate: what a client trusts. */
  readonly certPem: string;
  /** A certificate and key for these host names and IP addresses, signed by the authority. */
  issue(hosts: readonly string[]): { certPem: string; keyPem: string };
}

const day = 24 * 3600 * 1000;

function rsaKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  return {
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    privateKey: forge.pki.privateKeyFromPem(keyPem),
    keyPem,
  };
}

/** A positive, non-zero 16-byte serial number. */
function serial(): string {
  return `01${randomBytes(15).toString('hex')}`;
}

export function createAuthority(name = 'Test certificate authority'): Authority {
  const keys = rsaKeys();
  const ca = forge.pki.createCertificate();
  ca.publicKey = keys.publicKey;
  ca.serialNumber = serial();
  // Real time, not the test clock: TLS checks certificates against the computer's clock.
  ca.validity.notBefore = new Date(Date.now() - day);
  ca.validity.notAfter = new Date(Date.now() + 30 * day);
  const subject = [
    { name: 'commonName', value: name },
    { name: 'organizationName', value: 'Test hosts' },
  ];
  ca.setSubject(subject);
  ca.setIssuer(subject);
  ca.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  ca.sign(keys.privateKey, forge.md.sha256.create());

  const issued = new Map<string, { certPem: string; keyPem: string }>();
  return {
    name,
    certPem: forge.pki.certificateToPem(ca),
    issue(hosts) {
      const cached = issued.get(hosts.join(','));
      if (cached) return cached;
      const leafKeys = rsaKeys();
      const cert = forge.pki.createCertificate();
      cert.publicKey = leafKeys.publicKey;
      cert.serialNumber = serial();
      cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
      cert.validity.notAfter = new Date(Date.now() + 7 * day);
      cert.setSubject([{ name: 'commonName', value: hosts[0] ?? 'localhost' }]);
      cert.setIssuer(ca.subject.attributes);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          // Type 7 is an IP address, type 2 a DNS name.
          altNames: hosts.map((host) => (/^[\d.]+$/.test(host) ? { type: 7, ip: host } : { type: 2, value: host })),
        },
        { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() },
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const result = { certPem: forge.pki.certificateToPem(cert), keyPem: leafKeys.keyPem };
      issued.set(hosts.join(','), result);
      return result;
    },
  };
}
