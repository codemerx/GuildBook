// Commit signing (PLAN.md §3.10 "Signing"): git's SSH signing with one of the user's keys or one the app creates. The
// host shows a signature as verified only when the key is registered there as a signing key.

/** The SSH public key types git's SSH signing and the hosts accept. */
const KEY_TYPES = [
  'ssh-ed25519',
  'sk-ssh-ed25519@openssh.com',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa',
];

export interface PublicKey {
  readonly type: string;
  /** The base64 key blob. */
  readonly blob: string;
  readonly comment: string;
}

/** A public key line (`ssh-ed25519 AAAA… comment`), or null when it isn't one. */
export function parsePublicKey(line: string): PublicKey | null {
  const [type = '', blob = '', ...rest] = line.trim().split(/\s+/);
  if (!KEY_TYPES.includes(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length < 16) return null;
  return { type, blob, comment: rest.join(' ') };
}

/** Whether two key lines are the same key, whatever their comments. */
export function sameKey(a: string, b: string): boolean {
  const left = parsePublicKey(a);
  const right = parsePublicKey(b);
  return left !== null && right !== null && left.type === right.type && left.blob === right.blob;
}

/** What a key is called on the host and in the app: the device's name, so the user knows which one it is. */
export function keyTitle(appName: string, deviceName: string): string {
  return `${appName} signing key (${deviceName})`.slice(0, 100);
}

/** A short form for the screen: the type and the end of the blob. */
export function keyLabel(line: string): string {
  const key = parsePublicKey(line);
  if (!key) return line.slice(0, 40);
  return `${key.type} …${key.blob.slice(-12)}${key.comment ? ` ${key.comment}` : ''}`;
}
