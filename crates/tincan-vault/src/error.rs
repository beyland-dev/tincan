use std::fmt;

/// The stable error codes shared with the Tincan protocol (`packages/protocol/src/errors.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// The session bus or the Secret Service is unavailable.
    NotConnected,
    /// The database is locked by another connection.
    Busy,
    /// The keyring refused (a dismissed unlock prompt, a locked item) or the
    /// key does not open the database.
    PermissionDenied,
    Timeout,
    NotFound,
    InvalidInput,
    /// A constraint (unique, foreign key, check) failed.
    Conflict,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotConnected => "NOT_CONNECTED",
            Self::Busy => "BUSY",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::Timeout => "TIMEOUT",
            Self::NotFound => "NOT_FOUND",
            Self::InvalidInput => "INVALID_INPUT",
            Self::Conflict => "CONFLICT",
            Self::Internal => "INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every fallible `tincan-vault` operation returns this. Messages never contain
/// key material or bound parameter values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    code: ErrorCode,
    message: String,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => ErrorCode::Conflict,
            _ => ErrorCode::Internal,
        };
        Error::new(code, err.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(err: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode as Sqlite;
        let code = match &err {
            rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
                Sqlite::ConstraintViolation => ErrorCode::Conflict,
                Sqlite::DatabaseBusy | Sqlite::DatabaseLocked => ErrorCode::Busy,
                Sqlite::NotADatabase => ErrorCode::PermissionDenied,
                Sqlite::CannotOpen => ErrorCode::NotFound,
                Sqlite::PermissionDenied | Sqlite::ReadOnly => ErrorCode::PermissionDenied,
                _ => ErrorCode::Internal,
            },
            rusqlite::Error::InvalidParameterCount(..)
            | rusqlite::Error::InvalidParameterName(_)
            | rusqlite::Error::MultipleStatement
            | rusqlite::Error::ExecuteReturnedResults
            | rusqlite::Error::InvalidColumnIndex(_)
            | rusqlite::Error::InvalidColumnName(_) => ErrorCode::InvalidInput,
            rusqlite::Error::SqlInputError { .. } => ErrorCode::InvalidInput,
            _ => ErrorCode::Internal,
        };
        if code == ErrorCode::PermissionDenied
            && matches!(&err, rusqlite::Error::SqliteFailure(f, _) if f.code == Sqlite::NotADatabase)
        {
            return Error::new(code, "the vault key does not open this database");
        }
        Error::new(code, err.to_string())
    }
}

/// Maps a Secret Service or bus error to a Tincan code.
pub fn classify_dbus_error(name: &str, description: &str) -> ErrorCode {
    let text = format!("{name} {description}").to_ascii_lowercase();
    let has = |needle: &str| text.contains(needle);
    if has("serviceunknown")
        || has("namehasnoowner")
        || has("not activatable")
        || has("was not provided by any .service files")
        || has("noserver")
        || has("disconnected")
    {
        ErrorCode::NotConnected
    } else if has("islocked") || has("accessdenied") || has("notsupported") {
        ErrorCode::PermissionDenied
    } else if has("nosuchobject") || has("unknownobject") || has("unknownmethod") {
        ErrorCode::NotFound
    } else if has("noreply") || has("timeout") || has("timed out") {
        ErrorCode::Timeout
    } else if has("invalidargs") {
        ErrorCode::InvalidInput
    } else {
        ErrorCode::Internal
    }
}

impl From<zbus::Error> for Error {
    fn from(err: zbus::Error) -> Self {
        use zbus::DBusError;
        let (name, description) = match &err {
            zbus::Error::MethodError(name, description, _) => (
                name.as_str().to_owned(),
                description.clone().unwrap_or_default(),
            ),
            zbus::Error::FDO(fdo) => (
                fdo.name().as_str().to_owned(),
                fdo.description().unwrap_or_default().to_owned(),
            ),
            zbus::Error::InputOutput(io) => {
                return Error::new(
                    ErrorCode::NotConnected,
                    format!("session bus unavailable: {io}"),
                );
            }
            other => (String::new(), other.to_string()),
        };
        let code = classify_dbus_error(&name, &description);
        let message = match (name.is_empty(), description.is_empty()) {
            (true, _) => description,
            (false, true) => name,
            (false, false) => format!("{name}: {description}"),
        };
        Error::new(code, message)
    }
}

impl From<zbus::fdo::Error> for Error {
    fn from(err: zbus::fdo::Error) -> Self {
        zbus::Error::FDO(Box::new(err)).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_secret_service_errors() {
        assert_eq!(
            classify_dbus_error("org.freedesktop.DBus.Error.ServiceUnknown", ""),
            ErrorCode::NotConnected
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.Secret.Error.IsLocked", "locked"),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.Secret.Error.NoSuchObject", ""),
            ErrorCode::NotFound
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.DBus.Error.Failed", "boom"),
            ErrorCode::Internal
        );
    }
}
