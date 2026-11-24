//! NTrader trading core.
//!
//! A deterministic, single-threaded trading engine: every state change is the
//! result of a [`Command`], and applying the same commands in the same order
//! always produces the same state. That property is what makes the journal
//! (see [`journal`]) a complete recovery mechanism.

pub mod engine;
pub mod journal;
pub mod types;

pub use engine::Engine;
pub use journal::Node;
pub use types::*;
