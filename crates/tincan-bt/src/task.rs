//! Background task helpers. A panic inside a `tokio::spawn`ed task only
//! surfaces through its `JoinHandle`, so a long-running task (the MAP
//! supervisor, the ANCS session) runs its body through [`catch_panic`] and
//! turns a panic into a final state change instead of going quiet.

use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;

/// Runs `future`, returning `None` (after logging `task` at error level) if
/// it panics. The panic payload is not logged: it could quote data.
pub(crate) async fn catch_panic<F: Future>(task: &'static str, future: F) -> Option<F::Output> {
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(output) => Some(output),
        Err(_) => {
            tracing::error!(task, "background task panicked; stopping it");
            None
        }
    }
}

/// A connected peer-to-peer pair with nothing served (unit tests).
#[cfg(test)]
pub(crate) async fn p2p_pair() -> (zbus::Connection, zbus::Connection) {
    let (a, b) = std::os::unix::net::UnixStream::pair().expect("socket pair");
    let server = zbus::connection::Builder::unix_stream(a)
        .server(zbus::Guid::generate())
        .p2p()
        .build();
    let client = zbus::connection::Builder::unix_stream(b).p2p().build();
    let (server, client) = tokio::join!(server, client);
    (server.expect("server"), client.expect("client"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn turns_a_panic_into_none() {
        assert_eq!(catch_panic("ok", async { 7 }).await, Some(7));
        let panicked = catch_panic("boom", async {
            if std::hint::black_box(true) {
                panic!("test panic");
            }
        })
        .await;
        assert_eq!(panicked, None);
    }
}
