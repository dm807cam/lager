# 0014. AGPL-3.0-or-later and the DCO instead of a CLA

- Status: Accepted
- Date: 2026-11-19

## Context

Lager is a network service. Under a permissive license, someone could run a modified Lager as a hosted service without sharing their changes. Contributors also need to know under which terms their work is used, without signing an agreement.

## Decision

Lager is licensed under the GNU Affero General Public License, version 3 or later. Contributions are accepted under the same license ("inbound = outbound"). There is no contributor license agreement. Instead, contributors sign off every commit under the Developer Certificate of Origin (`git commit -s`), and CI checks the sign-off on pull requests.

## Consequences

- Whoever runs a modified Lager for others must offer them its source.
- Copyright stays with the individual contributors, so relicensing would need everyone's consent.
- Contributors need one extra flag on their commits. CONTRIBUTING.md explains it.
