//! Protocol-level tests, including a hostile delivery service (docs/testing.md: malicious-server
//! fixtures). The "server" here is the test itself: it may reorder, replay, drop, substitute or
//! tamper with anything it relays.

use super::*;

const CONVERSATION: &str = "0192f0c1-7a3b-7c4d-8e5f-000000000001";
const OTHER_CONVERSATION: &str = "0192f0c1-7a3b-7c4d-8e5f-000000000002";
const ALICE: &str = "0192f0c1-0000-7000-8000-00000000000a";
const BOB: &str = "0192f0c1-0000-7000-8000-00000000000b";
const MALLORY: &str = "0192f0c1-0000-7000-8000-00000000000c";
const NOW: u64 = 1_800_000_000;

fn client(user: &str) -> Client {
    Client::create(user, 1, NOW).unwrap()
}

/// Both sides pin each other's real identity (as fetched from an honest directory).
fn introduce(a: &mut Client, b: &mut Client) {
    a.observe_identity(&b.user_id(), &b.ask_public_key(), b.ask_version())
        .unwrap();
    b.observe_identity(&a.user_id(), &a.ask_public_key(), a.ask_version())
        .unwrap();
}

fn peers(users: &[&str]) -> Vec<String> {
    users.iter().map(|u| (*u).to_owned()).collect()
}

/// Alice creates the conversation with Bob; returns both clients in epoch 1.
fn conversation() -> (Client, Client) {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let key_package = bob.generate_key_packages(1, false).unwrap().remove(0);
    let output = alice
        .create_group(CONVERSATION, &[key_package], &peers(&[BOB]), NOW)
        .unwrap();
    assert_eq!(output.epoch, 0);
    assert_eq!(output.welcome_targets.len(), 1);
    assert_eq!(output.welcome_targets[0].device_id, bob.device_id());
    assert_eq!(alice.merge_pending(CONVERSATION, NOW).unwrap(), 1);
    let epoch = bob
        .join(
            CONVERSATION,
            &output.welcome.unwrap(),
            &peers(&[ALICE]),
            NOW,
        )
        .unwrap();
    assert_eq!(epoch, 1);
    (alice, bob)
}

fn text(processed: Processed) -> Vec<u8> {
    match processed {
        Processed::Application { plaintext, .. } => plaintext,
        other => panic!("expected application message, got {other:?}"),
    }
}

#[test]
fn two_users_exchange_messages_in_both_directions() {
    let (mut alice, mut bob) = conversation();
    let hello = alice.encrypt(CONVERSATION, b"hello bob").unwrap();
    match bob.process(CONVERSATION, &hello, &peers(&[ALICE])).unwrap() {
        Processed::Application {
            plaintext,
            sender_user_id,
            sender_device_id,
        } => {
            assert_eq!(plaintext, b"hello bob");
            assert_eq!(sender_user_id, ALICE);
            assert_eq!(sender_device_id, alice.device_id());
        }
        other => panic!("unexpected {other:?}"),
    }
    let reply = bob.encrypt(CONVERSATION, b"hi alice").unwrap();
    assert_eq!(
        text(alice.process(CONVERSATION, &reply, &peers(&[BOB])).unwrap()),
        b"hi alice"
    );
    assert_eq!(alice.members(CONVERSATION).unwrap().len(), 2);
    // The ciphertext never contains the plaintext.
    assert!(!hello.windows(9).any(|w| w == b"hello bob"));
}

#[test]
fn device_ids_are_uuid_v7() {
    let alice = client(ALICE);
    let id = alice.device_id();
    assert_eq!(&id[14..15], "7");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    // The timestamp prefix encodes `now` in milliseconds.
    assert_eq!(
        u64::from_str_radix(&id[..8], 16).unwrap(),
        (NOW * 1000) >> 16
    );
}

#[test]
fn senders_cannot_decrypt_their_own_echo() {
    let (mut alice, _bob) = conversation();
    let hello = alice.encrypt(CONVERSATION, b"hello").unwrap();
    assert_eq!(
        alice.process(CONVERSATION, &hello, &peers(&[BOB])),
        Err(CoreError::OwnMessage)
    );
}

#[test]
fn state_survives_snapshot_and_restore() {
    let (mut alice, bob) = conversation();
    let mut bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
    let message = alice.encrypt(CONVERSATION, b"after restore").unwrap();
    assert_eq!(
        text(
            bob.process(CONVERSATION, &message, &peers(&[ALICE]))
                .unwrap()
        ),
        b"after restore"
    );
    let mut alice = Client::restore(&alice.snapshot().unwrap()).unwrap();
    let reply = bob.encrypt(CONVERSATION, b"still works").unwrap();
    assert_eq!(
        text(alice.process(CONVERSATION, &reply, &peers(&[BOB])).unwrap()),
        b"still works"
    );
    assert!(alice.pin(BOB).unwrap().is_some());
}

#[test]
fn restore_rejects_corrupted_snapshots() {
    let snapshot = client(ALICE).snapshot().unwrap();
    assert!(Client::restore(&snapshot[..snapshot.len() - 1]).is_err());
    assert!(Client::restore(b"garbage").is_err());
    let mut extended = snapshot.clone();
    extended.push(0);
    assert!(Client::restore(&extended).is_err());
}

#[test]
fn padding_hides_short_message_lengths() {
    let (mut alice, _bob) = conversation();
    let short = alice.encrypt(CONVERSATION, b"k").unwrap();
    let longer = alice.encrypt(CONVERSATION, &[b'x'; 50]).unwrap();
    assert_eq!(short.len(), longer.len());
}

// ------------------------------------------------------------------ hostile delivery service

#[test]
fn replayed_messages_are_rejected() {
    let (mut alice, mut bob) = conversation();
    let message = alice.encrypt(CONVERSATION, b"once").unwrap();
    bob.process(CONVERSATION, &message, &peers(&[ALICE]))
        .unwrap();
    assert_eq!(
        bob.process(CONVERSATION, &message, &peers(&[ALICE])),
        Err(CoreError::Duplicate)
    );
}

#[test]
fn tampered_ciphertext_is_rejected_without_breaking_the_session() {
    let (mut alice, mut bob) = conversation();
    let message = alice.encrypt(CONVERSATION, b"secret").unwrap();
    let mut tampered = message.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x80;
    assert!(
        bob.process(CONVERSATION, &tampered, &peers(&[ALICE]))
            .is_err()
    );
    let next = alice.encrypt(CONVERSATION, b"next").unwrap();
    assert_eq!(
        text(bob.process(CONVERSATION, &next, &peers(&[ALICE])).unwrap()),
        b"next"
    );
}

#[test]
fn messages_delivered_out_of_order_within_an_epoch_still_decrypt() {
    let (mut alice, mut bob) = conversation();
    let first = alice.encrypt(CONVERSATION, b"1").unwrap();
    let second = alice.encrypt(CONVERSATION, b"2").unwrap();
    assert_eq!(
        text(
            bob.process(CONVERSATION, &second, &peers(&[ALICE]))
                .unwrap()
        ),
        b"2"
    );
    assert_eq!(
        text(bob.process(CONVERSATION, &first, &peers(&[ALICE])).unwrap()),
        b"1"
    );
}

#[test]
fn messages_for_another_conversation_are_rejected() {
    let (mut alice, mut bob) = conversation();
    let message = alice.encrypt(CONVERSATION, b"hi").unwrap();
    assert_eq!(
        bob.process(OTHER_CONVERSATION, &message, &peers(&[ALICE])),
        Err(CoreError::NoGroup)
    );
}

#[test]
fn server_substituted_device_keys_are_rejected() {
    // The server hands Alice a key package claiming to be Bob's, made by a device certified by
    // an account key that is not Bob's pinned key (a "ghost device").
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let impostor = client(BOB); // same user id, different account key
    let forged = impostor.generate_key_packages(1, false).unwrap().remove(0);
    assert_eq!(
        alice
            .create_group(CONVERSATION, &[forged], &peers(&[BOB]), NOW)
            .unwrap_err(),
        CoreError::Untrusted("certificate signature")
    );
    assert!(!alice.has_group(CONVERSATION).unwrap());
}

#[test]
fn key_packages_of_non_members_or_unknown_identities_are_rejected() {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    let mallory = client(MALLORY);
    introduce(&mut alice, &mut bob);
    let mallory_package = mallory.generate_key_packages(1, false).unwrap().remove(0);
    // Mallory is not a conversation member.
    assert!(matches!(
        alice.create_group(
            CONVERSATION,
            std::slice::from_ref(&mallory_package),
            &peers(&[BOB]),
            NOW
        ),
        Err(CoreError::NotAllowed(_))
    ));
    // Mallory is a member, but her identity was never fetched and pinned.
    assert!(matches!(
        alice.create_group(
            CONVERSATION,
            &[mallory_package],
            &peers(&[BOB, MALLORY]),
            NOW
        ),
        Err(CoreError::UnknownIdentity(_))
    ));
}

#[test]
fn tampered_key_packages_are_rejected() {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let package = bob.generate_key_packages(1, false).unwrap().remove(0);
    for index in [10, package.len() / 2, package.len() - 5] {
        let mut tampered = package.clone();
        tampered[index] ^= 0x01;
        assert!(
            alice
                .create_group(CONVERSATION, &[tampered], &peers(&[BOB]), NOW)
                .is_err()
        );
    }
}

#[test]
fn welcomes_containing_untrusted_members_leave_no_state() {
    // Mallory (unknown to Bob) creates a group with Bob and sends him the Welcome.
    let mut bob = client(BOB);
    let mut mallory = client(MALLORY);
    mallory
        .observe_identity(BOB, &bob.ask_public_key(), 1)
        .unwrap();
    let package = bob.generate_key_packages(1, false).unwrap().remove(0);
    let output = mallory
        .create_group(CONVERSATION, &[package], &peers(&[BOB]), NOW)
        .unwrap();
    let welcome = output.welcome.unwrap();
    assert!(matches!(
        bob.join(CONVERSATION, &welcome, &peers(&[MALLORY]), NOW),
        Err(CoreError::UnknownIdentity(_))
    ));
    assert!(!bob.has_group(CONVERSATION).unwrap());
}

#[test]
fn welcomes_for_a_different_conversation_are_rejected() {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let package = bob.generate_key_packages(1, false).unwrap().remove(0);
    let output = alice
        .create_group(CONVERSATION, &[package], &peers(&[BOB]), NOW)
        .unwrap();
    assert_eq!(
        bob.join(
            OTHER_CONVERSATION,
            &output.welcome.unwrap(),
            &peers(&[ALICE]),
            NOW
        ),
        Err(CoreError::Untrusted("welcome group id"))
    );
    assert!(!bob.has_group(OTHER_CONVERSATION).unwrap());
}

#[test]
fn a_key_package_is_used_once() {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let package = bob.generate_key_packages(1, false).unwrap().remove(0);
    let first = alice
        .create_group(
            CONVERSATION,
            std::slice::from_ref(&package),
            &peers(&[BOB]),
            NOW,
        )
        .unwrap();
    bob.join(CONVERSATION, &first.welcome.unwrap(), &peers(&[ALICE]), NOW)
        .unwrap();
    // A second group built from the same (replayed) one-time package cannot be joined.
    let second = alice
        .create_group(OTHER_CONVERSATION, &[package], &peers(&[BOB]), NOW)
        .unwrap();
    assert!(
        bob.join(
            OTHER_CONVERSATION,
            &second.welcome.unwrap(),
            &peers(&[ALICE]),
            NOW
        )
        .is_err()
    );
}

// ------------------------------------------------------------------ epochs and updates

#[test]
fn self_updates_advance_the_epoch_and_keep_certificates() {
    let (mut alice, mut bob) = conversation();
    let update = bob.self_update(CONVERSATION).unwrap();
    assert_eq!(update.epoch, 1);
    bob.merge_pending(CONVERSATION, NOW + 10).unwrap();
    // Alice validates Bob's new leaf (it must still carry his certificate).
    assert_eq!(
        alice
            .process(CONVERSATION, &update.commit, &peers(&[BOB]))
            .unwrap(),
        Processed::Commit {
            epoch: 2,
            removed_self: false
        }
    );
    let message = bob.encrypt(CONVERSATION, b"new epoch").unwrap();
    assert_eq!(
        text(
            alice
                .process(CONVERSATION, &message, &peers(&[BOB]))
                .unwrap()
        ),
        b"new epoch"
    );
}

#[test]
fn concurrent_commits_are_resolved_by_the_delivery_service_order() {
    let (mut alice, mut bob) = conversation();
    let from_alice = alice.self_update(CONVERSATION).unwrap();
    let from_bob = bob.self_update(CONVERSATION).unwrap();
    assert_eq!(from_alice.epoch, from_bob.epoch);
    // The server accepts Alice's commit (compare-and-set on the epoch) and rejects Bob's.
    alice.merge_pending(CONVERSATION, NOW).unwrap();
    bob.clear_pending(CONVERSATION).unwrap();
    bob.process(CONVERSATION, &from_alice.commit, &peers(&[ALICE]))
        .unwrap();
    // Alice's own commit echoed back is recognised and ignored safely.
    assert_eq!(alice.epoch(CONVERSATION).unwrap(), 2);
    assert_eq!(bob.epoch(CONVERSATION).unwrap(), 2);
    let retry = bob.self_update(CONVERSATION).unwrap();
    assert_eq!(retry.epoch, 2);
    bob.merge_pending(CONVERSATION, NOW).unwrap();
    alice
        .process(CONVERSATION, &retry.commit, &peers(&[BOB]))
        .unwrap();
    let message = alice.encrypt(CONVERSATION, b"in sync").unwrap();
    assert_eq!(
        text(
            bob.process(CONVERSATION, &message, &peers(&[ALICE]))
                .unwrap()
        ),
        b"in sync"
    );
}

#[test]
fn stale_epoch_application_messages_are_reported() {
    let (mut alice, mut bob) = conversation();
    let old = alice.encrypt(CONVERSATION, b"old").unwrap();
    for _ in 0..3 {
        let update = alice.self_update(CONVERSATION).unwrap();
        alice.merge_pending(CONVERSATION, NOW).unwrap();
        bob.process(CONVERSATION, &update.commit, &peers(&[ALICE]))
            .unwrap();
    }
    // Three epochs later, beyond max_past_epochs = 2, the old epoch's secrets are gone.
    assert_eq!(
        bob.process(CONVERSATION, &old, &peers(&[ALICE])),
        Err(CoreError::WrongEpoch)
    );
}

#[test]
fn update_schedule_triggers_after_time_or_message_count() {
    let (mut alice, _bob) = conversation();
    assert!(!alice.needs_update(CONVERSATION, NOW).unwrap());
    assert!(
        alice
            .needs_update(CONVERSATION, NOW + 7 * 24 * 3600)
            .unwrap()
    );
    for _ in 0..100 {
        alice.encrypt(CONVERSATION, b"x").unwrap();
    }
    assert!(alice.needs_update(CONVERSATION, NOW).unwrap());
    alice.self_update(CONVERSATION).unwrap();
    alice.merge_pending(CONVERSATION, NOW).unwrap();
    assert!(!alice.needs_update(CONVERSATION, NOW).unwrap());
}

// ------------------------------------------------------------------ identities

#[test]
fn identity_changes_are_detected_and_unverify_the_contact() {
    let mut alice = client(ALICE);
    let bob = client(BOB);
    assert_eq!(
        alice
            .observe_identity(BOB, &bob.ask_public_key(), 1)
            .unwrap(),
        IdentityObservation::New
    );
    assert_eq!(
        alice
            .observe_identity(BOB, &bob.ask_public_key(), 1)
            .unwrap(),
        IdentityObservation::Unchanged
    );
    alice.set_verified(BOB, true).unwrap();
    let reset = Client::create(BOB, 2, NOW).unwrap();
    assert_eq!(
        alice
            .observe_identity(BOB, &reset.ask_public_key(), 2)
            .unwrap(),
        IdentityObservation::Changed
    );
    let pin = alice.pin(BOB).unwrap().unwrap();
    assert!(!pin.verified);
    assert!(pin.changed);
    alice.acknowledge_change(BOB).unwrap();
    assert!(!alice.pin(BOB).unwrap().unwrap().changed);
}

#[test]
fn a_different_server_value_for_our_own_key_is_refused() {
    let mut alice = client(ALICE);
    let other = client(ALICE);
    assert!(
        alice
            .observe_identity(ALICE, &other.ask_public_key(), 1)
            .is_err()
    );
}

#[test]
fn safety_numbers_match_on_both_sides_and_change_with_keys() {
    let (alice, bob) = conversation();
    let from_alice = alice.safety_number(BOB).unwrap();
    let from_bob = bob.safety_number(ALICE).unwrap();
    assert_eq!(from_alice.digits, from_bob.digits);
    assert!(safety::qr_matches(&from_alice.qr, &from_bob.qr));
    let mut alice = alice;
    let reset = Client::create(BOB, 2, NOW).unwrap();
    alice
        .observe_identity(BOB, &reset.ask_public_key(), 2)
        .unwrap();
    assert_ne!(alice.safety_number(BOB).unwrap().digits, from_bob.digits);
}

#[test]
fn a_reset_identity_rejoins_only_after_the_peer_accepts_the_new_key() {
    let (mut alice, mut old_bob) = conversation();
    let mut new_bob = Client::create(BOB, 2, NOW).unwrap();
    new_bob
        .observe_identity(ALICE, &alice.ask_public_key(), 1)
        .unwrap();
    let package = new_bob.generate_key_packages(1, false).unwrap().remove(0);
    // Until Alice fetches and pins Bob's new key, his new device is not trusted.
    assert!(
        alice
            .update_members(
                CONVERSATION,
                std::slice::from_ref(&package),
                &[(BOB.into(), old_bob.device_id())],
                &peers(&[BOB])
            )
            .is_err()
    );
    assert_eq!(
        alice
            .observe_identity(BOB, &new_bob.ask_public_key(), 2)
            .unwrap(),
        IdentityObservation::Changed
    );
    let output = alice
        .update_members(
            CONVERSATION,
            &[package],
            &[(BOB.into(), old_bob.device_id())],
            &peers(&[BOB]),
        )
        .unwrap();
    alice.merge_pending(CONVERSATION, NOW).unwrap();
    new_bob
        .join(
            CONVERSATION,
            &output.welcome.unwrap(),
            &peers(&[ALICE]),
            NOW,
        )
        .unwrap();
    // The old device learns it was removed and drops the group.
    assert_eq!(
        old_bob
            .process(CONVERSATION, &output.commit, &peers(&[ALICE]))
            .unwrap(),
        Processed::Commit {
            epoch: 2,
            removed_self: true
        }
    );
    assert!(!old_bob.has_group(CONVERSATION).unwrap());
    let message = alice.encrypt(CONVERSATION, b"welcome back").unwrap();
    assert_eq!(
        text(
            new_bob
                .process(CONVERSATION, &message, &peers(&[ALICE]))
                .unwrap()
        ),
        b"welcome back"
    );
}

#[test]
fn commits_adding_untrusted_devices_are_rejected_by_other_members() {
    // A malicious member (or a forged commit) tries to add a device Bob cannot verify.
    let (mut alice, mut bob) = conversation();
    let mut mallory = client(MALLORY);
    alice
        .observe_identity(MALLORY, &mallory.ask_public_key(), 1)
        .unwrap();
    mallory
        .observe_identity(ALICE, &alice.ask_public_key(), 1)
        .unwrap();
    let package = mallory.generate_key_packages(1, false).unwrap().remove(0);
    let output = alice
        .update_members(CONVERSATION, &[package], &[], &peers(&[BOB, MALLORY]))
        .unwrap();
    // Bob's view of the conversation (from the server) does not include Mallory.
    assert!(matches!(
        bob.process(CONVERSATION, &output.commit, &peers(&[ALICE])),
        Err(CoreError::NotAllowed(_))
    ));
    // And even if the server claims she is a member, Bob has no pinned identity for her.
    assert!(matches!(
        bob.process(CONVERSATION, &output.commit, &peers(&[ALICE, MALLORY])),
        Err(CoreError::UnknownIdentity(_))
    ));
}

/// Builds a KeyPackage with an arbitrary credential identity and certificate, signed by
/// `signer_of`'s device key: what a malicious server could fabricate.
fn forged_key_package(signer_of: &Client, identity: Vec<u8>, certificate: Vec<u8>) -> Vec<u8> {
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity).into(),
        signature_key: signer_of.signer.to_public_vec().into(),
    };
    let extensions = Extensions::single(Extension::Unknown(
        CERT_EXTENSION,
        UnknownExtension(certificate),
    ))
    .unwrap();
    KeyPackage::builder()
        .leaf_node_capabilities(capabilities())
        .leaf_node_extensions(extensions)
        .build(
            CIPHERSUITE,
            &signer_of.provider,
            &signer_of.signer,
            credential,
        )
        .unwrap()
        .key_package()
        .tls_serialize_detached()
        .unwrap()
}

#[test]
fn a_genuine_certificate_on_someone_elses_signature_key_is_rejected() {
    // The server copies Bob's real certificate onto a leaf whose signing key it controls.
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    introduce(&mut alice, &mut bob);
    let server = client(BOB);
    let identity = identity_bytes(&bob.user_id, &bob.device_id);
    let forged = forged_key_package(&server, identity, bob.certificate());
    assert_eq!(
        alice
            .create_group(CONVERSATION, &[forged], &peers(&[BOB]), NOW)
            .unwrap_err(),
        CoreError::Untrusted("certificate signature key")
    );
}

#[test]
fn a_certificate_for_another_device_or_user_is_rejected() {
    let mut alice = client(ALICE);
    let mut bob = client(BOB);
    let mut mallory = client(MALLORY);
    introduce(&mut alice, &mut bob);
    introduce(&mut alice, &mut mallory);
    // Bob's genuine certificate, but the credential claims a different device id.
    let other_device = identity_bytes(&bob.user_id, &[9u8; 16]);
    let forged = forged_key_package(&bob, other_device, bob.certificate());
    assert_eq!(
        alice
            .create_group(CONVERSATION, &[forged], &peers(&[BOB]), NOW)
            .unwrap_err(),
        CoreError::Untrusted("certificate identity")
    );
    // Mallory presents Bob's genuine certificate under her own user id.
    let as_mallory = identity_bytes(&mallory.user_id, &bob.device_id);
    let forged = forged_key_package(&bob, as_mallory, bob.certificate());
    assert_eq!(
        alice
            .create_group(CONVERSATION, &[forged], &peers(&[BOB, MALLORY]), NOW)
            .unwrap_err(),
        CoreError::Untrusted("certificate identity")
    );
}
