//! Multi-device: linking, untrusted devices, backups and new-device notices, including a hostile
//! server that substitutes keys or payloads (docs/multi-device.md §9).

use super::*;

const CONVERSATION: &str = "0192f0c1-7a3b-7c4d-8e5f-000000000001";
const ALICE: &str = "0192f0c1-0000-7000-8000-00000000000a";
const BOB: &str = "0192f0c1-0000-7000-8000-00000000000b";
const NOW: u64 = 1_800_000_000;
const SHORT_ID: [u8; 5] = [1, 2, 3, 4, 5];

fn peers(users: &[&str]) -> Vec<String> {
    users.iter().map(|u| (*u).to_owned()).collect()
}

/// Links a new device of `existing`'s account; returns it and the transferred history.
fn link(existing: &Client, trusted: bool, history: &[u8]) -> (Client, Vec<u8>) {
    let mut new = Client::create_pending(&existing.user_id(), NOW + 1).unwrap();
    assert!(new.is_pending());
    let (hpke_public, signature_public) = new.link_request().unwrap();
    let code = new.link_code(&SHORT_ID).unwrap();
    let sealed = existing
        .approve_link(
            &code,
            &SHORT_ID,
            &new.device_id(),
            &hpke_public,
            &signature_public,
            trusted,
            history,
            NOW,
        )
        .unwrap();
    let received = new
        .complete_link(
            &sealed,
            &SHORT_ID,
            &existing.ask_public_key(),
            existing.ask_version(),
        )
        .unwrap();
    (new, received)
}

fn text(processed: Processed) -> Vec<u8> {
    match processed {
        Processed::Application { plaintext, .. } => plaintext,
        other => panic!("expected application message, got {other:?}"),
    }
}

#[test]
fn a_linked_trusted_device_joins_conversations_and_can_link_others() {
    let mut phone = Client::create(ALICE, 1, NOW).unwrap();
    let mut bob = Client::create(BOB, 1, NOW).unwrap();
    phone
        .observe_identity(BOB, &bob.ask_public_key(), 1)
        .unwrap();
    bob.observe_identity(ALICE, &phone.ask_public_key(), 1)
        .unwrap();
    phone.set_verified(BOB, true).unwrap();

    let (mut laptop, history) = link(&phone, true, b"history bundle");
    assert_eq!(history, b"history bundle");
    assert!(laptop.is_trusted() && !laptop.is_pending());
    assert_eq!(laptop.ask_public_key(), phone.ask_public_key());
    // Contact pins and verification states came along.
    assert!(laptop.pin(BOB).unwrap().unwrap().verified);
    // The certificate chains to the account key, so Bob accepts the new device.
    let package = laptop.generate_key_packages(1, false).unwrap().remove(0);
    let bob_package = bob.generate_key_packages(1, false).unwrap().remove(0);
    let created = phone
        .create_group(CONVERSATION, &[bob_package], &peers(&[BOB]), None, NOW)
        .unwrap();
    phone.merge_pending(CONVERSATION, NOW).unwrap();
    bob.join(
        CONVERSATION,
        &created.welcome.unwrap(),
        &peers(&[ALICE]),
        NOW,
    )
    .unwrap();
    let added = bob
        .update_members(CONVERSATION, &[package], &[], &peers(&[ALICE]))
        .unwrap();
    bob.merge_pending(CONVERSATION, NOW).unwrap();
    phone
        .process(CONVERSATION, &added.commit, &peers(&[BOB]))
        .unwrap();
    laptop
        .join(CONVERSATION, &added.welcome.unwrap(), &peers(&[BOB]), NOW)
        .unwrap();

    let message = bob.encrypt(CONVERSATION, b"to all of alice").unwrap();
    assert_eq!(
        text(
            phone
                .process(CONVERSATION, &message, &peers(&[BOB]))
                .unwrap()
        ),
        b"to all of alice"
    );
    assert_eq!(
        text(
            laptop
                .process(CONVERSATION, &message, &peers(&[BOB]))
                .unwrap()
        ),
        b"to all of alice"
    );
    // A trusted linked device can itself link further devices.
    let (tablet, _) = link(&laptop, false, b"");
    assert!(!tablet.is_trusted());
}

#[test]
fn untrusted_devices_can_message_but_not_link_others_or_back_up() {
    let phone = Client::create(ALICE, 1, NOW).unwrap();
    let (mut shared, _) = link(&phone, false, b"");
    assert!(!shared.is_trusted());
    assert!(shared.generate_key_packages(1, false).is_ok());
    let other = Client::create_pending(ALICE, NOW).unwrap();
    let (hpke, sig) = other.link_request().unwrap();
    let code = other.link_code(&SHORT_ID).unwrap();
    assert_eq!(
        shared.approve_link(
            &code,
            &SHORT_ID,
            &other.device_id(),
            &hpke,
            &sig,
            true,
            b"",
            NOW
        ),
        Err(CoreError::State(
            "this device does not hold the account key"
        ))
    );
    assert!(shared.backup_enable().is_err());
    // Its state survives persistence without an account key.
    let restored = Client::restore(&shared.snapshot().unwrap()).unwrap();
    assert!(!restored.is_trusted() && !restored.is_pending());
    assert_eq!(restored.ask_public_key(), phone.ask_public_key());
}

#[test]
fn keys_substituted_by_the_server_or_mistyped_codes_are_rejected() {
    let phone = Client::create(ALICE, 1, NOW).unwrap();
    let new = Client::create_pending(ALICE, NOW).unwrap();
    let attacker = Client::create_pending(ALICE, NOW).unwrap();
    let code = new.link_code(&SHORT_ID).unwrap();
    // The server hands the phone the attacker's keys under the code's link id.
    let (hpke, sig) = attacker.link_request().unwrap();
    assert_eq!(
        phone.approve_link(
            &code,
            &SHORT_ID,
            &attacker.device_id(),
            &hpke,
            &sig,
            true,
            b"",
            NOW
        ),
        Err(CoreError::Untrusted(
            "link code does not match the new device"
        ))
    );
    // A single wrong character in the code.
    let (hpke, sig) = new.link_request().unwrap();
    let mut typo: Vec<char> = code.chars().collect();
    typo[3] = if typo[3] == 'A' { 'B' } else { 'A' };
    let typo: String = typo.into_iter().collect();
    assert!(
        phone
            .approve_link(
                &typo,
                &SHORT_ID,
                &new.device_id(),
                &hpke,
                &sig,
                true,
                b"",
                NOW
            )
            .is_err()
    );
}

#[test]
fn a_pending_device_accepts_only_payloads_for_itself_and_its_accounts_current_key() {
    let phone = Client::create(ALICE, 1, NOW).unwrap();
    let mut new = Client::create_pending(ALICE, NOW).unwrap();
    let (hpke, sig) = new.link_request().unwrap();
    let code = new.link_code(&SHORT_ID).unwrap();
    let sealed = phone
        .approve_link(
            &code,
            &SHORT_ID,
            &new.device_id(),
            &hpke,
            &sig,
            true,
            b"",
            NOW,
        )
        .unwrap();
    // The server claims a different current identity key: refused.
    assert!(new.complete_link(&sealed, &SHORT_ID, &[9; 32], 1).is_err());
    // Another link id (AAD mismatch) or a modified payload: refused.
    assert!(
        new.complete_link(&sealed, &[9, 9, 9, 9, 9], &phone.ask_public_key(), 1)
            .is_err()
    );
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(
        new.complete_link(&tampered, &SHORT_ID, &phone.ask_public_key(), 1)
            .is_err()
    );
    // A payload built by someone else's account (server-injected identity): refused.
    let mallory = Client::create(ALICE, 1, NOW).unwrap(); // same user id, different key
    let forged = mallory
        .approve_link(
            &code,
            &SHORT_ID,
            &new.device_id(),
            &hpke,
            &sig,
            true,
            b"",
            NOW,
        )
        .unwrap();
    assert!(
        new.complete_link(&forged, &SHORT_ID, &phone.ask_public_key(), 1)
            .is_err()
    );
    assert!(new.is_pending());
    new.complete_link(&sealed, &SHORT_ID, &phone.ask_public_key(), 1)
        .unwrap();
    // A pending device's link keys survive a restart.
    let pending = Client::create_pending(ALICE, NOW).unwrap();
    let restored = Client::restore(&pending.snapshot().unwrap()).unwrap();
    assert_eq!(
        restored.link_request().unwrap(),
        pending.link_request().unwrap()
    );
}

#[test]
fn backups_restore_the_identity_on_a_new_device_with_the_recovery_key() {
    let mut phone = Client::create(ALICE, 1, NOW).unwrap();
    let bob = Client::create(BOB, 1, NOW).unwrap();
    phone
        .observe_identity(BOB, &bob.ask_public_key(), 1)
        .unwrap();
    phone.set_verified(BOB, true).unwrap();
    let (recovery_key, wrapped) = phone.backup_enable().unwrap();
    assert_eq!(recovery_key.replace('-', "").len(), 52);
    let backup = phone
        .backup_export(b"all my messages", 1, None, NOW)
        .unwrap();

    let restore = |secret: &str, blob: &[u8], manifest: &[u8], mac: &[u8], key: &[u8; 32]| {
        let mut device = Client::create_pending(ALICE, NOW).unwrap();
        device
            .backup_restore(
                BackupSecret::RecoveryKey(secret),
                &wrapped,
                blob,
                manifest,
                mac,
                key,
                1,
                NOW,
            )
            .map(|(app, manifest)| (device, app, manifest))
    };
    let (restored, app, manifest) = restore(
        &recovery_key,
        &backup.blob,
        &backup.manifest,
        &backup.mac,
        &phone.ask_public_key(),
    )
    .unwrap();
    assert_eq!(app, b"all my messages");
    assert_eq!(manifest.version, 1);
    assert!(restored.is_trusted());
    assert_eq!(restored.ask_public_key(), phone.ask_public_key());
    assert!(restored.pin(BOB).unwrap().unwrap().verified);
    // The restored device certifies itself with the recovered key, and keeps backing up.
    DeviceCertificate::decode(&restored.certificate().unwrap())
        .unwrap()
        .verify(&phone.ask_public_key())
        .unwrap();
    assert!(restored.backup_export(b"later", 2, None, NOW).is_ok());
    assert!(restored.generate_key_packages(1, false).is_ok());

    // Wrong recovery key, modified blob, modified manifest, identity reset since the backup.
    let (other_key, _) = Client::create(ALICE, 1, NOW)
        .unwrap()
        .backup_enable()
        .unwrap();
    assert!(
        restore(
            &other_key,
            &backup.blob,
            &backup.manifest,
            &backup.mac,
            &phone.ask_public_key()
        )
        .is_err()
    );
    let mut blob = backup.blob.clone();
    blob[50] ^= 1;
    assert!(
        restore(
            &recovery_key,
            &blob,
            &backup.manifest,
            &backup.mac,
            &phone.ask_public_key()
        )
        .is_err()
    );
    let manifest = String::from_utf8(backup.manifest.clone())
        .unwrap()
        .replace("\"version\":1", "\"version\":9");
    assert!(
        restore(
            &recovery_key,
            &backup.blob,
            manifest.as_bytes(),
            &backup.mac,
            &phone.ask_public_key()
        )
        .is_err()
    );
    assert_eq!(
        restore(
            &recovery_key,
            &backup.blob,
            &backup.manifest,
            &backup.mac,
            &[3; 32]
        )
        .err(),
        Some(CoreError::Untrusted(
            "backup was made with an older security key of this account"
        ))
    );
}

#[test]
fn backups_restore_with_a_passkey_prf_and_linked_trusted_devices_keep_backing_up() {
    let mut phone = Client::create(ALICE, 1, NOW).unwrap();
    phone.backup_enable().unwrap();
    let prf = [42u8; 32];
    let wrapped = phone.backup_passkey_wrap(&prf).unwrap();
    let backup = phone.backup_export(b"data", 1, None, NOW).unwrap();
    let mut device = Client::create_pending(ALICE, NOW).unwrap();
    assert!(
        device
            .backup_restore(
                BackupSecret::PasskeyPrf(&[41; 32]),
                &wrapped,
                &backup.blob,
                &backup.manifest,
                &backup.mac,
                &phone.ask_public_key(),
                1,
                NOW
            )
            .is_err()
    );
    let (app, _) = device
        .backup_restore(
            BackupSecret::PasskeyPrf(&prf),
            &wrapped,
            &backup.blob,
            &backup.manifest,
            &backup.mac,
            &phone.ask_public_key(),
            1,
            NOW,
        )
        .unwrap();
    assert_eq!(app, b"data");
    let (laptop, _) = link(&phone, true, b"");
    assert!(laptop.has_backup_key());
    // Linked devices share the BRK, so they recognise the account's backups as theirs; a device
    // that turned backups on again (new BRK) does not.
    assert!(laptop.backup_owns(&backup.manifest, &backup.mac));
    assert!(phone.backup_owns(&backup.manifest, &backup.mac));
    let mut other = Client::create(ALICE, 1, NOW).unwrap();
    assert!(!other.backup_owns(&backup.manifest, &backup.mac));
    other.backup_enable().unwrap();
    assert!(!other.backup_owns(&backup.manifest, &backup.mac));
    let mut mac = backup.mac;
    mac[0] ^= 1;
    assert!(!phone.backup_owns(&backup.manifest, &mac));
    let (shared, _) = link(&phone, false, b"");
    assert!(!shared.has_backup_key());
}

#[test]
fn new_devices_of_contacts_are_reported_after_the_first_observation() {
    let mut alice = Client::create(ALICE, 1, NOW).unwrap();
    let bob = Client::create(BOB, 1, NOW).unwrap();
    alice
        .observe_identity(BOB, &bob.ask_public_key(), 1)
        .unwrap();
    let d1 = "0192f0c1-0000-7000-8000-0000000000d1".to_owned();
    let d2 = "0192f0c1-0000-7000-8000-0000000000d2".to_owned();
    assert!(
        alice
            .observe_devices(BOB, std::slice::from_ref(&d1))
            .unwrap()
            .is_empty()
    );
    assert!(
        alice
            .observe_devices(BOB, std::slice::from_ref(&d1))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        alice
            .observe_devices(BOB, &[d1.clone(), d2.clone()])
            .unwrap(),
        vec![d2.clone()]
    );
    // Removing a device is not a "new device".
    assert!(alice.observe_devices(BOB, &[d2]).unwrap().is_empty());
    assert!(
        alice
            .observe_devices("0192f0c1-0000-7000-8000-0000000000ff", &[d1])
            .is_err()
    );
}

/// Seals an arbitrary payload to a pending device, as a malicious sender could.
fn seal(to: &Client, payload: &LinkPayload) -> Vec<u8> {
    let (hpke_public, _) = to.link_request().unwrap();
    let sealed = to
        .provider
        .crypto()
        .hpke_seal(
            CIPHERSUITE.hpke_config(),
            &hpke_public,
            link::HPKE_INFO,
            &link::aad(&SHORT_ID, &to.device_id),
            &serde_json::to_vec(payload).unwrap(),
        )
        .unwrap();
    link::encode_sealed(sealed.kem_output.as_slice(), sealed.ciphertext.as_slice())
}

fn payload_for(
    phone: &Client,
    certificate: &DeviceCertificate,
    ask_secret: Option<[u8; 32]>,
) -> LinkPayload {
    LinkPayload {
        version: 1,
        user_id: phone.user_id(),
        ask_public: B64.encode(phone.ask_public_key()),
        ask_version: 1,
        ask_secret: ask_secret.map(|s| B64.encode(s)),
        certificate: B64.encode(certificate.encode()),
        pins: BTreeMap::new(),
        backup_root: None,
        history: String::new(),
    }
}

#[test]
fn crafted_link_payloads_are_rejected() {
    let phone = Client::create(ALICE, 1, NOW).unwrap();
    let ask = phone.ask.as_ref().unwrap();
    let mut new = Client::create_pending(ALICE, NOW).unwrap();
    let user_id = new.user_id;
    let body = |device_id: Id, key: &[u8]| CertificateBody {
        user_id,
        device_id,
        mls_signature_key: key.try_into().unwrap(),
        ask_version: 1,
        created_at: NOW,
        ciphersuites: vec![CIPHERSUITE_ID],
    };
    let signature_key = new.signer.public().to_vec();
    let expected = phone.ask_public_key();

    // A genuine certificate, but for another device id.
    let other_device = ask.certify(body([7; 16], &signature_key));
    assert_eq!(
        new.complete_link(
            &seal(&new, &payload_for(&phone, &other_device, None)),
            &SHORT_ID,
            &expected,
            1
        ),
        Err(CoreError::Untrusted("certificate is not for this device"))
    );
    // A certificate for this device signed by a different key than the one it claims.
    let impostor = AccountKey::from_seed(Zeroizing::new([5; 32]), 1);
    let forged = impostor.certify(body(new.device_id, &signature_key));
    assert_eq!(
        new.complete_link(
            &seal(&new, &payload_for(&phone, &forged, None)),
            &SHORT_ID,
            &expected,
            1
        ),
        Err(CoreError::Untrusted("certificate signature"))
    );
    // A valid certificate, but an account-key secret that does not match the account key.
    let genuine = ask.certify(body(new.device_id, &signature_key));
    assert_eq!(
        new.complete_link(
            &seal(&new, &payload_for(&phone, &genuine, Some([5; 32]))),
            &SHORT_ID,
            &expected,
            1
        ),
        Err(CoreError::Untrusted("account key does not match"))
    );
    assert!(new.is_pending());
    // The genuine payload is accepted.
    new.complete_link(
        &seal(
            &new,
            &payload_for(&phone, &genuine, Some(*ask.secret_bytes())),
        ),
        &SHORT_ID,
        &expected,
        1,
    )
    .unwrap();
    assert!(new.is_trusted());
}
