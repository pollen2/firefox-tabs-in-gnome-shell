//! State shared between the extension side (stdin/stdout) and the D-Bus side.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::icons::IconStore;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

type Reply = Result<Value, String>;

#[derive(Default)]
struct State {
    serial: u32,
    snapshot: String,
    tab_count: u32,
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
}

pub struct Bridge {
    state: Mutex<State>,
    to_extension: mpsc::UnboundedSender<Vec<u8>>,
    icons: Option<IconStore>,
}

/// One message from the extension. A flat struct rather than a tagged enum:
/// serde can't borrow a `RawValue` through an internally tagged enum, and
/// borrowing lets us store the snapshot without re-serializing it.
#[derive(Deserialize)]
struct Incoming<'a> {
    #[serde(rename = "type")]
    kind: String,
    #[serde(borrow)]
    data: Option<&'a RawValue>,
    id: Option<u64>,
    #[serde(default)]
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
    key: Option<String>,
    png: Option<String>,
    #[serde(rename = "tabCount")]
    tab_count: Option<u32>,
}

pub enum Event {
    SnapshotChanged { serial: u32, tab_count_changed: bool },
    None,
}

impl Bridge {
    pub fn new(to_extension: mpsc::UnboundedSender<Vec<u8>>, icons: Option<IconStore>) -> Self {
        Self { state: Mutex::default(), to_extension, icons }
    }

    pub fn snapshot(&self) -> (u32, String) {
        let state = self.state.lock().unwrap();
        (state.serial, state.snapshot.clone())
    }

    pub fn tab_count(&self) -> u32 {
        self.state.lock().unwrap().tab_count
    }

    pub fn handle(&self, message: &[u8]) -> Result<Event, String> {
        let message: Incoming = serde_json::from_slice(message).map_err(|e| format!("bad message: {e}"))?;
        if message.kind == "icon" {
            // Written before the snapshot naming it is handled, as messages
            // are processed in order.
            let (Some(key), Some(png)) = (&message.key, &message.png) else {
                return Err("icon without key or png".into());
            };
            if let Some(icons) = &self.icons {
                icons.store(key, png)?;
            }
            return Ok(Event::None);
        }
        let mut state = self.state.lock().unwrap();
        match message.kind.as_str() {
            "snapshot" => {
                let data = message.data.ok_or("snapshot without data")?;
                state.snapshot = data.get().to_owned();
                state.serial = state.serial.wrapping_add(1).max(1);
                let tab_count = message.tab_count.unwrap_or(state.tab_count);
                let tab_count_changed = tab_count != state.tab_count;
                state.tab_count = tab_count;
                Ok(Event::SnapshotChanged { serial: state.serial, tab_count_changed })
            }
            "reply" => {
                let id = message.id.ok_or("reply without id")?;
                // A missing entry means the caller already timed out.
                if let Some(sender) = state.pending.remove(&id) {
                    let reply = if message.ok {
                        Ok(message.result.unwrap_or(Value::Null))
                    } else {
                        Err(message.error.unwrap_or_else(|| "unknown error".into()))
                    };
                    let _ = sender.send(reply);
                }
                Ok(Event::None)
            }
            other => Err(format!("unknown message type {other:?}")),
        }
    }

    /// Runs a command in the extension and waits for its reply.
    pub async fn call(&self, op: &str, args: Value) -> Reply {
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next_id += 1;
            let id = state.next_id;
            state.pending.insert(id, sender);
            id
        };
        let message = json!({"type": "command", "id": id, "op": op, "args": args});
        if self.to_extension.send(message.to_string().into_bytes()).is_err() {
            self.state.lock().unwrap().pending.remove(&id);
            return Err("Firefox is gone".into());
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("Firefox is gone".into()),
            Err(_) => {
                self.state.lock().unwrap().pending.remove(&id);
                Err(format!("Firefox did not answer {op} in time"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_stored_verbatim_and_bumps_serial() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let bridge = Bridge::new(tx, None);
        assert_eq!(bridge.snapshot(), (0, String::new()));

        let event = bridge.handle(br#"{"type":"snapshot","data":{"schema":1, "windows":[]}}"#).unwrap();
        assert!(matches!(event, Event::SnapshotChanged { serial: 1, .. }));
        assert_eq!(bridge.snapshot(), (1, r#"{"schema":1, "windows":[]}"#.to_owned()));
    }

    #[test]
    fn tab_count_change_is_reported_only_when_it_changes() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let bridge = Bridge::new(tx, None);
        let snapshot = |count: u32| format!(r#"{{"type":"snapshot","data":{{}},"tabCount":{count}}}"#);
        let changed = |event| matches!(event, Event::SnapshotChanged { tab_count_changed: true, .. });

        assert!(changed(bridge.handle(snapshot(3).as_bytes()).unwrap()));
        assert!(!changed(bridge.handle(snapshot(3).as_bytes()).unwrap()));
        assert!(changed(bridge.handle(snapshot(4).as_bytes()).unwrap()));
        assert_eq!(bridge.tab_count(), 4);
    }

    #[tokio::test]
    async fn call_resolves_with_reply() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let bridge = std::sync::Arc::new(Bridge::new(tx, None));

        let caller = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.call("activate", json!({"tabId": 7})).await }
        });
        let sent: Value = serde_json::from_slice(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(sent["op"], "activate");
        assert_eq!(sent["args"]["tabId"], 7);

        let reply = json!({"type": "reply", "id": sent["id"], "ok": true, "result": {"windowId": 3}});
        bridge.handle(reply.to_string().as_bytes()).unwrap();
        assert_eq!(caller.await.unwrap().unwrap()["windowId"], 3);
    }

    #[tokio::test]
    async fn call_reports_extension_errors() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let bridge = std::sync::Arc::new(Bridge::new(tx, None));

        let caller = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.call("close", json!({"tabIds": [1]})).await }
        });
        let sent: Value = serde_json::from_slice(&rx.recv().await.unwrap()).unwrap();
        let reply = json!({"type": "reply", "id": sent["id"], "ok": false, "error": "Invalid tab ID: 1"});
        bridge.handle(reply.to_string().as_bytes()).unwrap();
        assert_eq!(caller.await.unwrap().unwrap_err(), "Invalid tab ID: 1");
    }
}
