//! The D-Bus interface, see dbus/io.github.pollen2.FirefoxTabs1.xml.

use std::sync::Arc;

use serde_json::{Value, json};
use zbus::{fdo, interface, object_server::SignalEmitter};

use crate::bridge::Bridge;

pub const OBJECT_PATH: &str = "/io/github/pollen2/FirefoxTabs";
pub const BUS_NAME_PREFIX: &str = "io.github.pollen2.FirefoxTabs";

pub struct Service {
    pub bridge: Arc<Bridge>,
    pub firefox_pid: u32,
}

impl Service {
    async fn call(&self, op: &str, args: Value) -> fdo::Result<Value> {
        self.bridge.call(op, args).await.map_err(fdo::Error::Failed)
    }
}

#[interface(name = "io.github.pollen2.FirefoxTabs1")]
impl Service {
    #[zbus(out_args("serial", "json"))]
    fn get_snapshot(&self) -> (u32, String) {
        self.bridge.snapshot()
    }

    async fn activate_tab(&self, tab_id: i64) -> fdo::Result<String> {
        Ok(self.call("activate", json!({"tabId": tab_id})).await?.to_string())
    }

    async fn close_tabs(&self, tab_ids: Vec<i64>) -> fdo::Result<()> {
        self.call("close", json!({"tabIds": tab_ids})).await.map(drop)
    }

    async fn move_tabs(&self, tab_ids: Vec<i64>, window_id: i64, index: i32) -> fdo::Result<()> {
        self.call("move", json!({"tabIds": tab_ids, "windowId": window_id, "index": index}))
            .await
            .map(drop)
    }

    async fn move_tab_to_new_window(&self, tab_id: i64) -> fdo::Result<()> {
        self.call("newWindow", json!({"tabId": tab_id})).await.map(drop)
    }

    async fn group_tabs(&self, tab_ids: Vec<i64>, group_id: i64, window_id: i64) -> fdo::Result<i64> {
        let result = self
            .call("group", json!({"tabIds": tab_ids, "groupId": group_id, "windowId": window_id}))
            .await?;
        result.as_i64().ok_or_else(|| fdo::Error::Failed(format!("unexpected group id {result}")))
    }

    async fn ungroup_tabs(&self, tab_ids: Vec<i64>) -> fdo::Result<()> {
        self.call("ungroup", json!({"tabIds": tab_ids})).await.map(drop)
    }

    #[zbus(property)]
    fn firefox_pid(&self) -> u32 {
        self.firefox_pid
    }

    /// Announced only when it changes, so the shell's panel count costs a
    /// wakeup per opened or closed tab, not per page load.
    #[zbus(property)]
    fn tab_count(&self) -> u32 {
        self.bridge.tab_count()
    }

    #[zbus(signal)]
    pub async fn changed(emitter: &SignalEmitter<'_>, serial: u32) -> zbus::Result<()>;
}
