//! Which Notification Source events to resolve, and the recent notifications
//! the phone still shows. Desktop popup policy lives above this layer.

use std::collections::{HashMap, HashSet};

use super::protocol::{Category, EventId, SourceEvent};

/// The most notifications kept for `recent`.
pub const MAX_RETAINED: usize = 200;

/// A resolved notification.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Notification {
    pub uid: u32,
    pub app_id: String,
    /// The app's display name once known; a name derived from the id until then.
    pub app_name: String,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    pub category: Category,
    /// Unix seconds: the phone's Date attribute read as local time, or when
    /// it arrived if the phone sent none.
    pub received: i64,
    pub silent: bool,
    pub important: bool,
    pub has_positive_action: bool,
    pub has_negative_action: bool,
    /// Already on the phone when the subscription came up (a backlog replay).
    pub pre_existing: bool,
    /// Which subscription it arrived on; actions on older ones are dropped.
    pub session: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// New or genuinely updated: ask for its attributes.
    Fetch,
    /// A replay of a uid already seen this session.
    Ignore,
    /// Removed on the phone.
    Withdraw,
}

#[derive(Debug, Default)]
pub struct NotificationRegistry {
    seen: HashSet<u32>,
    notifications: HashMap<u32, Notification>,
    /// Arrival order, oldest first.
    order: Vec<u32>,
    session: u64,
}

impl NotificationRegistry {
    pub fn classify(&self, event: &SourceEvent) -> Decision {
        match event.event {
            EventId::Removed => Decision::Withdraw,
            EventId::Modified => Decision::Fetch,
            EventId::Added if self.seen.contains(&event.uid) => Decision::Ignore,
            EventId::Added => Decision::Fetch,
        }
    }

    pub fn remember(&mut self, uid: u32) {
        self.seen.insert(uid);
    }

    pub fn forget(&mut self, uid: u32) {
        self.seen.remove(&uid);
        self.notifications.remove(&uid);
        self.order.retain(|&u| u != uid);
    }

    /// A new subscription: iOS replays its backlog, possibly under new uids.
    pub fn begin_session(&mut self) {
        self.seen.clear();
        self.session += 1;
    }

    pub fn session(&self) -> u64 {
        self.session
    }

    pub fn clear(&mut self) {
        self.seen.clear();
        self.notifications.clear();
        self.order.clear();
    }

    pub fn len(&self) -> usize {
        self.notifications.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notifications.is_empty()
    }

    /// Stores a notification for the current session, dropping identical
    /// copies an earlier session replayed under another uid.
    pub fn store(&mut self, mut notification: Notification) {
        let session = self.session;
        let stale: Vec<u32> = self
            .notifications
            .iter()
            .filter(|(_, n)| {
                n.session != session
                    && n.app_id == notification.app_id
                    && n.title == notification.title
                    && n.subtitle == notification.subtitle
                    && n.body == notification.body
                    && n.received == notification.received
            })
            .map(|(&uid, _)| uid)
            .collect();
        for uid in stale {
            self.notifications.remove(&uid);
            self.order.retain(|&u| u != uid);
        }
        notification.session = session;
        let uid = notification.uid;
        if self.notifications.insert(uid, notification).is_none() {
            self.order.push(uid);
        }
        while self.order.len() > MAX_RETAINED {
            let oldest = self.order.remove(0);
            self.notifications.remove(&oldest);
        }
    }

    pub fn find(&self, uid: u32) -> Option<&Notification> {
        self.notifications.get(&uid)
    }

    /// Newest first by delivery time; backlog replay arrives out of order.
    pub fn recent(&self, limit: usize) -> Vec<Notification> {
        let mut out: Vec<Notification> = self
            .order
            .iter()
            .rev()
            .filter_map(|uid| self.notifications.get(uid).cloned())
            .collect();
        out.sort_by_key(|n| std::cmp::Reverse(n.received));
        out.truncate(limit);
        out
    }

    pub fn rename_app(&mut self, app_id: &str, name: &str) {
        if app_id.is_empty() || name.is_empty() {
            return;
        }
        for notification in self.notifications.values_mut() {
            if notification.app_id == app_id {
                notification.app_name = name.to_owned();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(uid: u32, event: EventId) -> SourceEvent {
        SourceEvent {
            event,
            flags: 0,
            category: Category::Other,
            category_count: 0,
            uid,
        }
    }

    fn stored(uid: u32, received: i64) -> Notification {
        Notification {
            uid,
            app_id: "com.example.app".into(),
            received,
            ..Notification::default()
        }
    }

    #[test]
    fn dedupes_repeated_added_events() {
        let mut registry = NotificationRegistry::default();
        let added = event(7, EventId::Added);
        assert_eq!(registry.classify(&added), Decision::Fetch);
        registry.remember(7);
        assert_eq!(registry.classify(&added), Decision::Ignore);
    }

    #[test]
    fn never_suppresses_a_modification() {
        let mut registry = NotificationRegistry::default();
        registry.remember(7);
        assert_eq!(
            registry.classify(&event(7, EventId::Modified)),
            Decision::Fetch
        );
    }

    #[test]
    fn withdraws_removed_notifications() {
        let mut registry = NotificationRegistry::default();
        registry.remember(7);
        registry.store(stored(7, 1));
        assert_eq!(
            registry.classify(&event(7, EventId::Removed)),
            Decision::Withdraw
        );
        registry.forget(7);
        assert!(registry.find(7).is_none());
        assert_eq!(
            registry.classify(&event(7, EventId::Added)),
            Decision::Fetch
        );
    }

    #[test]
    fn a_new_session_forgets_seen_uids() {
        let mut registry = NotificationRegistry::default();
        registry.remember(7);
        registry.begin_session();
        assert_eq!(
            registry.classify(&event(7, EventId::Added)),
            Decision::Fetch
        );
    }

    #[test]
    fn keeps_recent_notifications_newest_first() {
        let mut registry = NotificationRegistry::default();
        for uid in 1..=3 {
            registry.store(stored(uid, 0));
        }
        let recent = registry.recent(10);
        assert_eq!(
            recent.iter().map(|n| n.uid).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }

    #[test]
    fn sorts_by_delivery_time_not_arrival() {
        let mut registry = NotificationRegistry::default();
        registry.store(stored(1, 300));
        registry.store(stored(2, 100));
        registry.store(stored(3, 200));
        let recent = registry.recent(2);
        assert_eq!(recent.iter().map(|n| n.uid).collect::<Vec<_>>(), vec![1, 3]);
    }

    #[test]
    fn drops_copies_replayed_by_an_earlier_session() {
        let mut registry = NotificationRegistry::default();
        registry.store(stored(1, 100));
        registry.begin_session();
        registry.store(stored(9, 100));
        assert_eq!(registry.len(), 1);
        assert!(registry.find(1).is_none());
        assert_eq!(registry.find(9).map(|n| n.session), Some(1));
    }

    #[test]
    fn keeps_identical_notifications_from_the_same_session() {
        let mut registry = NotificationRegistry::default();
        registry.store(stored(1, 100));
        registry.store(stored(2, 100));
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn bounds_what_it_keeps() {
        let mut registry = NotificationRegistry::default();
        for uid in 0..250 {
            registry.store(stored(uid, i64::from(uid)));
        }
        assert_eq!(registry.len(), MAX_RETAINED);
        assert!(registry.find(0).is_none());
        assert!(registry.find(249).is_some());
    }

    #[test]
    fn renames_an_app_everywhere() {
        let mut registry = NotificationRegistry::default();
        registry.store(stored(1, 0));
        registry.rename_app("com.example.app", "Example");
        assert_eq!(
            registry.find(1).map(|n| n.app_name.as_str()),
            Some("Example")
        );
    }

    #[test]
    fn clearing_forgets_everything() {
        let mut registry = NotificationRegistry::default();
        registry.store(stored(1, 0));
        registry.remember(1);
        registry.clear();
        assert!(registry.is_empty());
        assert_eq!(
            registry.classify(&event(1, EventId::Added)),
            Decision::Fetch
        );
    }
}
