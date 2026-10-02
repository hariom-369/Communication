//! End-to-end encrypted attachments — docs/media.md §2, ADR-013, ADR-043. Pending review S-05.
//!
//! Library constructions only, the same ones as backups (ADR-042):
//! - a fresh random 256-bit key per attachment, sent to recipients inside the MLS message;
//! - XChaCha20-Poly1305 in the `aead` crate's STREAM construction (big-endian 32-bit counter,
//!   last-block flag), 64 KiB chunks, under HKDF-SHA-256(key, info = `tessera-media-v1`) —
//!   detects modification, reordering and truncation;
//! - SHA-256 of the ciphertext (lets the uploader and recipients check the stored object) and of
//!   the plaintext (recorded in the message; checked after decryption).
//!
//! Encryption and decryption are incremental so the worker can process a file in slices without
//! holding it twice in memory. Layout: `MAGIC || nonce(19) || STREAM chunks`.

use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::KeyInit;
use chacha20poly1305::aead::stream::{DecryptorBE32, EncryptorBE32};
use hkdf::Hkdf;
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};

pub const KEY_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 19;
/// Plaintext bytes per STREAM chunk; every chunk but the last must be exactly this size.
pub const CHUNK: usize = 64 * 1024;
pub const TAG: usize = 16;
const MAGIC: &[u8; 4] = b"TSM1";
pub const HEADER_BYTES: usize = MAGIC.len() + NONCE_BYTES;
/// Largest attachment (docs/media.md §1: 200 MiB for video and documents, with headroom).
pub const MAX_PLAINTEXT: u64 = 256 * 1024 * 1024;
const INFO: &[u8] = b"tessera-media-v1";

fn cipher(key: &[u8; KEY_BYTES]) -> XChaCha20Poly1305 {
    let mut okm = Zeroizing::new([0u8; KEY_BYTES]);
    // 32 bytes is always a valid HKDF-SHA-256 output length.
    Hkdf::<Sha256>::new(None, key)
        .expand(INFO, okm.as_mut())
        .expect("32-byte HKDF output");
    XChaCha20Poly1305::new(okm.as_ref().into())
}

/// Ciphertext size for a plaintext of `size` bytes.
pub fn ciphertext_size(size: u64) -> u64 {
    let chunks = size / CHUNK as u64 + 1; // the last chunk may be empty
    HEADER_BYTES as u64 + size + chunks * TAG as u64
}

/// What a finished encryption or decryption produced; recorded in the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDigest {
    pub plaintext_sha256: [u8; 32],
    pub ciphertext_sha256: [u8; 32],
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
}

pub struct Encryptor {
    stream: Option<EncryptorBE32<XChaCha20Poly1305>>,
    plain: Sha256,
    cipher: Sha256,
    plain_size: u64,
    cipher_size: u64,
}

impl Encryptor {
    /// Starts encrypting; returns the encryptor and the header (the first ciphertext bytes).
    pub fn new(key: &[u8; KEY_BYTES], nonce: [u8; NONCE_BYTES]) -> (Self, Vec<u8>) {
        let mut header = MAGIC.to_vec();
        header.extend_from_slice(&nonce);
        let mut cipher_hash = Sha256::new();
        cipher_hash.update(&header);
        let stream = EncryptorBE32::from_aead(cipher(key), nonce.as_ref().into());
        (
            Self {
                stream: Some(stream),
                plain: Sha256::new(),
                cipher: cipher_hash,
                plain_size: 0,
                cipher_size: header.len() as u64,
            },
            header,
        )
    }

    fn count(&mut self, plaintext: &[u8]) -> Result<()> {
        self.plain_size += plaintext.len() as u64;
        if self.plain_size > MAX_PLAINTEXT {
            return Err(CoreError::TooLarge);
        }
        self.plain.update(plaintext);
        Ok(())
    }

    /// Encrypts one full chunk (exactly [`CHUNK`] bytes).
    pub fn push(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() != CHUNK {
            return Err(CoreError::Malformed("media chunk size"));
        }
        self.count(plaintext)?;
        let stream = self
            .stream
            .as_mut()
            .ok_or(CoreError::State("media encryption finished"))?;
        let out = stream
            .encrypt_next(plaintext)
            .map_err(|_| CoreError::Mls("media encrypt"))?;
        self.cipher.update(&out);
        self.cipher_size += out.len() as u64;
        Ok(out)
    }

    /// Encrypts the final chunk (0..=[`CHUNK`] bytes) and returns it with the digest.
    pub fn finish(mut self, plaintext: &[u8]) -> Result<(Vec<u8>, MediaDigest)> {
        if plaintext.len() > CHUNK {
            return Err(CoreError::Malformed("media chunk size"));
        }
        self.count(plaintext)?;
        let stream = self
            .stream
            .take()
            .ok_or(CoreError::State("media encryption finished"))?;
        let out = stream
            .encrypt_last(plaintext)
            .map_err(|_| CoreError::Mls("media encrypt"))?;
        self.cipher.update(&out);
        self.cipher_size += out.len() as u64;
        Ok((
            out,
            MediaDigest {
                plaintext_sha256: self.plain.finalize().into(),
                ciphertext_sha256: self.cipher.finalize().into(),
                plaintext_size: self.plain_size,
                ciphertext_size: self.cipher_size,
            },
        ))
    }
}

pub struct Decryptor {
    stream: Option<DecryptorBE32<XChaCha20Poly1305>>,
    plain: Sha256,
    cipher: Sha256,
    plain_size: u64,
    cipher_size: u64,
}

impl Decryptor {
    /// Starts decrypting from the header (the first [`HEADER_BYTES`] ciphertext bytes).
    pub fn new(key: &[u8; KEY_BYTES], header: &[u8]) -> Result<Self> {
        if header.len() != HEADER_BYTES || &header[..MAGIC.len()] != MAGIC {
            return Err(CoreError::Malformed("media format"));
        }
        let mut cipher_hash = Sha256::new();
        cipher_hash.update(header);
        let stream = DecryptorBE32::from_aead(cipher(key), header[MAGIC.len()..].into());
        Ok(Self {
            stream: Some(stream),
            plain: Sha256::new(),
            cipher: cipher_hash,
            plain_size: 0,
            cipher_size: header.len() as u64,
        })
    }

    fn count(&mut self, ciphertext: &[u8]) -> Result<()> {
        self.cipher_size += ciphertext.len() as u64;
        if self.cipher_size > ciphertext_size(MAX_PLAINTEXT) {
            return Err(CoreError::TooLarge);
        }
        self.cipher.update(ciphertext);
        Ok(())
    }

    /// Decrypts one full chunk (exactly [`CHUNK`] + [`TAG`] bytes).
    pub fn push(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() != CHUNK + TAG {
            return Err(CoreError::Malformed("media chunk size"));
        }
        self.count(ciphertext)?;
        let stream = self
            .stream
            .as_mut()
            .ok_or(CoreError::State("media decryption finished"))?;
        let out = stream
            .decrypt_next(ciphertext)
            .map_err(|_| CoreError::Untrusted("media integrity"))?;
        self.plain.update(&out);
        self.plain_size += out.len() as u64;
        Ok(out)
    }

    /// Decrypts the final chunk ([`TAG`]..=[`CHUNK`] + [`TAG`] bytes) and checks the digest the
    /// message promised (both hashes, in constant time). Callers must not use any decrypted
    /// bytes unless this succeeds.
    pub fn finish(mut self, ciphertext: &[u8], expected: &MediaDigest) -> Result<Vec<u8>> {
        if ciphertext.len() < TAG || ciphertext.len() > CHUNK + TAG {
            return Err(CoreError::Malformed("media chunk size"));
        }
        self.count(ciphertext)?;
        let stream = self
            .stream
            .take()
            .ok_or(CoreError::State("media decryption finished"))?;
        let out = stream
            .decrypt_last(ciphertext)
            .map_err(|_| CoreError::Untrusted("media integrity"))?;
        self.plain.update(&out);
        self.plain_size += out.len() as u64;
        let plain: [u8; 32] = self.plain.finalize().into();
        let cipher: [u8; 32] = self.cipher.finalize().into();
        let hashes_match =
            plain.ct_eq(&expected.plaintext_sha256) & cipher.ct_eq(&expected.ciphertext_sha256);
        if !bool::from(hashes_match)
            || self.plain_size != expected.plaintext_size
            || self.cipher_size != expected.ciphertext_size
        {
            return Err(CoreError::Untrusted("media does not match the message"));
        }
        Ok(out)
    }
}

/// Whole-buffer helpers (tests, small files).
pub fn encrypt(
    key: &[u8; KEY_BYTES],
    nonce: [u8; NONCE_BYTES],
    plaintext: &[u8],
) -> Result<(Vec<u8>, MediaDigest)> {
    let (mut encryptor, mut out) = Encryptor::new(key, nonce);
    let mut chunks = plaintext.chunks_exact(CHUNK);
    for chunk in chunks.by_ref() {
        out.extend(encryptor.push(chunk)?);
    }
    let (last, digest) = encryptor.finish(chunks.remainder())?;
    out.extend(last);
    Ok((out, digest))
}

pub fn decrypt(key: &[u8; KEY_BYTES], blob: &[u8], expected: &MediaDigest) -> Result<Vec<u8>> {
    if blob.len() < HEADER_BYTES + TAG {
        return Err(CoreError::Malformed("media format"));
    }
    let (header, body) = blob.split_at(HEADER_BYTES);
    let mut decryptor = Decryptor::new(key, header)?;
    // The last chunk is the remainder; when the body is an exact multiple of a full encrypted
    // chunk, the last chunk is a full one (a plaintext that is a multiple of CHUNK ends with an
    // empty final chunk, so this only happens with truncated input, which then fails).
    let full = CHUNK + TAG;
    let last_len = match body.len() % full {
        0 => full,
        n => n,
    };
    let (rest, last) = body.split_at(body.len() - last_len);
    let mut out = Vec::with_capacity(body.len());
    for chunk in rest.chunks_exact(full) {
        out.extend(decryptor.push(chunk)?);
    }
    out.extend(decryptor.finish(last, expected)?);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const KEY: [u8; 32] = [5; 32];
    const NONCE: [u8; 19] = [6; 19];

    fn sample(size: usize) -> Vec<u8> {
        (0..size).map(|i| (i % 253) as u8).collect()
    }

    #[test]
    fn round_trips_at_every_chunk_boundary_and_predicts_sizes() {
        for size in [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 17] {
            let plaintext = sample(size);
            let (blob, digest) = encrypt(&KEY, NONCE, &plaintext).unwrap();
            assert_eq!(
                blob.len() as u64,
                ciphertext_size(size as u64),
                "size {size}"
            );
            assert_eq!(digest.ciphertext_size, blob.len() as u64);
            assert_eq!(digest.plaintext_size, size as u64);
            assert_eq!(
                digest.ciphertext_sha256,
                <[u8; 32]>::from(Sha256::digest(&blob))
            );
            assert_eq!(
                digest.plaintext_sha256,
                <[u8; 32]>::from(Sha256::digest(&plaintext))
            );
            assert_eq!(decrypt(&KEY, &blob, &digest).unwrap(), plaintext);
        }
    }

    #[test]
    fn rejects_tampering_truncation_reordering_wrong_keys_and_wrong_digests() {
        let plaintext = sample(3 * CHUNK + 100);
        let (blob, digest) = encrypt(&KEY, NONCE, &plaintext).unwrap();
        let full = CHUNK + TAG;
        let h = HEADER_BYTES;

        let mut flipped = blob.clone();
        flipped[h + 10] ^= 1;
        assert!(decrypt(&KEY, &flipped, &digest).is_err());
        // Truncated at a chunk boundary (the new last chunk was not sealed as last).
        assert!(decrypt(&KEY, &blob[..h + 2 * full], &digest).is_err());
        // Last chunk dropped mid-way.
        assert!(decrypt(&KEY, &blob[..blob.len() - 5], &digest).is_err());
        // Chunks swapped.
        let mut swapped = blob[..h].to_vec();
        swapped.extend_from_slice(&blob[h + full..h + 2 * full]);
        swapped.extend_from_slice(&blob[h..h + full]);
        swapped.extend_from_slice(&blob[h + 2 * full..]);
        assert!(decrypt(&KEY, &swapped, &digest).is_err());
        // Another key; another nonce in the header.
        assert!(decrypt(&[9; 32], &blob, &digest).is_err());
        let mut nonce = blob.clone();
        nonce[6] ^= 1;
        assert!(decrypt(&KEY, &nonce, &digest).is_err());
        // Correct ciphertext but the message promised something else.
        for change in 0..4 {
            let mut other = digest.clone();
            match change {
                0 => other.plaintext_sha256[0] ^= 1,
                1 => other.ciphertext_sha256[31] ^= 1,
                2 => other.plaintext_size += 1,
                _ => other.ciphertext_size -= 1,
            }
            assert_eq!(
                decrypt(&KEY, &blob, &other).err(),
                Some(CoreError::Untrusted("media does not match the message")),
                "change {change}"
            );
        }
    }

    #[test]
    fn a_different_attachment_cannot_be_substituted() {
        // Same key reused would be a client bug; still, a blob for other content fails the
        // digest the message carries.
        let (blob_a, digest_a) = encrypt(&KEY, NONCE, b"photo A").unwrap();
        let (blob_b, _) = encrypt(&KEY, NONCE, b"photo B").unwrap();
        assert!(decrypt(&KEY, &blob_a, &digest_a).is_ok());
        assert!(decrypt(&KEY, &blob_b, &digest_a).is_err());
    }

    #[test]
    fn incremental_api_enforces_chunk_sizes_and_order() {
        let (mut encryptor, _) = Encryptor::new(&KEY, NONCE);
        assert!(encryptor.push(&[0; 10]).is_err());
        assert!(encryptor.finish(&vec![0; CHUNK + 1]).is_err());
        let mut decryptor = Decryptor::new(&KEY, &[0; HEADER_BYTES]);
        assert!(decryptor.is_err());
        let (_, header) = Encryptor::new(&KEY, NONCE);
        decryptor = Decryptor::new(&KEY, &header);
        assert!(decryptor.unwrap().push(&[0; 10]).is_err());
    }

    proptest! {
        #[test]
        fn decrypt_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..400)) {
            let digest = MediaDigest {
                plaintext_sha256: [0; 32],
                ciphertext_sha256: [0; 32],
                plaintext_size: 0,
                ciphertext_size: 0,
            };
            let _ = decrypt(&KEY, &bytes, &digest);
        }

        #[test]
        fn round_trips_arbitrary_input(bytes in proptest::collection::vec(any::<u8>(), 0..2000)) {
            let (blob, digest) = encrypt(&KEY, NONCE, &bytes).unwrap();
            prop_assert_eq!(decrypt(&KEY, &blob, &digest).unwrap(), bytes);
        }
    }
}
