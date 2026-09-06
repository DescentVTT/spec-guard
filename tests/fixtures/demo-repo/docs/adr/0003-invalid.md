# ADR-0003: Malformed directives

Each directive below is invalid and must be reported rather than skipped.

<!-- @assert-count target="src/" symbol="Whatever" expct="1" -->
<!-- @assert-absence target="src/" -->
<!-- @assert-typo target="src/" symbol="Whatever" -->
<!-- @assert-count target="src/" symbol="Whatever" expected="many" -->
