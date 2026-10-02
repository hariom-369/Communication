//! Groups with roles (ADR-044): every member enforces the end-to-end policy on every commit,
//! including against a delivery service that lies about membership.

use super::*;

const GROUP: &str = "0192f0c1-7a3b-7c4d-8e5f-0000000000aa";
const OWNER: &str = "0192f0c1-0000-7000-8000-00000000000a";
const ADMIN: &str = "0192f0c1-0000-7000-8000-00000000000b";
const MEMBER: &str = "0192f0c1-0000-7000-8000-00000000000c";
const NEWCOMER: &str = "0192f0c1-0000-7000-8000-00000000000d";
const GHOST: &str = "0192f0c1-0000-7000-8000-00000000000e";
const NOW: u64 = 1_800_000_000;

fn ids(users: &[&str]) -> Vec<String> {
    users.iter().map(|u| (*u).to_owned()).collect()
}

/// Everyone pins everyone (an honest directory).
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

struct Group {
    owner: Client,
    admin: Client,
    member: Client,
    newcomer: Client,
}

impl Group {
    fn everyone(&self) -> Vec<String> {
        ids(&[OWNER, ADMIN, MEMBER, NEWCOMER])
    }
}

/// OWNER creates the group with ADMIN and MEMBER, then promotes ADMIN. NEWCOMER exists but is
/// not in the group yet.
fn group() -> Group {
    let mut owner = Client::create(OWNER, 1, NOW).unwrap();
    let mut admin = Client::create(ADMIN, 1, NOW).unwrap();
    let mut member = Client::create(MEMBER, 1, NOW).unwrap();
    let mut newcomer = Client::create(NEWCOMER, 1, NOW).unwrap();
    pin_all(&mut [&mut owner, &mut admin, &mut member, &mut newcomer]);
    let packages = vec![
        admin.generate_key_packages(1, false).unwrap().remove(0),
        member.generate_key_packages(1, false).unwrap().remove(0),
    ];
    let listed = ids(&[OWNER, ADMIN, MEMBER]);
    let created = owner
        .create_group(
            GROUP,
            &packages,
            &listed,
            Some(GroupPolicy::new(OWNER)),
            NOW,
        )
        .unwrap();
    owner.merge_pending(GROUP, NOW).unwrap();
    let welcome = created.welcome.unwrap();
    admin.join(GROUP, &welcome, &listed, NOW).unwrap();
    member.join(GROUP, &welcome, &listed, NOW).unwrap();
    let mut g = Group {
        owner,
        admin,
        member,
        newcomer,
    };
    let promoted = GroupPolicy {
        admins: vec![ADMIN.into()],
        ..GroupPolicy::new(OWNER)
    };
    let commit = g.owner.update_policy(GROUP, promoted, &listed).unwrap();
    g.owner.merge_pending(GROUP, NOW).unwrap();
    g.admin.process(GROUP, &commit.commit, &listed).unwrap();
    g.member.process(GROUP, &commit.commit, &listed).unwrap();
    g
}

#[test]
fn every_member_receives_the_same_authenticated_policy() {
    let g = group();
    for client in [&g.owner, &g.admin, &g.member] {
        let policy = client.group_policy(GROUP).unwrap().unwrap();
        assert_eq!(policy.owner, OWNER);
        assert_eq!(policy.admins, vec![ADMIN.to_string()]);
    }
}

#[test]
fn admins_add_people_and_members_cannot() {
    let mut g = group();
    let everyone = g.everyone();
    // A member's own device refuses to add someone.
    let package = g.newcomer.generate_key_packages(2, false).unwrap();
    assert!(matches!(
        g.member
            .update_members(GROUP, &package[..1], &[], &everyone),
        Err(CoreError::NotAllowed(_))
    ));
    // An admin may; the newcomer joins and everyone accepts the commit.
    let added = g
        .admin
        .update_members(GROUP, &package[1..], &[], &everyone)
        .unwrap();
    g.admin.merge_pending(GROUP, NOW).unwrap();
    g.owner.process(GROUP, &added.commit, &everyone).unwrap();
    g.member.process(GROUP, &added.commit, &everyone).unwrap();
    g.newcomer
        .join(GROUP, &added.welcome.unwrap(), &everyone, NOW)
        .unwrap();
    assert_eq!(
        g.newcomer.group_policy(GROUP).unwrap().unwrap().admins,
        vec![ADMIN.to_string()]
    );
}

#[test]
fn a_malicious_server_cannot_get_a_ghost_member_added() {
    // The server lists a user nobody invited and relays a commit adding them, built by a
    // member's device that was tricked or compromised. Every other member refuses it.
    let mut g = group();
    let mut ghost = Client::create(GHOST, 1, NOW).unwrap();
    for client in [&mut g.owner, &mut g.admin, &mut g.member] {
        client
            .observe_identity(GHOST, &ghost.ask_public_key(), 1)
            .unwrap();
    }
    ghost
        .observe_identity(MEMBER, &g.member.ask_public_key(), 1)
        .unwrap();
    let listed = ids(&[OWNER, ADMIN, MEMBER, GHOST]);
    let package = ghost.generate_key_packages(1, false).unwrap();
    // Bypass the member's own local check to simulate a compromised client.
    let mut group = g.member.load_group(&parse_id(GROUP).unwrap()).unwrap();
    let (key_package, target) = g
        .member
        .validate_key_package(&package[0], &g.member.parse_allowed(&listed).unwrap())
        .unwrap();
    let forged = g
        .member
        .commit(
            &mut group,
            vec![key_package],
            vec![],
            vec![target],
            true,
            None,
        )
        .unwrap();
    for client in [&mut g.owner, &mut g.admin] {
        assert!(matches!(
            client.process(GROUP, &forged.commit, &listed),
            Err(CoreError::NotAllowed(_))
        ));
    }
    // The group is unchanged for honest members.
    assert_eq!(g.owner.members(GROUP).unwrap().len(), 3);
}

#[test]
fn removals_follow_roles() {
    let mut g = group();
    let listed = ids(&[OWNER, ADMIN, MEMBER]);
    let owner_device = (OWNER.to_string(), g.owner.device_id());
    let admin_device = (ADMIN.to_string(), g.admin.device_id());
    let member_device = (MEMBER.to_string(), g.member.device_id());
    // A member removes nobody; an admin cannot remove the owner or (unless owner) another admin.
    assert!(
        g.member
            .update_members(GROUP, &[], std::slice::from_ref(&admin_device), &listed)
            .is_err()
    );
    assert!(
        g.admin
            .update_members(GROUP, &[], &[owner_device], &listed)
            .is_err()
    );
    // When the server says someone left, any member completes the removal.
    let without_admin = ids(&[OWNER, MEMBER]);
    let left = g
        .member
        .update_members(GROUP, &[], &[admin_device], &without_admin)
        .unwrap();
    g.member.clear_pending(GROUP).unwrap();
    assert!(g.owner.process(GROUP, &left.commit, &listed).is_err());
    g.owner.clear_pending(GROUP).ok();
    // The owner removes the member; everyone else accepts it.
    let removed = g
        .owner
        .update_members(GROUP, &[], &[member_device], &listed)
        .unwrap();
    g.owner.merge_pending(GROUP, NOW).unwrap();
    g.admin
        .process(GROUP, &removed.commit, &ids(&[OWNER, ADMIN]))
        .unwrap();
    assert!(matches!(
        g.member
            .process(GROUP, &removed.commit, &ids(&[OWNER, ADMIN])),
        Ok(Processed::Commit {
            removed_self: true,
            ..
        })
    ));
}

#[test]
fn role_and_settings_changes_are_checked_by_every_member() {
    let mut g = group();
    let listed = ids(&[OWNER, ADMIN, MEMBER]);
    // Admin changes a setting: accepted.
    let settings = GroupPolicy {
        admins: vec![ADMIN.into()],
        announcements_only: true,
        ..GroupPolicy::new(OWNER)
    };
    let commit = g.admin.update_policy(GROUP, settings, &listed).unwrap();
    g.admin.merge_pending(GROUP, NOW).unwrap();
    g.owner.process(GROUP, &commit.commit, &listed).unwrap();
    g.member.process(GROUP, &commit.commit, &listed).unwrap();
    assert!(
        g.member
            .group_policy(GROUP)
            .unwrap()
            .unwrap()
            .announcements_only
    );

    // An admin cannot promote a member (only the owner changes roles), not even with a
    // forged commit that skips the local check.
    let promote = GroupPolicy {
        admins: vec![ADMIN.into(), MEMBER.into()],
        announcements_only: true,
        ..GroupPolicy::new(OWNER)
    };
    assert!(
        g.admin
            .update_policy(GROUP, promote.clone(), &listed)
            .is_err()
    );
    let mut group = g.admin.load_group(&parse_id(GROUP).unwrap()).unwrap();
    let forged = g
        .admin
        .commit(&mut group, vec![], vec![], vec![], false, Some(promote))
        .unwrap();
    assert!(matches!(
        g.owner.process(GROUP, &forged.commit, &listed),
        Err(CoreError::NotAllowed(_))
    ));
    assert!(matches!(
        g.member.process(GROUP, &forged.commit, &listed),
        Err(CoreError::NotAllowed(_))
    ));

    // Ownership transfer to the admin.
    g.admin.clear_pending(GROUP).unwrap();
    let transfer = GroupPolicy {
        owner: ADMIN.into(),
        admins: vec![OWNER.into()],
        announcements_only: true,
        ..GroupPolicy::new(ADMIN)
    };
    let commit = g.owner.update_policy(GROUP, transfer, &listed).unwrap();
    g.owner.merge_pending(GROUP, NOW).unwrap();
    g.admin.process(GROUP, &commit.commit, &listed).unwrap();
    g.member.process(GROUP, &commit.commit, &listed).unwrap();
    assert_eq!(g.member.group_policy(GROUP).unwrap().unwrap().owner, ADMIN);
}

#[test]
fn one_to_one_conversations_never_gain_a_policy() {
    let mut alice = Client::create(OWNER, 1, NOW).unwrap();
    let mut bob = Client::create(ADMIN, 1, NOW).unwrap();
    pin_all(&mut [&mut alice, &mut bob]);
    let package = bob.generate_key_packages(1, false).unwrap();
    let created = alice
        .create_group(GROUP, &package, &ids(&[ADMIN]), None, NOW)
        .unwrap();
    alice.merge_pending(GROUP, NOW).unwrap();
    bob.join(GROUP, &created.welcome.unwrap(), &ids(&[OWNER]), NOW)
        .unwrap();
    assert!(
        alice
            .update_policy(GROUP, GroupPolicy::new(OWNER), &ids(&[ADMIN]))
            .is_err()
    );
    let mut group = alice.load_group(&parse_id(GROUP).unwrap()).unwrap();
    let forged = alice
        .commit(
            &mut group,
            vec![],
            vec![],
            vec![],
            false,
            Some(GroupPolicy::new(OWNER)),
        )
        .unwrap();
    assert!(bob.process(GROUP, &forged.commit, &ids(&[OWNER])).is_err());
    // And only the creator can be the owner of a new group.
    assert!(
        alice
            .create_group(
                "0192f0c1-7a3b-7c4d-8e5f-0000000000bb",
                &[],
                &ids(&[]),
                Some(GroupPolicy::new(ADMIN)),
                NOW
            )
            .is_err()
    );
}

/// Exit criterion (docs/groups.md §7): timing of a 1,024-member group. Run with
/// `cargo test --release large_group -- --ignored --nocapture`.
#[test]
#[ignore]
fn large_group_timing() {
    use std::time::Instant;
    let size: usize = std::env::var("GROUP_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1024);
    let mut owner = Client::create(OWNER, 1, NOW).unwrap();
    let mut members: Vec<Client> = (1..size)
        .map(|i| Client::create(&format!("0192f0c2-0000-7000-8000-{i:012x}"), 1, NOW).unwrap())
        .collect();
    let directory: Vec<(String, [u8; 32])> =
        std::iter::once((owner.user_id(), owner.ask_public_key()))
            .chain(members.iter().map(|m| (m.user_id(), m.ask_public_key())))
            .collect();
    let listed: Vec<String> = directory.iter().map(|(u, _)| u.clone()).collect();
    for (user, key) in &directory[1..] {
        owner.observe_identity(user, key, 1).unwrap();
    }
    // Two members are measured: the joiner and the one that processes a later commit.
    for m in members.iter_mut().take(2) {
        for (user, key) in &directory {
            if *user != m.user_id() {
                m.observe_identity(user, key, 1).unwrap();
            }
        }
    }
    let packages: Vec<Vec<u8>> = members
        .iter()
        .map(|m| m.generate_key_packages(1, false).unwrap().remove(0))
        .collect();

    let started = Instant::now();
    let created = owner
        .create_group(
            GROUP,
            &packages,
            &listed,
            Some(GroupPolicy::new(OWNER)),
            NOW,
        )
        .unwrap();
    owner.merge_pending(GROUP, NOW).unwrap();
    let create_ms = started.elapsed().as_millis();
    let welcome = created.welcome.unwrap();

    let started = Instant::now();
    members[0].join(GROUP, &welcome, &listed, NOW).unwrap();
    let join_ms = started.elapsed().as_millis();
    members[1].join(GROUP, &welcome, &listed, NOW).unwrap();

    // A self-update (path commit) by one member, processed by another.
    let started = Instant::now();
    let update = members[0].self_update(GROUP).unwrap();
    members[0].merge_pending(GROUP, NOW).unwrap();
    let update_ms = started.elapsed().as_millis();
    let started = Instant::now();
    members[1].process(GROUP, &update.commit, &listed).unwrap();
    let process_ms = started.elapsed().as_millis();

    let message = members[1].encrypt(GROUP, b"hello everyone").unwrap();
    let started = Instant::now();
    members[0].process(GROUP, &message, &listed).unwrap();
    let decrypt_us = started.elapsed().as_micros();

    println!(
        "{size} members (native, release): create {create_ms} ms, welcome {} KiB, join+validate \
         {join_ms} ms, self-update {update_ms} ms ({} KiB), process commit {process_ms} ms, \
         decrypt {decrypt_us} us",
        welcome.len() / 1024,
        update.commit.len() / 1024,
        size = size
    );
}
