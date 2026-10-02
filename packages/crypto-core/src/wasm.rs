//! WebAssembly boundary for the web client's dedicated crypto worker (ADR-006).
//!
//! Narrow, versioned surface: structured values cross as JSON strings with bytes in base64;
//! errors cross as `CODE: message` (codes from `CoreError::code`), never with key material.
//! wasm32-unknown-unknown aborts on panic: the worker treats a trap as fatal, discards the
//! instance and reloads from the last persisted snapshot.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::client::{BackupSecret, Client, CommitOutput, Processed};
use crate::error::CoreError;
use crate::group_policy::GroupPolicy;
use crate::{media, safety};

fn js(error: CoreError) -> JsError {
    JsError::new(&format!("{}: {}", error.code(), error))
}

fn bytes(value: &str) -> Result<Vec<u8>, JsError> {
    B64.decode(value)
        .map_err(|_| js(CoreError::Malformed("base64")))
}

fn strings(json_array: &str) -> Result<Vec<String>, JsError> {
    serde_json::from_str(json_array).map_err(|_| js(CoreError::Malformed("json")))
}

fn byte_list(json_array: &str) -> Result<Vec<Vec<u8>>, JsError> {
    strings(json_array)?
        .iter()
        .map(|value| bytes(value))
        .collect()
}

fn commit_json(output: CommitOutput) -> String {
    json!({
        "commit": B64.encode(&output.commit),
        "welcome": output.welcome.map(|w| B64.encode(w)),
        "welcomeTargets": output.welcome_targets,
        "epoch": output.epoch,
    })
    .to_string()
}

/// Short link id (base64) from a link code the user typed; the rest is checked by `approveLink`.
#[wasm_bindgen(js_name = parseLinkCode)]
pub fn parse_link_code(code: &str) -> Result<String, JsError> {
    let (short_id, _) = crate::link::parse_code(code).map_err(js)?;
    Ok(B64.encode(short_id))
}

/// Checks the keys the server returned for a link against the code the user typed (before the
/// user is asked to approve). `approveLink` checks again.
#[wasm_bindgen(js_name = verifyLinkCode)]
pub fn verify_link_code(
    code: &str,
    short_id: &str,
    hpke_public: &str,
    signature_public: &str,
) -> Result<(), JsError> {
    let short_id: [u8; crate::link::SHORT_ID_BYTES] = bytes(short_id)?
        .try_into()
        .map_err(|_| js(CoreError::Malformed("short id")))?;
    crate::link::verify(
        code,
        &short_id,
        &bytes(hpke_public)?,
        &bytes(signature_public)?,
    )
    .map_err(js)
}

#[wasm_bindgen]
pub struct CryptoClient {
    inner: Client,
}

#[wasm_bindgen]
impl CryptoClient {
    /// New device identity with a fresh account key (first device or identity reset).
    pub fn create(user_id: &str, ask_version: u32, now: f64) -> Result<CryptoClient, JsError> {
        Ok(Self {
            inner: Client::create(user_id, ask_version, now as u64).map_err(js)?,
        })
    }

    /// A device waiting to be linked from another device or restored from a backup.
    #[wasm_bindgen(js_name = createPending)]
    pub fn create_pending(user_id: &str, now: f64) -> Result<CryptoClient, JsError> {
        Ok(Self {
            inner: Client::create_pending(user_id, now as u64).map_err(js)?,
        })
    }

    pub fn restore(snapshot: &[u8]) -> Result<CryptoClient, JsError> {
        Ok(Self {
            inner: Client::restore(snapshot).map_err(js)?,
        })
    }

    /// Complete state for encrypted persistence by the worker.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(js)
    }

    pub fn identity(&self) -> String {
        let pending = self.inner.is_pending();
        json!({
            "userId": self.inner.user_id(),
            "deviceId": self.inner.device_id(),
            "askPublicKey": if pending { Value::Null } else { B64.encode(self.inner.ask_public_key()).into() },
            "askVersion": self.inner.ask_version(),
            "certificate": self.inner.certificate().ok().map(|c| B64.encode(c)),
            "trusted": self.inner.is_trusted(),
            "pending": pending,
            "backups": self.inner.has_backup_key(),
        })
        .to_string()
    }

    #[wasm_bindgen(js_name = linkRequest)]
    pub fn link_request(&self) -> Result<String, JsError> {
        let (hpke, signature) = self.inner.link_request().map_err(js)?;
        Ok(
            json!({ "hpkePublic": B64.encode(hpke), "signaturePublic": B64.encode(signature) })
                .to_string(),
        )
    }

    #[wasm_bindgen(js_name = linkCode)]
    pub fn link_code(&self, short_id: &str) -> Result<String, JsError> {
        self.inner.link_code(&bytes(short_id)?).map_err(js)
    }

    /// Returns the sealed payload, base64.
    #[wasm_bindgen(js_name = approveLink)]
    #[allow(clippy::too_many_arguments)]
    pub fn approve_link(
        &self,
        code: &str,
        short_id: &str,
        device_id: &str,
        hpke_public: &str,
        signature_public: &str,
        trusted: bool,
        history: &[u8],
        now: f64,
    ) -> Result<String, JsError> {
        let sealed = self
            .inner
            .approve_link(
                code,
                &bytes(short_id)?,
                device_id,
                &bytes(hpke_public)?,
                &bytes(signature_public)?,
                trusted,
                history,
                now as u64,
            )
            .map_err(js)?;
        Ok(B64.encode(sealed))
    }

    /// Returns the transferred history (opaque bytes).
    #[wasm_bindgen(js_name = completeLink)]
    pub fn complete_link(
        &mut self,
        sealed: &str,
        short_id: &str,
        expected_ask_public: &str,
        expected_version: u32,
    ) -> Result<Vec<u8>, JsError> {
        self.inner
            .complete_link(
                &bytes(sealed)?,
                &bytes(short_id)?,
                &bytes(expected_ask_public)?,
                expected_version,
            )
            .map_err(js)
    }

    #[wasm_bindgen(js_name = observeDevices)]
    pub fn observe_devices(&mut self, user_id: &str, device_ids: &str) -> Result<String, JsError> {
        let added = self
            .inner
            .observe_devices(user_id, &strings(device_ids)?)
            .map_err(js)?;
        Ok(Value::from(added).to_string())
    }

    #[wasm_bindgen(js_name = backupEnable)]
    pub fn backup_enable(&mut self) -> Result<String, JsError> {
        let (recovery_key, wrap) = self.inner.backup_enable().map_err(js)?;
        Ok(json!({ "recoveryKey": recovery_key, "wrap": B64.encode(wrap) }).to_string())
    }

    #[wasm_bindgen(js_name = backupNewRecoveryKey)]
    pub fn backup_new_recovery_key(&self) -> Result<String, JsError> {
        let (recovery_key, wrap) = self.inner.backup_new_recovery_key().map_err(js)?;
        Ok(json!({ "recoveryKey": recovery_key, "wrap": B64.encode(wrap) }).to_string())
    }

    #[wasm_bindgen(js_name = backupPasskeyWrap)]
    pub fn backup_passkey_wrap(&self, prf_output: &[u8]) -> Result<String, JsError> {
        Ok(B64.encode(self.inner.backup_passkey_wrap(prf_output).map_err(js)?))
    }

    #[wasm_bindgen(js_name = backupOwns)]
    pub fn backup_owns(&self, manifest: &str, mac: &str) -> Result<bool, JsError> {
        Ok(self.inner.backup_owns(manifest.as_bytes(), &bytes(mac)?))
    }

    #[wasm_bindgen(js_name = backupExport)]
    pub fn backup_export(
        &self,
        app: &[u8],
        version: f64,
        prev_hash: Option<String>,
        now: f64,
    ) -> Result<String, JsError> {
        let output = self
            .inner
            .backup_export(app, version as u64, prev_hash, now as u64)
            .map_err(js)?;
        Ok(json!({
            "blob": B64.encode(&output.blob),
            "manifest": String::from_utf8_lossy(&output.manifest),
            "mac": B64.encode(output.mac),
        })
        .to_string())
    }

    /// `kind` is `recovery` (secret = recovery key text) or `passkey` (secret = PRF output, base64).
    #[wasm_bindgen(js_name = backupRestore)]
    #[allow(clippy::too_many_arguments)]
    pub fn backup_restore(
        &mut self,
        kind: &str,
        secret: &str,
        wrap: &str,
        blob: &str,
        manifest: &str,
        mac: &str,
        expected_ask_public: &str,
        expected_version: u32,
        now: f64,
    ) -> Result<String, JsError> {
        let prf;
        let secret = match kind {
            "recovery" => BackupSecret::RecoveryKey(secret),
            "passkey" => {
                prf = bytes(secret)?;
                BackupSecret::PasskeyPrf(&prf)
            }
            _ => return Err(js(CoreError::Malformed("backup secret kind"))),
        };
        let (app, manifest) = self
            .inner
            .backup_restore(
                secret,
                &bytes(wrap)?,
                &bytes(blob)?,
                manifest.as_bytes(),
                &bytes(mac)?,
                &bytes(expected_ask_public)?,
                expected_version,
                now as u64,
            )
            .map_err(js)?;
        Ok(json!({ "app": B64.encode(app), "version": manifest.version, "createdAt": manifest.created_at }).to_string())
    }

    #[wasm_bindgen(js_name = generateKeyPackages)]
    pub fn generate_key_packages(&self, count: u32, last_resort: bool) -> Result<String, JsError> {
        let packages = self
            .inner
            .generate_key_packages(count as usize, last_resort)
            .map_err(js)?;
        Ok(Value::from(packages.iter().map(|p| B64.encode(p)).collect::<Vec<_>>()).to_string())
    }

    #[wasm_bindgen(js_name = observeIdentity)]
    pub fn observe_identity(
        &mut self,
        user_id: &str,
        public_key: &str,
        version: u32,
    ) -> Result<String, JsError> {
        let observation = self
            .inner
            .observe_identity(user_id, &bytes(public_key)?, version)
            .map_err(js)?;
        Ok(serde_json::to_string(&observation).unwrap_or_default())
    }

    pub fn pin(&self, user_id: &str) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.inner.pin(user_id).map_err(js)?).unwrap_or_default())
    }

    #[wasm_bindgen(js_name = setVerified)]
    pub fn set_verified(&mut self, user_id: &str, verified: bool) -> Result<(), JsError> {
        self.inner.set_verified(user_id, verified).map_err(js)
    }

    #[wasm_bindgen(js_name = acknowledgeChange)]
    pub fn acknowledge_change(&mut self, user_id: &str) -> Result<(), JsError> {
        self.inner.acknowledge_change(user_id).map_err(js)
    }

    #[wasm_bindgen(js_name = safetyNumber)]
    pub fn safety_number(&self, user_id: &str) -> Result<String, JsError> {
        let number = self.inner.safety_number(user_id).map_err(js)?;
        Ok(json!({ "digits": number.digits, "qr": B64.encode(&number.qr) }).to_string())
    }

    #[wasm_bindgen(js_name = qrMatches)]
    pub fn qr_matches(&self, user_id: &str, scanned: &str) -> Result<bool, JsError> {
        let number = self.inner.safety_number(user_id).map_err(js)?;
        Ok(safety::qr_matches(&number.qr, &bytes(scanned)?))
    }

    #[wasm_bindgen(js_name = hasGroup)]
    pub fn has_group(&self, conversation_id: &str) -> Result<bool, JsError> {
        self.inner.has_group(conversation_id).map_err(js)
    }

    pub fn epoch(&self, conversation_id: &str) -> Result<f64, JsError> {
        Ok(self.inner.epoch(conversation_id).map_err(js)? as f64)
    }

    pub fn members(&self, conversation_id: &str) -> Result<String, JsError> {
        Ok(
            serde_json::to_string(&self.inner.members(conversation_id).map_err(js)?)
                .unwrap_or_default(),
        )
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(
        &mut self,
        conversation_id: &str,
        key_packages: &str,
        allowed_users: &str,
        policy: Option<String>,
        now: f64,
    ) -> Result<String, JsError> {
        let policy = policy
            .map(|json| {
                serde_json::from_str::<GroupPolicy>(&json)
                    .map(GroupPolicy::normalised)
                    .map_err(|_| js(CoreError::Malformed("group policy")))
            })
            .transpose()?;
        let output = self
            .inner
            .create_group(
                conversation_id,
                &byte_list(key_packages)?,
                &strings(allowed_users)?,
                policy,
                now as u64,
            )
            .map_err(js)?;
        Ok(commit_json(output))
    }

    /// The group's authenticated roles and settings as JSON, or `null` for 1:1 conversations.
    #[wasm_bindgen(js_name = groupPolicy)]
    pub fn group_policy(&self, conversation_id: &str) -> Result<String, JsError> {
        let policy = self.inner.group_policy(conversation_id).map_err(js)?;
        serde_json::to_string(&policy).map_err(|_| js(CoreError::State("encode")))
    }

    /// Commit changing roles or settings (`policy` JSON); refused unless allowed.
    #[wasm_bindgen(js_name = updatePolicy)]
    pub fn update_policy(
        &mut self,
        conversation_id: &str,
        policy: &str,
        allowed_users: &str,
    ) -> Result<String, JsError> {
        let policy: GroupPolicy =
            serde_json::from_str(policy).map_err(|_| js(CoreError::Malformed("group policy")))?;
        let output = self
            .inner
            .update_policy(conversation_id, policy, &strings(allowed_users)?)
            .map_err(js)?;
        Ok(commit_json(output))
    }

    #[wasm_bindgen(js_name = mergePending)]
    pub fn merge_pending(&mut self, conversation_id: &str, now: f64) -> Result<f64, JsError> {
        Ok(self
            .inner
            .merge_pending(conversation_id, now as u64)
            .map_err(js)? as f64)
    }

    #[wasm_bindgen(js_name = clearPending)]
    pub fn clear_pending(&mut self, conversation_id: &str) -> Result<(), JsError> {
        self.inner.clear_pending(conversation_id).map_err(js)
    }

    #[wasm_bindgen(js_name = discardGroup)]
    pub fn discard_group(&mut self, conversation_id: &str) -> Result<(), JsError> {
        self.inner.discard_group(conversation_id).map_err(js)
    }

    pub fn join(
        &mut self,
        conversation_id: &str,
        welcome: &str,
        allowed_users: &str,
        now: f64,
    ) -> Result<f64, JsError> {
        Ok(self
            .inner
            .join(
                conversation_id,
                &bytes(welcome)?,
                &strings(allowed_users)?,
                now as u64,
            )
            .map_err(js)? as f64)
    }

    /// Returns the MLS message, base64.
    pub fn encrypt(&mut self, conversation_id: &str, plaintext: &[u8]) -> Result<String, JsError> {
        Ok(B64.encode(self.inner.encrypt(conversation_id, plaintext).map_err(js)?))
    }

    pub fn process(
        &mut self,
        conversation_id: &str,
        message: &str,
        allowed_users: &str,
    ) -> Result<String, JsError> {
        let processed = self
            .inner
            .process(conversation_id, &bytes(message)?, &strings(allowed_users)?)
            .map_err(js)?;
        Ok(match processed {
            Processed::Application {
                plaintext,
                sender_user_id,
                sender_device_id,
            } => json!({
                "kind": "application",
                "plaintext": B64.encode(plaintext),
                "senderUserId": sender_user_id,
                "senderDeviceId": sender_device_id,
            }),
            Processed::Commit {
                epoch,
                removed_self,
            } => {
                json!({ "kind": "commit", "epoch": epoch, "removedSelf": removed_self })
            }
        }
        .to_string())
    }

    /// `remove` is a JSON array of `[userId, deviceId]` pairs.
    #[wasm_bindgen(js_name = updateMembers)]
    pub fn update_members(
        &mut self,
        conversation_id: &str,
        key_packages: &str,
        remove: &str,
        allowed_users: &str,
    ) -> Result<String, JsError> {
        let remove: Vec<(String, String)> =
            serde_json::from_str(remove).map_err(|_| js(CoreError::Malformed("json")))?;
        let output = self
            .inner
            .update_members(
                conversation_id,
                &byte_list(key_packages)?,
                &remove,
                &strings(allowed_users)?,
            )
            .map_err(js)?;
        Ok(commit_json(output))
    }

    #[wasm_bindgen(js_name = needsUpdate)]
    pub fn needs_update(&self, conversation_id: &str, now: f64) -> Result<bool, JsError> {
        self.inner
            .needs_update(conversation_id, now as u64)
            .map_err(js)
    }

    #[wasm_bindgen(js_name = selfUpdate)]
    pub fn self_update(&mut self, conversation_id: &str) -> Result<String, JsError> {
        Ok(commit_json(
            self.inner.self_update(conversation_id).map_err(js)?,
        ))
    }
}

// ---------------------------------------------------------------- attachments (docs/media.md)

fn digest_json(key: &[u8; media::KEY_BYTES], digest: &media::MediaDigest) -> String {
    json!({
        "key": B64.encode(key),
        "plaintextSha256": B64.encode(digest.plaintext_sha256),
        "ciphertextSha256": B64.encode(digest.ciphertext_sha256),
        "plaintextSize": digest.plaintext_size,
        "ciphertextSize": digest.ciphertext_size,
    })
    .to_string()
}

fn array32(value: &str, what: &'static str) -> Result<[u8; 32], JsError> {
    bytes(value)?
        .try_into()
        .map_err(|_| js(CoreError::Malformed(what)))
}

/// Encrypts one attachment under a fresh random key, chunk by chunk (64 KiB plaintext chunks).
#[wasm_bindgen]
pub struct MediaEncryptor {
    key: zeroize::Zeroizing<[u8; media::KEY_BYTES]>,
    inner: Option<media::Encryptor>,
    header: Vec<u8>,
    digest: Option<media::MediaDigest>,
}

#[wasm_bindgen]
impl MediaEncryptor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<MediaEncryptor, JsError> {
        use openmls_traits::random::OpenMlsRand;
        let rng = openmls_rust_crypto::RustCrypto::default();
        let key: [u8; media::KEY_BYTES] = rng
            .random_array()
            .map_err(|_| js(CoreError::Mls("random")))?;
        let nonce: [u8; media::NONCE_BYTES] = rng
            .random_array()
            .map_err(|_| js(CoreError::Mls("random")))?;
        let key = zeroize::Zeroizing::new(key);
        let (inner, header) = media::Encryptor::new(&key, nonce);
        Ok(Self {
            key,
            inner: Some(inner),
            header,
            digest: None,
        })
    }

    /// The first ciphertext bytes.
    pub fn header(&self) -> Vec<u8> {
        self.header.clone()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| js(CoreError::State("media encryption finished")))?
            .push(chunk)
            .map_err(js)
    }

    pub fn finish(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| js(CoreError::State("media encryption finished")))?;
        let (out, digest) = inner.finish(chunk).map_err(js)?;
        self.digest = Some(digest);
        Ok(out)
    }

    /// `{key, plaintextSha256, ciphertextSha256, plaintextSize, ciphertextSize}` after `finish`.
    pub fn digest(&self) -> Result<String, JsError> {
        let digest = self
            .digest
            .as_ref()
            .ok_or_else(|| js(CoreError::State("media encryption not finished")))?;
        Ok(digest_json(&self.key, digest))
    }
}

/// Decrypts one attachment chunk by chunk; `finish` checks it against the message's digest.
#[wasm_bindgen]
pub struct MediaDecryptor {
    inner: Option<media::Decryptor>,
}

#[wasm_bindgen]
impl MediaDecryptor {
    #[wasm_bindgen(constructor)]
    pub fn new(key: &str, header: &[u8]) -> Result<MediaDecryptor, JsError> {
        let key = zeroize::Zeroizing::new(array32(key, "media key")?);
        Ok(Self {
            inner: Some(media::Decryptor::new(&key, header).map_err(js)?),
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| js(CoreError::State("media decryption finished")))?
            .push(chunk)
            .map_err(js)
    }

    /// `digest` is the JSON from the message: plaintextSha256, ciphertextSha256 (base64) and
    /// plaintextSize, ciphertextSize.
    pub fn finish(&mut self, chunk: &[u8], digest: &str) -> Result<Vec<u8>, JsError> {
        let value: Value =
            serde_json::from_str(digest).map_err(|_| js(CoreError::Malformed("json")))?;
        let text = |name: &str| value[name].as_str().unwrap_or_default().to_owned();
        let size = |name: &str| {
            value[name]
                .as_u64()
                .ok_or_else(|| js(CoreError::Malformed("media size")))
        };
        let expected = media::MediaDigest {
            plaintext_sha256: array32(&text("plaintextSha256"), "media hash")?,
            ciphertext_sha256: array32(&text("ciphertextSha256"), "media hash")?,
            plaintext_size: size("plaintextSize")?,
            ciphertext_size: size("ciphertextSize")?,
        };
        let inner = self
            .inner
            .take()
            .ok_or_else(|| js(CoreError::State("media decryption finished")))?;
        inner.finish(chunk, &expected).map_err(js)
    }
}
