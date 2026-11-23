//! A fake `org.freedesktop.Notifications` server for tests: it records what
//! it is asked to show, and lets the test click or close notifications.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use zbus::OwnedVariant;

pub const PATH: &str = "/org/freedesktop/Notifications";
const INTERFACE: &str = "org.freedesktop.Notifications";

#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub id: u32,
    pub app_name: String,
    pub replaces: u32,
    pub icon: String,
    pub summary: String,
    pub body: String,
    pub actions: Vec<String>,
    pub hints: HashMap<String, OwnedVariant>,
    pub expire_timeout: i32,
}

#[derive(Debug)]
pub struct State {
    pub capabilities: Vec<String>,
    /// Every Notify call, in order.
    pub shown: Vec<Shown>,
    /// The ids on screen.
    pub open: BTreeSet<u32>,
    pub closed_by_app: Vec<u32>,
    next_id: u32,
}

impl Default for State {
    fn default() -> Self {
        Self {
            capabilities: vec![
                "actions".to_owned(),
                "body".to_owned(),
                "body-markup".to_owned(),
            ],
            shown: Vec::new(),
            open: BTreeSet::new(),
            closed_by_app: Vec::new(),
            next_id: 0,
        }
    }
}

#[derive(Clone, Default)]
pub struct FakeNotifications {
    pub state: Arc<Mutex<State>>,
}

impl FakeNotifications {
    pub fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().expect("state"))
    }

    pub async fn serve(&self, connection: &zbus::Connection) -> zbus::Result<()> {
        connection
            .object_server()
            .at(PATH, Server(self.clone()))
            .await?;
        Ok(())
    }

    /// The user clicks `action` on notification `id`, as a server does it:
    /// an activation token first, then the action.
    pub async fn invoke(
        &self,
        connection: &zbus::Connection,
        id: u32,
        action: &str,
        token: Option<&str>,
    ) -> zbus::Result<()> {
        if let Some(token) = token {
            emit(connection, "ActivationToken", &(id, token)).await?;
        }
        emit(connection, "ActionInvoked", &(id, action)).await
    }

    /// The notification goes away for `reason` (1 expired, 2 dismissed, 3
    /// closed by the app).
    pub async fn close(
        &self,
        connection: &zbus::Connection,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()> {
        self.with(|s| s.open.remove(&id));
        emit(connection, "NotificationClosed", &(id, reason)).await
    }
}

async fn emit<B>(connection: &zbus::Connection, member: &str, body: &B) -> zbus::Result<()>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    connection
        .emit_signal(None::<()>, PATH, INTERFACE, member, body)
        .await
}

struct Server(FakeNotifications);

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Server {
    fn get_capabilities(&self) -> Vec<String> {
        self.0.with(|s| s.capabilities.clone())
    }

    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        actions: Vec<String>,
        hints: HashMap<String, OwnedVariant>,
        expire_timeout: i32,
    ) -> u32 {
        self.0.with(|s| {
            let id = if replaces_id != 0 && s.open.contains(&replaces_id) {
                replaces_id
            } else {
                s.next_id += 1;
                s.next_id
            };
            s.open.insert(id);
            s.shown.push(Shown {
                id,
                app_name,
                replaces: replaces_id,
                icon: app_icon,
                summary,
                body,
                actions,
                hints,
                expire_timeout,
            });
            id
        })
    }

    async fn close_notification(
        &self,
        id: u32,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<()> {
        let was_open = self.0.with(|s| {
            s.closed_by_app.push(id);
            s.open.remove(&id)
        });
        if was_open {
            emit(connection, "NotificationClosed", &(id, 3u32)).await?;
        }
        Ok(())
    }

    fn get_server_information(&self) -> (String, String, String, String) {
        (
            "fake".to_owned(),
            "tincan".to_owned(),
            "0".to_owned(),
            "1.2".to_owned(),
        )
    }
}
