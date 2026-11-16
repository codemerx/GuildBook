// The SSH keys the app can sign commits with (PLAN.md §3.10 "Signing"): one of the user's own, which the user picks as
// a public key file in a file dialog (PLAN.md §3.7 rule 5: main reads only that file), or a new one the app creates. A
// created key's private part goes to main's secrets service at once; it's never written anywhere else but a command's
// private temporary file (ADR 0014).

export interface NewSshKey {
  /** OpenSSH's private key format, unencrypted (it's kept by the secrets service). */
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface SigningKeySource {
  /**
   * What git signs with for a picked public key file: the private key next to it when one is there (only whether it
   * exists is checked), or the public key file itself, whose private part the user's agent holds.
   */
  signWith(publicKeyPath: string): string;
  /** A new Ed25519 key with this comment. */
  create(comment: string): NewSshKey;
}
