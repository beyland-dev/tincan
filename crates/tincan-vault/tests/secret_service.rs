//! The Secret Service client and key policy against an in-process fake keyring
//! over a peer-to-peer connection: no session bus or real keyring is touched.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tincan_vault::{ErrorCode, KeyLocation, KeyOptions, SecretService, load_or_create_with};
use zbus::object_server::{ObjectServer, SignalEmitter};
use zbus::{OwnedObjectPath, OwnedVariant, Variant, fdo};

type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

const COLLECTION: &str = "/org/freedesktop/secrets/collection/login";
const SESSION: &str = "/org/freedesktop/secrets/session/1";
const PROMPT: &str = "/org/freedesktop/secrets/prompt/1";

struct StoredItem {
    path: String,
    attributes: HashMap<String, String>,
    secret: Vec<u8>,
    locked: bool,
}

#[derive(Default)]
struct State {
    items: Vec<StoredItem>,
    next_id: u32,
    no_collection: bool,
    dismiss_prompts: bool,
    prompts_shown: u32,
}

type Shared = Arc<Mutex<State>>;

fn path(text: &str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(text.to_owned()).expect("object path")
}

struct FakeService(Shared);

#[zbus::interface(interface = "org.freedesktop.Secret.Service")]
impl FakeService {
    fn open_session(
        &self,
        algorithm: &str,
        _input: OwnedVariant,
    ) -> fdo::Result<(OwnedVariant, OwnedObjectPath)> {
        if algorithm != "plain" {
            return Err(fdo::Error::NotSupported(algorithm.to_owned()));
        }
        let output = OwnedVariant::try_from(Variant::from("")).expect("variant");
        Ok((output, path(SESSION)))
    }

    fn search_items(
        &self,
        attributes: HashMap<String, String>,
    ) -> (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) {
        let state = self.0.lock().expect("state");
        let mut unlocked = Vec::new();
        let mut locked = Vec::new();
        for item in &state.items {
            if attributes
                .iter()
                .all(|(k, v)| item.attributes.get(k) == Some(v))
            {
                if item.locked {
                    locked.push(path(&item.path));
                } else {
                    unlocked.push(path(&item.path));
                }
            }
        }
        (unlocked, locked)
    }

    async fn unlock(
        &self,
        _objects: Vec<OwnedObjectPath>,
        #[zbus(object_server)] server: &ObjectServer,
    ) -> fdo::Result<(Vec<OwnedObjectPath>, OwnedObjectPath)> {
        server.at(PROMPT, FakePrompt(self.0.clone())).await?;
        Ok((Vec::new(), path(PROMPT)))
    }

    fn read_alias(&self, name: &str) -> OwnedObjectPath {
        let state = self.0.lock().expect("state");
        if name == "default" && !state.no_collection {
            path(COLLECTION)
        } else {
            path("/")
        }
    }
}

struct FakeCollection(Shared);

#[zbus::interface(interface = "org.freedesktop.Secret.Collection")]
impl FakeCollection {
    async fn create_item(
        &self,
        properties: HashMap<String, OwnedVariant>,
        secret: Secret,
        replace: bool,
        #[zbus(object_server)] server: &ObjectServer,
    ) -> fdo::Result<(OwnedObjectPath, OwnedObjectPath)> {
        let attributes = properties
            .get("org.freedesktop.Secret.Item.Attributes")
            .ok_or_else(|| fdo::Error::InvalidArgs("no attributes".into()))?
            .try_clone()
            .map_err(|e| fdo::Error::Failed(e.to_string()))?;
        let attributes = HashMap::<String, String>::try_from(attributes)
            .map_err(|e| fdo::Error::InvalidArgs(e.to_string()))?;
        if secret.0.as_str() != SESSION || secret.3 != "text/plain" {
            return Err(fdo::Error::InvalidArgs("bad secret".into()));
        }
        let item_path = {
            let mut state = self.0.lock().expect("state");
            if replace {
                state.items.retain(|item| item.attributes != attributes);
            }
            state.next_id += 1;
            let item_path = format!("{COLLECTION}/{}", state.next_id);
            state.items.push(StoredItem {
                path: item_path.clone(),
                attributes,
                secret: secret.2,
                locked: false,
            });
            item_path
        };
        server
            .at(
                item_path.as_str(),
                FakeItem(self.0.clone(), item_path.clone()),
            )
            .await?;
        Ok((path(&item_path), path("/")))
    }
}

struct FakeItem(Shared, String);

#[zbus::interface(interface = "org.freedesktop.Secret.Item")]
impl FakeItem {
    fn get_secret(&self, session: OwnedObjectPath) -> fdo::Result<Secret> {
        let state = self.0.lock().expect("state");
        let item = state
            .items
            .iter()
            .find(|item| item.path == self.1)
            .ok_or_else(|| fdo::Error::UnknownObject(self.1.clone()))?;
        if item.locked {
            return Err(fdo::Error::AccessDenied("IsLocked".into()));
        }
        Ok((
            session,
            Vec::new(),
            item.secret.clone(),
            "text/plain".into(),
        ))
    }

    fn delete(&self) -> OwnedObjectPath {
        let mut state = self.0.lock().expect("state");
        state.items.retain(|item| item.path != self.1);
        path("/")
    }
}

struct FakePrompt(Shared);

#[zbus::interface(interface = "org.freedesktop.Secret.Prompt")]
impl FakePrompt {
    async fn prompt(
        &self,
        _window_id: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let (dismissed, unlocked) = {
            let mut state = self.0.lock().expect("state");
            state.prompts_shown += 1;
            let dismissed = state.dismiss_prompts;
            let mut unlocked = Vec::new();
            if !dismissed {
                for item in &mut state.items {
                    item.locked = false;
                    unlocked.push(path(&item.path));
                }
            }
            (dismissed, unlocked)
        };
        Self::completed(&emitter, dismissed, Variant::from(unlocked)).await?;
        Ok(())
    }

    #[zbus(signal)]
    async fn completed(
        emitter: &SignalEmitter<'_>,
        dismissed: bool,
        result: Variant<'_>,
    ) -> zbus::Result<()>;
}

struct FakeSession;

#[zbus::interface(interface = "org.freedesktop.Secret.Session")]
impl FakeSession {
    fn close(&self) {}
}

/// A client connection to a fresh fake keyring, the fake's state and the
/// server connection (kept alive by the caller).
async fn fake_keyring(state: State) -> (zbus::Connection, Shared, zbus::Connection) {
    let shared: Shared = Arc::new(Mutex::new(state));
    let (server_socket, client_socket) = std::os::unix::net::UnixStream::pair().expect("pair");
    let server = zbus::connection::Builder::unix_stream(server_socket)
        .server(zbus::Guid::generate())
        .p2p()
        .serve_at("/org/freedesktop/secrets", FakeService(shared.clone()))
        .serve_at(COLLECTION, FakeCollection(shared.clone()))
        .serve_at(SESSION, FakeSession)
        .build();
    let client = zbus::connection::Builder::unix_stream(client_socket)
        .p2p()
        .build();
    let (server, client) = tokio::join!(server, client);
    let server = server.expect("server");
    let preloaded: Vec<String> = shared
        .lock()
        .expect("state")
        .items
        .iter()
        .map(|item| item.path.clone())
        .collect();
    for item_path in preloaded {
        server
            .object_server()
            .at(
                item_path.as_str(),
                FakeItem(shared.clone(), item_path.clone()),
            )
            .await
            .expect("item");
    }
    (client.expect("client"), shared, server)
}

fn attrs(vault: &str) -> HashMap<&str, &str> {
    HashMap::from([
        ("xdg:schema", "dev.beyland.Tincan.VaultKey"),
        ("vault", vault),
    ])
}

fn locked_item(secret: &[u8]) -> StoredItem {
    StoredItem {
        path: format!("{COLLECTION}/9"),
        attributes: attrs("a")
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
        secret: secret.to_vec(),
        locked: true,
    }
}

fn key_options(dir: &tempfile::TempDir, allow_create: bool) -> KeyOptions {
    KeyOptions {
        id: "default".into(),
        key_file: dir.path().join("tincan.key"),
        allow_create,
    }
}

#[tokio::test]
async fn stores_replaces_finds_and_deletes() {
    let (client, state, _server) = fake_keyring(State::default()).await;
    let service = SecretService::with_connection(client).await.expect("open");

    assert!(service.find(&attrs("a")).await.expect("find").is_none());
    service
        .store("label", &attrs("a"), b"secret-a", "text/plain")
        .await
        .expect("store");
    service
        .store("label", &attrs("a"), b"secret-a2", "text/plain")
        .await
        .expect("replace");
    assert_eq!(state.lock().expect("state").items.len(), 1);
    let found = service.find(&attrs("a")).await.expect("find");
    assert_eq!(found.as_deref().map(Vec::as_slice), Some(&b"secret-a2"[..]));
    assert!(service.find(&attrs("b")).await.expect("other").is_none());

    assert_eq!(service.delete(&attrs("a")).await.expect("delete"), 1);
    assert!(service.find(&attrs("a")).await.expect("gone").is_none());
    service.close().await.expect("close");
}

#[tokio::test]
async fn unlocks_through_a_prompt() {
    let (client, state, _server) = fake_keyring(State {
        items: vec![locked_item(b"locked-secret")],
        ..State::default()
    })
    .await;
    let service = SecretService::with_connection(client).await.expect("open");
    let found = service.find(&attrs("a")).await.expect("find");
    assert_eq!(
        found.as_deref().map(Vec::as_slice),
        Some(&b"locked-secret"[..])
    );
    assert_eq!(state.lock().expect("state").prompts_shown, 1);
}

#[tokio::test]
async fn reports_a_dismissed_prompt() {
    let (client, _state, _server) = fake_keyring(State {
        items: vec![locked_item(b"locked-secret")],
        dismiss_prompts: true,
        ..State::default()
    })
    .await;
    let service = SecretService::with_connection(client).await.expect("open");
    let err = service.find(&attrs("a")).await.expect_err("dismissed");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

#[tokio::test]
async fn keeps_the_vault_key_in_the_keyring() {
    let dir = tempfile::tempdir().expect("tempdir");
    let options = key_options(&dir, true);
    let (client, state, _server) = fake_keyring(State::default()).await;

    let service = SecretService::with_connection(client.clone()).await;
    let (key, location) = load_or_create_with(service, &options)
        .await
        .expect("create");
    assert_eq!(location, KeyLocation::SecretService);
    assert!(!options.key_file.exists());
    {
        let state = state.lock().expect("state");
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.items[0].secret, key.to_hex().as_bytes());
        assert_eq!(state.items[0].attributes["vault"], "default");
    }

    let reopen = key_options(&dir, false);
    let service = SecretService::with_connection(client.clone()).await;
    let (again, _) = load_or_create_with(service, &reopen).await.expect("reload");
    assert_eq!(again, key);

    state.lock().expect("state").items.clear();
    let service = SecretService::with_connection(client).await;
    let err = load_or_create_with(service, &reopen)
        .await
        .expect_err("lost key");
    assert_eq!(err.code(), ErrorCode::NotFound);
    assert!(!reopen.key_file.exists());
}

#[tokio::test]
async fn falls_back_when_the_keyring_has_no_collection() {
    let dir = tempfile::tempdir().expect("tempdir");
    let options = key_options(&dir, true);
    let (client, _state, _server) = fake_keyring(State {
        no_collection: true,
        ..State::default()
    })
    .await;
    let service = SecretService::with_connection(client).await;
    let (_, location) = load_or_create_with(service, &options)
        .await
        .expect("fallback");
    assert_eq!(location, KeyLocation::File(options.key_file.clone()));
    assert!(options.key_file.exists());
}
