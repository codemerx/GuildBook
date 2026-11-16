// Secrets encrypted with the OS's secure storage through Electron's safeStorage (PLAN.md §2 "Secrets"). On Linux
// without a keyring (libsecret or KWallet), safeStorage selects `basic_text`: it can encrypt only with a built-in key,
// and only after setUsePlainTextEncryption(true), which the app calls once the user saw the warning (A4.13).
import { safeStorage } from 'electron';
import type { SecretCodec, SecretProtection } from '../secrets.ts';

export const safeStorageCodec: SecretCodec = {
  kind: 'os',
  protection(): SecretProtection {
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') return 'weak';
    }
    if (safeStorage.isEncryptionAvailable()) return 'os';
    return process.platform === 'linux' ? 'weak' : 'none';
  },
  allowWeak() {
    if (process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  },
  encrypt: (text) => new Uint8Array(safeStorage.encryptString(text)),
  decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
};
