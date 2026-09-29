# Security policy

## Supported versions

| Version of `@descent-vtt/spec-guard` | Gets security fixes |
| --- | --- |
| The latest minor release on npm | Yes, in a patch release of that minor |
| Any earlier minor | No: upgrade to the latest |

Before 1.0 a fix is made once, on the latest minor, as the family's versions
policy ([spec-core ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md))
sets out.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: the
repository's **Security** tab, then **Report a vulnerability**. Only the
maintainer sees the report.

Do not open a public issue, pull request or discussion about a vulnerability,
and do not show it in one, until a fixed release is out.

A useful report names the version, what an attacker has to control - a spec, a
file in the tree, the configuration, a request to the MCP server - and what
happens then, with the smallest reproduction you have.

## What to expect

- An acknowledgement of the report.
- A fix in a patch release, with an advisory that says which versions are
  affected and what to upgrade to.
- Credit in the advisory and the changelog, if you want it.
