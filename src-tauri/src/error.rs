use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("vault is locked")]
    Locked,

    #[error("a vault already exists")]
    VaultExists,

    #[error("no vault found; create one first")]
    NoVault,

    #[error("incorrect password")]
    BadPassword,

    #[error("password must be at least 8 characters")]
    WeakPassword,

    #[error("vault file is corrupt or was written by a newer version")]
    CorruptVault,

    #[error("{0}")]
    Invalid(String),

    #[error("wallet not found: {0}")]
    UnknownWallet(String),

    #[error("rpc error: {0}")]
    Rpc(String),

    #[error("io error: {0}")]
    Io(String),
}

impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::Invalid(msg.into())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Invalid(format!("json: {e}"))
    }
}

/// Errors cross the IPC bridge as `{ kind, message }` so the UI can branch on
/// `kind` (e.g. show the unlock screen on `Locked`) without parsing prose.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            AppError::Locked => "Locked",
            AppError::VaultExists => "VaultExists",
            AppError::NoVault => "NoVault",
            AppError::BadPassword => "BadPassword",
            AppError::WeakPassword => "WeakPassword",
            AppError::CorruptVault => "CorruptVault",
            AppError::Invalid(_) => "Invalid",
            AppError::UnknownWallet(_) => "UnknownWallet",
            AppError::Rpc(_) => "Rpc",
            AppError::Io(_) => "Io",
        };
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
