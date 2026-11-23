//! Keeps exactly one Control Point request in flight. Data Source responses
//! carry no request id, so the only way to match one to its request is to
//! never have two outstanding. Pure and clock-injected so it can be tested
//! without a phone; the session drives it.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::parser::{Assembled, DataSourceAssembler, Response};
use super::protocol::{Request, RequestKind};

/// A notification burst must not grow the daemon without bound.
pub const MAX_QUEUED_REQUESTS: usize = 64;
/// How long to wait for a Data Source response before giving up on it.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Completed(Request, Response),
    Failed(Request, String),
}

#[derive(Debug, Default)]
pub struct Sequencer {
    queue: VecDeque<Request>,
    in_flight: Option<(Request, Option<Instant>)>,
    assembler: DataSourceAssembler,
}

impl Sequencer {
    /// Queues a request; false when the queue is full.
    pub fn submit(&mut self, request: Request) -> bool {
        if self.queue.len() >= MAX_QUEUED_REQUESTS {
            return false;
        }
        self.queue.push_back(request);
        true
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight.is_some()
    }

    /// The next request to write, now marked in flight, or `None` while one
    /// is outstanding or nothing is queued. Report the write with `written`.
    pub fn next(&mut self, now: Instant) -> Option<Request> {
        if self.in_flight.is_some() {
            return None;
        }
        let request = self.queue.pop_front()?;
        let deadline = if request.attribute_ids.is_empty() {
            None
        } else {
            self.assembler
                .expect(request.response_header(), request.attribute_ids.clone());
            Some(now + REQUEST_TIMEOUT)
        };
        self.in_flight = Some((request.clone(), deadline));
        Some(request)
    }

    /// The write of the in-flight request finished. A refused write fails it;
    /// an action, which gets no response, completes as soon as it is written.
    pub fn written(&mut self, result: Result<(), String>) -> Option<Outcome> {
        let (request, _) = self.in_flight.as_ref()?;
        match result {
            Err(reason) => {
                let request = request.clone();
                self.clear_in_flight();
                Some(Outcome::Failed(request, reason))
            }
            Ok(()) if request.attribute_ids.is_empty() => {
                let request = request.clone();
                self.clear_in_flight();
                let response = Response {
                    command: request.command(),
                    uid: match request.kind {
                        RequestKind::Notification { uid } | RequestKind::Action { uid, .. } => uid,
                        RequestKind::App { .. } => 0,
                    },
                    ..Response::default()
                };
                Some(Outcome::Completed(request, response))
            }
            Ok(()) => None,
        }
    }

    /// A Data Source fragment. Fragments with nothing in flight are dropped.
    pub fn data(&mut self, fragment: &[u8]) -> Option<Outcome> {
        if !self.assembler.expecting() {
            return None;
        }
        match self.assembler.append(fragment) {
            Assembled::NeedMore => None,
            Assembled::Stale => {
                tracing::debug!(
                    bytes = fragment.len(),
                    "dropped a stale ANCS data source fragment"
                );
                None
            }
            Assembled::Complete(response) => {
                let (request, _) = self.in_flight.take()?;
                Some(Outcome::Completed(request, response))
            }
            Assembled::Error(reason) => {
                let (request, _) = self.in_flight.take()?;
                Some(Outcome::Failed(request, reason))
            }
        }
    }

    /// Fails the in-flight request once its response is overdue.
    pub fn tick(&mut self, now: Instant) -> Option<Outcome> {
        let (_, Some(deadline)) = self.in_flight.as_ref()? else {
            return None;
        };
        if now < *deadline {
            return None;
        }
        let (request, _) = self.in_flight.take()?;
        self.assembler.reset();
        Some(Outcome::Failed(
            request,
            "no data source response in time".into(),
        ))
    }

    /// Drops everything: the subscription it belonged to is gone.
    pub fn reset(&mut self) {
        self.queue.clear();
        self.clear_in_flight();
    }

    fn clear_in_flight(&mut self) {
        self.in_flight = None;
        self.assembler.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ancs::parser::tests::push_attribute;
    use crate::ancs::protocol::{Action, action_request, attribute, notification_request};

    fn request(uid: u32) -> Request {
        notification_request(uid, &[attribute::APP_IDENTIFIER])
    }

    fn response(uid: u32, app: &str) -> Vec<u8> {
        let mut bytes = vec![0];
        bytes.extend_from_slice(&uid.to_le_bytes());
        push_attribute(&mut bytes, 0, app);
        bytes
    }

    fn uid_of(request: &Request) -> u32 {
        match request.kind {
            RequestKind::Notification { uid } | RequestKind::Action { uid, .. } => uid,
            RequestKind::App { .. } => 0,
        }
    }

    /// Writes everything that can go out, as the session does, recording the
    /// writes and outcomes.
    struct Harness {
        sequencer: Sequencer,
        writes: Vec<Vec<u8>>,
        outcomes: Vec<Outcome>,
        write_succeeds: bool,
        start: Instant,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                sequencer: Sequencer::default(),
                writes: Vec::new(),
                outcomes: Vec::new(),
                write_succeeds: true,
                start: Instant::now(),
            }
        }

        fn pump(&mut self, now: Instant) {
            while let Some(request) = self.sequencer.next(now) {
                self.writes.push(request.payload.clone());
                let result = if self.write_succeeds {
                    Ok(())
                } else {
                    Err("refused".to_owned())
                };
                self.outcomes.extend(self.sequencer.written(result));
            }
        }

        fn tick(&mut self, after: Duration) {
            let now = self.start + after;
            self.outcomes.extend(self.sequencer.tick(now));
            self.pump(now);
        }

        fn data(&mut self, bytes: &[u8]) {
            self.outcomes.extend(self.sequencer.data(bytes));
            self.pump(self.start);
        }

        fn completions(&self) -> Vec<(&Request, &Response)> {
            self.outcomes
                .iter()
                .filter_map(|o| match o {
                    Outcome::Completed(req, res) => Some((req, res)),
                    Outcome::Failed(..) => None,
                })
                .collect()
        }

        fn failures(&self) -> Vec<&Request> {
            self.outcomes
                .iter()
                .filter_map(|o| match o {
                    Outcome::Failed(req, _) => Some(req),
                    Outcome::Completed(..) => None,
                })
                .collect()
        }
    }

    #[test]
    fn keeps_exactly_one_request_in_flight() {
        let mut h = Harness::new();
        for uid in 1..=3 {
            assert!(h.sequencer.submit(request(uid)));
        }
        h.tick(Duration::ZERO);
        assert_eq!(h.writes.len(), 1);
        assert_eq!(h.sequencer.queued(), 2);
        assert!(h.sequencer.in_flight());

        h.data(&response(1, "com.example.one"));
        assert_eq!(h.completions().len(), 1);
        assert_eq!(uid_of(h.completions()[0].0), 1);
        assert_eq!(h.writes.len(), 2, "the next request starts at once");
    }

    #[test]
    fn matches_each_response_to_its_own_request() {
        let mut h = Harness::new();
        h.sequencer.submit(request(11));
        h.sequencer.submit(request(22));
        h.tick(Duration::ZERO);
        h.data(&response(11, "com.example.first"));
        h.data(&response(22, "com.example.second"));
        let done = h.completions();
        assert_eq!(done.len(), 2);
        assert_eq!(uid_of(done[0].0), 11);
        assert_eq!(done[0].1.attribute(0), "com.example.first");
        assert_eq!(uid_of(done[1].0), 22);
        assert_eq!(done[1].1.attribute(0), "com.example.second");
    }

    /// A late answer must not be taken for the next request's: that would
    /// shift every later response onto the wrong request.
    #[test]
    fn a_late_response_does_not_shift_later_ones() {
        let mut h = Harness::new();
        for uid in [11, 22, 33] {
            h.sequencer.submit(request(uid));
        }
        h.tick(Duration::ZERO);
        h.tick(REQUEST_TIMEOUT);
        assert_eq!(h.failures().len(), 1);
        assert_eq!(h.writes.len(), 2);

        h.data(&response(11, "com.example.first"));
        assert!(h.completions().is_empty(), "the late answer is dropped");
        h.data(&response(22, "com.example.second"));
        h.data(&response(33, "com.example.third"));
        let done = h.completions();
        assert_eq!(done.len(), 2);
        for (request, response) in done {
            assert_eq!(uid_of(request), response.uid);
        }
    }

    /// The rest of a response that failed to parse is dropped too.
    #[test]
    fn a_malformed_response_does_not_shift_later_ones() {
        let mut h = Harness::new();
        for uid in [1, 2] {
            h.sequencer.submit(request(uid));
        }
        h.tick(Duration::ZERO);
        let mut bad = vec![0];
        bad.extend_from_slice(&1u32.to_le_bytes());
        push_attribute(&mut bad, 3, "wrong attribute");
        let (head, tail) = bad.split_at(8);
        h.data(head);
        assert_eq!(h.failures().len(), 1);
        h.data(tail);
        h.data(&response(2, "com.example.two"));
        let done = h.completions();
        assert_eq!(done.len(), 1);
        assert_eq!(uid_of(done[0].0), 2);
        assert_eq!(done[0].1.uid, 2);
    }

    #[test]
    fn does_not_wait_for_a_response_to_an_action() {
        let mut h = Harness::new();
        h.sequencer.submit(action_request(5, Action::Positive));
        h.sequencer.submit(request(6));
        h.tick(Duration::ZERO);
        assert_eq!(h.writes.len(), 2);
        assert_eq!(h.completions().len(), 1);
        assert_eq!(h.completions()[0].1.uid, 5);
        assert!(h.sequencer.in_flight());
    }

    #[test]
    fn times_out_a_request_that_is_never_answered() {
        let mut h = Harness::new();
        h.sequencer.submit(request(1));
        h.sequencer.submit(request(2));
        h.tick(Duration::ZERO);
        assert_eq!(h.writes.len(), 1);

        h.tick(REQUEST_TIMEOUT - Duration::from_secs(1));
        assert!(h.failures().is_empty(), "not yet due");

        h.tick(REQUEST_TIMEOUT);
        assert_eq!(h.failures().len(), 1);
        assert_eq!(uid_of(h.failures()[0]), 1);
        assert_eq!(h.writes.len(), 2, "the queue must not stay wedged");
    }

    #[test]
    fn fails_a_request_whose_write_is_refused() {
        let mut h = Harness::new();
        h.write_succeeds = false;
        h.sequencer.submit(request(1));
        h.tick(Duration::ZERO);
        assert_eq!(h.failures().len(), 1);
        assert!(!h.sequencer.in_flight());
    }

    #[test]
    fn fails_the_request_when_its_response_is_malformed() {
        let mut h = Harness::new();
        h.sequencer.submit(request(1));
        h.tick(Duration::ZERO);
        let mut bad = vec![0];
        bad.extend_from_slice(&1u32.to_le_bytes());
        push_attribute(&mut bad, 3, "wrong attribute");
        h.data(&bad);
        assert_eq!(h.failures().len(), 1);
        assert!(h.completions().is_empty());
    }

    #[test]
    fn drops_everything_on_reset() {
        let mut h = Harness::new();
        h.sequencer.submit(request(1));
        h.sequencer.submit(request(2));
        h.tick(Duration::ZERO);
        h.sequencer.reset();
        assert!(!h.sequencer.in_flight());
        assert_eq!(h.sequencer.queued(), 0);

        h.data(&response(1, "com.example.one"));
        assert!(h.completions().is_empty());
    }

    #[test]
    fn bounds_the_queue() {
        let mut sequencer = Sequencer::default();
        let accepted = (0..MAX_QUEUED_REQUESTS + 10)
            .filter(|&i| sequencer.submit(request(u32::try_from(i).expect("uid"))))
            .count();
        assert_eq!(accepted, MAX_QUEUED_REQUESTS);
    }
}
