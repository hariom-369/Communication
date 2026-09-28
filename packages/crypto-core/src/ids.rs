use crate::error::{CoreError, Result};

/// 128-bit identifier (UUID bytes). Users, devices and conversations share the representation.
pub type Id = [u8; 16];

/// Parses the canonical hyphenated UUID form used by the API (`8-4-4-4-12`, any case).
pub fn parse_id(text: &str) -> Result<Id> {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return Err(CoreError::Malformed("id length"));
    }
    let mut out = [0u8; 16];
    let mut nibbles = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return Err(CoreError::Malformed("id format"));
            }
            continue;
        }
        let value = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(CoreError::Malformed("id format")),
        };
        out[nibbles / 2] |= if nibbles.is_multiple_of(2) {
            value << 4
        } else {
            value
        };
        nibbles += 1;
    }
    Ok(out)
}

/// Formats an id in lowercase hyphenated form.
pub fn format_id(id: &Id) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(36);
    for (index, byte) in id.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_bad_input() {
        let text = "0192f0c1-7a3b-7c4d-8e5f-0123456789ab";
        assert_eq!(format_id(&parse_id(text).unwrap()), text);
        assert_eq!(format_id(&parse_id(&text.to_uppercase()).unwrap()), text);
        assert!(parse_id("0192f0c1-7a3b-7c4d-8e5f-0123456789a").is_err());
        assert!(parse_id("0192f0c1_7a3b-7c4d-8e5f-0123456789ab").is_err());
        assert!(parse_id("0192f0c1-7a3b-7c4d-8e5f-0123456789ag").is_err());
    }
}
