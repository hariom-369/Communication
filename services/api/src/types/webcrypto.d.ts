// The typings of @hpke/core use the Web Crypto global types, which the ES2023 library (without
// the DOM) does not declare; Node's implementation provides them.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
}

export {};
