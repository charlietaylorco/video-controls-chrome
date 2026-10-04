# Subscription review verification

Run all Node regressions from the repository root:

```sh
node --test tests/*.test.js
```

`subscriptions.test.js` runs the actual service-worker message listener and imported state module with asynchronous mock storage. It checks independent data, concurrent writers, cold-worker persistence and undo, conflicting undo, quota failures and recovery, collections, sender/URL validation, future-version preservation, storage bounds, and unchanged permissions.

The browser fixture runs the actual subscription content scripts, CSS, shared writer, and existing YT Lists Focus implementation. Only Chrome APIs are mocked. Every network request is intercepted; no account, real YouTube response, extension installation, browser profile, or credentials are used. The fixture deliberately puts misleading relative date labels in native page order.

With an existing Playwright CLI and test browser available, run:

```sh
node tests/build-subscriptions-fixture.js
cd output/playwright
playwright-cli -s=subscriptions-review open about:blank --browser=chrome
playwright-cli -s=subscriptions-review run-code --filename=subscriptions-setup.js
playwright-cli -s=subscriptions-review snapshot
playwright-cli -s=subscriptions-review run-code --filename=../../tests/subscriptions-browser-check.js
playwright-cli -s=subscriptions-review console error
playwright-cli -s=subscriptions-review close
```

If Chrome is installed elsewhere, pass `--config` referencing a local CLI config with `browser.browserName: "chromium"` and `browser.launchOptions.executablePath` pointing to the already installed test binary. Do not install a browser or load the extension into a personal profile to run this fixture. Generated setup code, logs and screenshots stay in the ignored `output/playwright` directory. The CLI check must return a `passed` result with an empty `pageErrors` array; the CLI can print a test error while returning shell exit zero, so inspect the result itself.

The browser checks cover keyboard and pointer decisions/cancellation, duplicate and late-arriving cards, renderer and browse-root recycling, native visibility, stored Later snapshots, undo/skip, search input, storage errors, native/SPA/reload persistence, Focus blocking and navigation timing, hostile metadata, compact viewport, modal focus, and reduced-motion operation. Screenshots are saved as `subscriptions-review-desktop.png` and `subscriptions-review-compact.png`.

An authenticated, installed-extension check against YouTube's current renderer variants remains a separate smoke test requiring permission to load/update the extension. Fixtures establish behavior against the supported renderer structures, not every YouTube experiment or region. Shorts shelves without supported individual video cards and mobile YouTube are not reviewed. No performance benchmark or numerical speedup is claimed.
