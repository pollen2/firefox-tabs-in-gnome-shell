//! Native messaging host: Firefox starts it when the extension connects and
//! closes its stdin when Firefox quits, which ends the process and releases
//! the bus name.

mod bridge;
mod native;
mod service;

use std::error::Error;
use std::sync::Arc;

use tokio::sync::mpsc;
use zbus::fdo::RequestNameFlags;

use bridge::{Bridge, Event};
use service::{BUS_NAME_PREFIX, OBJECT_PATH, Service};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("firefox-tabs-host: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    // Firefox spawns us directly, so our parent is the browser process that
    // owns the windows; the shell uses this pid to find them.
    let firefox_pid = std::os::unix::process::parent_id();

    let (to_extension, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
    let bridge = Arc::new(Bridge::new(to_extension));

    let connection = zbus::connection::Builder::session()?
        .serve_at(OBJECT_PATH, Service { bridge: bridge.clone(), firefox_pid })?
        .build()
        .await?;
    let service = connection.object_server().interface::<_, Service>(OBJECT_PATH).await?;

    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outgoing.recv().await {
            if let Err(e) = native::write_message(&mut stdout, &message).await {
                eprintln!("firefox-tabs-host: writing to Firefox failed: {e}");
                break;
            }
        }
    });

    // The name is only claimed once there is a snapshot to serve, so the shell
    // never sees an instance with nothing to show. If a previous host for the
    // same Firefox is still shutting down, the newer one takes over.
    let bus_name = format!("{BUS_NAME_PREFIX}.i{firefox_pid}");
    let mut named = false;

    let mut stdin = tokio::io::stdin();
    while let Some(message) = native::read_message(&mut stdin).await? {
        match bridge.handle(&message) {
            Ok(Event::SnapshotChanged(serial)) => {
                if !named {
                    connection
                        .request_name_with_flags(
                            bus_name.as_str(),
                            RequestNameFlags::AllowReplacement | RequestNameFlags::ReplaceExisting,
                        )
                        .await?;
                    named = true;
                }
                Service::changed(service.signal_emitter(), serial).await?;
            }
            Ok(Event::None) => {}
            Err(e) => eprintln!("firefox-tabs-host: {e}"),
        }
    }
    Ok(())
}
