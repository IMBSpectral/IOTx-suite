//! End-to-end over real sockets: HTTP create, WebSocket join, ops, presence, restart recovery.
//! Runs against the in-memory store, and also against Postgres when SHEETS_TEST_DATABASE_URL is set.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sheets_engine::Engine;
use sheets_server::store::Store;
use sheets_server::{App, Shared, router};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn serve(app: Shared) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(app, None)).await.unwrap() });
    addr.to_string()
}

/// A minimal HTTP/1.1 request (no client library needed).
async fn http(addr: &str, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(head.as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).to_string();
    let status = text.split(' ').nth(1).unwrap().parse().unwrap();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    (status, serde_json::from_str(body.trim()).unwrap_or(Value::Null))
}

async fn create(addr: &str, seed: &[u8]) -> String {
    let (status, v) = http(addr, "POST", "/api/books?title=Team%20budget", seed).await;
    assert_eq!(status, 201, "{v}");
    v["id"].as_str().unwrap().to_string()
}

async fn connect(addr: &str, book: &str, sid: &str) -> (Ws, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/{book}?sid={sid}&name={sid}")).await.unwrap();
    let welcome = recv(&mut ws).await;
    assert_eq!(welcome["t"], "welcome");
    (ws, welcome)
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("timed out waiting for a message").unwrap().unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

/// The next message of type `t`, skipping others (presence chatter).
async fn recv_t(ws: &mut Ws, t: &str) -> Value {
    loop {
        let m = recv(ws).await;
        if m["t"] == t {
            return m;
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

fn op(cid: u64, cell: &str, input: &str) -> Value {
    json!({"t": "op", "cid": cid, "sheet": 0, "steps": [{"cmd": "cell.set", "params": {"cell": cell, "input": input}}]})
}

fn cell_text(snapshot_b64: &str, r: u32, c: u32) -> Option<String> {
    let mut e = Engine::new();
    e.open("s.xlsx", &B64.decode(snapshot_b64).unwrap()).unwrap();
    e.viewport(r, c, r, c).unwrap().cells.first().map(|x| x.2.clone())
}

fn sid(n: &str) -> String {
    format!("{n}-{}", uuid::Uuid::new_v4().simple())
}

async fn two_people_edit_one_workbook(app: Shared) {
    let addr = serve(app).await;
    let mut seed = Engine::new();
    seed.execute("cell.set", json!({"cell": "A1", "input": "100"})).unwrap();
    let book = create(&addr, &seed.save_xlsx().unwrap()).await;
    let (a_sid, b_sid) = (sid("alice"), sid("bob"));
    let (mut a, wa) = connect(&addr, &book, &a_sid).await;
    assert_eq!(wa["seq"], 0);
    assert_eq!(wa["title"], "Team budget");
    assert_eq!(cell_text(wa["snapshot"].as_str().unwrap(), 0, 0).as_deref(), Some("100"));
    let (mut b, wb) = connect(&addr, &book, &b_sid).await;
    assert_eq!(wb["peers"][0]["sid"], a_sid.as_str());
    let joined = recv_t(&mut a, "presence").await;
    assert_eq!(joined["peer"]["sid"], b_sid.as_str());

    // Alice edits; both get the op with seq 1, in order.
    send(&mut a, op(1, "A2", "=A1*2")).await;
    let oa = recv_t(&mut a, "op").await;
    let ob = recv_t(&mut b, "op").await;
    assert_eq!(oa, ob);
    assert_eq!(oa["seq"], 1);
    assert_eq!(oa["sid"], a_sid.as_str());

    // Bob's invalid op is refused to Bob only.
    send(&mut b, json!({"t": "op", "cid": 1, "sheet": 7, "steps": [{"cmd": "cell.set", "params": {"cell": "A1", "input": "x"}}]})).await;
    let rej = recv_t(&mut b, "reject").await;
    assert_eq!(rej["cid"], 1);

    // Presence goes to the others.
    send(&mut b, json!({"t": "presence", "sheet": 0, "sel": "C3:D4"})).await;
    let p = recv_t(&mut a, "presence").await;
    assert_eq!(p["peer"]["sel"], "C3:D4");

    // A resent op (same cid) is not applied twice; the next new op gets seq 2.
    send(&mut a, op(1, "A2", "=A1*2")).await;
    send(&mut b, op(2, "B1", "bob was here")).await;
    let next = recv_t(&mut a, "op").await;
    assert_eq!(next["seq"], 2);
    assert_eq!(next["sid"], b_sid.as_str());

    // A late joiner gets the current state.
    let (_c, wc) = connect(&addr, &book, &sid("carol")).await;
    assert_eq!(wc["seq"], 2);
    let snap = wc["snapshot"].as_str().unwrap();
    assert_eq!(cell_text(snap, 1, 0).as_deref(), Some("200"));
    assert_eq!(cell_text(snap, 0, 1).as_deref(), Some("bob was here"));

    // Leaving tells the others.
    b.close(None).await.unwrap();
    let left = recv_t(&mut a, "leave").await;
    assert_eq!(left["sid"], b_sid.as_str());
}

async fn state_survives_a_restart(store_a: Shared, store_b: impl FnOnce(Shared) -> Shared) {
    let addr = serve(store_a.clone()).await;
    let book = create(&addr, b"").await;
    let s = sid("dana");
    let (mut a, _) = connect(&addr, &book, &s).await;
    for i in 1..=5u64 {
        send(&mut a, op(i, &format!("A{i}"), &format!("{}", i * 10))).await;
        recv_t(&mut a, "op").await;
    }
    send(&mut a, json!({"t": "title", "title": "Renamed"})).await;
    recv_t(&mut a, "title").await;
    // "Restart": a fresh app on the same store, with no rooms in memory.
    let app2 = store_b(store_a);
    app2.rooms.lock().await.clear();
    let addr2 = serve(app2).await;
    let (status, info) = http(&addr2, "GET", &format!("/api/books/{book}"), b"").await;
    assert_eq!(status, 200);
    assert_eq!(info["seq"], 5);
    assert_eq!(info["title"], "Renamed");
    let (mut a2, w) = connect(&addr2, &book, &s).await;
    assert_eq!(w["seq"], 5);
    assert_eq!(w["acked"], 5, "dedup state survives the restart");
    assert_eq!(cell_text(w["snapshot"].as_str().unwrap(), 4, 0).as_deref(), Some("50"));
    send(&mut a2, op(5, "A5", "dup")).await; // already applied before the restart
    send(&mut a2, op(6, "A6", "60")).await;
    let next = recv_t(&mut a2, "op").await;
    assert_eq!((next["seq"].clone(), next["cid"].clone()), (json!(6), json!(6)));
}

#[tokio::test]
async fn memory_two_people_edit_one_workbook() {
    two_people_edit_one_workbook(App::new(Store::memory())).await;
}

#[tokio::test]
async fn memory_state_survives_a_restart() {
    state_survives_a_restart(App::new(Store::memory()), |a| a).await;
}

#[tokio::test]
async fn bad_requests_are_refused() {
    let addr = serve(App::new(Store::memory())).await;
    assert_eq!(http(&addr, "GET", "/api/books/nope", b"").await.0, 404);
    assert_eq!(http(&addr, "GET", "/api/books/0123456789abcdef0123456789abcdef", b"").await.0, 404);
    let book = create(&addr, b"").await;
    // Unknown session id format.
    let r = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/{book}?sid=x")).await;
    assert!(r.is_err());
    // Garbage messages get an error reply, and the connection keeps working.
    let (mut ws, _) = connect(&addr, &book, &sid("eve")).await;
    ws.send(Message::Text("{not json".into())).await.unwrap();
    assert_eq!(recv_t(&mut ws, "error").await["t"], "error");
    send(&mut ws, op(1, "A1", "still fine")).await;
    assert_eq!(recv_t(&mut ws, "op").await["seq"], 1);
}

fn pg_url() -> Option<String> {
    std::env::var("SHEETS_TEST_DATABASE_URL").ok()
}

#[tokio::test]
async fn postgres_two_people_edit_one_workbook() {
    let Some(url) = pg_url() else { return eprintln!("skipped: SHEETS_TEST_DATABASE_URL not set") };
    two_people_edit_one_workbook(App::new(Store::postgres(&url).await.unwrap())).await;
}

#[tokio::test]
async fn postgres_state_survives_a_restart() {
    let Some(url) = pg_url() else { return eprintln!("skipped: SHEETS_TEST_DATABASE_URL not set") };
    let first = App::new(Store::postgres(&url).await.unwrap());
    let fresh = App::new(Store::postgres(&url).await.unwrap());
    state_survives_a_restart(first, move |_| fresh).await;
}
