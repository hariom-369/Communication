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

use crate::client::{Client, CommitOutput, Processed};
use crate::error::CoreError;
use crate::safety;

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
        json!({
            "userId": self.inner.user_id(),
            "deviceId": self.inner.device_id(),
            "askPublicKey": B64.encode(self.inner.ask_public_key()),
            "askVersion": self.inner.ask_version(),
            "certificate": B64.encode(self.inner.certificate()),
        })
        .to_string()
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
        now: f64,
    ) -> Result<String, JsError> {
        let output = self
            .inner
            .create_group(
                conversation_id,
                &byte_list(key_packages)?,
                &strings(allowed_users)?,
                now as u64,
            )
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
