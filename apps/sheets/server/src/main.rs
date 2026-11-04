//! Spectral Sheets collaboration server binary. See the library docs for the HTTP/WebSocket API.

use std::net::SocketAddr;

use sheets_server::room::{self, Room};
use sheets_server::store::Store;
use sheets_server::{App, router};

#[tokio::main]
async fn main() {
    let bind = std::env::var("SHEETS_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let store = match std::env::var("DATABASE_URL") {
        Ok(url) => match Store::postgres(&url).await {
            Ok(s) => {
                eprintln!("storing workbooks in Postgres");
                s
            }
            Err(e) => {
                eprintln!("can't use DATABASE_URL: {e}");
                std::process::exit(1);
            }
        },
        Err(_) => {
            eprintln!("DATABASE_URL not set: workbooks live in memory and are lost on restart");
            Store::memory()
        }
    };
    let app = App::new(store);
    let addr: SocketAddr = match bind.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad SHEETS_BIND {bind:?}: {e}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("can't listen on {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("Spectral Sheets server on http://{addr}");
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(e) = axum::serve(listener, router(app.clone(), std::env::var("SHEETS_STATIC").ok())).with_graceful_shutdown(shutdown).await {
        eprintln!("server error: {e}");
    }
    // Write snapshots for every open book before exiting.
    let rooms: Vec<Room> = app.rooms.lock().await.values().cloned().collect();
    for r in rooms {
        let mut room = r.lock().await;
        if room.has_unsnapshotted_ops() {
            room::save_snapshot(&mut room, &app.store).await;
        }
    }
}
