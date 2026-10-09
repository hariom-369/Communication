//! Group-call media keys (ADR-047): every current member derives the same secret for a call,
//! nobody outside the group can, and a membership change re-keys.

use super::*;

const GROUP: &str = "0192f0c1-7a3b-7c4d-8e5f-0000000000ca";
const CALL: &str = "0192f0c1-7a3b-7c4d-8e5f-00000000ca11";
const OTHER_CALL: &str = "0192f0c1-7a3b-7c4d-8e5f-00000000ca12";
const ALICE: &str = "0192f0c1-0000-7000-8000-0000000000a1";
const BOB: &str = "0192f0c1-0000-7000-8000-0000000000b2";
const CAROL: &str = "0192f0c1-0000-7000-8000-0000000000c3";
const NOW: u64 = 1_800_000_000;

fn ids(users: &[&str]) -> Vec<String> {
    users.iter().map(|u| (*u).to_owned()).collect()
}

fn pin_all(clients: &mut [&mut Client]) {
    let keys: Vec<(String, [u8; 32], u32)> = clients
        .iter()
        .map(|c| (c.user_id(), c.ask_public_key(), c.ask_version()))
        .collect();
    for client in clients.iter_mut() {
        for (user, key, version) in &keys {
            if *user != client.user_id() {
                client.observe_identity(user, key, *version).unwrap();
            }
        }
    }
}

/// ALICE creates a group with BOB and CAROL.
fn three() -> (Client, Client, Client) {
    let mut alice = Client::create(ALICE, 1, NOW).unwrap();
    let mut bob = Client::create(BOB, 1, NOW).unwrap();
    let mut carol = Client::create(CAROL, 1, NOW).unwrap();
    pin_all(&mut [&mut alice, &mut bob, &mut carol]);
    let packages = vec![
        bob.generate_key_packages(1, false).unwrap().remove(0),
        carol.generate_key_packages(1, false).unwrap().remove(0),
    ];
    let listed = ids(&[ALICE, BOB, CAROL]);
    let created = alice
        .create_group(
            GROUP,
            &packages,
            &listed,
            Some(GroupPolicy::new(ALICE)),
            NOW,
        )
        .unwrap();
    alice.merge_pending(GROUP, NOW).unwrap();
    let welcome = created.welcome.unwrap();
    bob.join(GROUP, &welcome, &listed, NOW).unwrap();
    carol.join(GROUP, &welcome, &listed, NOW).unwrap();
    (alice, bob, carol)
}

#[test]
fn every_member_derives_the_same_call_secret_with_distinct_sender_indexes() {
    let (alice, bob, carol) = three();
    let a = alice.call_secret(GROUP, CALL, 16).unwrap();
    let b = bob.call_secret(GROUP, CALL, 16).unwrap();
    let c = carol.call_secret(GROUP, CALL, 16).unwrap();
    assert_eq!(a.secret.len(), 16);
    assert_eq!(a.secret, b.secret);
    assert_eq!(a.secret, c.secret);
    assert_eq!(a.epoch, b.epoch);
    let mut indexes = vec![a.own_index, b.own_index, c.own_index];
    indexes.sort_unstable();
    indexes.dedup();
    assert_eq!(indexes.len(), 3, "each device sends under its own index");
    // The member list maps every index to its device.
    let bob_entry = a.members.iter().find(|m| m.index == b.own_index).unwrap();
    assert_eq!(bob_entry.user_id, BOB);
    assert_eq!(bob_entry.device_id, bob.device_id());
    // 32-byte keys (AES-256 suites) are supported; other lengths are refused.
    assert_eq!(alice.call_secret(GROUP, CALL, 32).unwrap().secret.len(), 32);
    assert!(alice.call_secret(GROUP, CALL, 12).is_err());
    assert!(alice.call_secret(GROUP, "not-a-call", 16).is_err());
}

#[test]
fn each_call_has_its_own_keys() {
    let (alice, _, _) = three();
    let one = alice.call_secret(GROUP, CALL, 16).unwrap();
    let two = alice.call_secret(GROUP, OTHER_CALL, 16).unwrap();
    assert_ne!(one.secret, two.secret);
}

#[test]
fn removing_a_member_rekeys_the_call_and_locks_them_out() {
    let (mut alice, mut bob, mut carol) = three();
    let before = alice.call_secret(GROUP, CALL, 16).unwrap();
    let carol_device = (CAROL.to_string(), carol.device_id());
    let removal = alice
        .update_members(GROUP, &[], &[carol_device], &ids(&[ALICE, BOB, CAROL]))
        .unwrap();
    alice.merge_pending(GROUP, NOW).unwrap();
    bob.process(GROUP, &removal.commit, &ids(&[ALICE, BOB]))
        .unwrap();
    assert!(matches!(
        carol.process(GROUP, &removal.commit, &ids(&[ALICE, BOB])),
        Ok(Processed::Commit {
            removed_self: true,
            ..
        })
    ));
    let after_alice = alice.call_secret(GROUP, CALL, 16).unwrap();
    let after_bob = bob.call_secret(GROUP, CALL, 16).unwrap();
    assert_eq!(after_alice.secret, after_bob.secret);
    assert_ne!(after_alice.secret, before.secret, "new epoch, new key");
    assert_eq!(after_alice.epoch, before.epoch + 1);
    assert_eq!(after_alice.members.len(), 2);
    // Carol can no longer derive anything for the new epoch.
    let carol_view = carol.call_secret(GROUP, CALL, 16);
    assert!(carol_view.is_err() || carol_view.unwrap().secret != after_alice.secret);
}

#[test]
fn outsiders_cannot_derive_call_keys() {
    let (alice, _, _) = three();
    let outsider = Client::create("0192f0c1-0000-7000-8000-0000000000d4", 1, NOW).unwrap();
    assert!(outsider.call_secret(GROUP, CALL, 16).is_err());
    assert!(
        alice
            .call_secret("0192f0c1-7a3b-7c4d-8e5f-0000000000cb", CALL, 16)
            .is_err()
    );
}
