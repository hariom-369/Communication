//! Account Signing Key (ASK) and device certificates — docs/crypto-design.md §3, ADR-007.
//!
//! The certificate is our own *data structure*, signed with standard Ed25519 (`ed25519-dalek`,
//! strict verification). It binds a device's MLS signature key to the user's ASK so that peers
//! accept only devices the user's own key vouched for (no server-added "ghost devices").

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::ids::Id;

/// Domain-separation prefix for certificate signatures.
const CERT_CONTEXT: &[u8] = b"tessera-device-cert-v1";
const CERT_VERSION: u8 = 1;
const MAX_CIPHERSUITES: usize = 8;
/// Upper bound on an encoded certificate; anything larger is rejected before parsing.
pub const MAX_CERT_BYTES: usize = 256;

/// The user's long-term identity key. Only its public half ever leaves the device.
pub struct AccountKey {
    signing: SigningKey,
    pub version: u32,
}

impl AccountKey {
    /// Builds the key from 32 bytes of CSPRNG output (supplied by the crypto provider).
    pub fn from_seed(seed: Zeroizing<[u8; 32]>, version: u32) -> Self {
        Self {
            signing: SigningKey::from_bytes(&seed),
            version,
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing.to_bytes())
    }

    /// Signs a certificate body for one of this user's devices.
    pub fn certify(&self, body: CertificateBody) -> DeviceCertificate {
        let encoded = body.encode();
        let signature = self.signing.sign(&signed_message(&encoded));
        DeviceCertificate {
            body,
            signature: signature.to_bytes(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateBody {
    pub user_id: Id,
    pub device_id: Id,
    /// The device's MLS leaf signature public key (Ed25519, 32 bytes).
    pub mls_signature_key: [u8; 32],
    pub ask_version: u32,
    /// Unix seconds, informational.
    pub created_at: u64,
    pub ciphersuites: Vec<u16>,
}

impl CertificateBody {
    /// Deterministic encoding (fixed layout, big-endian): the signed bytes are exactly the bytes
    /// transmitted, so there is no canonicalisation step to get wrong.
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(96);
        out.push(CERT_VERSION);
        out.extend_from_slice(&self.user_id);
        out.extend_from_slice(&self.device_id);
        out.extend_from_slice(&self.mls_signature_key);
        out.extend_from_slice(&self.ask_version.to_be_bytes());
        out.extend_from_slice(&self.created_at.to_be_bytes());
        // Callers construct bodies from our own constant list; never more than MAX_CIPHERSUITES.
        out.push(self.ciphersuites.len().min(MAX_CIPHERSUITES) as u8);
        for suite in self.ciphersuites.iter().take(MAX_CIPHERSUITES) {
            out.extend_from_slice(&suite.to_be_bytes());
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCertificate {
    pub body: CertificateBody,
    pub signature: [u8; 64],
}

fn signed_message(encoded_body: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(CERT_CONTEXT.len() + encoded_body.len());
    message.extend_from_slice(CERT_CONTEXT);
    message.extend_from_slice(encoded_body);
    message
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        if self.bytes.len() < count {
            return Err(CoreError::Malformed("certificate truncated"));
        }
        let (head, tail) = self.bytes.split_at(count);
        self.bytes = tail;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }
}

impl DeviceCertificate {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = self.body.encode();
        out.extend_from_slice(&self.signature);
        out
    }

    /// Strict decoding: exact lengths, known version, no trailing bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_CERT_BYTES {
            return Err(CoreError::Malformed("certificate too large"));
        }
        let mut reader = Reader { bytes };
        if reader.take(1)?[0] != CERT_VERSION {
            return Err(CoreError::Malformed("certificate version"));
        }
        let user_id = reader.array::<16>()?;
        let device_id = reader.array::<16>()?;
        let mls_signature_key = reader.array::<32>()?;
        let ask_version = u32::from_be_bytes(reader.array::<4>()?);
        let created_at = u64::from_be_bytes(reader.array::<8>()?);
        let count = reader.take(1)?[0] as usize;
        if count == 0 || count > MAX_CIPHERSUITES {
            return Err(CoreError::Malformed("certificate ciphersuites"));
        }
        let mut ciphersuites = Vec::with_capacity(count);
        for _ in 0..count {
            ciphersuites.push(u16::from_be_bytes(reader.array::<2>()?));
        }
        let signature = reader.array::<64>()?;
        if !reader.bytes.is_empty() {
            return Err(CoreError::Malformed("certificate trailing bytes"));
        }
        Ok(Self {
            body: CertificateBody {
                user_id,
                device_id,
                mls_signature_key,
                ask_version,
                created_at,
                ciphersuites,
            },
            signature,
        })
    }

    /// Verifies the signature with the user's ASK public key (strict: rejects small-order and
    /// non-canonical encodings).
    pub fn verify(&self, ask_public_key: &[u8; 32]) -> Result<()> {
        let key = VerifyingKey::from_bytes(ask_public_key)
            .map_err(|_| CoreError::Untrusted("account key"))?;
        let signature = Signature::from_bytes(&self.signature);
        key.verify_strict(&signed_message(&self.body.encode()), &signature)
            .map_err(|_| CoreError::Untrusted("certificate signature"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn ask(seed: u8) -> AccountKey {
        AccountKey::from_seed(Zeroizing::new([seed; 32]), 1)
    }

    fn body() -> CertificateBody {
        CertificateBody {
            user_id: [1; 16],
            device_id: [2; 16],
            mls_signature_key: [3; 32],
            ask_version: 1,
            created_at: 1_700_000_000,
            ciphersuites: vec![1],
        }
    }

    #[test]
    fn signs_encodes_decodes_and_verifies() {
        let key = ask(7);
        let certificate = key.certify(body());
        let decoded = DeviceCertificate::decode(&certificate.encode()).unwrap();
        assert_eq!(decoded, certificate);
        decoded.verify(&key.public_key()).unwrap();
    }

    #[test]
    fn rejects_other_keys_and_any_modified_field() {
        let key = ask(7);
        let certificate = key.certify(body());
        assert!(certificate.verify(&ask(8).public_key()).is_err());

        let encoded = certificate.encode();
        // Flipping any single bit of the body or signature must break verification or parsing.
        for index in 0..encoded.len() {
            let mut tampered = encoded.clone();
            tampered[index] ^= 0x01;
            let accepted = DeviceCertificate::decode(&tampered)
                .map(|c| c.verify(&key.public_key()).is_ok())
                .unwrap_or(false);
            assert!(!accepted, "bit flip at byte {index} was accepted");
        }
    }

    #[test]
    fn rejects_truncation_trailing_bytes_and_bad_counts() {
        let encoded = ask(7).certify(body()).encode();
        assert!(DeviceCertificate::decode(&encoded[..encoded.len() - 1]).is_err());
        let mut long = encoded.clone();
        long.push(0);
        assert!(DeviceCertificate::decode(&long).is_err());
        let mut zero_suites = encoded.clone();
        zero_suites[1 + 16 + 16 + 32 + 4 + 8] = 0;
        assert!(DeviceCertificate::decode(&zero_suites).is_err());
        assert!(DeviceCertificate::decode(&[0u8; MAX_CERT_BYTES + 1]).is_err());
    }

    proptest! {
        #[test]
        fn decoding_arbitrary_bytes_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
            let _ = DeviceCertificate::decode(&bytes);
        }
    }
}
