//! Device-side MLS client: identity, trust pins, KeyPackages and conversation groups.
//!
//! This is orchestration only. Every cryptographic operation is performed by OpenMLS
//! (RFC 9420) with the RustCrypto provider, or by `ed25519-dalek` for certificates.
//!
//! Trust model (ADR-007): a group member (leaf) is accepted only if its credential names
//! `user_id || device_id`, it carries a device certificate for exactly that device and leaf
//! signature key, and the certificate verifies under the user's **pinned** Account Signing Key.
//! Pins are trust-on-first-use; a changed key is recorded, unverifies the contact and is surfaced
//! to the user (docs/e2ee.md §9).

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use openmls::framing::errors::{MessageDecryptionError, SecretTreeError};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::random::OpenMlsRand;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::identity::{AccountKey, CertificateBody, DeviceCertificate};
use crate::ids::{Id, format_id, parse_id};
use crate::padding;
use crate::safety;

/// Baseline, mandatory-to-implement suite (crypto-design §2). The X-Wing hybrid suite waits on S-02.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
/// Wire value of `CIPHERSUITE`, as recorded by the server.
pub const CIPHERSUITE_ID: u16 = 0x0001;
/// Leaf-node extension carrying the device certificate (MLS private-use range 0xF000–0xFFFF).
pub const CERT_EXTENSION: u16 = 0xF0A1;
/// KeyPackage lifetime (crypto-design §4).
const KEY_PACKAGE_LIFETIME_SECONDS: u64 = 30 * 24 * 3600;
/// Self-update schedule for post-compromise security (crypto-design §6).
const UPDATE_AFTER_SECONDS: u64 = 7 * 24 * 3600;
const UPDATE_AFTER_MESSAGES: u32 = 100;
/// Out-of-order window and forward distance (crypto-design §6).
const OUT_OF_ORDER_TOLERANCE: u32 = 200;
const MAXIMUM_FORWARD_DISTANCE: u32 = 1000;
const MAX_PAST_EPOCHS: usize = 2;
/// Upper bound on any inbound MLS message; the server enforces 64 KiB, allow framing slack.
const MAX_MESSAGE_BYTES: usize = 70 * 1024;

const SNAPSHOT_MAGIC: &[u8; 4] = b"TSC\x01";
const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    /// Base64 Ed25519 public key.
    pub key: String,
    pub version: u32,
    /// The user compared safety numbers and marked this contact verified.
    pub verified: bool,
    /// The key changed since the user last acknowledged it.
    pub changed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupMeta {
    last_update_at: u64,
    sent_since_update: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    version: u32,
    user_id: String,
    device_id: String,
    ask_secret: String,
    ask_version: u32,
    signature_public_key: String,
    certificate: String,
    pins: BTreeMap<String, Pin>,
    groups: BTreeMap<String, GroupMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityObservation {
    New,
    Unchanged,
    Changed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRef {
    pub user_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutput {
    /// MLS PublicMessage (signed, not encrypted) for the delivery service to order.
    pub commit: Vec<u8>,
    /// Welcome for newly added devices, if any.
    pub welcome: Option<Vec<u8>>,
    pub welcome_targets: Vec<DeviceRef>,
    /// The epoch the commit applies to (the group's epoch before merging).
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Processed {
    Application {
        plaintext: Vec<u8>,
        sender_user_id: String,
        sender_device_id: String,
    },
    Commit {
        epoch: u64,
        removed_self: bool,
    },
}

pub struct Client {
    provider: OpenMlsRustCrypto,
    user_id: Id,
    device_id: Id,
    ask: AccountKey,
    signer: SignatureKeyPair,
    certificate: DeviceCertificate,
    pins: BTreeMap<Id, Pin>,
    groups: BTreeMap<Id, GroupMeta>,
}

fn mls<E>(what: &'static str) -> impl FnOnce(E) -> CoreError {
    move |_| CoreError::Mls(what)
}

fn decode_b64(value: &str, what: &'static str) -> Result<Vec<u8>> {
    B64.decode(value).map_err(|_| CoreError::State(what))
}

fn key32(bytes: &[u8], what: &'static str) -> Result<[u8; 32]> {
    bytes.try_into().map_err(|_| CoreError::Malformed(what))
}

fn identity_bytes(user_id: &Id, device_id: &Id) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(user_id);
    out.extend_from_slice(device_id);
    out
}

fn split_identity(credential: &Credential) -> Result<(Id, Id)> {
    if credential.credential_type() != CredentialType::Basic {
        return Err(CoreError::Untrusted("credential type"));
    }
    let content = credential.serialized_content();
    if content.len() != 32 {
        return Err(CoreError::Untrusted("credential identity"));
    }
    let mut user = [0u8; 16];
    let mut device = [0u8; 16];
    user.copy_from_slice(&content[..16]);
    device.copy_from_slice(&content[16..]);
    Ok((user, device))
}

fn group_id(conversation: &Id) -> GroupId {
    GroupId::from_slice(conversation)
}

fn capabilities() -> Capabilities {
    Capabilities::new(
        None,
        Some(&[CIPHERSUITE]),
        Some(&[ExtensionType::Unknown(CERT_EXTENSION)]),
        None,
        Some(&[CredentialType::Basic]),
    )
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .wire_format_policy(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY)
        .sender_ratchet_configuration(SenderRatchetConfiguration::new(
            OUT_OF_ORDER_TOLERANCE,
            MAXIMUM_FORWARD_DISTANCE,
        ))
        .max_past_epochs(MAX_PAST_EPOCHS)
        .use_ratchet_tree_extension(true)
        .build()
}

fn map_process_error<E>(error: ProcessMessageError<E>) -> CoreError {
    match error {
        ProcessMessageError::ValidationError(ValidationError::WrongEpoch)
        | ProcessMessageError::ValidationError(ValidationError::NoPastEpochData) => {
            CoreError::WrongEpoch
        }
        ProcessMessageError::ValidationError(ValidationError::WrongGroupId) => {
            CoreError::Malformed("group id")
        }
        // Keys for this generation were already used and deleted: a replay or duplicate.
        ProcessMessageError::ValidationError(ValidationError::UnableToDecrypt(
            MessageDecryptionError::SecretTreeError(SecretTreeError::SecretReuseError),
        )) => CoreError::Duplicate,
        // Older than the retained past-epoch window: forward secrecy deleted the keys.
        ProcessMessageError::ValidationError(ValidationError::UnableToDecrypt(
            MessageDecryptionError::SecretTreeError(SecretTreeError::TooDistantInThePast),
        )) => CoreError::WrongEpoch,
        ProcessMessageError::ValidationError(_) => CoreError::Untrusted("message validation"),
        ProcessMessageError::InvalidCommit(_) => CoreError::Untrusted("commit validation"),
        _ => CoreError::Mls("process message"),
    }
}

impl Client {
    /// Creates a new device identity with a fresh Account Signing Key (first device, or an
    /// identity reset). `ask_version` is the server-assigned version for the new key.
    pub fn create(user_id: &str, ask_version: u32, now: u64) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        let user_id = parse_id(user_id)?;
        // UUIDv7 (RFC 9562, ADR-028): 48-bit Unix milliseconds, then random bits.
        let mut device_id: Id = provider.rand().random_array().map_err(mls("random"))?;
        device_id[..6].copy_from_slice(&now.saturating_mul(1000).to_be_bytes()[2..]);
        device_id[6] = (device_id[6] & 0x0f) | 0x70;
        device_id[8] = (device_id[8] & 0x3f) | 0x80;
        let seed: [u8; 32] = provider.rand().random_array().map_err(mls("random"))?;
        let ask = AccountKey::from_seed(Zeroizing::new(seed), ask_version);
        let signer =
            SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls("keygen"))?;
        signer.store(provider.storage()).map_err(mls("storage"))?;
        let certificate = ask.certify(CertificateBody {
            user_id,
            device_id,
            mls_signature_key: key32(signer.public(), "signature key")?,
            ask_version,
            created_at: now,
            ciphersuites: vec![CIPHERSUITE_ID],
        });
        let mut pins = BTreeMap::new();
        pins.insert(
            user_id,
            Pin {
                key: B64.encode(ask.public_key()),
                version: ask_version,
                verified: true,
                changed: false,
            },
        );
        Ok(Self {
            provider,
            user_id,
            device_id,
            ask,
            signer,
            certificate,
            pins,
            groups: BTreeMap::new(),
        })
    }

    // ---------------------------------------------------------------- persistence

    /// Serialises the complete state (identity, pins, MLS storage). The caller must encrypt it
    /// before it leaves memory (docs/crypto-design.md §10).
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let state = PersistedState {
            version: STATE_VERSION,
            user_id: format_id(&self.user_id),
            device_id: format_id(&self.device_id),
            ask_secret: B64.encode(*self.ask.secret_bytes()),
            ask_version: self.ask.version,
            signature_public_key: B64.encode(self.signer.public()),
            certificate: B64.encode(self.certificate.encode()),
            pins: self
                .pins
                .iter()
                .map(|(k, v)| (format_id(k), v.clone()))
                .collect(),
            groups: self
                .groups
                .iter()
                .map(|(k, v)| (format_id(k), v.clone()))
                .collect(),
        };
        let json =
            Zeroizing::new(serde_json::to_vec(&state).map_err(|_| CoreError::State("encode"))?);
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| CoreError::State("lock"))?;
        let mut entries: Vec<(&Vec<u8>, &Vec<u8>)> = values.iter().collect();
        entries.sort();
        let mut out = Vec::with_capacity(json.len() + 64);
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.extend_from_slice(&(json.len() as u32).to_be_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (key, value) in entries {
            out.extend_from_slice(&(key.len() as u32).to_be_bytes());
            out.extend_from_slice(&(value.len() as u32).to_be_bytes());
            out.extend_from_slice(key);
            out.extend_from_slice(value);
        }
        Ok(out)
    }

    pub fn restore(bytes: &[u8]) -> Result<Self> {
        let mut cursor = bytes;
        let mut take = |count: usize| -> Result<&[u8]> {
            if cursor.len() < count {
                return Err(CoreError::State("truncated"));
            }
            let (head, tail) = cursor.split_at(count);
            cursor = tail;
            Ok(head)
        };
        if take(4)? != SNAPSHOT_MAGIC {
            return Err(CoreError::State("format"));
        }
        let read_u32 = |bytes: &[u8]| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let json_len = read_u32(take(4)?) as usize;
        let state: PersistedState =
            serde_json::from_slice(take(json_len)?).map_err(|_| CoreError::State("decode"))?;
        if state.version != STATE_VERSION {
            return Err(CoreError::State("version"));
        }
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| CoreError::State("lock"))?;
            let count = read_u32(take(4)?);
            for _ in 0..count {
                let key_len = read_u32(take(4)?) as usize;
                let value_len = read_u32(take(4)?) as usize;
                let key = take(key_len)?.to_vec();
                let value = take(value_len)?.to_vec();
                values.insert(key, value);
            }
        }
        if !cursor.is_empty() {
            return Err(CoreError::State("trailing bytes"));
        }
        let seed = Zeroizing::new(key32(&decode_b64(&state.ask_secret, "ask")?, "ask")?);
        let ask = AccountKey::from_seed(seed, state.ask_version);
        let public = decode_b64(&state.signature_public_key, "signature key")?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &public,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or(CoreError::State("signature key missing"))?;
        let certificate =
            DeviceCertificate::decode(&decode_b64(&state.certificate, "certificate")?)?;
        let mut pins = BTreeMap::new();
        for (user, pin) in state.pins {
            pins.insert(parse_id(&user)?, pin);
        }
        let mut groups = BTreeMap::new();
        for (conversation, meta) in state.groups {
            groups.insert(parse_id(&conversation)?, meta);
        }
        Ok(Self {
            provider,
            user_id: parse_id(&state.user_id)?,
            device_id: parse_id(&state.device_id)?,
            ask,
            signer,
            certificate,
            pins,
            groups,
        })
    }

    // ---------------------------------------------------------------- identity

    pub fn user_id(&self) -> String {
        format_id(&self.user_id)
    }

    pub fn device_id(&self) -> String {
        format_id(&self.device_id)
    }

    pub fn ask_public_key(&self) -> [u8; 32] {
        self.ask.public_key()
    }

    pub fn ask_version(&self) -> u32 {
        self.ask.version
    }

    pub fn certificate(&self) -> Vec<u8> {
        self.certificate.encode()
    }

    /// Records the Account Signing Key the server reports for a user (TOFU pinning).
    pub fn observe_identity(
        &mut self,
        user_id: &str,
        public_key: &[u8],
        version: u32,
    ) -> Result<IdentityObservation> {
        let user = parse_id(user_id)?;
        let key = key32(public_key, "account key")?;
        // Reject keys that could never verify a signature before pinning them.
        ed25519_dalek::VerifyingKey::from_bytes(&key)
            .map_err(|_| CoreError::Untrusted("account key"))?;
        let encoded = B64.encode(key);
        if user == self.user_id && encoded != B64.encode(self.ask.public_key()) {
            // Our own identity is authoritative locally; a different server value is an attack
            // or a reset performed elsewhere, never something to adopt silently.
            return Err(CoreError::Untrusted("own account key mismatch"));
        }
        match self.pins.get_mut(&user) {
            None => {
                self.pins.insert(
                    user,
                    Pin {
                        key: encoded,
                        version,
                        verified: false,
                        changed: false,
                    },
                );
                Ok(IdentityObservation::New)
            }
            Some(pin) if pin.key == encoded => {
                pin.version = version;
                Ok(IdentityObservation::Unchanged)
            }
            Some(pin) => {
                *pin = Pin {
                    key: encoded,
                    version,
                    verified: false,
                    changed: true,
                };
                Ok(IdentityObservation::Changed)
            }
        }
    }

    pub fn pin(&self, user_id: &str) -> Result<Option<Pin>> {
        Ok(self.pins.get(&parse_id(user_id)?).cloned())
    }

    /// The user compared safety numbers (or scanned the QR code) and confirms, or withdraws.
    pub fn set_verified(&mut self, user_id: &str, verified: bool) -> Result<()> {
        let pin = self
            .pins
            .get_mut(&parse_id(user_id)?)
            .ok_or_else(|| CoreError::UnknownIdentity(user_id.to_owned()))?;
        pin.verified = verified;
        if verified {
            pin.changed = false;
        }
        Ok(())
    }

    /// The user saw the key-change warning and chose to continue.
    pub fn acknowledge_change(&mut self, user_id: &str) -> Result<()> {
        let pin = self
            .pins
            .get_mut(&parse_id(user_id)?)
            .ok_or_else(|| CoreError::UnknownIdentity(user_id.to_owned()))?;
        pin.changed = false;
        Ok(())
    }

    pub fn safety_number(&self, peer_user_id: &str) -> Result<safety::SafetyNumber> {
        let peer = parse_id(peer_user_id)?;
        let pin = self
            .pins
            .get(&peer)
            .ok_or_else(|| CoreError::UnknownIdentity(peer_user_id.to_owned()))?;
        let key = key32(&decode_b64(&pin.key, "pin")?, "pin")?;
        Ok(safety::safety_number(
            (&self.user_id, &self.ask.public_key()),
            (&peer, &key),
        ))
    }

    // ---------------------------------------------------------------- key packages

    fn credential_with_key(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: BasicCredential::new(identity_bytes(&self.user_id, &self.device_id)).into(),
            signature_key: self.signer.to_public_vec().into(),
        }
    }

    fn leaf_extensions(&self) -> Result<Extensions<LeafNode>> {
        Extensions::single(Extension::Unknown(
            CERT_EXTENSION,
            UnknownExtension(self.certificate.encode()),
        ))
        .map_err(mls("leaf extensions"))
    }

    /// One-time KeyPackages (or the last-resort one) for upload (crypto-design §4).
    pub fn generate_key_packages(&self, count: usize, last_resort: bool) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let mut builder = KeyPackage::builder()
                .leaf_node_capabilities(capabilities())
                .leaf_node_extensions(self.leaf_extensions()?)
                .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS));
            if last_resort {
                builder = builder.mark_as_last_resort();
            }
            let bundle = builder
                .build(
                    CIPHERSUITE,
                    &self.provider,
                    &self.signer,
                    self.credential_with_key(),
                )
                .map_err(mls("key package"))?;
            out.push(
                bundle
                    .key_package()
                    .tls_serialize_detached()
                    .map_err(mls("key package encode"))?,
            );
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- trust checks

    /// Validates one group member (docs/crypto-design.md §3.2).
    fn validate_leaf(&self, leaf: &LeafNode, allowed: &BTreeSet<Id>) -> Result<(Id, Id)> {
        let (user, device) = split_identity(leaf.credential())?;
        if !allowed.contains(&user) {
            return Err(CoreError::NotAllowed(format_id(&user)));
        }
        let pin = self
            .pins
            .get(&user)
            .ok_or_else(|| CoreError::UnknownIdentity(format_id(&user)))?;
        let extension = leaf
            .extensions()
            .unknown(CERT_EXTENSION)
            .ok_or(CoreError::Untrusted("missing device certificate"))?;
        let certificate = DeviceCertificate::decode(&extension.0)?;
        if certificate.body.user_id != user || certificate.body.device_id != device {
            return Err(CoreError::Untrusted("certificate identity"));
        }
        if certificate.body.mls_signature_key.as_slice() != leaf.signature_key().as_slice() {
            return Err(CoreError::Untrusted("certificate signature key"));
        }
        if certificate.body.ask_version != pin.version {
            return Err(CoreError::Untrusted("certificate account key version"));
        }
        certificate.verify(&key32(&decode_b64(&pin.key, "pin")?, "pin")?)?;
        Ok((user, device))
    }

    fn validate_key_package(
        &self,
        bytes: &[u8],
        allowed: &BTreeSet<Id>,
    ) -> Result<(KeyPackage, DeviceRef)> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(CoreError::Malformed("key package size"));
        }
        let key_package = KeyPackageIn::tls_deserialize_exact(bytes)
            .map_err(|_| CoreError::Malformed("key package"))?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| CoreError::Untrusted("key package signature"))?;
        if key_package.ciphersuite() != CIPHERSUITE {
            return Err(CoreError::Untrusted("key package ciphersuite"));
        }
        let (user, device) = self.validate_leaf(key_package.leaf_node(), allowed)?;
        Ok((
            key_package,
            DeviceRef {
                user_id: format_id(&user),
                device_id: format_id(&device),
            },
        ))
    }

    fn parse_allowed(&self, allowed: &[String]) -> Result<BTreeSet<Id>> {
        let mut set = BTreeSet::new();
        for user in allowed {
            set.insert(parse_id(user)?);
        }
        set.insert(self.user_id);
        Ok(set)
    }

    fn validate_group_members(&self, group: &MlsGroup, allowed: &BTreeSet<Id>) -> Result<()> {
        for member in group.members() {
            let leaf = group
                .public_group()
                .leaf(member.index)
                .ok_or(CoreError::Untrusted("missing leaf"))?;
            self.validate_leaf(leaf, allowed)?;
        }
        Ok(())
    }

    fn load_group(&self, conversation: &Id) -> Result<MlsGroup> {
        MlsGroup::load(self.provider.storage(), &group_id(conversation))
            .map_err(mls("load group"))?
            .ok_or(CoreError::NoGroup)
    }

    // ---------------------------------------------------------------- groups

    pub fn has_group(&self, conversation_id: &str) -> Result<bool> {
        Ok(MlsGroup::load(
            self.provider.storage(),
            &group_id(&parse_id(conversation_id)?),
        )
        .map_err(mls("load group"))?
        .is_some())
    }

    pub fn epoch(&self, conversation_id: &str) -> Result<u64> {
        Ok(self
            .load_group(&parse_id(conversation_id)?)?
            .epoch()
            .as_u64())
    }

    /// Current members as (user, device) pairs.
    pub fn members(&self, conversation_id: &str) -> Result<Vec<DeviceRef>> {
        let group = self.load_group(&parse_id(conversation_id)?)?;
        group
            .members()
            .map(|member| {
                let (user, device) = split_identity(&member.credential)?;
                Ok(DeviceRef {
                    user_id: format_id(&user),
                    device_id: format_id(&device),
                })
            })
            .collect()
    }

    /// Creates the conversation's group and adds the given devices (one validated KeyPackage
    /// each). The returned commit is pending until `merge_pending` (server accepted it) or
    /// `discard_group` (another device created the group first).
    pub fn create_group(
        &mut self,
        conversation_id: &str,
        key_packages: &[Vec<u8>],
        allowed_users: &[String],
        now: u64,
    ) -> Result<CommitOutput> {
        let conversation = parse_id(conversation_id)?;
        if self.has_group(conversation_id)? {
            return Err(CoreError::GroupExists);
        }
        let allowed = self.parse_allowed(allowed_users)?;
        let mut packages = Vec::with_capacity(key_packages.len());
        let mut targets = Vec::with_capacity(key_packages.len());
        for bytes in key_packages {
            let (package, target) = self.validate_key_package(bytes, &allowed)?;
            packages.push(package);
            targets.push(target);
        }
        let mut group = MlsGroup::builder()
            .with_group_id(group_id(&conversation))
            .ciphersuite(CIPHERSUITE)
            .with_wire_format_policy(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(
                OUT_OF_ORDER_TOLERANCE,
                MAXIMUM_FORWARD_DISTANCE,
            ))
            .max_past_epochs(MAX_PAST_EPOCHS)
            .use_ratchet_tree_extension(true)
            .with_capabilities(capabilities())
            .with_leaf_node_extensions(self.leaf_extensions()?)
            .map_err(mls("leaf extensions"))?
            .build(&self.provider, &self.signer, self.credential_with_key())
            .map_err(mls("create group"))?;
        self.groups.insert(
            conversation,
            GroupMeta {
                last_update_at: now,
                sent_since_update: 0,
            },
        );
        if packages.is_empty() {
            return Ok(CommitOutput {
                commit: Vec::new(),
                welcome: None,
                welcome_targets: Vec::new(),
                epoch: 0,
            });
        }
        self.commit(&mut group, packages, Vec::new(), targets, false)
    }

    fn commit(
        &self,
        group: &mut MlsGroup,
        adds: Vec<KeyPackage>,
        removals: Vec<LeafNodeIndex>,
        targets: Vec<DeviceRef>,
        force_self_update: bool,
    ) -> Result<CommitOutput> {
        let epoch = group.epoch().as_u64();
        let bundle = group
            .commit_builder()
            .propose_adds(adds)
            .propose_removals(removals)
            .force_self_update(force_self_update)
            .load_psks(self.provider.storage())
            .map_err(mls("commit psks"))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(mls("commit build"))?
            .stage_commit(&self.provider)
            .map_err(mls("commit stage"))?;
        let (commit, welcome, _) = bundle.into_messages();
        Ok(CommitOutput {
            commit: commit.to_bytes().map_err(mls("commit encode"))?,
            welcome: welcome
                .map(|w| w.to_bytes())
                .transpose()
                .map_err(mls("welcome encode"))?,
            welcome_targets: targets,
            epoch,
        })
    }

    /// The delivery service accepted our pending commit.
    pub fn merge_pending(&mut self, conversation_id: &str, now: u64) -> Result<u64> {
        let conversation = parse_id(conversation_id)?;
        let mut group = self.load_group(&conversation)?;
        if group.pending_commit().is_none() {
            return Ok(group.epoch().as_u64());
        }
        let had_path = group
            .pending_commit()
            .map(|commit| commit.update_path_leaf_node().is_some())
            .unwrap_or(false);
        group
            .merge_pending_commit(&self.provider)
            .map_err(mls("merge commit"))?;
        if had_path {
            self.groups.insert(
                conversation,
                GroupMeta {
                    last_update_at: now,
                    sent_since_update: 0,
                },
            );
        }
        Ok(group.epoch().as_u64())
    }

    /// The delivery service rejected our pending commit (another commit won the epoch).
    pub fn clear_pending(&mut self, conversation_id: &str) -> Result<()> {
        let mut group = self.load_group(&parse_id(conversation_id)?)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(mls("clear commit"))
    }

    /// Deletes the local group (e.g. our creation lost the race, or we were removed).
    pub fn discard_group(&mut self, conversation_id: &str) -> Result<()> {
        let conversation = parse_id(conversation_id)?;
        if let Ok(mut group) = self.load_group(&conversation) {
            group
                .delete(self.provider.storage())
                .map_err(mls("delete group"))?;
        }
        self.groups.remove(&conversation);
        Ok(())
    }

    /// Joins from a Welcome after validating every member against pinned identities.
    pub fn join(
        &mut self,
        conversation_id: &str,
        welcome: &[u8],
        allowed_users: &[String],
        now: u64,
    ) -> Result<u64> {
        let conversation = parse_id(conversation_id)?;
        if welcome.len() > MAX_MESSAGE_BYTES {
            return Err(CoreError::Malformed("welcome size"));
        }
        if self.has_group(conversation_id)? {
            return Err(CoreError::GroupExists);
        }
        let allowed = self.parse_allowed(allowed_users)?;
        let message = MlsMessageIn::tls_deserialize_exact(welcome)
            .map_err(|_| CoreError::Malformed("welcome"))?;
        let welcome = match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(CoreError::Malformed("not a welcome")),
        };
        let staged = StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome, None)
            .map_err(|_| CoreError::Untrusted("welcome"))?;
        let mut group = staged
            .into_group(&self.provider)
            .map_err(|_| CoreError::Untrusted("welcome"))?;
        let checks = (|| {
            if group.group_id() != &group_id(&conversation) {
                return Err(CoreError::Untrusted("welcome group id"));
            }
            if group.ciphersuite() != CIPHERSUITE {
                return Err(CoreError::Untrusted("welcome ciphersuite"));
            }
            self.validate_group_members(&group, &allowed)
        })();
        if let Err(error) = checks {
            // Never keep state for a group we do not trust.
            let _ = group.delete(self.provider.storage());
            return Err(error);
        }
        self.groups.insert(
            conversation,
            GroupMeta {
                last_update_at: now,
                sent_since_update: 0,
            },
        );
        Ok(group.epoch().as_u64())
    }

    /// Encrypts padded application content (MLS PrivateMessage).
    pub fn encrypt(&mut self, conversation_id: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
        let conversation = parse_id(conversation_id)?;
        let mut group = self.load_group(&conversation)?;
        if group.pending_commit().is_some() {
            return Err(CoreError::State("pending commit"));
        }
        let padded = Zeroizing::new(padding::pad(plaintext)?);
        let message = group
            .create_message(&self.provider, &self.signer, &padded)
            .map_err(mls("encrypt"))?;
        self.groups
            .entry(conversation)
            .or_default()
            .sent_since_update += 1;
        message.to_bytes().map_err(mls("encode"))
    }

    /// Processes one inbound message in delivery-service order.
    pub fn process(
        &mut self,
        conversation_id: &str,
        bytes: &[u8],
        allowed_users: &[String],
    ) -> Result<Processed> {
        let conversation = parse_id(conversation_id)?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(CoreError::Malformed("message size"));
        }
        let allowed = self.parse_allowed(allowed_users)?;
        let mut group = self.load_group(&conversation)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|_| CoreError::Malformed("message"))?;
        let protocol = message
            .try_into_protocol_message()
            .map_err(|_| CoreError::Malformed("not a group message"))?;
        if protocol.group_id() != &group_id(&conversation) {
            return Err(CoreError::Malformed("group id"));
        }
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(map_process_error)?;
        if matches!(
            processed.content(),
            ProcessedMessageContent::OwnPrivateMessage
        ) {
            return Err(CoreError::OwnMessage);
        }
        let (sender_user, sender_device) = split_identity(processed.credential())?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                // Members were validated when they joined; a non-allowed sender means the
                // conversation's membership changed underneath us.
                if !allowed.contains(&sender_user) {
                    return Err(CoreError::NotAllowed(format_id(&sender_user)));
                }
                let plaintext = padding::unpad(&application.into_bytes())?;
                Ok(Processed::Application {
                    plaintext,
                    sender_user_id: format_id(&sender_user),
                    sender_device_id: format_id(&sender_device),
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) if staged.self_removed() => {
                // We were removed: drop the group without adopting anything from the commit
                // (no trust decision is needed for state we will never use).
                let epoch = staged.epoch().as_u64();
                let _ = group.delete(self.provider.storage());
                self.groups.remove(&conversation);
                Ok(Processed::Commit {
                    epoch,
                    removed_self: true,
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                // Every leaf the commit introduces or changes must chain to a pinned identity.
                for add in staged.add_proposals() {
                    self.validate_leaf(add.add_proposal().key_package().leaf_node(), &allowed)?;
                }
                for update in staged.update_proposals() {
                    self.validate_leaf(update.update_proposal().leaf_node(), &allowed)?;
                }
                if let Some(leaf) = staged.update_path_leaf_node() {
                    self.validate_leaf(leaf, &allowed)?;
                }
                group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(mls("merge commit"))?;
                Ok(Processed::Commit {
                    epoch: group.epoch().as_u64(),
                    removed_self: false,
                })
            }
            ProcessedMessageContent::OwnPendingCommit => {
                group
                    .merge_pending_commit(&self.provider)
                    .map_err(mls("merge commit"))?;
                Ok(Processed::Commit {
                    epoch: group.epoch().as_u64(),
                    removed_self: false,
                })
            }
            // Standalone and external proposals are not used by Tessera clients.
            _ => Err(CoreError::Untrusted("unexpected proposal")),
        }
    }

    /// Adds and removes devices so the group matches the conversation's authoritative device
    /// list. `key_packages` are for devices to add; `remove` lists devices to remove.
    pub fn update_members(
        &mut self,
        conversation_id: &str,
        key_packages: &[Vec<u8>],
        remove: &[(String, String)],
        allowed_users: &[String],
    ) -> Result<CommitOutput> {
        let conversation = parse_id(conversation_id)?;
        let allowed = self.parse_allowed(allowed_users)?;
        let mut group = self.load_group(&conversation)?;
        let mut adds = Vec::new();
        let mut targets = Vec::new();
        for bytes in key_packages {
            let (package, target) = self.validate_key_package(bytes, &allowed)?;
            adds.push(package);
            targets.push(target);
        }
        let mut removals = Vec::new();
        for (user, device) in remove {
            let identity = identity_bytes(&parse_id(user)?, &parse_id(device)?);
            let index = group
                .members()
                .find(|member| member.credential.serialized_content() == identity.as_slice())
                .map(|member| member.index)
                .ok_or(CoreError::Malformed("unknown member"))?;
            if index == group.own_leaf_index() {
                return Err(CoreError::Malformed("cannot remove own device"));
            }
            removals.push(index);
        }
        if adds.is_empty() && removals.is_empty() {
            return Err(CoreError::Malformed("empty membership change"));
        }
        self.commit(&mut group, adds, removals, targets, true)
    }

    /// Whether this device should issue a self-update now (PCS schedule, crypto-design §6).
    pub fn needs_update(&self, conversation_id: &str, now: u64) -> Result<bool> {
        let conversation = parse_id(conversation_id)?;
        Ok(match self.groups.get(&conversation) {
            Some(meta) => {
                now.saturating_sub(meta.last_update_at) >= UPDATE_AFTER_SECONDS
                    || meta.sent_since_update >= UPDATE_AFTER_MESSAGES
            }
            None => false,
        })
    }

    /// Commit refreshing this device's leaf (path update): post-compromise security.
    pub fn self_update(&mut self, conversation_id: &str) -> Result<CommitOutput> {
        let conversation = parse_id(conversation_id)?;
        let mut group = self.load_group(&conversation)?;
        self.commit(&mut group, Vec::new(), Vec::new(), Vec::new(), true)
    }
}

#[cfg(test)]
mod tests;
