# Cross-platform development requirements

- Runtime application code must support both macOS and Windows.
- Do not invoke Unix-only absolute paths from shared runtime code without a tested Windows branch.
- Use `node:path` for filesystem paths and avoid assuming `/` or a macOS `.app` directory layout.
- When adding processes, networking transports, environment-file lookup, or multi-instance behavior, add tests for both `darwin` and `win32` behavior.
- Platform-specific packaging scripts may remain separate, but shared application features must work with `npm start` on macOS and Windows.
