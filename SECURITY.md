# Security Policy

We take the security of the devicecloud.dev CLI (`@devicecloud.dev/dcd`)
seriously. Thank you for helping keep our users safe.

## Supported Versions

Security fixes are released against the latest published major version on npm.
Always upgrade to the newest release before reporting:

```sh-session
$ npm install -g @devicecloud.dev/dcd@latest   # npm install
$ dcd upgrade                                   # binary install
```

| Version        | Supported          |
| -------------- | ------------------ |
| Latest `5.x`   | :white_check_mark: |
| Older majors   | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue, pull request, or Discord message for
security vulnerabilities.** Public reports put users at risk before a fix is
available.

Instead, email **security@devicecloud.dev** with:

- A description of the vulnerability and its impact.
- Steps to reproduce (a proof of concept is ideal).
- The CLI version (`dcd --version`), OS, and Node.js version where applicable.
- Any suggested remediation, if you have one.

### What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity triage within 7 business days.
- Coordinated disclosure: we will work with you on a fix and a disclosure
  timeline, and credit you in the release notes if you wish.

Please give us a reasonable opportunity to remediate before any public
disclosure.

## Scope

This policy covers the code in this repository — the `dcd` CLI and the `dcd-mcp`
server. Vulnerabilities in the devicecloud.dev backend or web console should also
be sent to **security@devicecloud.dev** and will be routed to the right team.

## Secrets

This repository is scanned for committed secrets by [gitleaks](https://github.com/gitleaks/gitleaks)
on every push and pull request, and via a local pre-commit hook. If you believe
a secret has been committed, email **security@devicecloud.dev** immediately
rather than opening an issue.
