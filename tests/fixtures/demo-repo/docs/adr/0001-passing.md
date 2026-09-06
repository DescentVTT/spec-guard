# ADR-0001: One session owner, no legacy gateway

## Status

Accepted.

## Decision

Session state has exactly one owner, and the retired payment gateway must never
leak back into the controller or service layers.

<!-- @assert-count target="src/" symbol="UserSessionManager" expected="1" reason="exactly one owner of session state" -->
<!-- @assert-absence target="src/controllers,src/services" symbol="LegacyPaymentGateway" -->
<!-- @assert-absence target="src/" symbol="STRIPE_SECRET_KEY" expected="0" -->
<!-- @assert-count target="src/ui" symbol="PrimaryButton" min="1" -->
<!-- @assert-count target="src/core" symbol="DeprecatedHelper" max="3" -->
<!-- @assert-present file="SECURITY.md" -->
<!-- @assert-present file="config/production.json" -->

A directive may span several lines:

<!--
  @assert-count
  target="src/"
  symbol="BillingService"
  expected="4"
-->

Examples inside a fence are documentation, not assertions:

```md
<!-- @assert-count target="src/" symbol="NeverExecuted" expected="99" -->
```

The same goes for inline code: `<!-- @assert-absence target="src/" symbol="AlsoNeverExecuted" -->`.
