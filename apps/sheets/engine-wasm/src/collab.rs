//! Real-time collaboration: one server-ordered log of engine commands, replicated everywhere.
//!
//! Every edit is an engine command. The server applies each op to its own engine, gives it the next
//! sequence number and broadcasts it; every client applies ops in that order, so all replicas run
//! the same commands on the same state and converge.
//!
//! A client shows its own edits at once (optimistic). They wait in `pending` until the server echoes
//! them back. When someone else's op arrives first, the client undoes its pending ops (the engine's
//! own undo history), applies the remote op, and re-applies its pending ops on top: a rebase.
//!
//! View state (which sheet is open, the selection, the clipboard) stays local. Ops carry the sheet
//! they were made on, and each replica applies them there without changing what its user sees.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

use crate::{Engine, EngineError, Result};

/// One engine command inside an op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub cmd: String,
    #[serde(default)]
    pub params: Json,
}

/// What a client sends: its own id for the op, the sheet it was made on, the commands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Submit {
    pub cid: u64,
    pub sheet: usize,
    pub steps: Vec<Step>,
}

/// An op the server accepted: `seq` orders it among everyone's ops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub seq: u64,
    /// Session id of the author.
    pub sid: String,
    pub cid: u64,
    pub sheet: usize,
    pub steps: Vec<Step>,
}

/// Commands that only touch this user's view or clipboard: run locally, never sent.
pub fn is_local_only(id: &str) -> bool {
    matches!(id, "sheet.activate" | "edit.copy" | "edit.cut") || id.starts_with("selection.") || imbgridly_engine::find_command(id).is_some_and(|c| !c.journal)
}

/// Commands whose effect depends on history this replica may not share (undo/redo). The server
/// applies them and every client reloads the server's state.
pub fn is_server_only(id: &str) -> bool {
    matches!(id, "edit.undo" | "edit.redo")
}

/// Equal apart from line-ending style and trailing newlines (the OS clipboard rewrites them).
pub fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace("\r\n", "\n").replace('\r', "\n").trim_end_matches('\n').to_string();
    norm(a) == norm(b)
}

/// Upper bound on undo steps a client keeps pending; past it the client resyncs from a snapshot
/// instead of rebasing (the engine keeps at most 100 undo steps).
pub const MAX_PENDING_STEPS: u64 = 90;

impl Engine {
    pub fn revision(&self) -> u64 {
        self.doc().map_or(0, |d| d.revision)
    }

    pub fn active_sheet(&self) -> usize {
        self.doc().map_or(0, |d| d.wb.active_sheet)
    }

    pub fn sheet_count(&self) -> usize {
        self.doc().map_or(0, |d| d.wb.sheets.len())
    }

    fn activate(&mut self, sheet: usize) -> Result<()> {
        if self.active_sheet() != sheet {
            if sheet >= self.sheet_count() {
                return Err(EngineError(format!("no sheet {sheet}")));
            }
            self.session.execute_headless("sheet.activate", json!({ "sheet": sheet }))?;
        }
        Ok(())
    }

    fn undo_steps(&mut self, n: u64) -> Result<()> {
        for _ in 0..n {
            self.session.execute_headless("edit.undo", json!({}))?;
        }
        Ok(())
    }

    /// Runs `steps` on `sheet`, all or nothing. Returns the undo steps it recorded.
    ///
    /// Ops run with an empty clipboard, whatever this replica's user last copied: `edit.paste`
    /// chooses between "our own copy" and "external text" by looking at the clipboard, and that
    /// choice must be the same on every replica. An in-app paste carries its own copy step.
    pub fn apply_steps(&mut self, sheet: usize, steps: &[Step]) -> Result<u64> {
        if steps.is_empty() {
            return Err(EngineError("empty op".into()));
        }
        self.activate(sheet)?;
        let clipboard = self.session.clipboard.take();
        let result = self.run_steps(steps);
        self.session.clipboard = clipboard;
        result
    }

    fn run_steps(&mut self, steps: &[Step]) -> Result<u64> {
        let before = self.revision();
        for step in steps {
            if let Err(e) = self.session.execute_headless(&step.cmd, step.params.clone()) {
                let done = self.revision().saturating_sub(before);
                self.undo_steps(done)?;
                return Err(e.into());
            }
        }
        Ok(self.revision().saturating_sub(before))
    }
}

#[derive(Clone, Debug)]
struct Pending {
    submit: Submit,
    /// Undo steps this op recorded locally, to take it back during a rebase.
    undo: u64,
}

/// What the page must do after the replica handled something.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Outcome {
    /// An op to send to the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send: Option<Submit>,
    /// Pending ops of ours that no longer apply after a rebase (dropped; tell the user).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped: Vec<u64>,
    /// The replica can't rebase (too much pending history): reload from the server's snapshot.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub resync: bool,
    pub revision: u64,
    /// Ops of ours not yet confirmed by the server (0 = everything is saved).
    pub pending: usize,
    /// What a local-only command returned (the text `edit.copy` puts on the system clipboard).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Json>,
}

/// A client's copy of a shared workbook.
pub struct Replica {
    pub engine: Engine,
    pub sid: String,
    /// Last server sequence number applied.
    pub seq: u64,
    pending: VecDeque<Pending>,
    next_cid: u64,
    /// The sheet this user is looking at.
    view_sheet: usize,
}

impl Replica {
    /// A replica of the server's state at `seq`, loaded from its snapshot.
    pub fn from_snapshot(sid: impl Into<String>, bytes: &[u8], seq: u64) -> Result<Replica> {
        let mut engine = Engine::new();
        engine.open("shared.xlsx", bytes)?;
        let view_sheet = engine.active_sheet();
        Ok(Replica { engine, sid: sid.into(), seq, pending: VecDeque::new(), next_cid: 1, view_sheet })
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn pending_steps(&self) -> u64 {
        self.pending.iter().map(|p| p.undo).sum()
    }

    fn outcome(&self) -> Outcome {
        Outcome { revision: self.engine.revision(), pending: self.pending.len(), ..Outcome::default() }
    }

    /// The user ran a command. Local-only commands run here; edits run here and are sent; undo and
    /// redo are only sent (the server's state comes back).
    pub fn local(&mut self, cmd: &str, params: Json) -> Result<Outcome> {
        self.local_steps(vec![Step { cmd: cmd.to_string(), params }])
    }

    /// Several commands as one op (copy + paste, so every replica pastes the same source).
    pub fn local_steps(&mut self, steps: Vec<Step>) -> Result<Outcome> {
        let (steps, was_cut) = self.with_copy_source(steps);
        let out = self.local_steps_inner(steps)?;
        // A cut moves once: after its paste the clipboard is spent.
        if was_cut && out.send.is_some() {
            self.engine.session.clipboard = None;
        }
        Ok(out)
    }

    /// A paste of this user's own copy becomes [copy-of-the-source, paste], so every replica
    /// pastes the same cells (formulas shifted, formats kept) though none shares this clipboard.
    /// Returns whether the source was a cut.
    fn with_copy_source(&self, steps: Vec<Step>) -> (Vec<Step>, bool) {
        let [only] = steps.as_slice() else { return (steps, false) };
        if only.cmd != "edit.paste" {
            return (steps, false);
        }
        let Some(clip) = self.engine.session.clipboard.as_ref() else { return (steps, false) };
        let ours = match only.params.get("text").and_then(Json::as_str) {
            None => true,
            Some(text) => same_text(text, &clip.text),
        };
        if !ours || !clip.areas.is_empty() {
            return (steps, false);
        }
        let source = Step {
            cmd: if clip.cut { "edit.cut" } else { "edit.copy" }.into(),
            params: json!({ "range": clip.selected.to_string(), "sheet": clip.sheet }),
        };
        let mut paste = only.clone();
        if let Some(p) = paste.params.as_object_mut() {
            p.remove("text");
            p.remove("html");
        }
        (vec![source, paste], clip.cut)
    }

    fn local_steps_inner(&mut self, steps: Vec<Step>) -> Result<Outcome> {
        let Some(first) = steps.first() else { return Err(EngineError("empty op".into())) };
        if steps.len() == 1 && is_local_only(&first.cmd) {
            let mut r = self.engine.execute(&first.cmd, first.params.clone())?;
            self.view_sheet = self.engine.active_sheet();
            return Ok(Outcome { result: Some(r["result"].take()), ..self.outcome() });
        }
        let cid = self.next_cid;
        self.next_cid += 1;
        let submit = Submit { cid, sheet: self.view_sheet, steps };
        if submit.steps.iter().any(|s| is_server_only(&s.cmd)) {
            return Ok(Outcome { send: Some(submit), ..self.outcome() });
        }
        let undo = self.engine.apply_steps(self.view_sheet, &submit.steps)?;
        // The user's own edit may move their view (inserting a sheet opens it).
        self.view_sheet = self.engine.active_sheet();
        self.pending.push_back(Pending { submit: submit.clone(), undo });
        let resync = self.pending_steps() > MAX_PENDING_STEPS;
        Ok(Outcome { send: Some(submit), resync, ..self.outcome() })
    }

    /// Takes back every pending op (newest first).
    fn rollback(&mut self) -> Result<()> {
        let total: u64 = self.pending.iter().map(|p| p.undo).sum();
        self.engine.undo_steps(total)
    }

    /// Re-applies pending ops on the new base; ones that no longer apply are dropped.
    fn replay(&mut self) -> Vec<u64> {
        let mut dropped = vec![];
        let mut kept = VecDeque::with_capacity(self.pending.len());
        for mut p in std::mem::take(&mut self.pending) {
            match self.engine.apply_steps(p.submit.sheet, &p.submit.steps) {
                Ok(undo) => {
                    p.undo = undo;
                    kept.push_back(p);
                }
                Err(_) => dropped.push(p.submit.cid),
            }
        }
        self.pending = kept;
        dropped
    }

    /// An op from the server (anyone's, in order).
    pub fn remote(&mut self, op: &Op) -> Result<Outcome> {
        if op.seq <= self.seq {
            return Ok(self.outcome()); // already applied (a duplicate after reconnecting)
        }
        if op.seq != self.seq + 1 {
            return Ok(Outcome { resync: true, ..self.outcome() });
        }
        // Our own op coming back: it was applied when we made it, and nothing came in between.
        if op.sid == self.sid
            && let Some(front) = self.pending.front()
            && front.submit.cid == op.cid
        {
            self.pending.pop_front();
            self.seq = op.seq;
            return Ok(self.outcome());
        }
        // Undo/redo act on the server's history, which replicas don't share: reload its state.
        if self.pending_steps() > MAX_PENDING_STEPS || op.steps.iter().any(|s| is_server_only(&s.cmd)) {
            return Ok(Outcome { resync: true, ..self.outcome() });
        }
        self.rollback()?;
        // An op the server accepted must apply here too; if it doesn't, this replica has diverged.
        let applied = self.engine.apply_steps(op.sheet, &op.steps);
        self.seq = op.seq;
        let dropped = self.replay();
        self.engine.activate(self.view_sheet.min(self.engine.sheet_count().saturating_sub(1)))?;
        if applied.is_err() {
            return Ok(Outcome { resync: true, dropped, ..self.outcome() });
        }
        Ok(Outcome { dropped, ..self.outcome() })
    }

    /// The server refused one of our ops: take it back, keep the rest.
    pub fn rejected(&mut self, cid: u64) -> Result<Outcome> {
        if !self.pending.iter().any(|p| p.submit.cid == cid) {
            return Ok(self.outcome());
        }
        self.rollback()?;
        self.pending.retain(|p| p.submit.cid != cid);
        let dropped = self.replay();
        self.engine.activate(self.view_sheet.min(self.engine.sheet_count().saturating_sub(1)))?;
        Ok(Outcome { dropped, ..self.outcome() })
    }

    /// Reloads the server's state (`bytes` at `seq`). Ops of ours the server already has (`acked`:
    /// the last cid it applied from us) are forgotten; the rest are re-applied and returned to resend.
    pub fn resync(&mut self, bytes: &[u8], seq: u64, acked: u64) -> Result<Vec<Submit>> {
        let mut engine = Engine::new();
        engine.open("shared.xlsx", bytes)?;
        self.engine = engine;
        self.seq = seq;
        self.pending.retain(|p| p.submit.cid > acked);
        self.next_cid = self.next_cid.max(acked + 1);
        let _dropped = self.replay();
        self.engine.activate(self.view_sheet.min(self.engine.sheet_count().saturating_sub(1)))?;
        Ok(self.unconfirmed())
    }

    /// Ops still waiting for the server, oldest first (resent after reconnecting).
    pub fn unconfirmed(&self) -> Vec<Submit> {
        self.pending.iter().map(|p| p.submit.clone()).collect()
    }
}

/// The server's copy: applies ops in arrival order and numbers them.
pub struct Authority {
    pub engine: Engine,
    pub seq: u64,
    /// The last cid applied per session: a resent op is recognised and not applied twice.
    pub acked: HashMap<String, u64>,
}

/// Why the server didn't apply an op.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// Already applied (resent after a reconnect): not an error, just don't apply or broadcast.
    Duplicate,
    Invalid(String),
}

impl Authority {
    pub fn new(engine: Engine, seq: u64) -> Authority {
        Authority { engine, seq, acked: HashMap::new() }
    }

    pub fn acked(&self, sid: &str) -> u64 {
        self.acked.get(sid).copied().unwrap_or(0)
    }

    /// Applies a client's op. On success it gets the next sequence number.
    pub fn apply(&mut self, sid: &str, submit: Submit) -> std::result::Result<Op, Refusal> {
        if submit.cid <= self.acked(sid) {
            return Err(Refusal::Duplicate);
        }
        self.apply_new(sid, submit).map_err(|e| Refusal::Invalid(e.0))
    }

    fn apply_new(&mut self, sid: &str, submit: Submit) -> Result<Op> {
        let Submit { cid, sheet, steps } = submit;
        if steps.iter().any(|s| is_local_only(&s.cmd) && s.cmd != "edit.copy" && s.cmd != "edit.cut") {
            return Err(EngineError("view commands are not shared".into()));
        }
        self.engine.apply_steps(sheet, &steps)?;
        self.seq += 1;
        self.acked.insert(sid.to_string(), cid);
        Ok(Op { seq: self.seq, sid: sid.to_string(), cid, sheet, steps })
    }

    /// Replays a logged op (recovery after a restart). Ops that fail are skipped, as they were live.
    pub fn replay(&mut self, op: &Op) {
        let _ = self.engine.apply_steps(op.sheet, &op.steps);
        self.seq = op.seq;
        let acked = self.acked.entry(op.sid.clone()).or_insert(0);
        *acked = (*acked).max(op.cid);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn step(cmd: &str, params: Json) -> Step {
        Step { cmd: cmd.into(), params }
    }

    fn set(cell: &str, input: &str) -> Vec<Step> {
        vec![step("cell.set", json!({"cell": cell, "input": input}))]
    }

    struct World {
        server: Authority,
        clients: Vec<Replica>,
        /// Ops in flight to the server, per client.
        outbox: Vec<VecDeque<Submit>>,
        /// Ops in flight from the server, per client.
        inbox: Vec<VecDeque<std::result::Result<Op, u64>>>,
    }

    impl World {
        fn new(n: usize) -> World {
            let mut seed = Engine::new();
            seed.execute("cell.set", json!({"cell": "A1", "input": "seed"})).unwrap();
            let bytes = seed.save_xlsx().unwrap();
            let server = Authority::new(Replica::from_snapshot("server", &bytes, 0).unwrap().engine, 0);
            let clients = (0..n).map(|i| Replica::from_snapshot(format!("c{i}"), &bytes, 0).unwrap()).collect();
            World { server, clients, outbox: vec![VecDeque::new(); n], inbox: vec![VecDeque::new(); n] }
        }

        fn edit(&mut self, c: usize, steps: Vec<Step>) {
            let out = self.clients[c].local_steps(steps).unwrap();
            if let Some(s) = out.send {
                self.outbox[c].push_back(s);
            }
        }

        /// The server takes the next op from client `c`.
        fn deliver_up(&mut self, c: usize) {
            let Some(s) = self.outbox[c].pop_front() else { return };
            let sid = self.clients[c].sid.clone();
            match self.server.apply(&sid, s.clone()) {
                Ok(op) => {
                    for q in &mut self.inbox {
                        q.push_back(Ok(op.clone()));
                    }
                }
                Err(Refusal::Duplicate) => {}
                Err(Refusal::Invalid(_)) => self.inbox[c].push_back(Err(s.cid)),
            }
        }

        fn deliver_down(&mut self, c: usize) {
            let Some(m) = self.inbox[c].pop_front() else { return };
            match m {
                Ok(op) => {
                    let out = self.clients[c].remote(&op).unwrap();
                    assert!(!out.resync, "client {c} needed a resync at seq {}", op.seq);
                }
                Err(cid) => {
                    self.clients[c].rejected(cid).unwrap();
                }
            }
        }

        fn settle(&mut self) {
            loop {
                let busy = self.outbox.iter().any(|q| !q.is_empty()) || self.inbox.iter().any(|q| !q.is_empty());
                if !busy {
                    break;
                }
                for c in 0..self.clients.len() {
                    self.deliver_up(c);
                }
                for c in 0..self.clients.len() {
                    while !self.inbox[c].is_empty() {
                        self.deliver_down(c);
                    }
                }
            }
        }

        fn text(e: &Engine, sheet: usize, r: u32, c: u32) -> Option<String> {
            let mut e2 = Engine::new();
            e2.open("x.xlsx", &e.save_xlsx().unwrap()).unwrap();
            e2.execute("sheet.activate", json!({"sheet": sheet})).unwrap();
            e2.viewport(r, c, r, c).unwrap().cells.first().map(|x| x.2.clone())
        }

        /// Every replica's workbook equals the server's, cell for cell on the used area.
        fn assert_converged(&self) {
            let want = self.server.engine.save_xlsx().unwrap();
            let mut reference = Engine::new();
            reference.open("s.xlsx", &want).unwrap();
            for (i, c) in self.clients.iter().enumerate() {
                assert_eq!(c.pending_len(), 0, "client {i} still has pending ops");
                assert_eq!(c.seq, self.server.seq, "client {i} seq");
                for sheet in 0..reference.sheet_count() {
                    reference.execute("sheet.activate", json!({"sheet": sheet})).unwrap();
                    let mut mine = Engine::new();
                    mine.open("c.xlsx", &c.engine.save_xlsx().unwrap()).unwrap();
                    mine.execute("sheet.activate", json!({"sheet": sheet})).unwrap();
                    let a = reference.viewport(0, 0, 40, 10).unwrap().cells;
                    let b = mine.viewport(0, 0, 40, 10).unwrap().cells;
                    assert_eq!(a, b, "client {i} differs from the server on sheet {sheet}");
                }
            }
        }
    }

    #[test]
    fn own_edits_show_at_once_and_are_confirmed_by_the_echo() {
        let mut w = World::new(1);
        w.edit(0, set("B2", "=2+2"));
        assert_eq!(World::text(&w.clients[0].engine, 0, 1, 1).as_deref(), Some("4"));
        assert_eq!(w.clients[0].pending_len(), 1);
        w.settle();
        assert_eq!(w.clients[0].pending_len(), 0);
        assert_eq!(w.server.seq, 1);
        w.assert_converged();
    }

    #[test]
    fn concurrent_edits_converge_in_server_order() {
        let mut w = World::new(2);
        w.edit(0, set("A2", "10"));
        w.edit(1, set("A3", "=A2*3"));
        w.edit(0, set("A2", "20"));
        w.edit(1, set("B1", "from c1"));
        // c1 reaches the server first, then c0.
        w.deliver_up(1);
        w.deliver_up(1);
        w.deliver_up(0);
        w.deliver_up(0);
        while !w.inbox.iter().all(|q| q.is_empty()) {
            for c in 0..2 {
                w.deliver_down(c);
            }
        }
        w.assert_converged();
        assert_eq!(World::text(&w.clients[1].engine, 0, 2, 0).as_deref(), Some("60"));
    }

    #[test]
    fn same_cell_conflict_is_last_writer_wins_by_server_order() {
        let mut w = World::new(2);
        w.edit(0, set("C3", "zero"));
        w.edit(1, set("C3", "one"));
        w.deliver_up(1);
        w.deliver_up(0);
        w.settle();
        w.assert_converged();
        assert_eq!(World::text(&w.server.engine, 0, 2, 2).as_deref(), Some("zero"));
    }

    #[test]
    fn formatting_and_structure_replicate() {
        let mut w = World::new(2);
        w.edit(0, set("A5", "Total"));
        w.edit(0, vec![step("home.bold", json!({"range": "A5"}))]);
        w.edit(1, vec![step("home.insertSheet", json!({}))]);
        w.edit(1, set("A1", "second sheet"));
        w.settle();
        w.assert_converged();
        assert_eq!(w.server.engine.sheet_count(), 2);
        // Each user still sees the sheet they chose: c0 stayed on sheet 0.
        assert_eq!(w.clients[0].engine.active_sheet(), 0);
        assert_eq!(w.clients[1].engine.active_sheet(), 1);
    }

    #[test]
    fn copy_and_paste_travel_together_so_every_replica_pastes_the_same_source() {
        let mut w = World::new(2);
        w.edit(0, set("A1", "1"));
        w.edit(0, set("A2", "=A1+1"));
        w.settle();
        // c1 copies something else locally (its clipboard is its own).
        w.clients[1].local("edit.copy", json!({"range": "A1"})).unwrap();
        w.edit(0, vec![step("edit.copy", json!({"range": "A1:A2"})), step("edit.paste", json!({"at": "D1"}))]);
        w.settle();
        w.assert_converged();
        let mut e = Engine::new();
        e.open("x.xlsx", &w.clients[1].engine.save_xlsx().unwrap()).unwrap();
        assert_eq!(e.edit_text(1, 3).unwrap(), "=D1+1");
    }

    #[test]
    fn paste_does_the_same_thing_on_every_replica_whatever_each_one_copied() {
        let mut w = World::new(2);
        w.edit(0, set("A1", "=1+1"));
        w.settle();
        // c1 happens to have copied A1, whose text ("2") equals what c0 pastes from another app.
        w.clients[1].local("edit.copy", json!({"range": "A1"})).unwrap();
        w.edit(0, vec![step("edit.paste", json!({"at": "B1", "text": "2"}))]);
        w.settle();
        w.assert_converged();
        let mut e = Engine::new();
        e.open("x.xlsx", &w.clients[1].engine.save_xlsx().unwrap()).unwrap();
        assert_eq!(e.edit_text(0, 1).unwrap(), "2", "pasted as text, not as c1's formula");
        // c1's own clipboard is untouched: its in-app paste still pastes the formula, everywhere.
        let out = w.clients[1].local("edit.paste", json!({"at": "C1", "text": "2\r\n"})).unwrap();
        let sent = out.send.clone().unwrap();
        assert_eq!(sent.steps.iter().map(|s| s.cmd.as_str()).collect::<Vec<_>>(), vec!["edit.copy", "edit.paste"]);
        w.outbox[1].push_back(sent);
        w.settle();
        w.assert_converged();
        let mut e = Engine::new();
        e.open("x.xlsx", &w.server.engine.save_xlsx().unwrap()).unwrap();
        assert_eq!(e.edit_text(0, 2).unwrap(), "=1+1");
    }

    #[test]
    fn cut_and_paste_moves_once() {
        let mut w = World::new(2);
        w.edit(0, set("A1", "moving"));
        w.settle();
        w.clients[0].local("edit.cut", json!({"range": "A1"})).unwrap();
        w.edit(0, vec![step("edit.paste", json!({"at": "C3"}))]);
        w.settle();
        w.assert_converged();
        assert_eq!(World::text(&w.server.engine, 0, 2, 2).as_deref(), Some("moving"));
        assert_eq!(World::text(&w.server.engine, 0, 0, 0), None);
        assert!(w.clients[0].local("edit.paste", json!({"at": "D4"})).is_err() || w.clients[0].pending_len() == 0);
    }

    #[test]
    fn copy_from_another_sheet_pastes_its_source() {
        let mut w = World::new(2);
        w.edit(0, set("A1", "on sheet one"));
        w.edit(0, vec![step("home.insertSheet", json!({}))]);
        w.settle();
        w.edit(0, vec![step("edit.copy", json!({"range": "A1", "sheet": 0})), step("edit.paste", json!({"at": "B2"}))]);
        w.settle();
        w.assert_converged();
        assert_eq!(World::text(&w.server.engine, 1, 1, 1).as_deref(), Some("on sheet one"));
    }

    #[test]
    fn a_rejected_op_is_taken_back_and_later_ops_survive() {
        let mut w = World::new(1);
        w.edit(0, set("A1", "keep"));
        // Valid locally (sheet 1 exists here), but the server rejects ops for a sheet it lacks.
        w.clients[0].engine.execute("home.insertSheet", json!({})).unwrap();
        w.clients[0].engine.execute("sheet.activate", json!({"sheet": 0})).unwrap();
        let bad = Submit { cid: 999, sheet: 1, steps: set("A1", "x") };
        let sid = w.clients[0].sid.clone();
        assert!(matches!(w.server.apply(&sid, bad), Err(Refusal::Invalid(_))));
        assert!(w.server.apply(&sid, Submit { cid: 1000, sheet: 0, steps: vec![] }).is_err());
        assert!(w.server.apply(&sid, Submit { cid: 1001, sheet: 0, steps: vec![step("sheet.activate", json!({"sheet": 0}))] }).is_err());
        w.settle();
        assert_eq!(World::text(&w.server.engine, 0, 0, 0).as_deref(), Some("keep"));
    }

    #[test]
    fn view_commands_stay_local() {
        let mut w = World::new(2);
        w.edit(0, vec![step("home.insertSheet", json!({}))]);
        w.settle();
        let out = w.clients[0].local("sheet.activate", json!({"sheet": 0})).unwrap();
        assert!(out.send.is_none());
        let out = w.clients[0].local("edit.copy", json!({"range": "A1"})).unwrap();
        assert!(out.send.is_none());
        let out = w.clients[0].local("edit.undo", json!({})).unwrap();
        assert!(out.send.is_some(), "undo goes to the server");
    }

    #[test]
    fn stale_or_out_of_order_ops_ask_for_a_resync() {
        let mut w = World::new(1);
        let op = Op { seq: 5, sid: "x".into(), cid: 1, sheet: 0, steps: set("A1", "1") };
        assert!(w.clients[0].remote(&op).unwrap().resync);
        let dup = Op { seq: 0, ..op };
        assert!(!w.clients[0].remote(&dup).unwrap().resync);
    }

    #[test]
    fn undo_is_applied_by_the_server_and_replicas_resync_to_it() {
        let mut w = World::new(2);
        w.edit(0, set("A1", "one"));
        w.edit(0, set("A1", "two"));
        w.settle();
        w.edit(1, vec![step("edit.undo", json!({}))]);
        w.deliver_up(1);
        assert_eq!(World::text(&w.server.engine, 0, 0, 0).as_deref(), Some("one"));
        let snap = w.server.engine.save_xlsx().unwrap();
        for c in 0..2 {
            let Some(Ok(op)) = w.inbox[c].pop_front() else { panic!("no op") };
            let out = w.clients[c].remote(&op).unwrap();
            assert!(out.resync);
            let sid = w.clients[c].sid.clone();
            let resend = w.clients[c].resync(&snap, w.server.seq, w.server.acked(&sid)).unwrap();
            assert!(resend.is_empty());
        }
        w.assert_converged();
    }

    #[test]
    fn resync_keeps_unsent_edits_and_never_applies_an_op_twice() {
        let mut w = World::new(1);
        w.edit(0, set("A1", "applied"));
        w.edit(0, set("A2", "in flight"));
        w.deliver_up(0); // the server has A1, not yet A2
        w.inbox[0].clear(); // the connection drops before the echo arrives
        // Reconnect: snapshot at the server's seq, then resend what the server lacks.
        let snap = w.server.engine.save_xlsx().unwrap();
        let acked = w.server.acked("c0");
        assert_eq!(acked, 1);
        let resend = w.clients[0].resync(&snap, w.server.seq, acked).unwrap();
        assert_eq!(resend.iter().map(|s| s.cid).collect::<Vec<_>>(), vec![2]);
        assert_eq!(World::text(&w.clients[0].engine, 0, 1, 0).as_deref(), Some("in flight"));
        // The old connection's copy of op 2 still reaches the server, then the resent one: applied once.
        w.deliver_up(0);
        assert_eq!(w.server.apply("c0", resend[0].clone()), Err(Refusal::Duplicate));
        w.settle();
        w.assert_converged();
        assert_eq!(w.server.seq, 2);
    }

    /// Many clients, random edits, random delivery interleavings: everyone ends equal to the server.
    #[test]
    fn randomized_interleavings_converge() {
        let mut rng: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = |n: u64| {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng % n
        };
        let rounds: usize = std::env::var("SHEETS_FUZZ_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
        for _round in 0..rounds {
            let mut w = World::new(3);
            for _ in 0..40 {
                let c = next(3) as usize;
                match next(10) {
                    0..=5 => {
                        let cell = format!("{}{}", ["A", "B", "C"][next(3) as usize], 1 + next(6));
                        let input = match next(3) {
                            0 => format!("{}", next(100)),
                            1 => "=SUM(A1:C6)".to_string(),
                            _ => format!("t{}", next(9)),
                        };
                        w.edit(c, set(&cell, &input));
                    }
                    6 => w.edit(c, vec![step("home.bold", json!({"range": "A1:B2"}))]),
                    7 => w.deliver_up(next(3) as usize),
                    _ => w.deliver_down(next(3) as usize),
                }
            }
            w.settle();
            w.assert_converged();
        }
    }
}
