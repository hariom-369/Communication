//! Length-hiding padding of application plaintext before MLS encryption (crypto-design §9).
//!
//! Frame: `u32 big-endian length || payload || zero bytes` up to a bucket size. Buckets are
//! powers of two from 64 bytes to 32 KiB, then multiples of 8 KiB up to `MAX_PADDED`, which
//! keeps the MLS ciphertext under the server's 64 KiB limit.

use crate::error::{CoreError, Result};

const MIN_BUCKET: usize = 64;
const POW2_LIMIT: usize = 32 * 1024;
const LINEAR_STEP: usize = 8 * 1024;
pub const MAX_PADDED: usize = 56 * 1024;
/// Largest payload that fits (length prefix included).
pub const MAX_PLAINTEXT: usize = MAX_PADDED - 4;

fn bucket(framed_len: usize) -> usize {
    if framed_len <= POW2_LIMIT {
        framed_len.next_power_of_two().max(MIN_BUCKET)
    } else {
        framed_len.div_ceil(LINEAR_STEP) * LINEAR_STEP
    }
}

pub fn pad(payload: &[u8]) -> Result<Vec<u8>> {
    if payload.len() > MAX_PLAINTEXT {
        return Err(CoreError::TooLarge);
    }
    let framed = payload.len() + 4;
    let mut out = Vec::with_capacity(bucket(framed));
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out.resize(bucket(framed), 0);
    Ok(out)
}

/// Strict: the length must fit, and every padding byte must be zero.
pub fn unpad(padded: &[u8]) -> Result<Vec<u8>> {
    if padded.len() < 4 || padded.len() > MAX_PADDED {
        return Err(CoreError::Malformed("padding frame size"));
    }
    let length = u32::from_be_bytes([padded[0], padded[1], padded[2], padded[3]]) as usize;
    let end = 4usize
        .checked_add(length)
        .ok_or(CoreError::Malformed("padding length"))?;
    if end > padded.len() {
        return Err(CoreError::Malformed("padding length"));
    }
    if padded[end..].iter().any(|byte| *byte != 0) {
        return Err(CoreError::Malformed("padding bytes"));
    }
    Ok(padded[4..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn pads_to_buckets() {
        assert_eq!(pad(b"").unwrap().len(), 64);
        assert_eq!(pad(&[1; 60]).unwrap().len(), 64);
        assert_eq!(pad(&[1; 61]).unwrap().len(), 128);
        assert_eq!(pad(&[1; 40_000]).unwrap().len(), 40 * 1024);
        assert_eq!(pad(&[1; MAX_PLAINTEXT]).unwrap().len(), MAX_PADDED);
        assert_eq!(pad(&[1; MAX_PLAINTEXT + 1]), Err(CoreError::TooLarge));
    }

    #[test]
    fn rejects_non_zero_padding_and_bad_lengths() {
        let mut padded = pad(b"hi").unwrap();
        padded[10] = 1;
        assert!(unpad(&padded).is_err());
        let mut long = pad(b"hi").unwrap();
        long[0] = 0xff;
        assert!(unpad(&long).is_err());
        assert!(unpad(&[0, 0]).is_err());
    }

    proptest! {
        #[test]
        fn round_trips(payload in proptest::collection::vec(any::<u8>(), 0..5000)) {
            prop_assert_eq!(unpad(&pad(&payload).unwrap()).unwrap(), payload);
        }

        #[test]
        fn unpad_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
            let _ = unpad(&bytes);
        }
    }
}
