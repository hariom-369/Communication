//! Group roles and settings, carried end-to-end — docs/groups.md §2, ADR-044. Pending review S-12.
//!
//! The server stores roles to enforce its own API, but a malicious server could claim anything.
//! So the authoritative copy lives in the MLS **group context** as a private-use extension
//! (`0xF0A2`): every member agrees on it (it is part of the key schedule), every change is a
//! signed commit, and newly joined members receive it in the signed GroupInfo of their Welcome.
//!
//! Every client checks every commit against the policy *before* the commit:
//! - only the owner changes the owner or the admin list, or an admin when the owner has left;
//! - only admins (and the owner) change settings;
//! - adding a **user** who is not yet in the group needs an admin, unless members may add;
//! - removing a user entirely needs an admin (never the owner, and only the owner removes
//!   admins), unless the delivery service says that user left;
//! - adding or removing **devices** of users already in the group is always allowed (device
//!   lists follow each user's own signed device certificates).
//!
//! No new cryptography: this is MLS's own group-context agreement plus a policy check.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const POLICY_EXTENSION: u16 = 0xF0A2;
/// Largest E2EE group (users). Measured join cost is ~5 ms per member natively (1.3 s at 256,
/// 5.6 s at 1,024 — `large_group_timing`), so groups stop at 256 until that is profiled (ADR-044).
pub const MAX_GROUP_USERS: usize = 256;
const MAX_POLICY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupPolicy {
    pub v: u8,
    /// User id (lowercase UUID).
    pub owner: String,
    /// Admins other than the owner, sorted, without duplicates.
    pub admins: Vec<String>,
    pub members_can_add: bool,
    pub members_can_edit_info: bool,
    pub announcements_only: bool,
}

impl GroupPolicy {
    pub fn new(owner: &str) -> Self {
        Self {
            v: 1,
            owner: owner.to_lowercase(),
            admins: Vec::new(),
            members_can_add: false,
            members_can_edit_info: true,
            announcements_only: false,
        }
    }

    /// Canonical encoding (field order fixed by the struct; admins sorted).
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check()?;
        serde_json::to_vec(self).map_err(|_| CoreError::State("encode policy"))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_POLICY_BYTES {
            return Err(CoreError::Malformed("group policy size"));
        }
        let policy: Self =
            serde_json::from_slice(bytes).map_err(|_| CoreError::Malformed("group policy"))?;
        policy.check()?;
        Ok(policy)
    }

    fn check(&self) -> Result<()> {
        let is_id = |s: &str| {
            s.len() == 36
                && s.chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
        };
        if self.v != 1 || !is_id(&self.owner) {
            return Err(CoreError::Malformed("group policy"));
        }
        if self.admins.len() >= MAX_GROUP_USERS
            || !self.admins.iter().all(|a| is_id(a))
            || !self.admins.windows(2).all(|w| w[0] < w[1])
            || self.admins.contains(&self.owner)
        {
            return Err(CoreError::Malformed("group policy admins"));
        }
        Ok(())
    }

    pub fn is_admin(&self, user: &str) -> bool {
        self.owner == user || self.admins.iter().any(|a| a == user)
    }

    pub fn can_add_users(&self, user: &str) -> bool {
        self.members_can_add || self.is_admin(user)
    }

    /// Normalises (sorts, dedups, drops the owner from) the admin list.
    pub fn normalised(mut self) -> Self {
        self.owner = self.owner.to_lowercase();
        let mut admins: Vec<String> = self.admins.iter().map(|a| a.to_lowercase()).collect();
        admins.sort();
        admins.dedup();
        admins.retain(|a| *a != self.owner);
        self.admins = admins;
        self
    }
}

/// What a commit does, in user terms (computed from the commit before it is merged).
pub struct CommitEffect<'a> {
    pub committer: &'a str,
    /// Users who had no device in the group before and gain one.
    pub new_users: BTreeSet<String>,
    /// Users who had devices before and have none afterwards.
    pub removed_users: BTreeSet<String>,
    /// The new policy, if the commit changes the group context.
    pub new_policy: Option<GroupPolicy>,
}

/// Checks a commit against the policy in force before it. `still_listed` says whether the
/// delivery service still lists a user as a member (a user who left is removed by anyone).
pub fn authorize(
    old: &GroupPolicy,
    effect: &CommitEffect<'_>,
    still_listed: impl Fn(&str) -> bool,
) -> Result<()> {
    let committer = effect.committer;
    if !effect.new_users.is_empty() && !old.can_add_users(committer) {
        return Err(CoreError::NotAllowed("only admins can add people".into()));
    }
    for removed in &effect.removed_users {
        if !still_listed(removed) || removed == committer {
            continue; // left the conversation (or leaving): any member completes it
        }
        if removed == &old.owner {
            return Err(CoreError::NotAllowed("the owner cannot be removed".into()));
        }
        let allowed = if old.admins.contains(removed) {
            committer == old.owner
        } else {
            old.is_admin(committer)
        };
        if !allowed {
            return Err(CoreError::NotAllowed(
                "not allowed to remove this member".into(),
            ));
        }
    }
    if let Some(new) = &effect.new_policy {
        if new == old {
            return Ok(());
        }
        if !old.is_admin(committer) {
            return Err(CoreError::NotAllowed(
                "only admins can change the group".into(),
            ));
        }
        let roles_changed = new.owner != old.owner || new.admins != old.admins;
        if roles_changed {
            let owner_gone = !still_listed(&old.owner);
            let by_owner = committer == old.owner;
            if !(by_owner || owner_gone) {
                return Err(CoreError::NotAllowed("only the owner changes roles".into()));
            }
            // Ownership goes to an existing admin (or the owner keeps it).
            if new.owner != old.owner && !old.admins.contains(&new.owner) {
                return Err(CoreError::NotAllowed(
                    "the new owner must be an admin".into(),
                ));
            }
            // When the owner left, an admin may only promote an admin to owner (no other edits).
            if !by_owner {
                let mut expected = old.admins.clone();
                expected.retain(|a| *a != new.owner);
                if new.admins != expected {
                    return Err(CoreError::NotAllowed(
                        "only the owner changes admins".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0192f0c1-0000-7000-8000-00000000000a";
    const ADMIN: &str = "0192f0c1-0000-7000-8000-00000000000b";
    const MEMBER: &str = "0192f0c1-0000-7000-8000-00000000000c";
    const OTHER: &str = "0192f0c1-0000-7000-8000-00000000000d";

    fn policy() -> GroupPolicy {
        GroupPolicy {
            admins: vec![ADMIN.into()],
            ..GroupPolicy::new(OWNER)
        }
    }

    fn effect<'a>(committer: &'a str) -> CommitEffect<'a> {
        CommitEffect {
            committer,
            new_users: BTreeSet::new(),
            removed_users: BTreeSet::new(),
            new_policy: None,
        }
    }

    #[test]
    fn encoding_is_canonical_and_strict() {
        let encoded = policy().encode().unwrap();
        assert_eq!(GroupPolicy::decode(&encoded).unwrap(), policy());
        assert!(GroupPolicy::decode(b"{\"v\":1}").is_err());
        let mut unsorted = policy();
        unsorted.admins = vec![OTHER.into(), ADMIN.into()];
        assert!(unsorted.encode().is_err());
        assert_eq!(
            unsorted.normalised().admins,
            vec![ADMIN.to_string(), OTHER.to_string()]
        );
        let extra = String::from_utf8(encoded)
            .unwrap()
            .replace("\"v\":1", "\"v\":1,\"x\":1");
        assert!(GroupPolicy::decode(extra.as_bytes()).is_err());
    }

    #[test]
    fn the_permission_matrix_holds() {
        let p = policy();
        let listed = |_: &str| true;
        // Adding people.
        for (committer, ok) in [(OWNER, true), (ADMIN, true), (MEMBER, false)] {
            let mut e = effect(committer);
            e.new_users.insert(OTHER.into());
            assert_eq!(authorize(&p, &e, listed).is_ok(), ok, "add by {committer}");
        }
        let open = GroupPolicy {
            members_can_add: true,
            ..policy()
        };
        let mut e = effect(MEMBER);
        e.new_users.insert(OTHER.into());
        assert!(authorize(&open, &e, listed).is_ok());

        // Removing people: admins remove members; only the owner removes admins; nobody the owner.
        for (committer, target, ok) in [
            (OWNER, MEMBER, true),
            (ADMIN, MEMBER, true),
            (MEMBER, OTHER, false),
            (ADMIN, ADMIN, true), // an admin leaving
            (OWNER, ADMIN, true),
            (MEMBER, ADMIN, false),
            (ADMIN, OWNER, false),
        ] {
            let mut e = effect(committer);
            e.removed_users.insert(target.into());
            assert_eq!(
                authorize(&p, &e, listed).is_ok(),
                ok,
                "{committer} removes {target}"
            );
        }
        // Someone who left (per the delivery service) may be removed by anyone.
        let mut e = effect(MEMBER);
        e.removed_users.insert(OTHER.into());
        assert!(authorize(&p, &e, |u| u != OTHER).is_ok());

        // Settings: admins only.
        for (committer, ok) in [(OWNER, true), (ADMIN, true), (MEMBER, false)] {
            let mut e = effect(committer);
            e.new_policy = Some(GroupPolicy {
                announcements_only: true,
                ..policy()
            });
            assert_eq!(
                authorize(&p, &e, listed).is_ok(),
                ok,
                "settings by {committer}"
            );
        }
        // Roles: owner only.
        let promoted = GroupPolicy {
            admins: vec![ADMIN.into(), MEMBER.into()],
            ..policy()
        };
        for (committer, ok) in [(OWNER, true), (ADMIN, false), (MEMBER, false)] {
            let mut e = effect(committer);
            e.new_policy = Some(promoted.clone().normalised());
            assert_eq!(
                authorize(&p, &e, listed).is_ok(),
                ok,
                "roles by {committer}"
            );
        }
        // Ownership transfer: only to an admin.
        let mut e = effect(OWNER);
        e.new_policy = Some(
            GroupPolicy {
                owner: ADMIN.into(),
                admins: vec![OWNER.into()],
                ..policy()
            }
            .normalised(),
        );
        assert!(authorize(&p, &e, listed).is_ok());
        let mut e = effect(OWNER);
        e.new_policy = Some(
            GroupPolicy {
                owner: MEMBER.into(),
                ..policy()
            }
            .normalised(),
        );
        assert!(authorize(&p, &e, listed).is_err());
        // Owner gone: an admin may take ownership, and change nothing else.
        let owner_left = |u: &str| u != OWNER;
        let mut e = effect(ADMIN);
        e.new_policy = Some(GroupPolicy {
            owner: ADMIN.into(),
            admins: vec![],
            ..policy()
        });
        assert!(authorize(&p, &e, owner_left).is_ok());
        let mut e = effect(ADMIN);
        e.new_policy = Some(GroupPolicy {
            owner: ADMIN.into(),
            admins: vec![MEMBER.into()],
            ..policy()
        });
        assert!(authorize(&p, &e, owner_left).is_err());
    }
}
