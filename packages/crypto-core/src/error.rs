use std::fmt;

/// Typed errors surfaced across the WASM boundary as stable string codes.
///
/// Messages never include key material or plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// Input bytes could not be parsed (length, framing, encoding).
    Malformed(&'static str),
    /// A signature, certificate or credential check failed.
    Untrusted(&'static str),
    /// No pinned identity for a user referenced by a group member or key package.
    UnknownIdentity(String),
    /// A member or key package belongs to a user who is not part of the conversation.
    NotAllowed(String),
    /// The conversation's group does not exist locally.
    NoGroup,
    /// The conversation's group already exists locally.
    GroupExists,
    /// The message belongs to a different epoch than this device can process.
    WrongEpoch,
    /// The message was already processed (replay or duplicate delivery).
    Duplicate,
    /// Our own message echoed back (senders cannot decrypt their own MLS messages).
    OwnMessage,
    /// The plaintext is larger than the largest padding bucket.
    TooLarge,
    /// The local state is missing or was produced by an incompatible version.
    State(&'static str),
    /// OpenMLS or the crypto provider reported an error (details are not exposed).
    Mls(&'static str),
}

impl CoreError {
    /// Stable machine-readable code used by the TypeScript side.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Malformed(_) => "MALFORMED",
            CoreError::Untrusted(_) => "UNTRUSTED",
            CoreError::UnknownIdentity(_) => "UNKNOWN_IDENTITY",
            CoreError::NotAllowed(_) => "NOT_ALLOWED",
            CoreError::NoGroup => "NO_GROUP",
            CoreError::GroupExists => "GROUP_EXISTS",
            CoreError::WrongEpoch => "WRONG_EPOCH",
            CoreError::Duplicate => "DUPLICATE",
            CoreError::OwnMessage => "OWN_MESSAGE",
            CoreError::TooLarge => "TOO_LARGE",
            CoreError::State(_) => "STATE",
            CoreError::Mls(_) => "MLS",
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Malformed(what) => write!(f, "malformed input: {what}"),
            CoreError::Untrusted(what) => write!(f, "verification failed: {what}"),
            CoreError::UnknownIdentity(user) => write!(f, "no pinned identity for user {user}"),
            CoreError::NotAllowed(user) => write!(f, "user {user} is not a conversation member"),
            CoreError::NoGroup => write!(f, "no local group for this conversation"),
            CoreError::GroupExists => write!(f, "group already exists"),
            CoreError::WrongEpoch => {
                write!(f, "message is from an epoch this device cannot process")
            }
            CoreError::Duplicate => write!(f, "message was already processed"),
            CoreError::OwnMessage => write!(f, "own message"),
            CoreError::TooLarge => write!(f, "plaintext too large"),
            CoreError::State(what) => write!(f, "local state error: {what}"),
            CoreError::Mls(what) => write!(f, "MLS error: {what}"),
        }
    }
}

impl std::error::Error for CoreError {}

pub type Result<T> = std::result::Result<T, CoreError>;
