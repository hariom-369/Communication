#![no_main]
use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::backup;

fuzz_target!(|data: &[u8]| {
    let _ = backup::decrypt(&[7; 32], data);
    let _ = backup::unwrap(b"secret", backup::RECOVERY_WRAP_INFO, data);
    let _ = backup::verify_manifest(&[7; 32], data, data.get(..32).unwrap_or(data));
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = backup::parse_recovery_key(text);
        let _ = tessera_crypto_core::link::parse_code(text);
    }
});
