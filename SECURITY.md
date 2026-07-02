# Security Policy

## Supported Versions

CodexScope is early-stage software. Security fixes target the latest commit on
the `main` branch and the latest published GitHub Release when releases exist.

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities or reports containing
private account, session, or token data.

Use GitHub's private vulnerability reporting for this repository when it is
available from the Security tab. If that option is unavailable, contact the
maintainer through the GitHub profile linked from the repository owner.

Useful details to include:

- affected OS and CodexScope version or commit
- whether the issue affects local log parsing, account/rate-limit access,
  screenshot capture, packaging, or update/release flow
- minimal reproduction steps
- whether any local Codex session data, auth data, or account metadata could be
  exposed

The maintainer will acknowledge valid reports as soon as practical and will
coordinate a fix before public disclosure when the issue has real security
impact.

## Data Handling Notes

CodexScope reads local Codex logs and account metadata to build local usage
summaries. It should not upload Codex session logs, account usage data, or auth
material as part of normal operation. Please treat any bug that violates that
expectation as security-sensitive.
