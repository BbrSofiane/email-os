//! Seed access for the legacy fixture store. The data itself lives in
//! [`crate::synthetic::data`], shared with the synthetic Gmail provider so the
//! 18 conversations exist exactly once in the source tree.

pub(crate) use crate::synthetic::data::{fixtures, SeedConversation, SEED_VERSION};
