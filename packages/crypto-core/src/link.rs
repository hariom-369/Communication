//! Device linking — docs/multi-device.md §3, ADR-042. Pending review S-04.
//!
//! The new device (N) publishes its ephemeral HPKE public key and MLS signature key to the
//! server, which assigns a short link id. N shows a **link code**: the short id plus a 80-bit
//! SHA-256 fingerprint of N's keys. The user types (or scans) the code on an existing trusted
//! device (E). E fetches N's keys from the server and accepts them only if they match the
//! fingerprint, so a server substituting keys would need a second preimage of an 80-bit
//! truncated hash. E then sends N its certificate (and, for trusted devices, the account
//! identity key) with HPKE (RFC 9180) single-shot encryption to N's key, via the server.
//!
//! This is the standard "authenticate a public key with a short fingerprint over a trusted
//! channel" pattern, with HPKE from the MLS crypto provider; no new primitive or protocol.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::base32;
use crate::error::{CoreError, Result};

pub const SHORT_ID_BYTES: usize = 5;
pub const FINGERPRINT_BYTES: usize = 10;
pub const HPKE_INFO: &[u8] = b"tessera-device-link-v1";
const FINGERPRINT_CONTEXT: &[u8] = b"tessera-link-code-v1";
/// Largest sealed link payload accepted (it may carry transferred history).
pub const MAX_SEALED_BYTES: usize = 8 * 1024 * 1024;

pub fn fingerprint(
    short_id: &[u8; SHORT_ID_BYTES],
    hpke_public: &[u8],
    signature_public: &[u8],
) -> [u8; FINGERPRINT_BYTES] {
    let mut hash = Sha256::new();
    hash.update(FINGERPRINT_CONTEXT);
    hash.update(short_id);
    hash.update((hpke_public.len() as u32).to_be_bytes());
    hash.update(hpke_public);
    hash.update((signature_public.len() as u32).to_be_bytes());
    hash.update(signature_public);
    let digest = hash.finalize();
    let mut out = [0u8; FINGERPRINT_BYTES];
    out.copy_from_slice(&digest[..FINGERPRINT_BYTES]);
    out
}

/// 24 base32 characters in groups of four (e.g. `ABCD-EFGH-…`).
pub fn code(short_id: &[u8; SHORT_ID_BYTES], fingerprint: &[u8; FINGERPRINT_BYTES]) -> String {
    let mut bytes = short_id.to_vec();
    bytes.extend_from_slice(fingerprint);
    base32::grouped(&base32::encode(&bytes), 4)
}

pub fn parse_code(text: &str) -> Result<([u8; SHORT_ID_BYTES], [u8; FINGERPRINT_BYTES])> {
    let bytes = base32::decode(text)?;
    if bytes.len() != SHORT_ID_BYTES + FINGERPRINT_BYTES {
        return Err(CoreError::Malformed("link code length"));
    }
    let mut short_id = [0u8; SHORT_ID_BYTES];
    let mut fp = [0u8; FINGERPRINT_BYTES];
    short_id.copy_from_slice(&bytes[..SHORT_ID_BYTES]);
    fp.copy_from_slice(&bytes[SHORT_ID_BYTES..]);
    Ok((short_id, fp))
}

/// Checks keys fetched from the server against the code the user entered (constant time).
pub fn verify(
    code_text: &str,
    short_id: &[u8; SHORT_ID_BYTES],
    hpke_public: &[u8],
    signature_public: &[u8],
) -> Result<()> {
    let (code_id, code_fp) = parse_code(code_text)?;
    let expected = fingerprint(short_id, hpke_public, signature_public);
    if bool::from(code_id.ct_eq(short_id)) && bool::from(code_fp.ct_eq(&expected)) {
        Ok(())
    } else {
        Err(CoreError::Untrusted(
            "link code does not match the new device",
        ))
    }
}

/// HPKE AAD binding the payload to this link and this device.
pub fn aad(short_id: &[u8; SHORT_ID_BYTES], device_id: &[u8; 16]) -> Vec<u8> {
    let mut out = short_id.to_vec();
    out.extend_from_slice(device_id);
    out
}

/// `u32 length || kem_output || ciphertext`.
pub fn encode_sealed(kem_output: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + kem_output.len() + ciphertext.len());
    out.extend_from_slice(&(kem_output.len() as u32).to_be_bytes());
    out.extend_from_slice(kem_output);
    out.extend_from_slice(ciphertext);
    out
}

pub fn decode_sealed(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    if bytes.len() < 4 || bytes.len() > MAX_SEALED_BYTES {
        return Err(CoreError::Malformed("sealed payload"));
    }
    let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if length > 256 || 4 + length > bytes.len() {
        return Err(CoreError::Malformed("sealed payload"));
    }
    Ok((&bytes[4..4 + length], &bytes[4 + length..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_bind_both_keys() {
        let id = [1, 2, 3, 4, 5];
        let fp = fingerprint(&id, &[7; 32], &[8; 32]);
        let text = code(&id, &fp);
        assert_eq!(text.replace('-', "").len(), 24);
        verify(&text, &id, &[7; 32], &[8; 32]).unwrap();
        verify(&text.to_lowercase(), &id, &[7; 32], &[8; 32]).unwrap();
        assert!(verify(&text, &id, &[9; 32], &[8; 32]).is_err());
        assert!(verify(&text, &id, &[7; 32], &[9; 32]).is_err());
        assert!(verify(&text, &[1, 2, 3, 4, 6], &[7; 32], &[8; 32]).is_err());
        assert!(parse_code("ABCD-EFGH").is_err());
    }

    #[test]
    fn sealed_payload_framing_is_strict() {
        let sealed = encode_sealed(&[1; 32], &[2; 100]);
        assert_eq!(
            decode_sealed(&sealed).unwrap(),
            (&[1u8; 32][..], &[2u8; 100][..])
        );
        assert!(decode_sealed(&[0, 0, 1, 0]).is_err());
        assert!(decode_sealed(&[0, 0]).is_err());
    }
}
