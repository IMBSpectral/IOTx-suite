//! Spectral Sheets collaboration server.
//!
//! `POST /api/books` creates a shared workbook (optionally seeded with XLSX bytes), `GET /ws/{id}`
//! joins it. Settings come from the environment:
//!   SHEETS_BIND      address to listen on (default 127.0.0.1:8787)
//!   DATABASE_URL     Postgres; without it books live in memory and vanish on restart
//!   SHEETS_STATIC    a built web app to serve (web/dist), so one process serves everything

pub mod room;
pub mod store;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use sheets_engine::Engine;
use tokio::sync::{Mutex, mpsc};

use room::{ClientMsg, Room, RoomState};
use store::{Snapshot, Store};

/// Largest workbook accepted on create, and largest websocket message.
const MAX_BOOK_BYTES: usize = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

pub struct App {
    pub store: Store,
    pub rooms: Mutex<HashMap<String, Room>>,
}

impl App {
    pub fn new(store: Store) -> Shared {
        Arc::new(App { store, rooms: Mutex::new(HashMap::new()) })
    }
}

pub type Shared = Arc<App>;

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({"error": message.into()}))).into_response()
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The room for `id`, loading it from the store on first use.
async fn room(app: &App, id: &str) -> Result<Option<Room>, String> {
    let mut rooms = app.rooms.lock().await;
    if let Some(r) = rooms.get(id) {
        return Ok(Some(r.clone()));
    }
    let Some(loaded) = app.store.load(id).await? else { return Ok(None) };
    let state = RoomState::restore(id, loaded.title, &loaded.snapshot, &loaded.ops)?;
    let r: Room = Arc::new(Mutex::new(state));
    rooms.insert(id.to_string(), r.clone());
    Ok(Some(r))
}

#[derive(Deserialize)]
struct CreateQuery {
    title: Option<String>,
}

/// Creates a shared workbook from the posted XLSX bytes (empty body = blank workbook).
async fn create_book(State(app): State<Shared>, Query(q): Query<CreateQuery>, body: Bytes) -> Response {
    let mut engine = Engine::new();
    if !body.is_empty()
        && let Err(e) = engine.open("upload.xlsx", &body)
    {
        return error(StatusCode::BAD_REQUEST, format!("not a workbook: {e}"));
    }
    let bytes = match engine.save_xlsx() {
        Ok(b) => b,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.0),
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let title: String = q.title.unwrap_or_else(|| "Untitled spreadsheet".into()).chars().take(200).collect();
    let snapshot = Snapshot { seq: 0, bytes, acked: HashMap::new() };
    match app.store.create(&id, &title, &snapshot).await {
        Ok(()) => (StatusCode::CREATED, axum::Json(json!({"id": id, "title": title}))).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_book(State(app): State<Shared>, Path(id): Path<String>) -> Response {
    if !valid_id(&id) {
        return error(StatusCode::NOT_FOUND, "no such workbook");
    }
    match room(&app, &id).await {
        Ok(Some(r)) => {
            let r = r.lock().await;
            axum::Json(json!({"id": id, "title": r.title, "seq": r.auth.seq, "people": r.client_count()})).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "no such workbook"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[derive(Deserialize)]
struct JoinQuery {
    sid: String,
    name: Option<String>,
}

async fn join(ws: WebSocketUpgrade, State(app): State<Shared>, Path(id): Path<String>, Query(q): Query<JoinQuery>) -> Response {
    if !valid_id(&id) || !valid_id(&q.sid) {
        return error(StatusCode::BAD_REQUEST, "bad workbook or session id");
    }
    let r = match room(&app, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return error(StatusCode::NOT_FOUND, "no such workbook"),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let name: String = q.name.unwrap_or_else(|| "Anonymous".into()).chars().take(40).collect();
    ws.max_message_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| session(app, r, q.sid, name, socket))
}

/// One connected tab: forwards its messages into the room and the room's messages out to it.
async fn session(app: Shared, r: Room, sid: String, name: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if let Err(e) = r.lock().await.join(&sid, &name, tx.clone()) {
        let _ = sink.send(Message::Text(json!({"t": "error", "error": e}).to_string().into())).await;
        return;
    }
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let parsed: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(json!({"t": "error", "error": format!("bad message: {e}")}).to_string());
                continue;
            }
        };
        let mut room = r.lock().await;
        let effect = room.handle(&sid, parsed);
        room::commit(&mut room, &app.store, effect).await;
    }
    let mut room = r.lock().await;
    room.leave(&sid, &tx);
    // The last person left: write a snapshot so the log stays short.
    if room.client_count() == 0 && room.has_unsnapshotted_ops() {
        room::save_snapshot(&mut room, &app.store).await;
    }
    drop(room);
    writer.abort();
}

pub fn router(app: Shared, static_dir: Option<String>) -> Router {
    let api = Router::new()
        .route("/api/books", post(create_book))
        .route("/api/books/{id}", get(get_book))
        .route("/ws/{id}", get(join))
        .route("/api/health", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BOOK_BYTES))
        .with_state(app);
    match static_dir {
        Some(dir) => {
            let index = format!("{dir}/index.html");
            api.fallback_service(tower_http::services::ServeDir::new(dir).fallback(tower_http::services::ServeFile::new(index)))
        }
        None => api,
    }
}

