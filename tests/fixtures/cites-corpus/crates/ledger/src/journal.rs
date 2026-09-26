// The journal. ADR-0007 moved it to an async writer; ADR-0009 put that writer
// on tokio, which is what this module does now.

/// Writes a batch. ADR-0009, ADR-9 and ADR-009 on one line are one citation.
pub async fn write_batch(batch: &[u8]) -> std::io::Result<()> {
    let _ = batch;
    Ok(())
}

// ADR-0007 again, on a line of its own: a second finding, since it is a second line.
