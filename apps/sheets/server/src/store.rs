//! Durable state per workbook: a snapshot (XLSX bytes at some seq) plus the ops after it.
//! Postgres in production; an in-memory store for tests and quick local runs.

use std::collections::HashMap;

use sheets_engine::collab::Op;
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub seq: u64,
    pub bytes: Vec<u8>,
    /// Last cid applied per session, so resent ops stay deduplicated across restarts.
    pub acked: HashMap<String, u64>,
}

#[derive(Clone, Debug)]
pub struct Loaded {
    pub title: String,
    pub snapshot: Snapshot,
    /// Ops after the snapshot, in order.
    pub ops: Vec<Op>,
}

pub type StoreResult<T> = Result<T, String>;

pub enum Store {
    Memory(Mutex<HashMap<String, MemBook>>),
    Postgres(tokio_postgres::Client),
}

#[derive(Default)]
pub struct MemBook {
    title: String,
    snapshot: Option<Snapshot>,
    ops: Vec<Op>,
}

/// Arbitrary constant naming the advisory lock that guards schema creation.
const SCHEMA_LOCK: i64 = 0x5348_4545_5453;

const SCHEMA: &str = "
create table if not exists books (
  id text primary key,
  title text not null,
  created_at timestamptz not null default now()
);
create table if not exists snapshots (
  book_id text not null references books(id) on delete cascade,
  seq bigint not null,
  bytes bytea not null,
  acked jsonb not null,
  created_at timestamptz not null default now(),
  primary key (book_id, seq)
);
create table if not exists ops (
  book_id text not null references books(id) on delete cascade,
  seq bigint not null,
  sid text not null,
  cid bigint not null,
  sheet integer not null,
  steps jsonb not null,
  created_at timestamptz not null default now(),
  primary key (book_id, seq)
);
";

fn db_err(e: tokio_postgres::Error) -> String {
    e.to_string()
}

fn to_i64(v: u64) -> StoreResult<i64> {
    i64::try_from(v).map_err(|_| "sequence number out of range".to_string())
}

impl Store {
    pub fn memory() -> Store {
        Store::Memory(Mutex::new(HashMap::new()))
    }

    /// Connects and creates the tables if needed.
    pub async fn postgres(url: &str) -> StoreResult<Store> {
        let (client, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls).await.map_err(db_err)?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                eprintln!("postgres connection closed: {e}");
            }
        });
        // Concurrent "create table if not exists" can still collide: serialize it across processes.
        client.batch_execute(&format!("select pg_advisory_lock({SCHEMA_LOCK}); {SCHEMA} select pg_advisory_unlock({SCHEMA_LOCK});")).await.map_err(db_err)?;
        Ok(Store::Postgres(client))
    }

    pub async fn create(&self, id: &str, title: &str, snapshot: &Snapshot) -> StoreResult<()> {
        match self {
            Store::Memory(m) => {
                let mut m = m.lock().await;
                if m.contains_key(id) {
                    return Err("book exists".into());
                }
                m.insert(id.to_string(), MemBook { title: title.to_string(), snapshot: Some(snapshot.clone()), ops: vec![] });
                Ok(())
            }
            Store::Postgres(c) => {
                c.execute("insert into books (id, title) values ($1, $2)", &[&id, &title]).await.map_err(db_err)?;
                self.save_snapshot(id, snapshot).await
            }
        }
    }

    pub async fn load(&self, id: &str) -> StoreResult<Option<Loaded>> {
        match self {
            Store::Memory(m) => {
                let m = m.lock().await;
                let Some(b) = m.get(id) else { return Ok(None) };
                let Some(snapshot) = b.snapshot.clone() else { return Ok(None) };
                let ops = b.ops.iter().filter(|o| o.seq > snapshot.seq).cloned().collect();
                Ok(Some(Loaded { title: b.title.clone(), snapshot, ops }))
            }
            Store::Postgres(c) => {
                let Some(book) = c.query_opt("select title from books where id = $1", &[&id]).await.map_err(db_err)? else {
                    return Ok(None);
                };
                let title: String = book.get(0);
                let Some(snap) = c
                    .query_opt("select seq, bytes, acked from snapshots where book_id = $1 order by seq desc limit 1", &[&id])
                    .await
                    .map_err(db_err)?
                else {
                    return Ok(None);
                };
                let seq: i64 = snap.get(0);
                let acked: serde_json::Value = snap.get(2);
                let snapshot = Snapshot {
                    seq: u64::try_from(seq).map_err(|_| "bad seq".to_string())?,
                    bytes: snap.get(1),
                    acked: serde_json::from_value(acked).map_err(|e| e.to_string())?,
                };
                let rows = c
                    .query("select seq, sid, cid, sheet, steps from ops where book_id = $1 and seq > $2 order by seq", &[&id, &seq])
                    .await
                    .map_err(db_err)?;
                let mut ops = Vec::with_capacity(rows.len());
                for r in rows {
                    let steps: serde_json::Value = r.get(4);
                    ops.push(Op {
                        seq: u64::try_from(r.get::<_, i64>(0)).map_err(|_| "bad seq".to_string())?,
                        sid: r.get(1),
                        cid: u64::try_from(r.get::<_, i64>(2)).map_err(|_| "bad cid".to_string())?,
                        sheet: usize::try_from(r.get::<_, i32>(3)).map_err(|_| "bad sheet".to_string())?,
                        steps: serde_json::from_value(steps).map_err(|e| e.to_string())?,
                    });
                }
                Ok(Some(Loaded { title, snapshot, ops }))
            }
        }
    }

    pub async fn append(&self, id: &str, op: &Op) -> StoreResult<()> {
        match self {
            Store::Memory(m) => {
                let mut m = m.lock().await;
                let b = m.get_mut(id).ok_or("no such book")?;
                b.ops.push(op.clone());
                Ok(())
            }
            Store::Postgres(c) => {
                let steps = serde_json::to_value(&op.steps).map_err(|e| e.to_string())?;
                let sheet = i32::try_from(op.sheet).map_err(|_| "sheet out of range".to_string())?;
                c.execute(
                    "insert into ops (book_id, seq, sid, cid, sheet, steps) values ($1, $2, $3, $4, $5, $6)",
                    &[&id, &to_i64(op.seq)?, &op.sid, &to_i64(op.cid)?, &sheet, &steps],
                )
                .await
                .map_err(db_err)?;
                Ok(())
            }
        }
    }

    /// Writes a snapshot and drops the ops it covers.
    pub async fn save_snapshot(&self, id: &str, s: &Snapshot) -> StoreResult<()> {
        match self {
            Store::Memory(m) => {
                let mut m = m.lock().await;
                let b = m.get_mut(id).ok_or("no such book")?;
                b.ops.retain(|o| o.seq > s.seq);
                b.snapshot = Some(s.clone());
                Ok(())
            }
            Store::Postgres(c) => {
                let acked = serde_json::to_value(&s.acked).map_err(|e| e.to_string())?;
                let seq = to_i64(s.seq)?;
                c.execute(
                    "insert into snapshots (book_id, seq, bytes, acked) values ($1, $2, $3, $4) on conflict (book_id, seq) do update set bytes = excluded.bytes, acked = excluded.acked",
                    &[&id, &seq, &s.bytes, &acked],
                )
                .await
                .map_err(db_err)?;
                c.execute("delete from ops where book_id = $1 and seq <= $2", &[&id, &seq]).await.map_err(db_err)?;
                c.execute("delete from snapshots where book_id = $1 and seq < $2", &[&id, &seq]).await.map_err(db_err)?;
                Ok(())
            }
        }
    }

    pub async fn set_title(&self, id: &str, title: &str) -> StoreResult<()> {
        match self {
            Store::Memory(m) => {
                if let Some(b) = m.lock().await.get_mut(id) {
                    b.title = title.to_string();
                }
                Ok(())
            }
            Store::Postgres(c) => {
                c.execute("update books set title = $2 where id = $1", &[&id, &title]).await.map_err(db_err)?;
                Ok(())
            }
        }
    }
}
