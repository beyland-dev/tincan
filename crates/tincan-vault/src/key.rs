//! The vault key: 32 random bytes used as a raw SQLCipher key (no KDF), kept in
//! the Secret Service, or in a 0600 file when there is no keyring.

use std::collections::HashMap;
use std::fmt;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::error::{Error, ErrorCode, Result};
use crate::secret_service::SecretService;

pub const KEY_LEN: usize = 32;
const SCHEMA: &str = "dev.beyland.Tincan.VaultKey";
const CONTENT_TYPE: &str = "text/plain";

/// A vault key. Wiped from memory on drop; `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct VaultKey(Zeroizing<[u8; KEY_LEN]>);

impl fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VaultKey(..)")
    }
}

impl VaultKey {
    /// A new key from the kernel's CSPRNG.
    pub fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        let mut filled = 0;
        while filled < KEY_LEN {
            let rest = &mut bytes[filled..];
            // SAFETY: `rest` is a valid, writable buffer of `rest.len()` bytes.
            let n = unsafe { libc::getrandom(rest.as_mut_ptr().cast(), rest.len(), 0) };
            if n < 0 {
                let err = std::io::Error::last_os_error();
                if err.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(Error::new(
                    ErrorCode::Internal,
                    format!("getrandom failed: {err}"),
                ));
            }
            filled += n as usize;
        }
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Parses 64 hex digits, ignoring surrounding whitespace.
    pub fn from_hex(text: &[u8]) -> Result<Self> {
        let text = text.trim_ascii();
        if text.len() != KEY_LEN * 2 {
            return Err(Error::new(
                ErrorCode::InvalidInput,
                "a vault key is 64 hex digits",
            ));
        }
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        for (i, pair) in text.as_chunks::<2>().0.iter().enumerate() {
            let hi = hex_value(pair[0]);
            let lo = hex_value(pair[1]);
            match (hi, lo) {
                (Some(hi), Some(lo)) => bytes[i] = (hi << 4) | lo,
                _ => {
                    return Err(Error::new(
                        ErrorCode::InvalidInput,
                        "a vault key is 64 hex digits",
                    ));
                }
            }
        }
        Ok(Self(bytes))
    }

    /// Lowercase hex, 64 digits.
    pub fn to_hex(&self) -> Zeroizing<String> {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = Zeroizing::new(String::with_capacity(KEY_LEN * 2));
        for byte in self.0.iter() {
            out.push(DIGITS[usize::from(byte >> 4)] as char);
            out.push(DIGITS[usize::from(byte & 0xf)] as char);
        }
        out
    }

    /// The `PRAGMA key` statement for this raw key, built in one buffer of
    /// exactly the right size so no reallocation leaves a copy behind.
    pub(crate) fn pragma(&self) -> Zeroizing<String> {
        const HEAD: &str = "PRAGMA key = \"x'";
        const TAIL: &str = "'\";";
        let mut out = Zeroizing::new(String::with_capacity(HEAD.len() + KEY_LEN * 2 + TAIL.len()));
        out.push_str(HEAD);
        out.push_str(self.to_hex().as_str());
        out.push_str(TAIL);
        out
    }
}

fn hex_value(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        b'A'..=b'F' => Some(digit - b'A' + 10),
        _ => None,
    }
}

/// Where the key came from (reported by `doctor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyLocation {
    SecretService,
    /// The fallback file; `doctor` warns about it.
    File(PathBuf),
}

/// How to find (or create) a vault's key.
#[derive(Debug, Clone)]
pub struct KeyOptions {
    /// Identifies the vault among Tincan's keyring items (`"default"`).
    pub id: String,
    /// The fallback key file. If it exists it wins, so a vault that once fell
    /// back keeps opening when a keyring appears later.
    pub key_file: PathBuf,
    /// Whether a missing key may be created. Pass `false` when the database
    /// already exists: a new key could never open it.
    pub allow_create: bool,
}

impl KeyOptions {
    /// Options for the vault at `db_path`: the key file sits next to it, and a
    /// key is only created when the database doesn't exist yet.
    pub fn for_database(db_path: &Path, id: &str) -> Self {
        Self {
            id: id.to_owned(),
            key_file: db_path.with_extension("key"),
            allow_create: !db_path.exists(),
        }
    }

    fn attributes(&self) -> HashMap<&str, &str> {
        HashMap::from([("xdg:schema", SCHEMA), ("vault", self.id.as_str())])
    }

    fn label(&self) -> String {
        format!("Tincan vault key ({})", self.id)
    }
}

/// Finds or creates the key: the key file if present, else the Secret Service,
/// else (no keyring at all) a new key file.
pub async fn load_or_create(options: &KeyOptions) -> Result<(VaultKey, KeyLocation)> {
    if key_file_present(&options.key_file) {
        return load_key_file(options);
    }
    let service = SecretService::connect().await;
    load_or_create_with(service, options).await
}

/// [`load_or_create`] with an already-connected (or failed) Secret Service.
pub async fn load_or_create_with(
    service: Result<SecretService>,
    options: &KeyOptions,
) -> Result<(VaultKey, KeyLocation)> {
    if key_file_present(&options.key_file) {
        return load_key_file(options);
    }
    let service = match service {
        Ok(service) => service,
        Err(err) if err.code() == ErrorCode::NotConnected => {
            tracing::warn!("no Secret Service; using a key file");
            return create_key_file(options);
        }
        Err(err) => return Err(err),
    };
    let result = from_service(&service, options).await;
    let _ = service.close().await;
    match result {
        Err(err) if matches!(err.code(), ErrorCode::NotConnected | ErrorCode::NotFound) => {
            tracing::warn!(code = %err.code(), "keyring unusable; using a key file");
            create_key_file(options)
        }
        other => other,
    }
}

async fn from_service(
    service: &SecretService,
    options: &KeyOptions,
) -> Result<(VaultKey, KeyLocation)> {
    if let Some(secret) = service.find(&options.attributes()).await? {
        return Ok((VaultKey::from_hex(&secret)?, KeyLocation::SecretService));
    }
    if !options.allow_create {
        return Err(missing_key());
    }
    let key = VaultKey::generate()?;
    store_and_verify(service, options, &key).await?;
    Ok((key, KeyLocation::SecretService))
}

async fn store_and_verify(
    service: &SecretService,
    options: &KeyOptions,
    key: &VaultKey,
) -> Result<()> {
    let attributes = options.attributes();
    service
        .store(
            &options.label(),
            &attributes,
            key.to_hex().as_bytes(),
            CONTENT_TYPE,
        )
        .await?;
    // Read it back: a keyring that accepts writes but loses them would
    // otherwise leave an unopenable vault behind.
    match service.find(&attributes).await? {
        Some(secret) if VaultKey::from_hex(&secret)? == *key => Ok(()),
        _ => Err(Error::new(
            ErrorCode::Internal,
            "the keyring did not return the stored vault key",
        )),
    }
}

/// Removes this vault's key from the Secret Service (tests, `tincan reset`).
pub async fn delete_from_service(service: &SecretService, options: &KeyOptions) -> Result<usize> {
    service.delete(&options.attributes()).await
}

fn missing_key() -> Error {
    Error::new(
        ErrorCode::NotFound,
        "the vault exists but its key is missing from the keyring",
    )
}

/// Whether something (a file, a symlink, anything) sits at the key path.
/// Unlike `Path::exists`, a dangling symlink counts, so it is refused by
/// [`read_key_file`] instead of silently replaced.
fn key_file_present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// A key file never holds more than the hex key and a line break.
const MAX_KEY_FILE: u64 = 4096;

fn key_file_error(code: ErrorCode, path: &Path, problem: &str) -> Error {
    Error::new(code, format!("{}: {problem}", path.display()))
}

/// Reads and checks the key file without following a symlink at `path`: it
/// must be a regular file owned by this user with no group or other
/// permissions. A looser mode is refused rather than tightened, because the
/// key may already have been read by someone else; the user decides.
fn read_key_file(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    // O_NONBLOCK keeps a FIFO planted at the path from blocking the open; it
    // has no effect on the regular file this goes on to require.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
        .map_err(|err| {
            if err.raw_os_error() == Some(libc::ELOOP) {
                key_file_error(
                    ErrorCode::PermissionDenied,
                    path,
                    "is a symlink; refusing to follow it",
                )
            } else {
                err.into()
            }
        })?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(key_file_error(
            ErrorCode::PermissionDenied,
            path,
            "is not a regular file",
        ));
    }
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(key_file_error(
            ErrorCode::PermissionDenied,
            path,
            "is owned by another user",
        ));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(key_file_error(
            ErrorCode::PermissionDenied,
            path,
            "is readable by other users; chmod 600 it",
        ));
    }
    let mut text = Zeroizing::new(Vec::with_capacity(128));
    file.take(MAX_KEY_FILE).read_to_end(&mut text)?;
    Ok(text)
}

/// The key in an existing key file. An empty file is what an interrupted
/// first run of an older Tincan left behind: when no database exists yet
/// (`allow_create`), nothing can depend on it and a new key replaces it.
fn load_key_file(options: &KeyOptions) -> Result<(VaultKey, KeyLocation)> {
    let path = &options.key_file;
    let text = read_key_file(path)?;
    if text.trim_ascii().is_empty() {
        if options.allow_create {
            tracing::warn!(
                "the vault key file is empty and no vault exists yet; creating a new key"
            );
            std::fs::remove_file(path)?;
            return create_key_file(options);
        }
        return Err(key_file_error(
            ErrorCode::NotFound,
            path,
            "is empty, so the vault cannot be opened. Restore the key file from a backup, \
             or move the vault and its key file aside to start over with an empty vault",
        ));
    }
    let key = VaultKey::from_hex(&text).map_err(|_| {
        key_file_error(
            ErrorCode::InvalidInput,
            path,
            "does not hold a vault key (64 hex digits). Restore it from a backup, \
             or move the vault and its key file aside to start over with an empty vault",
        )
    })?;
    Ok((key, KeyLocation::File(path.clone())))
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Creates the key file crash-safely: the key is written and fsynced to a new
/// 0600 temp file in the same directory, hard-linked into place (which fails
/// if a key file appeared meanwhile, so an existing key is never replaced),
/// and the directory is fsynced. A crash leaves either no key file or a
/// complete one, never an empty one.
fn create_key_file(options: &KeyOptions) -> Result<(VaultKey, KeyLocation)> {
    if !options.allow_create {
        return Err(missing_key());
    }
    let path = &options.key_file;
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_owned(),
        _ => PathBuf::from("."),
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let name = path.file_name().ok_or_else(|| {
        Error::new(
            ErrorCode::InvalidInput,
            "the key file path has no file name",
        )
    })?;
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let temp = dir.join(temp_name);

    let key = VaultKey::generate()?;
    let written = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)?;
        let mut text = Zeroizing::new(String::with_capacity(KEY_LEN * 2 + 1));
        text.push_str(key.to_hex().as_str());
        text.push('\n');
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })()
    .and_then(|()| Ok(std::fs::hard_link(&temp, path)?));
    let _ = std::fs::remove_file(&temp);
    match written {
        Ok(()) => {}
        // Another process created the key first: use theirs.
        Err(err) if err.code() == ErrorCode::Conflict => return load_key_file(options),
        Err(err) => return Err(err),
    }
    std::fs::File::open(&dir)?.sync_all()?;
    Ok((key, KeyLocation::File(path.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn round_trips_hex() {
        let key = VaultKey::generate().expect("key");
        let hex = key.to_hex();
        assert_eq!(hex.len(), 64);
        assert_eq!(VaultKey::from_hex(hex.as_bytes()).expect("parse"), key);
        assert_eq!(
            VaultKey::from_hex(format!(" {}\n", hex.to_uppercase()).as_bytes()).expect("upper"),
            key
        );
        assert_ne!(VaultKey::generate().expect("key"), key);
    }

    #[test]
    fn rejects_bad_hex() {
        for bad in [&b"abc"[..], &[b'z'; 64][..], &[b'0'; 65][..]] {
            assert_eq!(
                VaultKey::from_hex(bad).expect_err("bad").code(),
                ErrorCode::InvalidInput
            );
        }
    }

    #[test]
    fn debug_hides_the_key() {
        let key = VaultKey::from_bytes([0xab; KEY_LEN]);
        assert_eq!(format!("{key:?}"), "VaultKey(..)");
        assert!(key.pragma().contains("x'abab"));
    }

    fn options(dir: &Path, allow_create: bool) -> KeyOptions {
        KeyOptions {
            id: "test".into(),
            key_file: dir.join("sub/vault.key"),
            allow_create,
        }
    }

    fn no_bus() -> Result<SecretService> {
        Err(Error::new(ErrorCode::NotConnected, "no bus"))
    }

    #[tokio::test]
    async fn falls_back_to_a_private_key_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        let (key, location) = load_or_create_with(no_bus(), &opts).await.expect("create");
        assert_eq!(location, KeyLocation::File(opts.key_file.clone()));
        let mode = |p: &Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode(&opts.key_file), 0o600);
        assert_eq!(mode(opts.key_file.parent().expect("dir")), 0o700);

        let (again, _) = load_or_create_with(no_bus(), &options(dir.path(), false))
            .await
            .expect("reload");
        assert_eq!(again, key);
    }

    #[tokio::test]
    async fn never_creates_a_key_for_an_existing_vault() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = load_or_create_with(no_bus(), &options(dir.path(), false))
            .await
            .expect_err("missing");
        assert_eq!(err.code(), ErrorCode::NotFound);
        assert!(!dir.path().join("sub/vault.key").exists());
    }

    #[tokio::test]
    async fn refuses_a_shared_key_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        load_or_create_with(no_bus(), &opts).await.expect("create");
        std::fs::set_permissions(&opts.key_file, std::fs::Permissions::from_mode(0o644))
            .expect("chmod");
        let err = load_or_create_with(no_bus(), &opts)
            .await
            .expect_err("shared");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }

    #[tokio::test]
    async fn propagates_keyring_refusals() {
        let dir = tempfile::tempdir().expect("tempdir");
        let refused = Err(Error::new(ErrorCode::PermissionDenied, "dismissed"));
        let err = load_or_create_with(refused, &options(dir.path(), true))
            .await
            .expect_err("refused");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert!(!dir.path().join("sub/vault.key").exists());
    }

    #[tokio::test]
    async fn creates_the_key_file_without_leftovers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        load_or_create_with(no_bus(), &opts).await.expect("create");
        let names: Vec<_> = std::fs::read_dir(opts.key_file.parent().expect("dir"))
            .expect("list")
            .map(|e| e.expect("entry").file_name())
            .collect();
        assert_eq!(names, ["vault.key"]);
        let text = std::fs::read_to_string(&opts.key_file).expect("read");
        assert_eq!(text.len(), 65);
        assert!(text.ends_with('\n'));
    }

    #[tokio::test]
    async fn never_replaces_an_existing_key_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        let (key, _) = load_or_create_with(no_bus(), &opts).await.expect("create");
        // A creator that lost the race (the file appeared after its check).
        let (again, _) = create_key_file(&opts).expect("lost race");
        assert_eq!(again, key);
    }

    #[tokio::test]
    async fn refuses_a_symlinked_key_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        let target = dir.path().join("real.key");
        std::fs::write(&target, format!("{}\n", "ab".repeat(32))).expect("write");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        std::fs::create_dir_all(opts.key_file.parent().expect("dir")).expect("mkdir");
        std::os::unix::fs::symlink(&target, &opts.key_file).expect("symlink");
        let err = load_or_create_with(no_bus(), &opts)
            .await
            .expect_err("symlink");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert!(err.message().contains("symlink"));

        // A dangling symlink is refused too, not replaced by a new key.
        std::fs::remove_file(&target).expect("rm");
        let err = load_or_create_with(no_bus(), &opts)
            .await
            .expect_err("dangling");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn refuses_a_fifo_or_directory_without_hanging() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), true);
        std::fs::create_dir_all(opts.key_file.parent().expect("dir")).expect("mkdir");
        let c_path =
            std::ffi::CString::new(opts.key_file.as_os_str().as_encoded_bytes()).expect("c path");
        // SAFETY: `c_path` is a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            load_or_create_with(no_bus(), &opts),
        )
        .await
        .expect("does not hang")
        .expect_err("fifo");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert!(err.message().contains("not a regular file"));

        std::fs::remove_file(&opts.key_file).expect("rm");
        std::fs::create_dir(&opts.key_file).expect("dir");
        let err = load_or_create_with(no_bus(), &opts).await.expect_err("dir");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }

    #[tokio::test]
    async fn recovers_an_empty_key_file_only_before_a_vault_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), false);
        std::fs::create_dir_all(opts.key_file.parent().expect("dir")).expect("mkdir");
        std::fs::write(&opts.key_file, b"").expect("write");
        std::fs::set_permissions(&opts.key_file, std::fs::Permissions::from_mode(0o600))
            .expect("chmod");
        let err = load_or_create_with(no_bus(), &opts)
            .await
            .expect_err("empty");
        assert_eq!(err.code(), ErrorCode::NotFound);
        assert!(err.message().contains("is empty"), "{}", err.message());
        assert!(opts.key_file.exists());

        let opts = options(dir.path(), true);
        let (key, location) = load_or_create_with(no_bus(), &opts).await.expect("recover");
        assert_eq!(location, KeyLocation::File(opts.key_file.clone()));
        let (again, _) = load_or_create_with(no_bus(), &options(dir.path(), false))
            .await
            .expect("reload");
        assert_eq!(again, key);
    }

    #[tokio::test]
    async fn explains_a_truncated_key_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let opts = options(dir.path(), false);
        std::fs::create_dir_all(opts.key_file.parent().expect("dir")).expect("mkdir");
        std::fs::write(&opts.key_file, b"abcd").expect("write");
        std::fs::set_permissions(&opts.key_file, std::fs::Permissions::from_mode(0o600))
            .expect("chmod");
        let err = load_or_create_with(no_bus(), &opts)
            .await
            .expect_err("short");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("backup"));
    }
}
