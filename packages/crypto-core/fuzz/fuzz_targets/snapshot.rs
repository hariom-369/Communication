#![no_main]
use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::Client;

fuzz_target!(|data: &[u8]| {
    let _ = Client::restore(data);
});
