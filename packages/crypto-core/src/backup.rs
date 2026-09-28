//! Encrypted backups — docs/encrypted-backups.md, ADR-014. Pending review S-06.
//!
//! Library constructions only (RustCrypto):
//! - keys: HKDF-SHA-256 from the random 256-bit Backup Root Key (BRK);
//! - backup body: XChaCha20-Poly1305 in the `aead` crate's STREAM construction (big-endian
//!   32-bit counter, last-block flag), 64 KiB chunks — detects reordering and truncation;
//! - BRK wrapping (recovery key, passkey PRF): XChaCha20-Poly1305 with a random 192-bit nonce;
//! - manifest integrity: HMAC-SHA-256 under a key derived from the BRK.
//!
//! Deviation from the Phase 0 sketch (libsodium `secretstream`): same primitive family and
//! properties, without adding a C library to the WebAssembly build (ADR-042).

use chacha20poly1305::aead::stream::{DecryptorBE32, EncryptorBE32};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::base32;
use crate::error::{CoreError, Result};

pub const KEY_BYTES: usize = 32;
pub const WRAP_NONCE_BYTES: usize = 24;
pub const STREAM_NONCE_BYTES: usize = 19;
const CHUNK: usize = 64 * 1024;
const TAG: usize = 16;
const MAGIC: &[u8; 4] = b"TSB1";
/// Upper bound on a decrypted backup (history is text; media is not backed up yet).
pub const MAX_PLAINTEXT: usize = 64 * 1024 * 1024;

pub const RECOVERY_WRAP_INFO: &[u8] = b"tessera-rk-wrap-v1";
pub const PASSKEY_WRAP_INFO: &[u8] = b"tessera-pk-wrap-v1";
const WRAP_AAD: &[u8] = b"tessera-backup-wrap-v1";
const ENC_INFO: &[u8] = b"tessera-backup-enc-v1";
const MAC_INFO: &[u8] = b"tessera-backup-manifest-v1";

fn hkdf(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> Zeroizing<[u8; KEY_BYTES]> {
    let mut okm = Zeroizing::new([0u8; KEY_BYTES]);
    // 32 bytes is always a valid HKDF-SHA-256 output length.
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info, okm.as_mut())
        .expect("32-byte HKDF output");
    okm
}

/// Recovery key for display: 52 base32 characters in groups of four.
pub fn format_recovery_key(key: &[u8; KEY_BYTES]) -> String {
    base32::grouped(&base32::encode(key), 4)
}

pub fn parse_recovery_key(text: &str) -> Result<Zeroizing<[u8; KEY_BYTES]>> {
    let bytes = Zeroizing::new(base32::decode(text)?);
    let key: [u8; KEY_BYTES] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| CoreError::Malformed("recovery key length"))?;
    Ok(Zeroizing::new(key))
}

/// Wraps the BRK under a key derived from `secret` (recovery key or passkey PRF output).
pub fn wrap(
    secret: &[u8],
    info: &[u8],
    brk: &[u8; KEY_BYTES],
    nonce: [u8; WRAP_NONCE_BYTES],
) -> Result<Vec<u8>> {
    let key = hkdf(secret, None, info);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: brk,
                aad: WRAP_AAD,
            },
        )
        .map_err(|_| CoreError::Mls("wrap"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn unwrap(secret: &[u8], info: &[u8], wrapped: &[u8]) -> Result<Zeroizing<[u8; KEY_BYTES]>> {
    if wrapped.len() != WRAP_NONCE_BYTES + KEY_BYTES + TAG {
        return Err(CoreError::Malformed("wrapped key"));
    }
    let key = hkdf(secret, None, info);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let (nonce, ciphertext) = wrapped.split_at(WRAP_NONCE_BYTES);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: WRAP_AAD,
                },
            )
            .map_err(|_| CoreError::Untrusted("wrong recovery key or passkey"))?,
    );
    let brk: [u8; KEY_BYTES] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| CoreError::Malformed("brk"))?;
    Ok(Zeroizing::new(brk))
}

/// Encrypts a backup body. Layout: `MAGIC || backup_id(16) || nonce(19) || STREAM chunks`.
pub fn encrypt(
    brk: &[u8; KEY_BYTES],
    backup_id: &[u8; 16],
    nonce: [u8; STREAM_NONCE_BYTES],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(CoreError::TooLarge);
    }
    let key = hkdf(brk, Some(backup_id), ENC_INFO);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let mut stream = EncryptorBE32::from_aead(cipher, nonce.as_ref().into());
    let mut out = Vec::with_capacity(plaintext.len() + plaintext.len() / CHUNK * TAG + 64);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(backup_id);
    out.extend_from_slice(&nonce);
    let chunks: Vec<&[u8]> = plaintext.chunks(CHUNK).collect();
    let (last, rest) = chunks
        .split_last()
        .map_or((&[][..], &[][..]), |(l, r)| (*l, r));
    for chunk in rest {
        out.extend(
            stream
                .encrypt_next(*chunk)
                .map_err(|_| CoreError::Mls("backup encrypt"))?,
        );
    }
    out.extend(
        stream
            .encrypt_last(last)
            .map_err(|_| CoreError::Mls("backup encrypt"))?,
    );
    Ok(out)
}

/// Decrypts a backup body; fails on any modification, reordering or truncation.
pub fn decrypt(brk: &[u8; KEY_BYTES], blob: &[u8]) -> Result<(Vec<u8>, [u8; 16])> {
    let header = MAGIC.len() + 16 + STREAM_NONCE_BYTES;
    if blob.len() < header + TAG || &blob[..MAGIC.len()] != MAGIC {
        return Err(CoreError::Malformed("backup format"));
    }
    let mut backup_id = [0u8; 16];
    backup_id.copy_from_slice(&blob[MAGIC.len()..MAGIC.len() + 16]);
    let nonce = &blob[MAGIC.len() + 16..header];
    let key = hkdf(brk, Some(&backup_id), ENC_INFO);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let mut stream = DecryptorBE32::from_aead(cipher, nonce.into());
    let body = &blob[header..];
    if body.len() > MAX_PLAINTEXT + (MAX_PLAINTEXT / CHUNK + 1) * TAG {
        return Err(CoreError::TooLarge);
    }
    let chunks: Vec<&[u8]> = body.chunks(CHUNK + TAG).collect();
    let (last, rest) = chunks
        .split_last()
        .ok_or(CoreError::Malformed("backup format"))?;
    let mut out = Vec::with_capacity(body.len());
    for chunk in rest {
        let plain = stream
            .decrypt_next(*chunk)
            .map_err(|_| CoreError::Untrusted("backup integrity"))?;
        out.extend_from_slice(&plain);
    }
    let plain = stream
        .decrypt_last(*last)
        .map_err(|_| CoreError::Untrusted("backup integrity"))?;
    out.extend_from_slice(&plain);
    Ok((out, backup_id))
}

fn manifest_mac(brk: &[u8; KEY_BYTES]) -> Hmac<Sha256> {
    let key = hkdf(brk, None, MAC_INFO);
    <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key.as_ref())
        .expect("HMAC accepts any key length")
}

pub fn sign_manifest(brk: &[u8; KEY_BYTES], manifest: &[u8]) -> [u8; 32] {
    let mut mac = manifest_mac(brk);
    mac.update(manifest);
    mac.finalize().into_bytes().into()
}

/// Constant-time verification of the manifest MAC.
pub fn verify_manifest(brk: &[u8; KEY_BYTES], manifest: &[u8], tag: &[u8]) -> Result<()> {
    let mut mac = manifest_mac(brk);
    mac.update(manifest);
    mac.verify_slice(tag)
        .map_err(|_| CoreError::Untrusted("backup manifest"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const BRK: [u8; 32] = [7; 32];
    const ID: [u8; 16] = [1; 16];

    #[test]
    fn recovery_keys_round_trip_as_52_characters() {
        let text = format_recovery_key(&[0xAB; 32]);
        assert_eq!(text.replace('-', "").len(), 52);
        assert_eq!(
            *parse_recovery_key(&text.to_lowercase()).unwrap(),
            [0xAB; 32]
        );
        assert!(parse_recovery_key("ABCD").is_err());
    }

    #[test]
    fn wraps_open_only_with_the_same_secret_and_purpose() {
        let wrapped = wrap(b"secret", RECOVERY_WRAP_INFO, &BRK, [3; 24]).unwrap();
        assert_eq!(
            *unwrap(b"secret", RECOVERY_WRAP_INFO, &wrapped).unwrap(),
            BRK
        );
        assert!(unwrap(b"other", RECOVERY_WRAP_INFO, &wrapped).is_err());
        assert!(unwrap(b"secret", PASSKEY_WRAP_INFO, &wrapped).is_err());
        let mut tampered = wrapped.clone();
        tampered[30] ^= 1;
        assert!(unwrap(b"secret", RECOVERY_WRAP_INFO, &tampered).is_err());
    }

    #[test]
    fn multi_chunk_backups_round_trip_and_detect_truncation_reordering_and_tampering() {
        let plaintext: Vec<u8> = (0..(3 * CHUNK + 100)).map(|i| (i % 251) as u8).collect();
        let blob = encrypt(&BRK, &ID, [9; 19], &plaintext).unwrap();
        let (decrypted, id) = decrypt(&BRK, &blob).unwrap();
        assert_eq!(decrypted, plaintext);
        assert_eq!(id, ID);

        let header = 4 + 16 + 19;
        // Truncated at a chunk boundary: the new last chunk was not encrypted as "last".
        assert!(decrypt(&BRK, &blob[..header + 2 * (CHUNK + TAG)]).is_err());
        // Chunks swapped.
        let mut swapped = blob[..header].to_vec();
        swapped.extend_from_slice(&blob[header + CHUNK + TAG..header + 2 * (CHUNK + TAG)]);
        swapped.extend_from_slice(&blob[header..header + CHUNK + TAG]);
        swapped.extend_from_slice(&blob[header + 2 * (CHUNK + TAG)..]);
        assert!(decrypt(&BRK, &swapped).is_err());
        // Any flipped bit, another key, another backup id.
        let mut flipped = blob.clone();
        flipped[header + 5] ^= 1;
        assert!(decrypt(&BRK, &flipped).is_err());
        assert!(decrypt(&[8; 32], &blob).is_err());
        let mut other_id = blob.clone();
        other_id[5] ^= 1;
        assert!(decrypt(&BRK, &other_id).is_err());
    }

    #[test]
    fn empty_backups_are_valid() {
        let blob = encrypt(&BRK, &ID, [0; 19], b"").unwrap();
        assert_eq!(decrypt(&BRK, &blob).unwrap().0, b"");
    }

    #[test]
    fn manifests_are_authenticated() {
        let tag = sign_manifest(&BRK, b"{\"version\":3}");
        verify_manifest(&BRK, b"{\"version\":3}", &tag).unwrap();
        assert!(verify_manifest(&BRK, b"{\"version\":2}", &tag).is_err());
        assert!(verify_manifest(&[8; 32], b"{\"version\":3}", &tag).is_err());
    }

    proptest! {
        #[test]
        fn decrypt_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..400)) {
            let _ = decrypt(&BRK, &bytes);
        }
    }
}
