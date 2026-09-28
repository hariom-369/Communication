//! Safety numbers — docs/crypto-design.md §8.
//!
//! Mirrors the construction of Signal's published numeric fingerprint (iterated SHA-512 over a
//! version, the public key and a stable identifier, 5200 iterations, 30-byte output displayed as
//! six 5-digit chunks) applied to the user's Account Signing Key. Only the version constant
//! differs, so values can never collide with Signal's. Pending review S-04.

use sha2::{Digest, Sha512};
use subtle::ConstantTimeEq;

use crate::ids::Id;

const FINGERPRINT_VERSION: u16 = 0x5453; // "TS"
const ITERATIONS: usize = 5200;
const FINGERPRINT_BYTES: usize = 30;
const QR_VERSION: u8 = 1;

/// 30-byte fingerprint of one user's identity.
pub fn fingerprint(user_id: &Id, ask_public_key: &[u8; 32]) -> [u8; FINGERPRINT_BYTES] {
    let mut hash = Vec::with_capacity(64);
    hash.extend_from_slice(&FINGERPRINT_VERSION.to_be_bytes());
    hash.extend_from_slice(ask_public_key);
    hash.extend_from_slice(user_id);
    for _ in 0..ITERATIONS {
        let mut digest = Sha512::new();
        digest.update(&hash);
        digest.update(ask_public_key);
        hash = digest.finalize().to_vec();
    }
    let mut out = [0u8; FINGERPRINT_BYTES];
    out.copy_from_slice(&hash[..FINGERPRINT_BYTES]);
    out
}

/// Six groups of five digits: each 5-byte chunk as a big-endian 40-bit integer mod 100000.
fn digits(fingerprint: &[u8; FINGERPRINT_BYTES]) -> String {
    let mut out = String::with_capacity(30);
    for chunk in fingerprint.chunks_exact(5) {
        let value = chunk
            .iter()
            .fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte));
        out.push_str(&format!("{:05}", value % 100_000));
    }
    out
}

pub struct SafetyNumber {
    /// 60 digits; identical on both sides.
    pub digits: String,
    /// QR payload; identical on both sides, so scanning is an equality check.
    pub qr: Vec<u8>,
}

/// Safety number for the pair (order-independent: both users compute the same value).
pub fn safety_number(a: (&Id, &[u8; 32]), b: (&Id, &[u8; 32])) -> SafetyNumber {
    let fa = fingerprint(a.0, a.1);
    let fb = fingerprint(b.0, b.1);
    let (da, db) = (digits(&fa), digits(&fb));
    let (first_digits, second_digits) = if da <= db { (da, db) } else { (db, da) };
    let (first, second) = if fa <= fb { (fa, fb) } else { (fb, fa) };
    let mut qr = Vec::with_capacity(1 + 2 * FINGERPRINT_BYTES);
    qr.push(QR_VERSION);
    qr.extend_from_slice(&first);
    qr.extend_from_slice(&second);
    SafetyNumber {
        digits: format!("{first_digits}{second_digits}"),
        qr,
    }
}

/// Compares a scanned QR payload with the expected one in constant time.
pub fn qr_matches(expected: &[u8], scanned: &[u8]) -> bool {
    expected.len() == scanned.len() && bool::from(expected.ct_eq(scanned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_symmetric_sixty_digits_and_stable() {
        let (alice, bob) = (([1u8; 16], [10u8; 32]), ([2u8; 16], [20u8; 32]));
        let ab = safety_number((&alice.0, &alice.1), (&bob.0, &bob.1));
        let ba = safety_number((&bob.0, &bob.1), (&alice.0, &alice.1));
        assert_eq!(ab.digits, ba.digits);
        assert_eq!(ab.qr, ba.qr);
        assert_eq!(ab.digits.len(), 60);
        assert!(ab.digits.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(ab.qr.len(), 61);
        // Regression vector: changing the construction must be a deliberate, reviewed change.
        assert_eq!(digits(&fingerprint(&alice.0, &alice.1)), REGRESSION_ALICE);
    }

    const REGRESSION_ALICE: &str = include_str!("../testdata/safety-number-alice.txt");

    #[test]
    fn changes_when_any_key_or_identifier_changes() {
        let base = safety_number((&[1; 16], &[10; 32]), (&[2; 16], &[20; 32]));
        for other in [
            safety_number((&[1; 16], &[11; 32]), (&[2; 16], &[20; 32])),
            safety_number((&[3; 16], &[10; 32]), (&[2; 16], &[20; 32])),
            safety_number((&[1; 16], &[10; 32]), (&[2; 16], &[21; 32])),
        ] {
            assert_ne!(base.digits, other.digits);
            assert!(!qr_matches(&base.qr, &other.qr));
        }
        assert!(qr_matches(&base.qr, &base.qr.clone()));
        assert!(!qr_matches(&base.qr, &base.qr[..60]));
    }
}
