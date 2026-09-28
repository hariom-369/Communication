#![no_main]
use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::identity::DeviceCertificate;

fuzz_target!(|data: &[u8]| {
    if let Ok(certificate) = DeviceCertificate::decode(data) {
        // Re-encoding a parsed certificate must reproduce the input exactly (canonical form).
        assert_eq!(certificate.encode(), data);
        let _ = certificate.verify(&[7u8; 32]);
    }
});
