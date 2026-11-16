// The SSH keys the app can sign commits with (PLAN.md §3.10 "Signing", the SigningKeySource port): for a public key
// file the user picked, the private key next to it (only whether it exists is checked: PLAN.md §3.7 rule 2), and new
// Ed25519 keys in OpenSSH's own private key format, which ssh-keygen (git's signing program) reads.
import type { NewSshKey, SigningKeySource } from '@app/core';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

/** An SSH wire-format string: its length, then its bytes. */
function sshString(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

const text = (value: string) => sshString(Buffer.from(value, 'utf8'));

/** A new Ed25519 key: `openssh-key-v1`, unencrypted, and its public key line. */
export function newEd25519Key(comment: string): NewSshKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  const publicBlob = Buffer.concat([text('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([
    check,
    check,
    text('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    text(comment),
  ]);
  // Padded to the cipher's block size (8 for "none") with 1, 2, 3, …
  const padding = Buffer.from(Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1));
  secret = Buffer.concat([secret, padding]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    text('none'),
    text('none'),
    sshString(Buffer.alloc(0)),
    count,
    sshString(publicBlob),
    sshString(secret),
  ]);
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')}${comment === '' ? '' : ` ${comment}`}`,
  };
}

export class NodeSigningKeys implements SigningKeySource {
  signWith(publicKeyPath: string): string {
    const privateFile = publicKeyPath.endsWith('.pub') ? publicKeyPath.slice(0, -'.pub'.length) : null;
    return privateFile !== null && existsSync(privateFile) ? privateFile : publicKeyPath;
  }

  create(comment: string): NewSshKey {
    return newEd25519Key(comment);
  }
}
