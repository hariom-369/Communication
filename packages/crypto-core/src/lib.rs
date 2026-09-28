//! Tessera client cryptography (docs/crypto-design.md).
//!
//! Orchestrates OpenMLS (RFC 9420) and Ed25519; implements no cryptographic primitive or
//! protocol of its own. Runs natively for tests and as WebAssembly inside the web client's
//! dedicated crypto worker (ADR-006).

pub mod backup;
pub mod base32;
pub mod client;
pub mod error;
pub mod identity;
pub mod ids;
pub mod link;
pub mod padding;
pub mod safety;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use client::Client;
pub use error::{CoreError, Result};
