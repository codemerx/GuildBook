// The signed tool catalog of a release (ADR 0026, PLAN.md §3.4):
//   node scripts/catalog-release.ts keygen <private-key-file> --id=<key id>
//       makes a release key pair: the private key goes to the file (outside the repository; it becomes the release
//       pipeline's secret CATALOG_SIGNING_KEY), and the public key is printed, to add to packages/tools/src/keys.ts
//   node scripts/catalog-release.ts sign <out folder> [--development]
//       signs packages/tools/src/catalog.json with CATALOG_SIGNING_KEY (a PEM) as CATALOG_KEY_ID, writes catalog.json
//       and catalog.json.sig into the folder, and checks them as a production build would (with --development, as a
//       development build: for trying a refresh with the development key)
// The release pipeline uploads both files to the release named `catalog` (release-feed.ts).
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifySignedCatalog } from '../packages/adapters/src/catalog/catalog-loader.ts';
import { trustedCatalogKeys } from '../packages/tools/src/keys.ts';

const repo = path.resolve(import.meta.dirname, '..');
export const CATALOG_SOURCE = path.join(repo, 'packages', 'tools', 'src', 'catalog.json');

/** The detached signature file of ADR 0026 for these exact bytes. */
export function signatureFile(bytes: Uint8Array, privateKeyPem: string, keyId: string): string {
  const signature = sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64');
  return `${JSON.stringify({ keyId, signature })}\n`;
}

export function keygen(file: string, id: string): string {
  const target = path.resolve(file);
  if (target.startsWith(`${repo}${path.sep}`)) throw new Error('the private key must not be inside the repository');
  if (existsSync(target)) throw new Error(`${target} exists: a key is never overwritten`);
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) throw new Error(`not a key id: ${id}`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

export function signCatalogTo(
  out: string,
  key: { readonly pem: string; readonly id: string },
  development: boolean,
): { tools: number } {
  const bytes = readFileSync(CATALOG_SOURCE);
  const signature = signatureFile(bytes, key.pem, key.id);
  const checked = verifySignedCatalog(bytes, signature, trustedCatalogKeys({ development }));
  if (!checked.ok) {
    throw new Error(
      `the signed catalog doesn't check out (${checked.error}): is ${key.id} in packages/tools/src/keys.ts?`,
    );
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'catalog.json'), bytes);
  writeFileSync(path.join(out, 'catalog.json.sig'), signature);
  return { tools: checked.value.tools.length };
}

function main(args: readonly string[]): void {
  const [command, target] = args;
  const id = args.find((a) => a.startsWith('--id='))?.slice('--id='.length);
  if (command === 'keygen' && target && id) {
    const publicKey = keygen(target, id);
    process.stdout.write(
      `The private key is in ${path.resolve(target)}: store it as the secret CATALOG_SIGNING_KEY, with ` +
        `CATALOG_KEY_ID=${id}, and keep no other copy.\nAdd this to catalogKeys in packages/tools/src/keys.ts:\n` +
        `  { id: '${id}', publicKey: ${JSON.stringify(publicKey)}, development: false },\n`,
    );
    return;
  }
  if (command === 'sign' && target) {
    const pem = process.env.CATALOG_SIGNING_KEY;
    const keyId = process.env.CATALOG_KEY_ID;
    if (!pem || !keyId) throw new Error('sign needs CATALOG_SIGNING_KEY and CATALOG_KEY_ID');
    const { tools } = signCatalogTo(target, { pem, id: keyId }, args.includes('--development'));
    process.stdout.write(`signed the catalog (${tools} tools) as ${keyId} into ${target}\n`);
    return;
  }
  process.stderr.write('usage: catalog-release.ts keygen <file> --id=<id> | sign <out> [--development]\n');
  process.exit(2);
}

if (import.meta.main) main(process.argv.slice(2));
