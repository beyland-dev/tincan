//! The encrypted database. The schema and queries live in TypeScript
//! (`@beyland/tincan-core`); this is a thin, typed connection.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags, params_from_iter};

use crate::error::{Error, ErrorCode, Result};
use crate::key::VaultKey;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// A SQL value (parameter or column).
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<ValueRef<'_>> for SqlValue {
    fn from(value: ValueRef<'_>) -> Self {
        match value {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(n) => Self::Integer(n),
            ValueRef::Real(n) => Self::Real(n),
            ValueRef::Text(t) => Self::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Self::Blob(b.to_vec()),
        }
    }
}

impl From<&SqlValue> for Value {
    fn from(value: &SqlValue) -> Self {
        match value {
            SqlValue::Null => Value::Null,
            SqlValue::Integer(n) => Value::Integer(*n),
            SqlValue::Real(n) => Value::Real(*n),
            SqlValue::Text(t) => Value::Text(t.clone()),
            SqlValue::Blob(b) => Value::Blob(b.clone()),
        }
    }
}

/// The result of a statement that doesn't return rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Changes {
    pub changes: u64,
    pub last_insert_rowid: i64,
}

/// Query results: column names once, then rows in column order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
}

/// An open, keyed SQLCipher database.
#[derive(Debug)]
pub struct Vault {
    connection: Connection,
    path: Option<PathBuf>,
}

impl Vault {
    /// Opens (creating if needed) the database at `path` with `key`. Fails with
    /// `PERMISSION_DENIED` when the key doesn't match.
    pub fn open(path: &Path, key: &VaultKey) -> Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
        }
        let connection = Connection::open_with_flags(
            plain_filename(path),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        restrict_permissions(path)?;
        let vault = Self::keyed(connection, key, Some(path.to_owned()))?;
        vault
            .connection
            .pragma_update(None, "journal_mode", "WAL")?;
        Ok(vault)
    }

    /// An encrypted in-memory database (tests).
    pub fn open_in_memory(key: &VaultKey) -> Result<Self> {
        Self::keyed(Connection::open_in_memory()?, key, None)
    }

    fn keyed(connection: Connection, key: &VaultKey, path: Option<PathBuf>) -> Result<Self> {
        // SQLCipher logs decrypt failures to stderr itself; a wrong key is
        // reported through the returned error instead.
        connection.execute_batch("PRAGMA cipher_log_level = NONE;")?;
        connection.execute_batch(key.pragma().as_str())?;
        // The first read decrypts page 1: a wrong key fails here, not later.
        connection.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
        let version: String = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(|_| Error::new(ErrorCode::Internal, "SQLCipher is not linked"))?;
        if version.is_empty() {
            return Err(Error::new(ErrorCode::Internal, "SQLCipher is not linked"));
        }
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self { connection, path })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The SQLCipher version string.
    pub fn cipher_version(&self) -> Result<String> {
        Ok(self
            .connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))?)
    }

    /// Runs one statement with positional (`?`) parameters.
    pub fn exec(&self, sql: &str, params: &[SqlValue]) -> Result<Changes> {
        let mut statement = self.connection.prepare_cached(sql)?;
        let changes = statement.execute(params_from_iter(params.iter().map(Value::from)))?;
        Ok(Changes {
            changes: changes as u64,
            last_insert_rowid: self.connection.last_insert_rowid(),
        })
    }

    /// Runs several `;`-separated statements without parameters (migrations).
    pub fn exec_batch(&self, sql: &str) -> Result<()> {
        Ok(self.connection.execute_batch(sql)?)
    }

    /// Runs a query with positional parameters and collects every row.
    pub fn query(&self, sql: &str, params: &[SqlValue]) -> Result<Rows> {
        let mut statement = self.connection.prepare_cached(sql)?;
        let columns: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let width = columns.len();
        let mut rows = Vec::new();
        let mut cursor = statement.query(params_from_iter(params.iter().map(Value::from)))?;
        while let Some(row) = cursor.next()? {
            let mut values = Vec::with_capacity(width);
            for i in 0..width {
                values.push(SqlValue::from(row.get_ref(i)?));
            }
            rows.push(values);
        }
        Ok(Rows { columns, rows })
    }

    /// Whether a transaction is open.
    pub fn in_transaction(&self) -> bool {
        !self.connection.is_autocommit()
    }

    pub fn begin(&self) -> Result<()> {
        if self.in_transaction() {
            return Err(Error::new(
                ErrorCode::InvalidInput,
                "a transaction is already open",
            ));
        }
        self.exec_batch("BEGIN IMMEDIATE")
    }

    pub fn commit(&self) -> Result<()> {
        self.exec_batch("COMMIT")
    }

    pub fn rollback(&self) -> Result<()> {
        if self.in_transaction() {
            self.exec_batch("ROLLBACK")?;
        }
        Ok(())
    }

    /// Runs `body` in an immediate transaction: committed if it returns `Ok`,
    /// rolled back otherwise.
    pub fn transaction<T>(&self, body: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        self.begin()?;
        match body(self) {
            Ok(value) => {
                self.commit()?;
                Ok(value)
            }
            Err(err) => {
                self.rollback()?;
                Err(err)
            }
        }
    }

    pub fn close(self) -> Result<()> {
        self.connection.close().map_err(|(_, err)| Error::from(err))
    }
}

/// The bundled SQLite is built with `SQLITE_USE_URI`, so a filename that
/// starts with `file:` is parsed as a URI (whose query could set `vfs`,
/// `mode`, …) even without `SQLITE_OPEN_URI`. Such a (relative) path gets a
/// `./` prefix so it is read as a plain filename, like every other path.
fn plain_filename(path: &Path) -> PathBuf {
    if path.as_os_str().as_encoded_bytes().starts_with(b"file:") {
        Path::new(".").join(path)
    } else {
        path.to_owned()
    }
}

fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if path.as_os_str().is_empty() || path.to_str().is_some_and(|p| p.starts_with(':')) {
        return Ok(());
    }
    let permissions = std::fs::metadata(path)?.permissions();
    if permissions.mode() & 0o077 != 0 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> VaultKey {
        VaultKey::from_bytes([byte; crate::key::KEY_LEN])
    }

    #[test]
    fn a_file_colon_path_is_a_plain_filename() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = std::env::current_dir().expect("cwd");
        let relative = Path::new("file:vault.db?vfs=unix-none&mode=memory");
        assert_eq!(plain_filename(relative), Path::new("./").join(relative));
        assert_eq!(plain_filename(&cwd), cwd);
        // Opened by absolute path inside the temp dir, the name is literal.
        let path = dir.path().join("file:x.db?mode=memory");
        Vault::open(&path, &key(3))
            .expect("open")
            .close()
            .expect("close");
        assert!(path.exists());
    }

    #[test]
    fn links_sqlcipher_with_fts5() {
        let vault = Vault::open_in_memory(&key(1)).expect("open");
        assert!(!vault.cipher_version().expect("version").is_empty());
        vault
            .exec_batch(
                "CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello there');",
            )
            .expect("fts5");
        let rows = vault
            .query(
                "SELECT count(*) FROM t WHERE t MATCH ?",
                &[SqlValue::Text("hello".into())],
            )
            .expect("match");
        assert_eq!(rows.rows, vec![vec![SqlValue::Integer(1)]]);
    }

    #[test]
    fn encrypts_at_rest_and_rejects_the_wrong_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("data/tincan.db");
        {
            let vault = Vault::open(&path, &key(7)).expect("open");
            vault
                .exec_batch("CREATE TABLE m (id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE)")
                .expect("schema");
            vault
                .exec(
                    "INSERT INTO m (body) VALUES (?)",
                    &[SqlValue::Text("plaintext-marker".into())],
                )
                .expect("insert");
            vault.close().expect("close");
        }
        let bytes = std::fs::read(&path).expect("read");
        assert!(!bytes.starts_with(b"SQLite format 3"));
        assert!(!bytes.windows(16).any(|w| w == b"plaintext-marker"));
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let err = Vault::open(&path, &key(8)).expect_err("wrong key");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);

        let vault = Vault::open(&path, &key(7)).expect("reopen");
        let rows = vault.query("SELECT id, body FROM m", &[]).expect("query");
        assert_eq!(rows.columns, ["id", "body"]);
        assert_eq!(
            rows.rows,
            vec![vec![
                SqlValue::Integer(1),
                SqlValue::Text("plaintext-marker".into())
            ]]
        );
    }

    #[test]
    fn maps_types_and_errors() {
        let vault = Vault::open_in_memory(&key(2)).expect("open");
        vault
            .exec_batch("CREATE TABLE v (i INTEGER, r REAL, t TEXT UNIQUE, b BLOB, n)")
            .expect("schema");
        let row = [
            SqlValue::Integer(-3),
            SqlValue::Real(1.5),
            SqlValue::Text("x".into()),
            SqlValue::Blob(vec![0, 1, 2]),
            SqlValue::Null,
        ];
        let changes = vault
            .exec("INSERT INTO v VALUES (?, ?, ?, ?, ?)", &row)
            .expect("insert");
        assert_eq!(
            changes,
            Changes {
                changes: 1,
                last_insert_rowid: 1
            }
        );
        assert_eq!(
            vault.query("SELECT * FROM v", &[]).expect("q").rows,
            vec![row.to_vec()]
        );

        let conflict = vault
            .exec(
                "INSERT INTO v (t) VALUES (?)",
                &[SqlValue::Text("x".into())],
            )
            .expect_err("unique");
        assert_eq!(conflict.code(), ErrorCode::Conflict);
        let bad = vault
            .exec("INSERT INTO v (t) VALUES (?)", &[])
            .expect_err("count");
        assert_eq!(bad.code(), ErrorCode::InvalidInput);
        let syntax = vault.query("SELEC 1", &[]).expect_err("syntax");
        assert!(matches!(
            syntax.code(),
            ErrorCode::InvalidInput | ErrorCode::Internal
        ));
    }

    #[test]
    fn transactions_commit_or_roll_back() {
        let vault = Vault::open_in_memory(&key(3)).expect("open");
        vault
            .exec_batch("CREATE TABLE c (n INTEGER)")
            .expect("schema");
        let count =
            |v: &Vault| v.query("SELECT count(*) FROM c", &[]).expect("q").rows[0][0].clone();

        vault
            .transaction(|v| v.exec("INSERT INTO c VALUES (1)", &[]).map(|_| ()))
            .expect("commit");
        assert_eq!(count(&vault), SqlValue::Integer(1));

        let err = vault
            .transaction(|v| {
                v.exec("INSERT INTO c VALUES (2)", &[])?;
                assert!(v.in_transaction());
                Err::<(), _>(Error::new(ErrorCode::Internal, "abort"))
            })
            .expect_err("rollback");
        assert_eq!(err.message(), "abort");
        assert_eq!(count(&vault), SqlValue::Integer(1));
        assert!(!vault.in_transaction());

        vault.begin().expect("begin");
        assert_eq!(
            vault.begin().expect_err("nested").code(),
            ErrorCode::InvalidInput
        );
        vault.rollback().expect("rollback");
    }
}
