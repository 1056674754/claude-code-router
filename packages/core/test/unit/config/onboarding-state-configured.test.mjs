import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("onboarding state treats a persisted config with providers as finished", async () => {
  const testRoot = path.join(
    process.env.CCR_INTERNAL_HOME_DIR ?? "",
    `onboarding-state-configured-${process.pid}`
  );
  process.env.CCR_INTERNAL_HOME_DIR = path.join(testRoot, "home");
  process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(testRoot, "app-data");
  process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(testRoot, "user-data");
  mkdirSync(path.join(testRoot, "home"), { recursive: true });

  const {
    loadPersistedAppSetting
  } = await import("@ccr/core/config/config-repository.ts");
  const {
    replacePersistedAppConfig
  } = await import("@ccr/core/config/config-repository.ts");
  const { loadOnboardingFinished } = await import("@ccr/core/config/onboarding-state.ts");

  assert.equal(await loadOnboardingFinished(), false);

  await replacePersistedAppConfig({ Providers: [{ name: "   " }] });
  assert.equal(await loadOnboardingFinished(), false);

  await replacePersistedAppConfig({
    Providers: [
      { name: "Zhipu GLM" },
      { name: "Ctyun" }
    ]
  });
  assert.equal(await loadOnboardingFinished(), true);

  const seeded = await loadPersistedAppSetting("onboardingFinishedAt");
  assert.equal(typeof seeded === "string" && Boolean(seeded.trim()), true);
  assert.equal(await loadOnboardingFinished(), true);

  rmSync(testRoot, { force: true, recursive: true });
});
