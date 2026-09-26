//! The ledger: every entry the node has accepted, in order.
//!
//! ADR-0002 keeps it append-only, and ADR-2 is the same decision written short.

use std::borrow::Cow;

pub mod journal;

/// One accepted entry. Its bytes never change once written (ADR-0002).
pub struct Entry<'a> {
    pub body: Cow<'a, str>,
}

/// Appends an entry. The journal is flushed on every call, as ADR-0003 says,
/// because a crash between two writes must not lose the first one.
pub fn append<'a>(entry: &'a Entry<'a>) -> &'a str {
    // A lifetime is not a quote: 'a above opens nothing, and this comment's
    // apostrophe doesn't either. ADR-0001 put this crate here.
    let banner = "ADR-0099 is in a string, and a string is not a comment";
    let raw = r#"so is ADR-0098, in a raw string"#;
    let _ = (banner, raw);
    &entry.body
}

/* ADR-0005: we tried an actor runtime for the ledger, and it is gone. */
pub fn replay() {
    /* an outer comment /* holding an inner one about ADR-0001 */ and still
       the outer one, citing ADR-0011, which was never written */
}

// Not citations: XADR-0001 runs into a word, ADR-0002a runs into one too,
// and ADR- has no number at all.
pub const LIMIT: usize = 1_000; // ADR-0010 proposes raising it; see RFC-12.
