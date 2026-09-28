#![no_main]
use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::padding::{pad, unpad};

fuzz_target!(|data: &[u8]| {
    if let Ok(payload) = unpad(data) {
        assert!(payload.len() + 4 <= data.len());
    }
    if let Ok(padded) = pad(data) {
        assert_eq!(unpad(&padded).unwrap(), data);
    }
});
