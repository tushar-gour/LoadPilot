# Security

LoadPilot is an early-stage HTTP(S) reverse-proxy library, not a hardened public ingress appliance. Configure trusted ingress, authenticated/admin-only backend configuration, resource limits and monitoring outside the library. Use TLS certificate validation and avoid exposing metrics or sensitive request data to untrusted clients.

Please report suspected vulnerabilities privately through the repository's private vulnerability reporting feature if enabled, or contact the maintainer privately. Do not post credentials, private keys, exploit details or production traffic in a public issue.

The localhost certificate/key under tests/fixtures are synthetic test fixtures only. Never use them for production TLS. They must not be distributed in the npm tarball. Benchmark outputs, heap snapshots and local secrets must remain untracked.
