//! Signed web releases (docs/e2ee.md §7, ADR-052, review item S-03).
//!
//! A release manifest lists every file the web app is served from, with its SHA-256. The
//! release key signs `RELEASE_CONTEXT || manifest bytes` with Ed25519 (`ed25519-dalek`, verified
//! with `verify_strict`). The service worker accepts an app update only when the manifest verifies
//! under a key it already trusts and every file it then downloads matches its digest.
//! No primitive is implemented here: SHA-256 (`sha2`) and Ed25519 (`ed25519-dalek`) only.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// Domain separation: a release signature can never be mistaken for any other Tessera signature.
pub const RELEASE_CONTEXT: &[u8] = b"tessera web release manifest v1\n";

/// SHA-256 of a served file.
pub fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Whether `signature` (64 bytes) over the manifest verifies under any of `keys` (32 bytes each).
pub fn verify(manifest: &[u8], signature: &[u8], keys: &[Vec<u8>]) -> bool {
    let Ok(signature) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    let signature = Signature::from_bytes(&signature);
    let mut message = Vec::with_capacity(RELEASE_CONTEXT.len() + manifest.len());
    message.extend_from_slice(RELEASE_CONTEXT);
    message.extend_from_slice(manifest);
    keys.iter().any(|key| {
        <[u8; 32]>::try_from(key.as_slice())
            .ok()
            .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
            .is_some_and(|key| key.verify_strict(&message, &signature).is_ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed(manifest: &[u8], key: &SigningKey) -> Vec<u8> {
        let mut message = RELEASE_CONTEXT.to_vec();
        message.extend_from_slice(manifest);
        key.sign(&message).to_bytes().to_vec()
    }

    #[test]
    fn accepts_a_manifest_signed_by_a_trusted_key() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let manifest = br#"{"version":1}"#;
        let signature = signed(manifest, &key);
        let trusted = vec![
            other.verifying_key().to_bytes().to_vec(),
            key.verifying_key().to_bytes().to_vec(),
        ];
        assert!(verify(manifest, &signature, &trusted));
    }

    #[test]
    fn refuses_other_keys_changed_manifests_and_malformed_input() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let manifest = br#"{"version":1}"#;
        let signature = signed(manifest, &key);
        let trusted = vec![key.verifying_key().to_bytes().to_vec()];
        let stranger = vec![
            SigningKey::from_bytes(&[8u8; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        ];
        assert!(!verify(manifest, &signature, &stranger));
        assert!(!verify(br#"{"version":2}"#, &signature, &trusted));
        assert!(!verify(manifest, &signature[..63], &trusted));
        assert!(!verify(manifest, &signature, &[vec![1, 2, 3]]));
        assert!(!verify(manifest, &signature, &[]));
        // Without the context string the same key's signature does not count.
        let bare = key.sign(manifest).to_bytes();
        assert!(!verify(manifest, &bare, &trusted));
    }

    #[test]
    fn digests_are_sha256() {
        assert_eq!(
            digest(b"abc").to_vec(),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad
            ]
        );
    }
}
