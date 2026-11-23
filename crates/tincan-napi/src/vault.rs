//! `Vault`: the encrypted SQLCipher database, with its key in the Secret
//! Service (or a fallback key file). Statements are synchronous, like
//! better-sqlite3: they run on the JS thread against a local file.

use std::cell::RefCell;
use std::path::PathBuf;
use std::ptr;

use napi::bindgen_prelude::{
    Buffer, Function, JsObjectValue, JsValue, Null, Object, PromiseRaw, ToNapiValue,
    Uint8ArraySlice, Unknown, i64n,
};
use napi::{Env, Status, ValueType, sys};
use napi_derive::napi;
use tincan_vault::{KeyLocation, KeyOptions, SqlValue, VaultKey};

use crate::{Failure, catch, guard_as, spawn_js};

/// The largest integer a JS number holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// `Vault.open` options.
#[napi(object)]
pub struct VaultOpenOptions {
    /// Names this vault's keyring item (default `"default"`).
    pub id: Option<String>,
}

/// The result of a statement that doesn't return rows.
#[napi(object)]
pub struct VaultChanges {
    pub changes: i64,
    pub last_insert_rowid: i64,
}

/// A keyed SQLCipher database. Closed by `close()`; every call after that
/// throws `NOT_CONNECTED`.
#[napi]
pub struct Vault {
    // `RefCell`, not `&mut self`: `transaction` calls back into JS, which may
    // use the vault again. A borrow is never held across that call.
    inner: RefCell<Option<tincan_vault::Vault>>,
    key_storage: &'static str,
    key_file: Option<String>,
    path: Option<String>,
}

#[napi]
impl Vault {
    /// Opens (creating if needed) the database at `path`. The key comes from
    /// a `<path minus extension>.key` file if one exists, else the Secret
    /// Service (which may show an unlock prompt), else a new key file. A key
    /// is only created for a database that doesn't exist yet. Rejects
    /// `NOT_FOUND` when an existing database's key is missing,
    /// `PERMISSION_DENIED` for a dismissed prompt or a key that doesn't open
    /// it, and `INVALID_INPUT` for an empty path or id.
    #[napi(ts_return_type = "Promise<Vault>")]
    pub fn open<'env>(
        env: &'env Env,
        path: String,
        options: Option<VaultOpenOptions>,
    ) -> napi::Result<PromiseRaw<'env, Vault>> {
        let id = options
            .and_then(|o| o.id)
            .unwrap_or_else(|| "default".to_string());
        spawn_js(
            env,
            async move {
                if path.is_empty() || id.is_empty() {
                    return Err(Failure::new(
                        "INVALID_INPUT",
                        "The vault path and id must not be empty.",
                    ));
                }
                let db_path = PathBuf::from(&path);
                let options = KeyOptions::for_database(&db_path, &id);
                let (key, location) = tincan_vault::load_or_create(&options).await?;
                let vault =
                    tokio::task::spawn_blocking(move || tincan_vault::Vault::open(&db_path, &key))
                        .await
                        .map_err(|_| Failure::new("INTERNAL", "opening the vault panicked"))??;
                Ok((vault, location, path))
            },
            |(vault, location, path)| {
                let (key_storage, key_file) = match location {
                    KeyLocation::SecretService => ("keyring", None),
                    KeyLocation::File(file) => ("file", Some(file.display().to_string())),
                };
                Vault {
                    inner: RefCell::new(Some(vault)),
                    key_storage,
                    key_file,
                    path: Some(path),
                }
            },
        )
    }

    /// An encrypted in-memory database with a random key (tests). Never
    /// touches the keyring.
    #[napi]
    pub fn open_in_memory() -> napi::Result<Vault, String> {
        guard_as(|| {
            let vault = tincan_vault::Vault::open_in_memory(&VaultKey::generate()?)?;
            Ok::<_, tincan_vault::Error>(Vault {
                inner: RefCell::new(Some(vault)),
                key_storage: "memory",
                key_file: None,
                path: None,
            })
        })
    }

    /// Where the key is kept. `file` is the fallback `doctor` warns about.
    #[napi(getter, ts_return_type = "'keyring' | 'file' | 'memory'")]
    pub fn key_storage(&self) -> String {
        self.key_storage.to_string()
    }

    /// The key file, when `keyStorage` is `file`.
    #[napi(getter)]
    pub fn key_file(&self) -> Option<String> {
        self.key_file.clone()
    }

    /// The database file (`null` in memory).
    #[napi(getter)]
    pub fn path(&self) -> Option<String> {
        self.path.clone()
    }

    #[napi(getter)]
    pub fn is_open(&self) -> bool {
        self.inner.borrow().is_some()
    }

    #[napi(getter)]
    pub fn in_transaction(&self) -> bool {
        self.inner
            .borrow()
            .as_ref()
            .is_some_and(tincan_vault::Vault::in_transaction)
    }

    /// The SQLCipher version.
    #[napi]
    pub fn cipher_version(&self) -> napi::Result<String, String> {
        guard_as(|| self.with(|v| Ok(v.cipher_version()?)))
    }

    /// Runs one statement with positional (`?`) parameters. Numbers with no
    /// fractional part bind as INTEGER, others as REAL; booleans as 0/1;
    /// `Uint8Array`s (and `Buffer`s) as BLOB; `null`/`undefined` as NULL.
    #[napi(
        ts_args_type = "sql: string, params?: Array<null | undefined | number | bigint | boolean | string | Uint8Array>"
    )]
    pub fn exec(
        &self,
        sql: String,
        params: Option<Vec<Unknown<'_>>>,
    ) -> napi::Result<VaultChanges, String> {
        guard_as(|| {
            let params = sql_params(params)?;
            self.with(|v| {
                let changes = v.exec(&sql, &params)?;
                Ok(VaultChanges {
                    changes: i64::try_from(changes.changes).unwrap_or(i64::MAX),
                    last_insert_rowid: changes.last_insert_rowid,
                })
            })
        })
    }

    /// Runs `;`-separated statements without parameters (migrations).
    #[napi]
    pub fn exec_batch(&self, sql: String) -> napi::Result<(), String> {
        guard_as(|| self.with(|v| Ok(v.exec_batch(&sql)?)))
    }

    /// Runs a query and returns every row as an object keyed by column name
    /// (a later duplicate name wins). INTEGERs come back as numbers, or as
    /// bigints beyond `Number.MAX_SAFE_INTEGER`; BLOBs as `Buffer`s.
    #[napi(
        ts_generic_types = "T = Record<string, null | number | bigint | string | Buffer>",
        ts_args_type = "sql: string, params?: Array<null | undefined | number | bigint | boolean | string | Uint8Array>",
        ts_return_type = "Array<T>"
    )]
    pub fn query<'env>(
        &self,
        env: &'env Env,
        sql: String,
        params: Option<Vec<Unknown<'_>>>,
    ) -> napi::Result<Vec<Object<'env>>, String> {
        let rows = guard_as(|| {
            let params = sql_params(params)?;
            self.with(|v| Ok(v.query(&sql, &params)?))
        })?;
        guard_as(|| {
            rows.rows
                .into_iter()
                .map(|row| {
                    let mut object = Object::new(env)?;
                    for (name, value) in rows.columns.iter().zip(row) {
                        object.set_named_property(name, JsSqlValue(value))?;
                    }
                    Ok(object)
                })
                .collect::<napi::Result<Vec<_>>>()
                .map_err(|err| Failure::new("INTERNAL", err.reason))
        })
    }

    /// Runs `body` in an immediate transaction and returns its result:
    /// committed if it returns, rolled back if it throws (the error is
    /// rethrown as is). `body` must be synchronous: a returned promise rolls
    /// back and throws `INVALID_INPUT`. Throws `INVALID_INPUT` when a
    /// transaction is already open.
    #[napi(
        ts_generic_types = "T",
        ts_args_type = "body: () => T",
        ts_return_type = "T"
    )]
    pub fn transaction<'env>(
        &self,
        env: &'env Env,
        body: Function<'env, (), Unknown<'env>>,
    ) -> napi::Result<Unknown<'env>> {
        catch(|| self.with(|v| Ok(v.begin()?))).map_err(|f| f.into_js(env))?;
        let rollback = || {
            let _ = catch(|| self.with(|v| Ok(v.rollback()?)));
        };
        let value = match call_leaving_exception(env, &body) {
            Ok(value) => value,
            Err(err) => {
                rollback();
                return Err(err);
            }
        };
        if value.is_promise().unwrap_or(false) {
            rollback();
            return Err(Failure::new(
                "INVALID_INPUT",
                "A vault transaction body must be synchronous.",
            )
            .into_js(env));
        }
        if let Err(failure) = catch(|| self.with(|v| Ok(v.commit()?))) {
            rollback();
            return Err(failure.into_js(env));
        }
        Ok(value)
    }

    /// Closes the database. Safe to call twice; a transaction still open is
    /// rolled back.
    #[napi]
    pub fn close(&self) -> napi::Result<(), String> {
        guard_as(|| match self.inner.borrow_mut().take() {
            Some(vault) => vault.close(),
            None => Ok(()),
        })
    }
}

impl Vault {
    fn with<T>(
        &self,
        f: impl FnOnce(&tincan_vault::Vault) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        match self.inner.borrow().as_ref() {
            Some(vault) => f(vault),
            None => Err(Failure::new("NOT_CONNECTED", "The vault is closed.")),
        }
    }
}

/// Calls `body` with no arguments. If it throws, the exception is left
/// pending and the returned error (status `PendingException`) makes napi
/// rethrow it unchanged; `Function::call` would instead wrap it, which fails
/// for a thrown primitive.
fn call_leaving_exception<'env>(
    env: &'env Env,
    body: &Function<'env, (), Unknown<'env>>,
) -> napi::Result<Unknown<'env>> {
    let mut receiver = ptr::null_mut();
    let mut result = ptr::null_mut();
    // SAFETY: plain N-API calls on the current env with values from it.
    unsafe {
        sys::napi_get_undefined(env.raw(), &mut receiver);
        let status =
            sys::napi_call_function(env.raw(), receiver, body.raw(), 0, ptr::null(), &mut result);
        if status == sys::Status::napi_ok {
            Ok(Unknown::from_raw_unchecked(env.raw(), result))
        } else {
            Err(napi::Error::new(
                Status::PendingException,
                "the vault transaction body threw",
            ))
        }
    }
}

/// Converts JS parameters to SQL values.
fn sql_params(params: Option<Vec<Unknown<'_>>>) -> Result<Vec<SqlValue>, Failure> {
    params
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, value)| {
            sql_param(value).map_err(|message| {
                Failure::new("INVALID_INPUT", format!("Parameter {}: {message}", i + 1))
            })
        })
        .collect()
}

fn sql_param(value: &Unknown<'_>) -> Result<SqlValue, String> {
    let napi_err = |err: napi::Error| err.reason;
    // SAFETY: each `cast` matches the type `get_type` just reported (or, for
    // objects, is checked by `Uint8ArraySlice` itself).
    unsafe {
        Ok(match value.get_type().map_err(napi_err)? {
            ValueType::Null | ValueType::Undefined => SqlValue::Null,
            ValueType::Boolean => {
                SqlValue::Integer(i64::from(value.cast::<bool>().map_err(napi_err)?))
            }
            ValueType::Number => {
                let n = value.cast::<f64>().map_err(napi_err)?;
                if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 {
                    SqlValue::Integer(n as i64)
                } else {
                    SqlValue::Real(n)
                }
            }
            ValueType::BigInt => {
                let (n, lossless) = value
                    .cast::<napi::bindgen_prelude::BigInt>()
                    .map_err(napi_err)?
                    .get_i64();
                if !lossless {
                    return Err("bigint out of the 64-bit range".to_string());
                }
                SqlValue::Integer(n)
            }
            ValueType::String => SqlValue::Text(value.cast::<String>().map_err(napi_err)?),
            ValueType::Object => match value.cast::<Uint8ArraySlice<'_>>() {
                Ok(bytes) => SqlValue::Blob(bytes.to_vec()),
                Err(_) => return Err("objects other than Uint8Array can't be bound".to_string()),
            },
            other => return Err(format!("{other} values can't be bound")),
        })
    }
}

/// A column value on its way to JS.
struct JsSqlValue(SqlValue);

impl ToNapiValue for JsSqlValue {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> napi::Result<sys::napi_value> {
        // SAFETY: forwarded from the caller.
        unsafe {
            match value.0 {
                SqlValue::Null => Null::to_napi_value(env, Null),
                SqlValue::Integer(n) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) => {
                    f64::to_napi_value(env, n as f64)
                }
                SqlValue::Integer(n) => i64n::to_napi_value(env, i64n(n)),
                SqlValue::Real(n) => f64::to_napi_value(env, n),
                SqlValue::Text(text) => String::to_napi_value(env, text),
                SqlValue::Blob(bytes) => Buffer::to_napi_value(env, Buffer::from(bytes)),
            }
        }
    }
}
