//! RFC 4648 base32 (alphabet `A–Z2–7`, no padding) for human-typed codes: recovery keys and
//! device-link codes. Decoding ignores case, spaces and hyphens. Encoding only — no crypto.

use crate::error::{CoreError, Result};

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn decode(text: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a',
            b'2'..=b'7' => byte - b'2' + 26,
            b' ' | b'-' => continue,
            _ => return Err(CoreError::Malformed("code characters")),
        };
        buffer = (buffer << 5) | u64::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    // Leftover bits must be zero padding (a canonical encoding).
    if bits >= 5 || buffer & ((1 << bits) - 1) != 0 {
        return Err(CoreError::Malformed("code length"));
    }
    Ok(out)
}

/// Groups of `size` characters separated by hyphens, for display.
pub fn grouped(text: &str, size: usize) -> String {
    text.as_bytes()
        .chunks(size)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn matches_rfc4648_vectors() {
        // RFC 4648 §10 (padding removed).
        for (input, output) in [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ] {
            assert_eq!(encode(input.as_bytes()), output);
            assert_eq!(decode(output).unwrap(), input.as_bytes());
        }
    }

    #[test]
    fn decodes_human_input_and_rejects_invalid_codes() {
        assert_eq!(decode("mzxw-6ytb oi").unwrap(), b"foobar");
        assert!(decode("MZXW6YTB0I").is_err()); // '0' is not in the alphabet
        assert!(decode("MZXW6YTBOJ").is_err()); // non-zero padding bits
        assert_eq!(grouped("ABCDEFGHIJ", 4), "ABCD-EFGH-IJ");
    }

    proptest! {
        #[test]
        fn round_trips(bytes in proptest::collection::vec(any::<u8>(), 0..64)) {
            prop_assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
        }
    }
}
