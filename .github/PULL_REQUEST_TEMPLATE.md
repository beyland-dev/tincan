## Summary

- What does this PR change and why?

## Testing

- [ ] `pnpm ready` passes (`vp check`, `vp test`, `vp build`)
- [ ] `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` passes (if Rust changed)
- [ ] New or changed behaviour has tests (against `fake-phone` or D-Bus mocks; never a real phone in automated tests)

## Privacy & safety

- [ ] No message text, phone numbers, or contact names are logged or included in errors
- [ ] Fixtures, tests and screenshots use synthetic data only (555 numbers, made-up names, example domains)
- [ ] Changes to what AI agents can read or do keep the defaults conservative and are covered by tests

## Docs

- [ ] Docs updated where behaviour changed (README, `docs/`, `website/`, CHANGELOG), or not needed

## Notes

- Any breaking protocol/store changes or manual hardware tests performed:
