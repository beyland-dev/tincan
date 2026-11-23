use std::fmt;

/// The stable error codes shared with the Tincan protocol (`packages/protocol/src/errors.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    NotConnected,
    Busy,
    PermissionDenied,
    Timeout,
    NotFound,
    InvalidInput,
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
            Self::Internal => "INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every fallible `tincan-bt` operation returns this. The message never contains
/// message bodies or phone numbers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    NotConnected(String),
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    Timeout(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    Internal(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// Bluetooth addresses in `message` (from BlueZ or zbus descriptions,
    /// object paths) are masked; see [`crate::redact::scrub`].
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if let std::borrow::Cow::Owned(scrubbed) = crate::redact::scrub(&message) {
            message = scrubbed;
        }
        match code {
            ErrorCode::NotConnected => Self::NotConnected(message),
            ErrorCode::Busy => Self::Busy(message),
            ErrorCode::PermissionDenied => Self::PermissionDenied(message),
            ErrorCode::Timeout => Self::Timeout(message),
            ErrorCode::NotFound => Self::NotFound(message),
            ErrorCode::InvalidInput => Self::InvalidInput(message),
            ErrorCode::Internal => Self::Internal(message),
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Self::NotConnected(_) => ErrorCode::NotConnected,
            Self::Busy(_) => ErrorCode::Busy,
            Self::PermissionDenied(_) => ErrorCode::PermissionDenied,
            Self::Timeout(_) => ErrorCode::Timeout,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::Internal(_) => ErrorCode::Internal,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NotConnected(m)
            | Self::Busy(m)
            | Self::PermissionDenied(m)
            | Self::Timeout(m)
            | Self::NotFound(m)
            | Self::InvalidInput(m)
            | Self::Internal(m) => m,
        }
    }
}

/// A failure to reach a message bus at all: the bus (and so BlueZ or obexd)
/// is unavailable, whatever the underlying I/O error says.
pub fn bus_unavailable(bus: &str, err: &zbus::Error) -> Error {
    Error::new(
        ErrorCode::NotConnected,
        format!("{bus} bus unavailable: {err}"),
    )
}

/// Maps a D-Bus error name and description (BlueZ, obexd or the bus itself) to a
/// Tincan code. Text matching inspects the description because obexd reports
/// most failures as `org.bluez.obex.Error.Failed` with the real cause only in
/// the description.
pub fn classify_dbus_error(name: &str, description: &str) -> ErrorCode {
    let name_lc = name.to_ascii_lowercase();
    let text = description.to_ascii_lowercase();
    let has = |needle: &str| name_lc.contains(needle) || text.contains(needle);

    if has("serviceunknown")
        || has("nameHasNoOwner".to_ascii_lowercase().as_str())
        || has("not activatable")
        || has("was not provided by any .service files")
        || has("notconnected")
        || has("not connected")
        || has("host is down")
        || has("no route to host")
        || has("page timeout")
        || has("notready")
        || has("not ready")
    {
        return ErrorCode::NotConnected;
    }
    if has("forbidden")
        || has("0x43")
        || has("notauthorized")
        || has("not authorized")
        || has("accessdenied")
        || has("access denied")
        || has("notpermitted")
        || has("authenticationrejected")
        || has("authenticationcanceled")
        || has("authenticationfailed")
    {
        return ErrorCode::PermissionDenied;
    }
    if has("inprogress")
        || has("in progress")
        || has("busy")
        || has("alreadyexists")
        || has("connection refused")
        || has("(111)")
    {
        return ErrorCode::Busy;
    }
    if has("noreply") || has("timedout") || has("timeout") || has("timed out") {
        return ErrorCode::Timeout;
    }
    if has("unknownobject")
        || has("unknownmethod")
        || has("unknowninterface")
        || has("unknownproperty")
        || has("doesnotexist")
        || has("does not exist")
        || has("unable to find service record")
        || has("no such service")
        || has("not found")
    {
        return ErrorCode::NotFound;
    }
    if has("invalidargs") || has("invalidarguments") || has("invalid arguments") {
        return ErrorCode::InvalidInput;
    }
    ErrorCode::Internal
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
            zbus::Error::InputOutput(io) => (String::new(), io.to_string()),
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

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            std::io::ErrorKind::TimedOut => ErrorCode::Timeout,
            _ => ErrorCode::Internal,
        };
        Error::new(code, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_bus_is_not_connected() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory");
        let err = bus_unavailable("system", &zbus::Error::InputOutput(io.into()));
        assert_eq!(err.code(), ErrorCode::NotConnected);
        assert!(err.message().starts_with("system bus unavailable"));
    }

    #[test]
    fn dbus_errors_never_carry_a_full_address() {
        let err = Error::from(zbus::Error::MethodError(
            zbus::names::OwnedErrorName::try_from("org.bluez.Error.Failed").expect("name"),
            Some("Device /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF not available".into()),
            zbus::message::Message::method_call("/", "Ping")
                .build(&())
                .expect("message"),
        ));
        if !crate::redact::sensitive() {
            assert!(!err.message().contains("AA_BB"), "{}", err.message());
            assert!(err.message().contains("dev_…_EE_FF"));
        }
        let err = Error::new(ErrorCode::NotFound, "no AA:BB:CC:DD:EE:FF");
        if !crate::redact::sensitive() {
            assert_eq!(err.message(), "no …:EE:FF");
        }
    }

    #[test]
    fn codes_are_stable_strings() {
        assert_eq!(ErrorCode::NotConnected.as_str(), "NOT_CONNECTED");
        assert_eq!(ErrorCode::Busy.as_str(), "BUSY");
        assert_eq!(ErrorCode::PermissionDenied.as_str(), "PERMISSION_DENIED");
        assert_eq!(ErrorCode::Timeout.as_str(), "TIMEOUT");
        assert_eq!(ErrorCode::NotFound.as_str(), "NOT_FOUND");
        assert_eq!(ErrorCode::InvalidInput.as_str(), "INVALID_INPUT");
        assert_eq!(ErrorCode::Internal.as_str(), "INTERNAL");
    }

    #[test]
    fn error_round_trips_its_code() {
        let err = Error::new(ErrorCode::Busy, "held elsewhere");
        assert_eq!(err.code(), ErrorCode::Busy);
        assert_eq!(err.to_string(), "held elsewhere");
        assert_eq!(err.message(), "held elsewhere");
    }

    #[test]
    fn classifies_what_bluez_and_obexd_report() {
        let cases = [
            (
                "org.freedesktop.DBus.Error.ServiceUnknown",
                "",
                ErrorCode::NotConnected,
            ),
            ("org.bluez.Error.NotConnected", "", ErrorCode::NotConnected),
            (
                "org.bluez.obex.Error.Failed",
                "Host is down",
                ErrorCode::NotConnected,
            ),
            (
                "org.bluez.obex.Error.Failed",
                "Forbidden",
                ErrorCode::PermissionDenied,
            ),
            (
                "org.bluez.Error.NotAuthorized",
                "",
                ErrorCode::PermissionDenied,
            ),
            (
                "org.bluez.Error.AuthenticationFailed",
                "",
                ErrorCode::PermissionDenied,
            ),
            (
                "org.bluez.Error.AuthenticationCanceled",
                "",
                ErrorCode::PermissionDenied,
            ),
            ("org.bluez.Error.AlreadyExists", "", ErrorCode::Busy),
            ("org.bluez.Error.InProgress", "", ErrorCode::Busy),
            (
                "org.bluez.obex.Error.Failed",
                "Connection refused (111)",
                ErrorCode::Busy,
            ),
            ("org.freedesktop.DBus.Error.NoReply", "", ErrorCode::Timeout),
            (
                "org.freedesktop.DBus.Error.UnknownObject",
                "",
                ErrorCode::NotFound,
            ),
            (
                "org.bluez.obex.Error.Failed",
                "Unable to find service record",
                ErrorCode::NotFound,
            ),
            (
                "org.bluez.Error.InvalidArguments",
                "",
                ErrorCode::InvalidInput,
            ),
            (
                "org.bluez.Error.Failed",
                "something odd",
                ErrorCode::Internal,
            ),
        ];
        for (name, description, expected) in cases {
            assert_eq!(
                classify_dbus_error(name, description),
                expected,
                "{name} {description}"
            );
        }
    }
}
