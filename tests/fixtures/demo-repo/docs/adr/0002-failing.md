# ADR-0002: Deliberately broken invariants

This spec exists so the test suite can prove failures are detected. Every
directive below is expected to fail against the fixture codebase.

<!-- @assert-absence target="src/" symbol="LegacyPaymentGateway" reason="retired in ADR-0002" -->
<!-- @assert-count target="src/core" symbol="DeprecatedHelper" max="1" -->
<!-- @assert-count target="src/" symbol="MissingSymbol" min="1" -->
<!-- @assert-present file="docs/does-not-exist.md" -->
