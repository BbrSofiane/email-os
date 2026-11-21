//! Gmail integration and mailbox operations, kept separate from fixture storage.
pub mod auth;
pub mod browsing;
pub mod operations;
pub(crate) mod parse;
#[cfg(test)]
mod profile_lock_tests;
pub mod provider;
pub mod secrets;
pub(crate) mod session;
pub mod store;
pub mod sync;
pub mod types;
