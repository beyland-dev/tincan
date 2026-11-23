//! A minimal Secret Service client (`org.freedesktop.secrets`: GNOME Keyring,
//! KWallet 6, KeePassXC) over the workspace's zbus.
//!
//! It uses the `plain` session algorithm: the secret crosses the user's own
//! session bus unencrypted, which is no weaker than Tincan's threat model (any
//! process on that bus can talk to the daemon socket and is the user). The
//! `oo7` and `secret-service` crates add DH-AES sessions but pin an older zbus
//! major; see `docs/decisions/`.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use zbus::{ObjectPath, OwnedObjectPath, OwnedVariant, Variant};
use zeroize::Zeroizing;

use crate::error::{Error, ErrorCode, Result};

const DEFAULT_ALIAS_PATH: &str = "/org/freedesktop/secrets/aliases/default";
const LABEL: &str = "org.freedesktop.Secret.Item.Label";
const ATTRIBUTES: &str = "org.freedesktop.Secret.Item.Attributes";
/// Unlock prompts wait on a person typing their login password.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// `(session, parameters, value, content_type)`, the spec's `Secret` struct.
type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Service",
    default_service = "org.freedesktop.secrets",
    default_path = "/org/freedesktop/secrets"
)]
trait Service {
    fn open_session(
        &self,
        algorithm: &str,
        input: &Variant<'_>,
    ) -> zbus::Result<(OwnedVariant, OwnedObjectPath)>;

    fn search_items(
        &self,
        attributes: HashMap<&str, &str>,
    ) -> zbus::Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>)>;

    fn unlock(
        &self,
        objects: &[&ObjectPath<'_>],
    ) -> zbus::Result<(Vec<OwnedObjectPath>, OwnedObjectPath)>;

    fn read_alias(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Collection",
    default_service = "org.freedesktop.secrets"
)]
trait Collection {
    fn create_item(
        &self,
        properties: HashMap<&str, Variant<'_>>,
        secret: &Secret,
        replace: bool,
    ) -> zbus::Result<(OwnedObjectPath, OwnedObjectPath)>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Item",
    default_service = "org.freedesktop.secrets"
)]
trait Item {
    fn get_secret(&self, session: &ObjectPath<'_>) -> zbus::Result<Secret>;

    fn delete(&self) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Prompt",
    default_service = "org.freedesktop.secrets"
)]
trait Prompt {
    fn prompt(&self, window_id: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    fn completed(&self, dismissed: bool, result: Variant<'_>) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Session",
    default_service = "org.freedesktop.secrets"
)]
trait Session {
    fn close(&self) -> zbus::Result<()>;
}

fn is_none_path(path: &ObjectPath<'_>) -> bool {
    path.as_str() == "/"
}

/// An open Secret Service session.
pub struct SecretService {
    connection: zbus::Connection,
    session: OwnedObjectPath,
}

impl SecretService {
    /// Connects on the session bus. `NOT_CONNECTED` when there is no bus or no
    /// Secret Service provider.
    pub async fn connect() -> Result<Self> {
        let connection = zbus::Connection::session().await.map_err(|err| {
            Error::new(
                ErrorCode::NotConnected,
                format!("session bus unavailable: {err}"),
            )
        })?;
        Self::with_connection(connection).await
    }

    /// Opens a `plain` session over an existing connection (tests pass a
    /// peer-to-peer connection to a fake service).
    pub async fn with_connection(connection: zbus::Connection) -> Result<Self> {
        let service = ServiceProxy::new(&connection).await?;
        let (_, session) = service
            .open_session("plain", &Variant::from(""))
            .await
            .map_err(Error::from)?;
        Ok(Self {
            connection,
            session,
        })
    }

    /// The secret of the first item matching `attributes`, unlocking it (which
    /// may show a password prompt) if needed.
    pub async fn find(
        &self,
        attributes: &HashMap<&str, &str>,
    ) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let service = ServiceProxy::new(&self.connection).await?;
        let (unlocked, locked) = service.search_items(attributes.clone()).await?;
        let item = match (unlocked.into_iter().next(), locked.into_iter().next()) {
            (Some(item), _) => item,
            (None, Some(item)) => {
                self.unlock(&service, &item).await?;
                item
            }
            (None, None) => return Ok(None),
        };
        let proxy = ItemProxy::builder(&self.connection)
            .path(item)
            .build()
            .await?;
        let (_, _, value, _) = proxy.get_secret(&self.session).await?;
        Ok(Some(Zeroizing::new(value)))
    }

    /// Stores `secret` under `attributes` in the default collection, replacing
    /// an item with the same attributes. `NOT_FOUND` when the keyring has no
    /// default collection.
    pub async fn store(
        &self,
        label: &str,
        attributes: &HashMap<&str, &str>,
        secret: &[u8],
        content_type: &str,
    ) -> Result<()> {
        let service = ServiceProxy::new(&self.connection).await?;
        let mut collection = service.read_alias("default").await?;
        if is_none_path(&collection) {
            collection = OwnedObjectPath::try_from(DEFAULT_ALIAS_PATH)
                .map_err(|err| Error::new(ErrorCode::Internal, err.to_string()))?;
        }
        let proxy = CollectionProxy::builder(&self.connection)
            .path(collection)
            .build()
            .await?;
        let mut properties = HashMap::new();
        properties.insert(LABEL, Variant::from(label));
        properties.insert(ATTRIBUTES, Variant::from(attributes.clone()));
        let secret: Secret = (
            self.session.clone(),
            Vec::new(),
            secret.to_vec(),
            content_type.to_owned(),
        );
        let result = proxy.create_item(properties, &secret, true).await;
        let mut secret = secret;
        zeroize::Zeroize::zeroize(&mut secret.2);
        let (_, prompt) = result.map_err(|err| match Error::from(err) {
            e if e.code() == ErrorCode::NotFound => {
                Error::new(ErrorCode::NotFound, "the keyring has no default collection")
            }
            e => e,
        })?;
        self.run_prompt(&prompt).await?;
        Ok(())
    }

    /// Deletes every item matching `attributes`; returns how many.
    pub async fn delete(&self, attributes: &HashMap<&str, &str>) -> Result<usize> {
        let service = ServiceProxy::new(&self.connection).await?;
        let (unlocked, locked) = service.search_items(attributes.clone()).await?;
        for item in &locked {
            self.unlock(&service, item).await?;
        }
        let mut deleted = 0;
        for item in unlocked.into_iter().chain(locked) {
            let proxy = ItemProxy::builder(&self.connection)
                .path(item)
                .build()
                .await?;
            let prompt = proxy.delete().await?;
            self.run_prompt(&prompt).await?;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// Closes the session. Dropping the connection closes it too.
    pub async fn close(self) -> Result<()> {
        let proxy = SessionProxy::builder(&self.connection)
            .path(self.session)
            .build()
            .await?;
        proxy.close().await?;
        Ok(())
    }

    async fn unlock(&self, service: &ServiceProxy<'_>, item: &ObjectPath<'_>) -> Result<()> {
        let (unlocked, prompt) = service.unlock(&[item]).await?;
        if unlocked.iter().any(|path| path.as_str() == item.as_str()) {
            return Ok(());
        }
        self.run_prompt(&prompt).await
    }

    async fn run_prompt(&self, prompt: &ObjectPath<'_>) -> Result<()> {
        if is_none_path(prompt) {
            return Ok(());
        }
        let proxy = PromptProxy::builder(&self.connection)
            .path(prompt.to_owned())
            .build()
            .await?;
        let mut completed = proxy.receive_completed().await?;
        proxy.prompt("").await?;
        let signal = tokio::time::timeout(PROMPT_TIMEOUT, completed.next())
            .await
            .map_err(|_| Error::new(ErrorCode::Timeout, "the keyring prompt timed out"))?
            .ok_or_else(|| Error::new(ErrorCode::NotConnected, "the keyring went away"))?;
        let args = signal.args()?;
        if args.dismissed {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                "the keyring prompt was dismissed",
            ));
        }
        Ok(())
    }
}
