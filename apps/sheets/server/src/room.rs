//! One open workbook: the authoritative engine, who's connected, and the order of ops.
//!
//! Everything that changes a room happens under its lock, and every message to a client goes
//! through that client's queue while the lock is held, so all clients see ops in `seq` order.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sheets_engine::Engine;
use sheets_engine::collab::{Authority, Op, Refusal, Submit};
use tokio::sync::{Mutex, mpsc};

use crate::store::{Snapshot, Store};

/// A snapshot every this many ops keeps restarts and joins fast.
pub const SNAPSHOT_EVERY: u64 = 100;
pub const MAX_CLIENTS: usize = 50;
pub const MAX_STEPS: usize = 64;

const COLORS: [&str; 8] = ["#d31763", "#0b8043", "#a35a00", "#5d722c", "#1a73e8", "#9334e6", "#e37400", "#00897b"];

/// Messages from a client.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    Op(Submit),
    Presence { sheet: usize, sel: String },
    Title { title: String },
    Resync,
}

#[derive(Clone, Debug, Serialize)]
pub struct Peer {
    pub sid: String,
    pub name: String,
    pub color: String,
    pub sheet: usize,
    pub sel: String,
}

struct Client {
    peer: Peer,
    tx: mpsc::UnboundedSender<String>,
}

pub struct RoomState {
    pub id: String,
    pub title: String,
    pub auth: Authority,
    clients: HashMap<String, Client>,
    /// seq of the last snapshot written.
    snapshot_seq: u64,
    next_color: usize,
}

pub type Room = Arc<Mutex<RoomState>>;

/// What a handled message changed, to persist and then announce.
#[derive(Debug)]
pub enum Effect {
    None,
    Op(Op),
    Title,
}

fn send(tx: &mpsc::UnboundedSender<String>, msg: &Json) {
    // A closed queue means the client is going away; its socket task cleans up.
    let _ = tx.send(msg.to_string());
}

impl RoomState {
    /// Rebuilds a room from its stored snapshot and the ops after it.
    pub fn restore(id: &str, title: String, snapshot: &Snapshot, ops: &[Op]) -> Result<RoomState, String> {
        let mut engine = Engine::new();
        engine.open("book.xlsx", &snapshot.bytes).map_err(|e| e.0)?;
        let mut auth = Authority::new(engine, snapshot.seq);
        auth.acked = snapshot.acked.clone();
        for op in ops {
            auth.replay(op);
        }
        Ok(RoomState { id: id.to_string(), title, auth, clients: HashMap::new(), snapshot_seq: snapshot.seq, next_color: 0 })
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        Ok(Snapshot { seq: self.auth.seq, bytes: self.auth.engine.save_xlsx().map_err(|e| e.0)?, acked: self.auth.acked.clone() })
    }

    fn snapshot_msg(&self, kind: &str, sid: &str) -> Result<Json, String> {
        let s = self.snapshot()?;
        Ok(json!({
            "t": kind,
            "seq": s.seq,
            "acked": self.auth.acked(sid),
            "title": self.title,
            "snapshot": B64.encode(&s.bytes),
        }))
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    /// Adds a connection. `sid` is the client's own id, kept across reconnects of the same tab.
    pub fn join(&mut self, sid: &str, name: &str, tx: mpsc::UnboundedSender<String>) -> Result<(), String> {
        if self.clients.len() >= MAX_CLIENTS && !self.clients.contains_key(sid) {
            return Err("this workbook has too many people in it".into());
        }
        let color = COLORS.get(self.next_color % COLORS.len()).copied().unwrap_or("#1a73e8").to_string();
        self.next_color += 1;
        let peer = Peer { sid: sid.to_string(), name: name.to_string(), color, sheet: 0, sel: "A1".into() };
        let mut welcome = self.snapshot_msg("welcome", sid)?;
        welcome["you"] = json!(peer);
        welcome["peers"] = json!(self.clients.values().filter(|c| c.peer.sid != sid).map(|c| &c.peer).collect::<Vec<_>>());
        send(&tx, &welcome);
        let joined = json!({"t": "presence", "peer": peer});
        for c in self.clients.values().filter(|c| c.peer.sid != sid) {
            send(&c.tx, &joined);
        }
        self.clients.insert(sid.to_string(), Client { peer, tx });
        Ok(())
    }

    /// Removes a connection, unless the same tab already reconnected with a newer one.
    pub fn leave(&mut self, sid: &str, tx: &mpsc::UnboundedSender<String>) {
        if self.clients.get(sid).is_some_and(|c| c.tx.same_channel(tx)) {
            self.clients.remove(sid);
            let msg = json!({"t": "leave", "sid": sid});
            for c in self.clients.values() {
                send(&c.tx, &msg);
            }
        }
    }

    fn broadcast(&self, msg: &Json) {
        for c in self.clients.values() {
            send(&c.tx, msg);
        }
    }

    fn reply(&self, sid: &str, msg: &Json) {
        if let Some(c) = self.clients.get(sid) {
            send(&c.tx, msg);
        }
    }

    /// Handles one message. Accepted ops and title changes are returned, not yet announced: the
    /// caller writes them to the store first, then calls [`RoomState::publish`], so nobody ever
    /// sees a change the server could lose in a crash.
    pub fn handle(&mut self, sid: &str, msg: ClientMsg) -> Effect {
        match msg {
            ClientMsg::Op(submit) => {
                let cid = submit.cid;
                if submit.steps.len() > MAX_STEPS {
                    self.reply(sid, &json!({"t": "reject", "cid": cid, "error": "too many commands in one op"}));
                    return Effect::None;
                }
                match self.auth.apply(sid, submit) {
                    Ok(op) => Effect::Op(op),
                    Err(Refusal::Duplicate) => Effect::None,
                    Err(Refusal::Invalid(error)) => {
                        self.reply(sid, &json!({"t": "reject", "cid": cid, "error": error}));
                        Effect::None
                    }
                }
            }
            ClientMsg::Presence { sheet, sel } => {
                let sel: String = sel.chars().take(64).collect();
                if let Some(c) = self.clients.get_mut(sid) {
                    c.peer.sheet = sheet;
                    c.peer.sel = sel;
                    let msg = json!({"t": "presence", "peer": c.peer});
                    for (other, c) in &self.clients {
                        if other != sid {
                            send(&c.tx, &msg);
                        }
                    }
                }
                Effect::None
            }
            ClientMsg::Title { title } => {
                self.title = title.chars().take(200).collect();
                Effect::Title
            }
            ClientMsg::Resync => {
                match self.snapshot_msg("snapshot", sid) {
                    Ok(m) => self.reply(sid, &m),
                    Err(e) => self.reply(sid, &json!({"t": "error", "error": e})),
                }
                Effect::None
            }
        }
    }

    /// Announces a change after it was written to the store.
    pub fn publish(&self, effect: &Effect) {
        match effect {
            Effect::Op(op) => {
                let mut msg = json!(op);
                msg["t"] = json!("op");
                self.broadcast(&msg);
            }
            Effect::Title => self.broadcast(&json!({"t": "title", "title": self.title})),
            Effect::None => {}
        }
    }

    /// Whether enough ops piled up since the last snapshot.
    pub fn snapshot_due(&self) -> bool {
        self.auth.seq >= self.snapshot_seq + SNAPSHOT_EVERY
    }

    pub fn snapshot_written(&mut self, seq: u64) {
        self.snapshot_seq = self.snapshot_seq.max(seq);
    }

    pub fn has_unsnapshotted_ops(&self) -> bool {
        self.auth.seq > self.snapshot_seq
    }
}

/// Writes what a handled message changed, then announces it (write first: an announced change is
/// never lost). If the op log write fails, a snapshot is attempted at once so the change is kept.
pub async fn commit(room: &mut RoomState, store: &Store, effect: Effect) {
    let mut snapshot_now = room.snapshot_due();
    match &effect {
        Effect::Op(op) => {
            if let Err(e) = store.append(&room.id, op).await {
                eprintln!("book {}: couldn't log op {}: {e}", room.id, op.seq);
                snapshot_now = true;
            }
        }
        Effect::Title => {
            if let Err(e) = store.set_title(&room.id, &room.title).await {
                eprintln!("book {}: couldn't save the title: {e}", room.id);
            }
        }
        Effect::None => return,
    }
    room.publish(&effect);
    if snapshot_now {
        save_snapshot(room, store).await;
    }
}

pub async fn save_snapshot(room: &mut RoomState, store: &Store) {
    match room.snapshot() {
        Ok(s) => match store.save_snapshot(&room.id, &s).await {
            Ok(()) => room.snapshot_written(s.seq),
            Err(e) => eprintln!("book {}: couldn't write snapshot: {e}", room.id),
        },
        Err(e) => eprintln!("book {}: couldn't build snapshot: {e}", room.id),
    }
}
