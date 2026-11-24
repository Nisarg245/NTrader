//! Journal: an append-only log from which the engine state is rebuilt on start.
//!
//! Every non-tick command is logged. Ticks are logged only when they fire a
//! trigger (a stop, a pending order or a margin re-check). Quotes that moved
//! without changing state are written as a compact `Quotes` record just before
//! the next logged command, so replay sees the same prices the live engine saw
//! without storing every tick.

use crate::engine::Engine;
use crate::types::*;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::Path;

#[derive(Serialize, Deserialize)]
enum Record {
    /// (symbol, bid, ask, ts) set silently, without evaluating triggers.
    Q(Vec<(SymbolId, Price, Price, Ts)>),
    C(Command),
}

pub struct Node {
    pub engine: Engine,
    file: Option<BufWriter<File>>,
    dirty: Vec<SymbolId>,
    is_dirty: Vec<bool>,
    /// fsync after every record. Slower, but survives power loss.
    pub sync: bool,
}

impl Node {
    /// An engine with no journal (tests, benchmarks).
    pub fn in_memory() -> Node {
        Node {
            engine: Engine::new(),
            file: None,
            dirty: Vec::new(),
            is_dirty: Vec::new(),
            sync: false,
        }
    }

    /// Open a journal, replaying it if it exists. `on_event` receives every
    /// event produced during replay, so callers can rebuild derived state
    /// such as deal history.
    pub fn open(path: &Path, mut on_event: impl FnMut(&Event)) -> io::Result<Node> {
        let mut engine = Engine::new();
        if path.exists() {
            let mut out = Vec::new();
            for (n, line) in BufReader::new(File::open(path)?).lines().enumerate() {
                let line = line?;
                if line.is_empty() {
                    continue;
                }
                let rec: Record = match serde_json::from_str(&line) {
                    Ok(r) => r,
                    // A torn final line from a crash mid-write is expected; stop there.
                    Err(e) => {
                        eprintln!("journal: stopping replay at line {}: {e}", n + 1);
                        break;
                    }
                };
                match rec {
                    Record::Q(quotes) => {
                        for (s, b, a, t) in quotes {
                            engine.set_quote(s, b, a, t);
                        }
                    }
                    Record::C(cmd) => {
                        engine.apply(&cmd, &mut out);
                        out.iter().for_each(&mut on_event);
                        out.clear();
                    }
                }
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Node {
            engine,
            file: Some(BufWriter::new(file)),
            dirty: Vec::new(),
            is_dirty: Vec::new(),
            sync: false,
        })
    }

    /// Apply a command and persist it. Events are appended to `out`; they must
    /// only be published after this returns.
    pub fn apply(&mut self, cmd: &Command, out: &mut Vec<Event>) -> io::Result<()> {
        let before = out.len();
        self.engine.apply(cmd, out);
        if self.file.is_none() {
            return Ok(());
        }
        if let Command::Tick { symbol, .. } = cmd {
            if out.len() == before && !self.engine.last_tick_fired() {
                let i = *symbol as usize;
                if i >= self.is_dirty.len() {
                    self.is_dirty.resize(i + 1, false);
                }
                if !self.is_dirty[i] {
                    self.is_dirty[i] = true;
                    self.dirty.push(*symbol);
                }
                return Ok(());
            }
            // This tick is logged in full below, so its symbol needs no Quotes entry.
            if let Some(d) = self.is_dirty.get_mut(*symbol as usize) {
                if *d {
                    *d = false;
                    self.dirty.retain(|s| s != symbol);
                }
            }
        }
        let w = self.file.as_mut().unwrap();
        if !self.dirty.is_empty() {
            let quotes: Vec<_> = self
                .dirty
                .drain(..)
                .filter_map(|s| {
                    self.is_dirty[s as usize] = false;
                    self.engine.quote(s).map(|(b, a, t)| (s, b, a, t))
                })
                .collect();
            serde_json::to_writer(&mut *w, &Record::Q(quotes))?;
            w.write_all(b"\n")?;
        }
        serde_json::to_writer(&mut *w, &RecordRef::C(cmd))?;
        w.write_all(b"\n")?;
        w.flush()?;
        if self.sync {
            w.get_ref().sync_data()?;
        }
        Ok(())
    }
}

/// Borrowing twin of [`Record`], to log a command without cloning it.
#[derive(Serialize)]
enum RecordRef<'a> {
    C(&'a Command),
}
