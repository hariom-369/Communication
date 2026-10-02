#![no_main]
//! Every byte string a hostile server can hand to a client: group messages, Welcomes and
//! KeyPackages. Must never panic; errors are fine.
use std::sync::OnceLock;

use libfuzzer_sys::fuzz_target;
use tessera_crypto_core::Client;

const CONVERSATION: &str = "0192f0c1-7a3b-7c4d-8e5f-000000000001";
const ALICE: &str = "0192f0c1-0000-7000-8000-00000000000a";
const BOB: &str = "0192f0c1-0000-7000-8000-00000000000b";

/// Snapshot of a Bob who is in a conversation with Alice (built once).
fn bob_snapshot() -> &'static [u8] {
    static SNAPSHOT: OnceLock<Vec<u8>> = OnceLock::new();
    SNAPSHOT.get_or_init(|| {
        let mut alice = Client::create(ALICE, 1, 1).unwrap();
        let mut bob = Client::create(BOB, 1, 1).unwrap();
        alice.observe_identity(BOB, &bob.ask_public_key(), 1).unwrap();
        bob.observe_identity(ALICE, &alice.ask_public_key(), 1).unwrap();
        let package = bob.generate_key_packages(1, false).unwrap().remove(0);
        let out = alice.create_group(CONVERSATION, &[package], &[BOB.into()], None, 1).unwrap();
        alice.merge_pending(CONVERSATION, 1).unwrap();
        bob.join(CONVERSATION, &out.welcome.unwrap(), &[ALICE.into()], 1).unwrap();
        bob.snapshot().unwrap()
    })
}

fuzz_target!(|data: &[u8]| {
    let mut bob = Client::restore(bob_snapshot()).unwrap();
    let allowed = [ALICE.to_owned()];
    let _ = bob.process(CONVERSATION, data, &allowed);
    let _ = bob.join("0192f0c1-7a3b-7c4d-8e5f-000000000009", data, &allowed, 1);
    let _ = bob.update_members(CONVERSATION, &[data.to_vec()], &[], &allowed);
    // Link payloads and backups relayed or stored by the server.
    let mut pending = Client::create_pending(BOB, 1).unwrap();
    let _ = pending.complete_link(data, &[1, 2, 3, 4, 5], &[0; 32], 1);
    let _ = pending.backup_restore(
        tessera_crypto_core::client::BackupSecret::PasskeyPrf(&[7; 32]),
        data.get(..72).unwrap_or(data),
        data,
        data,
        data.get(..32).unwrap_or(data),
        &[0; 32],
        1,
        1,
    );
});
