//! Frames on the wire.

// ADR-0004 put JSON on the wire; ADR-0006 replaced it with bincode.
pub fn encode(frame: &[u8]) -> Vec<u8> {
    frame.to_vec() // RFC-12 fixes the frame boundaries.
}

/// The handshake follows RFC-13, and the resumption one follows RFC-14.
pub fn handshake() {}

// spec-core's ADR-0042 and the upstream-crate ADR-0077 are other projects' decisions.
