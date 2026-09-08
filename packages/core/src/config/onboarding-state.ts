import { existsSync } from "node:fs";
import {
  loadPersistedAppConfig,
  loadPersistedAppSetting,
  replacePersistedAppSetting
} from "@ccr/core/config/config-repository";
import {
  ONBOARDING_FINISHED_AT_SETTING_KEY,
  ONBOARDING_FINISHED_FILE
} from "@ccr/core/config/constants";

export async function loadOnboardingFinished(): Promise<boolean> {
  try {
    const persisted = await loadPersistedAppSetting(ONBOARDING_FINISHED_AT_SETTING_KEY);
    if (typeof persisted === "string" && Boolean(persisted.trim())) {
      return true;
    }
    // A persisted config with providers is already a working setup; older
    // versions never wrote the flag for it, so seed the flag instead of
    // forcing the wizard on every launch.
    if (await persistedConfigHasProviders()) {
      await markOnboardingFinished();
      return true;
    }
    return false;
  } catch (error) {
    console.warn(`[config] Failed to load onboarding state: ${formatError(error)}`);
    return existsSync(ONBOARDING_FINISHED_FILE);
  }
}

async function persistedConfigHasProviders(): Promise<boolean> {
  const config = await loadPersistedAppConfig() as { Providers?: unknown } | undefined;
  return Array.isArray(config?.Providers) && config.Providers.some((provider) => {
    if (!provider || typeof provider !== "object") {
      return false;
    }
    const name = (provider as { name?: unknown }).name;
    return typeof name === "string" && Boolean(name.trim());
  });
}

export async function markOnboardingFinished(): Promise<void> {
  await replacePersistedAppSetting(ONBOARDING_FINISHED_AT_SETTING_KEY, new Date().toISOString());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
