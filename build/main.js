"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_controlMapper = require("./lib/controlMapper");
var import_homeApiClient = require("./lib/homeApiClient");
var import_retry = require("./lib/retry");
const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
const MIN_POLLING_INTERVAL_SECONDS = 30;
const MAX_POLLING_INTERVAL_SECONDS = 86400;
class Liebherr extends utils.Adapter {
  client;
  pollTimer;
  pollingIntervalMs = DEFAULT_POLLING_INTERVAL_SECONDS * 1e3;
  consecutiveFailures = 0;
  knownDevices = /* @__PURE__ */ new Map();
  unloading = false;
  /** @param options Adapter startup options supplied by js-controller. */
  constructor(options = {}) {
    super({
      ...options,
      name: "liebherr"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a;
    await this.setConnection(false);
    this.pollingIntervalMs = this.getPollingIntervalMs(this.config.pollingInterval);
    const apiKey = (_a = this.config.apiKey) == null ? void 0 : _a.trim();
    if (!apiKey) {
      this.log.warn("No Liebherr HomeAPI key is configured");
      return;
    }
    await this.extendObject("devices", {
      type: "folder",
      common: { name: "Liebherr devices" },
      native: {}
    });
    await this.loadKnownDevices();
    this.client = new import_homeApiClient.HomeApiClient(apiKey);
    await this.pollAndSchedule();
  }
  getPollingIntervalMs(configuredInterval) {
    if (!Number.isFinite(configuredInterval)) {
      return DEFAULT_POLLING_INTERVAL_SECONDS * 1e3;
    }
    const seconds = Math.min(
      MAX_POLLING_INTERVAL_SECONDS,
      Math.max(MIN_POLLING_INTERVAL_SECONDS, Math.round(configuredInterval))
    );
    if (seconds !== configuredInterval) {
      this.log.warn(
        `Polling interval ${configuredInterval} seconds is outside the supported range; using ${seconds} seconds`
      );
    }
    return seconds * 1e3;
  }
  async loadKnownDevices() {
    const objects = await this.getAdapterObjectsAsync();
    for (const object of Object.values(objects)) {
      if (object.type !== "device" || typeof object.native.deviceId !== "string") {
        continue;
      }
      const relativeId = object._id.startsWith(`${this.namespace}.`) ? object._id.slice(this.namespace.length + 1) : object._id;
      const deviceKey = relativeId.split(".")[1];
      if (deviceKey) {
        this.knownDevices.set(object.native.deviceId, deviceKey);
      }
    }
  }
  async pollAndSchedule() {
    if (this.unloading || !this.client) {
      return;
    }
    let nextDelay = this.pollingIntervalMs;
    try {
      const errors = await this.pollOnce();
      if (errors.length === 0) {
        this.consecutiveFailures = 0;
        await this.setConnection(true);
      } else {
        this.consecutiveFailures++;
        await this.setConnection(false);
        nextDelay = Math.max(
          ...errors.map(
            (error) => (0, import_retry.calculateRetryDelay)(this.pollingIntervalMs, this.consecutiveFailures, error)
          )
        );
      }
    } catch (error) {
      this.consecutiveFailures++;
      await this.setConnection(false);
      this.logApiError(error, "discovering devices");
      nextDelay = (0, import_retry.calculateRetryDelay)(this.pollingIntervalMs, this.consecutiveFailures, error);
    }
    if (!this.unloading) {
      this.pollTimer = this.setTimeout(() => void this.pollAndSchedule(), nextDelay);
    }
  }
  async pollOnce() {
    const client = this.client;
    if (!client) {
      return [];
    }
    const devices = await client.getDevices();
    const reconciliation = (0, import_controlMapper.reconcileDeviceIds)(
      this.knownDevices.keys(),
      devices.map((device) => device.deviceId)
    );
    for (const missingDeviceId of reconciliation.missing) {
      const deviceKey = this.knownDevices.get(missingDeviceId);
      if (deviceKey) {
        await this.updateState(
          `devices.${deviceKey}.info.available`,
          "Device available",
          "indicator.connected",
          "boolean",
          false
        );
      }
    }
    const errors = [];
    for (const device of devices) {
      const deviceKey = await this.updateDevice(device);
      try {
        const controls = await client.getControls(device.deviceId);
        for (const control of controls) {
          const mapping = (0, import_controlMapper.mapControl)(control);
          if (!mapping) {
            this.log.debug(
              `Unsupported or malformed control type "${control.type}" (${control.name}) ignored`
            );
            continue;
          }
          if (mapping.scope === "zone" && mapping.zoneId !== void 0) {
            await this.updateZoneControl(deviceKey, mapping.zoneId, mapping.zonePosition, mapping.states);
          } else {
            await this.updateDeviceControl(deviceKey, mapping.states);
          }
        }
      } catch (error) {
        errors.push(error);
        await this.setState(`devices.${deviceKey}.info.available`, { val: false, ack: true });
        this.logApiError(error, `reading controls for device ${device.deviceId}`);
      }
    }
    return errors;
  }
  async updateDevice(device) {
    var _a, _b, _c;
    const deviceKey = (_a = this.knownDevices.get(device.deviceId)) != null ? _a : (0, import_controlMapper.toIdSegment)(device.deviceId);
    this.knownDevices.set(device.deviceId, deviceKey);
    const deviceRoot = `devices.${deviceKey}`;
    await this.extendObject(deviceRoot, {
      type: "device",
      common: { name: (_c = (_b = device.nickname) != null ? _b : device.deviceName) != null ? _c : device.deviceId },
      native: { deviceId: device.deviceId }
    });
    await this.extendObject(`${deviceRoot}.info`, {
      type: "channel",
      common: { name: "Device information" },
      native: {}
    });
    await this.updateState(`${deviceRoot}.info.deviceId`, "Device ID", "text", "string", device.deviceId);
    await this.updateOptionalTextState(`${deviceRoot}.info.nickname`, "Nickname", device.nickname);
    await this.updateOptionalTextState(`${deviceRoot}.info.deviceName`, "Device name", device.deviceName);
    await this.updateOptionalTextState(`${deviceRoot}.info.deviceType`, "Device type", device.deviceType);
    await this.updateOptionalTextState(`${deviceRoot}.info.imageUrl`, "Image URL", device.imageUrl);
    await this.updateState(
      `${deviceRoot}.info.available`,
      "Device available",
      "indicator.connected",
      "boolean",
      true
    );
    return deviceKey;
  }
  async updateOptionalTextState(id, name, value) {
    if (value !== void 0) {
      await this.updateState(id, name, "text", "string", value);
    }
  }
  async updateDeviceControl(deviceKey, states) {
    const channelId = `devices.${deviceKey}.controls`;
    await this.extendObject(channelId, {
      type: "channel",
      common: { name: "Device controls" },
      native: {}
    });
    await this.updateMappedStates(channelId, states);
  }
  async updateZoneControl(deviceKey, zoneId, zonePosition, states) {
    const channelId = `devices.${deviceKey}.zone_${(0, import_controlMapper.toIdSegment)(String(zoneId))}`;
    await this.extendObject(channelId, {
      type: "channel",
      common: { name: zonePosition ? `Zone ${zoneId} (${zonePosition})` : `Zone ${zoneId}` },
      native: { zoneId }
    });
    await this.updateState(`${channelId}.zoneId`, "Zone ID", "value", "number", zoneId);
    if (zonePosition !== void 0) {
      await this.updateState(`${channelId}.position`, "Zone position", "text", "string", zonePosition);
    }
    await this.updateMappedStates(channelId, states);
  }
  async updateMappedStates(channelId, states) {
    var _a;
    for (const state of states) {
      await this.extendObject(`${channelId}.${state.id}`, {
        type: "state",
        common: state.common,
        native: (_a = state.native) != null ? _a : {}
      });
      await this.setState(`${channelId}.${state.id}`, { val: state.value, ack: true });
    }
  }
  async updateState(id, name, role, type, value) {
    await this.extendObject(id, {
      type: "state",
      common: {
        name,
        type,
        role,
        read: true,
        write: false
      },
      native: {}
    });
    await this.setState(id, { val: value, ack: true });
  }
  async setConnection(connected) {
    await this.setState("info.connection", { val: connected, ack: true });
  }
  logApiError(error, operation) {
    var _a;
    if (error instanceof import_homeApiClient.LiebherrApiError) {
      switch (error.status) {
        case 401:
          this.log.error(`HomeAPI authentication failed while ${operation}; check the configured API key`);
          return;
        case 403:
          this.log.error(`HomeAPI access was forbidden while ${operation}`);
          return;
        case 404:
          this.log.warn(`HomeAPI resource was not found while ${operation}`);
          return;
        case 412:
          this.log.warn(`HomeAPI precondition failed while ${operation}`);
          return;
        case 422:
          this.log.warn(`HomeAPI rejected the request while ${operation}`);
          return;
        case 429: {
          const retry = error.retryAfterMs ? `; retrying in at least ${Math.ceil(error.retryAfterMs / 1e3)} seconds` : "";
          this.log.warn(`HomeAPI rate limit reached while ${operation}${retry}`);
          return;
        }
        case 500:
        case 503:
          this.log.warn(`HomeAPI is temporarily unavailable (HTTP ${error.status}) while ${operation}`);
          return;
        default:
          this.log.warn(`HomeAPI returned HTTP ${(_a = error.status) != null ? _a : "unknown"} while ${operation}`);
          return;
      }
    }
    if (error instanceof import_homeApiClient.LiebherrNetworkError) {
      this.log.warn(`Network error while ${operation}`);
      return;
    }
    if (error instanceof import_homeApiClient.LiebherrResponseError) {
      this.log.error(`Malformed HomeAPI response while ${operation}`);
      return;
    }
    this.log.error(`Unexpected error while ${operation}`);
  }
  onUnload(callback) {
    this.unloading = true;
    this.clearTimeout(this.pollTimer);
    this.pollTimer = void 0;
    void this.setConnection(false).catch(
      (error) => this.log.debug(`Could not reset connection state during unload: ${error.message}`)
    ).finally(callback);
  }
}
if (require.main !== module) {
  module.exports = (options) => new Liebherr(options);
} else {
  new Liebherr();
}
//# sourceMappingURL=main.js.map
