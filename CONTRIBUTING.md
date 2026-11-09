# Contributing

```bash
npm install
```

```bash
npm test
```

The tests run against a fake game (`test/fakeGame.ts`) that answers with the same JSON shapes as the real device tools, so they pass on any OS without a device.

When you change how PlayPilot reads a real tool:

1. Capture the real output on a device and update the fake to match it exactly.
2. Add a test that fails without your change.
3. Run one real session on a simulator (`playpilot agent start` through `finish`) and check the frames and report by eye.

Guidelines:

- No runtime dependencies. Node built-ins only.
- Findings must be worth a person's time. A new detector needs a test that shows it stays quiet on normal play.
- Keep agent-facing output short. Agents read every line of every step.
- Probes stay development-only and never write personal data.
