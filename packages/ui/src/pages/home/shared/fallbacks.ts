import type {
  AppConfig,
  AppInfo,
  AppUpdateStatus,
  GatewayStatus,
  ProxyCertificateStatus,
  ProxyNetworkSnapshot,
  ProxyStatus
} from "@ccr/core/contracts/app";
import { createDefaultAppConfig } from "@ccr/core/config/default-config";

// Module-level navigator access breaks node-side test imports; degrade to an
// unknown platform when running outside a browser.
const runtimePlatform = typeof navigator === "undefined" ? "" : navigator.platform;

export const fallbackInfo: AppInfo = {
  configDbFile: "Browser preview",
  configDir: "Browser preview",
  dataDir: "Browser preview",
  desktop: false,
  launchAtLoginSupported: /^Mac|^Win/i.test(runtimePlatform),
  name: "Claude Code Router",
  platform: runtimePlatform,
  requestLogsDbFile: "Browser preview",
  usageDbFile: "Browser preview",
  version: "0.1.0"
};

export const fallbackUpdateStatus: AppUpdateStatus = {
  canCheck: false,
  canDownload: false,
  canInstall: false,
  currentVersion: fallbackInfo.version,
  state: "idle",
  supported: false
};

export const fallbackConfig: AppConfig = createDefaultAppConfig({});

export const fallbackGatewayStatus: GatewayStatus = {
  coreEndpoint: "http://127.0.0.1:3457",
  endpoint: "http://127.0.0.1:3456",
  networkEndpoints: [],
  state: "stopped"
};

export const fallbackProxyStatus: ProxyStatus = {
  caCertFile: "Browser preview",
  endpoint: "http://127.0.0.1:3456",
  mode: "gateway",
  port: 3456,
  state: "stopped",
  systemProxy: {
    state: "unsupported"
  },
  targetHosts: []
};

export const fallbackProxyCertificateStatus: ProxyCertificateStatus = {
  caCertFile: "Browser preview",
  canInstall: false,
  message: "Certificate detection is available in the Electron app.",
  platform: runtimePlatform,
  state: "unknown",
  trusted: false
};

export const fallbackProxyNetworkSnapshot: ProxyNetworkSnapshot = {
  capturedAt: new Date().toISOString(),
  captureEnabled: false,
  items: [],
  maxBodyBytes: 256 * 1024,
  maxEntries: 200
};
