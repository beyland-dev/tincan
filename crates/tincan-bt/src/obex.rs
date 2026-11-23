//! What MAP and PBAP share in obexd's client API (`org.bluez.obex` on the
//! **session** bus): opening and removing sessions, and file transfers.
//!
//! - `/org/bluez/obex` `Client1.CreateSession(s destination, a{sv} args) -> o`
//!   with `Target` (`map`, `pbap`), and `Client1.RemoveSession(o)`.
//! - Downloads and uploads go through private files under
//!   `$XDG_RUNTIME_DIR/tincan`; each returns a `Transfer1` object whose `Status`
//!   is watched through `PropertiesChanged` (obexd removes the object once it
//!   settles).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use crate::error::{Error, ErrorCode, Result, bus_unavailable};
use crate::map::validate_address;
use crate::props::{get_str, props_from_zbus};

pub const OBEX_SERVICE: &str = "org.bluez.obex";
pub const OBEX_CLIENT_PATH: &str = "/org/bluez/obex";

const TRANSFER_IFACE: &str = "org.bluez.obex.Transfer1";
const TRANSFER_POLL: Duration = Duration::from_millis(250);
const FILE_SETTLE: Duration = Duration::from_secs(2);

/// What obexd methods that start a transfer return: the transfer object and
/// its properties.
pub(crate) type TransferReply = (zbus::OwnedObjectPath, HashMap<String, zbus::OwnedVariant>);

#[zbus::proxy(
    interface = "org.bluez.obex.Client1",
    default_service = "org.bluez.obex",
    default_path = "/org/bluez/obex"
)]
trait ObexClient {
    fn create_session(
        &self,
        destination: &str,
        args: HashMap<&str, zbus::Variant<'_>>,
    ) -> zbus::Result<zbus::OwnedObjectPath>;

    fn remove_session(&self, session: &zbus::ObjectPath<'_>) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.bluez.obex.Transfer1",
    default_service = "org.bluez.obex"
)]
trait Transfer {
    #[zbus(property)]
    fn status(&self) -> zbus::Result<String>;
}

/// Connects to the session bus, where obexd (and the notification server)
/// live. `NOT_CONNECTED` without one.
pub async fn session_bus() -> Result<zbus::Connection> {
    zbus::Connection::session()
        .await
        .map_err(|e| bus_unavailable("session", &e))
}

/// How a transfer ended, from its `Status` property.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferState {
    Pending,
    Complete,
    Failed,
}

pub fn transfer_state(status: &str) -> TransferState {
    match status {
        "complete" => TransferState::Complete,
        "error" => TransferState::Failed,
        _ => TransferState::Pending,
    }
}

/// How a watched transfer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransferEnd {
    Complete,
    /// The object went away before a final status was seen.
    Vanished,
    TimedOut,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A private file under `$XDG_RUNTIME_DIR/tincan` that is removed when dropped.
struct TempFile(PathBuf);

impl TempFile {
    fn ensure_private_dir(dir: &Path) -> Result<()> {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                format!("{} is not a directory.", dir.display()),
            ));
        }
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        if meta.uid() != uid {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                format!("{} is owned by another user.", dir.display()),
            ));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                format!("{} must have mode 0700.", dir.display()),
            ));
        }
        Ok(())
    }

    fn path_for(prefix: &str, extension: &str) -> Result<PathBuf> {
        let dir = match std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
            Some(runtime) => PathBuf::from(runtime).join("tincan"),
            None => {
                // SAFETY: `geteuid` has no preconditions and cannot fail.
                let uid = unsafe { libc::geteuid() };
                std::env::temp_dir().join(format!("tincan-{uid}"))
            }
        };
        Self::ensure_private_dir(&dir)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        Ok(dir.join(format!(
            "{prefix}-{}-{n}-{nanos}.{extension}",
            std::process::id()
        )))
    }

    /// A path for obexd to create (downloads).
    fn reserve(prefix: &str, extension: &str) -> Result<Self> {
        Ok(Self(Self::path_for(prefix, extension)?))
    }

    /// A new 0600 file holding `contents` (uploads).
    fn with_contents(prefix: &str, extension: &str, contents: &[u8]) -> Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let this = Self(Self::path_for(prefix, extension)?);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&this.0)?;
        file.write_all(contents)?;
        file.sync_all()?;
        Ok(this)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn path_str(&self) -> Result<String> {
        self.0
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::new(ErrorCode::Internal, "Temp path is not UTF-8."))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// An open obexd client session for one profile.
pub(crate) struct ObexSession {
    connection: zbus::Connection,
    path: zbus::OwnedObjectPath,
    /// `MAP` or `PBAP`, for messages.
    profile: &'static str,
    pub(crate) transfer_timeout: Duration,
    closed: AtomicBool,
}

impl ObexSession {
    /// `CreateSession` with `Target = target`. **Talks to the phone.**
    pub(crate) async fn create(
        connection: zbus::Connection,
        address: &str,
        target: &str,
        profile: &'static str,
        transfer_timeout: Duration,
    ) -> Result<Self> {
        validate_address(address)?;
        let client = ObexClientProxy::new(&connection).await?;
        let args = HashMap::from([("Target", zbus::Variant::from(target))]);
        let path = client.create_session(address, args).await?;
        tracing::debug!(profile, session = %path, device = %crate::redact::address(address), "OBEX session created");
        Ok(Self {
            connection,
            path,
            profile,
            transfer_timeout,
            closed: AtomicBool::new(false),
        })
    }

    pub(crate) fn connection(&self) -> &zbus::Connection {
        &self.connection
    }

    pub(crate) fn path(&self) -> &zbus::OwnedObjectPath {
        &self.path
    }

    /// Downloads into a private temp file: `start` gets the target path and
    /// starts the transfer. Returns the file's bytes once it settles; a file
    /// still empty after [`FILE_SETTLE`] comes back empty. A download larger
    /// than `max_size` bytes fails with `INTERNAL`.
    ///
    /// Only the reserved path is ever read (and removed): a `Filename` in
    /// obexd's reply that names any other file is refused, so whatever owns
    /// `org.bluez.obex` on the session bus can't make Tincan read or delete
    /// an arbitrary file.
    pub(crate) async fn download<F, Fut>(
        &self,
        prefix: &str,
        extension: &str,
        max_size: u64,
        start: F,
    ) -> Result<Vec<u8>>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = zbus::Result<TransferReply>>,
    {
        let file = TempFile::reserve(prefix, extension)?;
        let mut watch = self.transfer_watch().await?;
        let (transfer, props) = start(file.path_str()?).await?;
        check_reported_filename(
            file.path(),
            get_str(&props_from_zbus(&props), "Filename").as_deref(),
        )?;
        let end = self.wait_for_transfer(&mut watch, &transfer).await?;
        if end == TransferEnd::TimedOut {
            return Err(Error::new(
                ErrorCode::Timeout,
                format!("The {} download timed out.", self.profile),
            ));
        }
        read_settled(file.path(), max_size, self.profile).await
    }

    /// Uploads `contents` from a private temp file: `start` gets its path and
    /// starts the transfer.
    pub(crate) async fn upload<F, Fut>(
        &self,
        prefix: &str,
        extension: &str,
        contents: &[u8],
        start: F,
    ) -> Result<TransferEnd>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = zbus::Result<TransferReply>>,
    {
        let file = TempFile::with_contents(prefix, extension, contents)?;
        let mut watch = self.transfer_watch().await?;
        let (transfer, _props) = start(file.path_str()?).await?;
        self.wait_for_transfer(&mut watch, &transfer).await
    }

    /// Subscribes to transfer status changes under this session. Created
    /// before the call that starts a transfer, so a fast transfer's final
    /// status can't be missed.
    async fn transfer_watch(&self) -> Result<zbus::MessageStream> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")
            .member("PropertiesChanged")
            .path_namespace(self.path.as_str())
            .arg(0, TRANSFER_IFACE)
            .build()?;
        Ok(zbus::MessageStream::for_match_rule(rule, &self.connection, None).await?)
    }

    async fn wait_for_transfer(
        &self,
        watch: &mut zbus::MessageStream,
        transfer: &zbus::OwnedObjectPath,
    ) -> Result<TransferEnd> {
        use futures_util::StreamExt;
        let proxy = TransferProxy::builder(&self.connection)
            .path(transfer.as_ref())
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?;
        let deadline = tokio::time::Instant::now() + self.transfer_timeout;
        // One poll first: the transfer may have settled before the reply.
        let mut poll_now = true;
        loop {
            if poll_now {
                match proxy.status().await {
                    Ok(status) => match transfer_state(&status) {
                        TransferState::Complete => return Ok(TransferEnd::Complete),
                        TransferState::Failed => return Err(self.transfer_failed()),
                        TransferState::Pending => {}
                    },
                    Err(err) => {
                        let err = Error::from(err);
                        if err.code() == ErrorCode::NotFound {
                            return Ok(TransferEnd::Vanished);
                        }
                        return Err(err);
                    }
                }
            }
            tokio::select! {
                message = watch.next() => {
                    poll_now = false;
                    let Some(Ok(message)) = message else { continue };
                    if message.header().path().map(|p| p.as_str()) != Some(transfer.as_str()) {
                        continue;
                    }
                    let Ok((_, changed, _)) = message
                        .body()
                        .deserialize::<(String, HashMap<String, zbus::OwnedVariant>, Vec<String>)>()
                    else {
                        continue;
                    };
                    if let Some(status) = get_str(&props_from_zbus(&changed), "Status") {
                        match transfer_state(&status) {
                            TransferState::Complete => return Ok(TransferEnd::Complete),
                            TransferState::Failed => return Err(self.transfer_failed()),
                            TransferState::Pending => {}
                        }
                    }
                }
                () = tokio::time::sleep(TRANSFER_POLL) => poll_now = true,
                () = tokio::time::sleep_until(deadline) => return Ok(TransferEnd::TimedOut),
            }
        }
    }

    fn transfer_failed(&self) -> Error {
        Error::new(
            ErrorCode::Internal,
            format!("The {} transfer failed.", self.profile),
        )
    }

    pub(crate) async fn remove(&self) -> Result<()> {
        let client = ObexClientProxy::new(&self.connection).await?;
        client.remove_session(&self.path.as_ref()).await?;
        Ok(())
    }

    /// `RemoveSession`. Closing twice is a no-op.
    pub(crate) async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.remove().await
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

impl Drop for ObexSession {
    fn drop(&mut self) {
        if !*self.closed.get_mut() {
            tracing::warn!(profile = self.profile, session = %self.path, "OBEX session dropped without close()");
        }
    }
}

/// Accepts obexd's reported download path only when it is the path Tincan
/// reserved (or the same file reached through a different spelling of the
/// private directory). No report means obexd used the path it was given.
fn check_reported_filename(reserved: &Path, reported: Option<&str>) -> Result<()> {
    let Some(reported) = reported else {
        return Ok(());
    };
    let reported = Path::new(reported);
    if reported == reserved {
        return Ok(());
    }
    let same_dir = || -> Option<bool> {
        let canonical = |p: &Path| std::fs::canonicalize(p.parent()?).ok();
        Some(canonical(reported)? == canonical(reserved)?)
    };
    if reported.is_absolute()
        && reported.file_name().is_some()
        && reported.file_name() == reserved.file_name()
        && same_dir() == Some(true)
    {
        return Ok(());
    }
    Err(Error::new(
        ErrorCode::Internal,
        "obexd reported a download file other than the one Tincan reserved; refusing to read it.",
    ))
}

/// Opens a downloaded file without following a symlink (or blocking on a
/// FIFO) and reads at most `max_size` bytes of it into one buffer sized
/// from its length.
fn read_capped(path: &Path, max_size: u64, profile: &str) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::other(format!(
            "The {profile} download is not a regular file."
        )));
    }
    if metadata.len() > max_size {
        return Err(too_large(profile, max_size));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    // One byte past the cap tells a file that grew past it from one that
    // ended exactly there.
    file.take(max_size.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_size {
        return Err(too_large(profile, max_size));
    }
    Ok(bytes)
}

fn too_large(profile: &str, max_size: u64) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::FileTooLarge,
        format!(
            "The {profile} download is larger than the {} MiB limit.",
            max_size / (1024 * 1024)
        ),
    )
}

/// Reads a downloaded file, allowing obexd up to [`FILE_SETTLE`] to finish
/// writing it after the transfer reports complete.
async fn read_settled(path: &Path, max_size: u64, profile: &str) -> Result<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + FILE_SETTLE;
    loop {
        let owned = (path.to_owned(), profile.to_owned());
        let read = tokio::task::spawn_blocking(move || read_capped(&owned.0, max_size, &owned.1))
            .await
            .unwrap_or_else(|_| Err(std::io::Error::other("reading the download panicked")));
        match read {
            Ok(bytes) if !bytes.is_empty() => return Ok(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::FileTooLarge => {
                return Err(Error::new(ErrorCode::Internal, err.to_string()));
            }
            Ok(_) | Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(TRANSFER_POLL).await;
            }
            Ok(bytes) => return Ok(bytes),
            Err(err) => return Err(err.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_transfer_states() {
        assert_eq!(transfer_state("complete"), TransferState::Complete);
        assert_eq!(transfer_state("error"), TransferState::Failed);
        assert_eq!(transfer_state("active"), TransferState::Pending);
        assert_eq!(transfer_state("queued"), TransferState::Pending);
    }

    #[test]
    fn only_reads_the_reserved_download_file() {
        let reserved = TempFile::reserve("test-dl", "bin").expect("reserve");
        let path = reserved.path();
        let as_str = path.to_str().expect("utf-8");
        assert!(check_reported_filename(path, None).is_ok());
        assert!(check_reported_filename(path, Some(as_str)).is_ok());
        let dir = path.parent().expect("dir");
        let name = path.file_name().expect("name").to_str().expect("utf-8");
        let respelled = format!("{}/./{name}", dir.display());
        assert!(check_reported_filename(path, Some(&respelled)).is_ok());
        for other in [
            "/etc/passwd".to_string(),
            format!(
                "{}/.ssh/id_ed25519",
                std::env::var("HOME").unwrap_or_default()
            ),
            format!("{}/other.bin", dir.display()),
            format!("{}/../{name}", dir.display()),
            name.to_string(),
            String::new(),
        ] {
            let err = check_reported_filename(path, Some(&other)).expect_err(&other);
            assert_eq!(err.code(), ErrorCode::Internal);
        }
    }

    #[tokio::test]
    async fn caps_the_download_size() {
        let file = TempFile::with_contents("test-cap", "bin", &[7u8; 2048]).expect("file");
        let bytes = read_settled(file.path(), 2048, "TEST")
            .await
            .expect("at cap");
        assert_eq!(bytes.len(), 2048);
        let err = read_settled(file.path(), 2047, "TEST")
            .await
            .expect_err("over");
        assert_eq!(err.code(), ErrorCode::Internal);
        assert!(err.message().contains("limit"), "{}", err.message());
    }

    #[tokio::test]
    async fn never_follows_a_symlinked_download() {
        let target = TempFile::with_contents("test-target", "bin", b"secret").expect("file");
        let link = TempFile::reserve("test-link", "bin").expect("reserve");
        std::os::unix::fs::symlink(target.path(), link.path()).expect("symlink");
        tokio::time::pause();
        let err = read_settled(link.path(), 1024, "TEST")
            .await
            .expect_err("symlink");
        assert_ne!(err.code(), ErrorCode::NotFound);
        assert!(target.path().exists());
    }

    #[test]
    fn rejects_shared_or_symlinked_temp_dir() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = std::env::temp_dir().join(format!("tincan-obex-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ok_dir = root.join("private");
        TempFile::ensure_private_dir(&ok_dir).expect("private dir ok");

        let shared = root.join("shared");
        std::fs::create_dir_all(&shared).expect("create");
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert_eq!(
            TempFile::ensure_private_dir(&shared)
                .expect_err("shared rejected")
                .code(),
            ErrorCode::PermissionDenied
        );

        let link = root.join("link");
        symlink(&ok_dir, &link).expect("symlink");
        assert_eq!(
            TempFile::ensure_private_dir(&link)
                .expect_err("symlink rejected")
                .code(),
            ErrorCode::PermissionDenied
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
