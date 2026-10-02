#![no_main]
use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::media;

// Attachments come from the server (ciphertext) and from other users (the digest in a
// message): neither may make decryption panic or accept wrong content.
fuzz_target!(|data: &[u8]| {
    let digest = media::MediaDigest {
        plaintext_sha256: [0; 32],
        ciphertext_sha256: [0; 32],
        plaintext_size: data.len() as u64,
        ciphertext_size: data.len() as u64,
    };
    assert!(media::decrypt(&[7; 32], data, &digest).is_err());
    if let Ok(mut decryptor) = media::Decryptor::new(&[7; 32], data.get(..media::HEADER_BYTES).unwrap_or(data)) {
        let _ = decryptor.push(data);
    }
});
