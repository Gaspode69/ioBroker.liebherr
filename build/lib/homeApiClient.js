"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var homeApiClient_exports = {};
__export(homeApiClient_exports, {
  HOME_API_BASE_URL: () => HOME_API_BASE_URL,
  HomeApiClient: () => HomeApiClient,
  LiebherrApiError: () => LiebherrApiError,
  LiebherrNetworkError: () => LiebherrNetworkError,
  LiebherrResponseError: () => LiebherrResponseError,
  parseControls: () => parseControls,
  parseDevices: () => parseDevices
});
module.exports = __toCommonJS(homeApiClient_exports);
const HOME_API_BASE_URL = "https://home-api.smartdevice.liebherr.com";
class LiebherrApiError extends Error {
  /**
   * @param message Safe error message without credentials.
   * @param status HTTP status code.
   * @param retryAfterMs Server-requested retry delay.
   */
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.name = "LiebherrApiError";
  }
}
class LiebherrResponseError extends Error {
  /** @param message Safe response validation message. */
  constructor(message) {
    super(message);
    this.name = "LiebherrResponseError";
  }
}
class LiebherrNetworkError extends Error {
  /** Creates a credential-safe network error. */
  constructor() {
    super("The Liebherr HomeAPI request could not be completed");
    this.name = "LiebherrNetworkError";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(value) {
  return typeof value === "string" ? value : void 0;
}
function parseRetryAfter(value, now = Date.now()) {
  if (value === null) {
    return void 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1e3);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return void 0;
}
function parseDevices(payload) {
  if (!Array.isArray(payload)) {
    throw new LiebherrResponseError("The HomeAPI device response is not an array");
  }
  return payload.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.deviceId !== "string" || entry.deviceId.length === 0) {
      throw new LiebherrResponseError(`The HomeAPI device at index ${index} is malformed`);
    }
    return {
      deviceId: entry.deviceId,
      nickname: optionalString(entry.nickname),
      deviceType: optionalString(entry.deviceType),
      imageUrl: optionalString(entry.imageUrl),
      deviceName: optionalString(entry.deviceName)
    };
  });
}
function parseControls(payload) {
  if (!Array.isArray(payload)) {
    throw new LiebherrResponseError("The HomeAPI controls response is not an array");
  }
  return payload.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.type !== "string" || entry.type.length === 0 || typeof entry.name !== "string" || entry.name.length === 0) {
      throw new LiebherrResponseError(`The HomeAPI control at index ${index} is malformed`);
    }
    const control = {
      ...entry,
      type: entry.type,
      name: entry.name
    };
    if (typeof entry.zoneId === "number" && Number.isFinite(entry.zoneId)) {
      control.zoneId = entry.zoneId;
    } else {
      delete control.zoneId;
    }
    if (typeof entry.zonePosition === "string") {
      control.zonePosition = entry.zonePosition;
    } else {
      delete control.zonePosition;
    }
    return control;
  });
}
class HomeApiClient {
  /**
   * @param apiKey HomeAPI credential, used only in the api-key header.
   * @param options Optional injectable client settings.
   */
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    var _a, _b, _c;
    this.baseUrl = ((_a = options.baseUrl) != null ? _a : HOME_API_BASE_URL).replace(/\/$/, "");
    this.fetch = (_b = options.fetch) != null ? _b : globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = (_c = options.requestTimeoutMs) != null ? _c : 15e3;
  }
  baseUrl;
  fetch;
  requestTimeoutMs;
  /** @returns All appliances associated with the configured API key. */
  async getDevices() {
    return parseDevices(await this.get("/v1/devices"));
  }
  /**
   * @param deviceId Appliance identifier returned by getDevices.
   * @returns All currently reported capabilities for the appliance.
   */
  async getControls(deviceId) {
    return parseControls(await this.get(`/v1/devices/${encodeURIComponent(deviceId)}/controls`));
  }
  async get(path) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "api-key": this.apiKey
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      throw new LiebherrNetworkError();
    }
    if (!response.ok) {
      throw new LiebherrApiError(
        `The Liebherr HomeAPI returned HTTP ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after"))
      );
    }
    try {
      return await response.json();
    } catch {
      throw new LiebherrResponseError("The HomeAPI returned invalid JSON");
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOME_API_BASE_URL,
  HomeApiClient,
  LiebherrApiError,
  LiebherrNetworkError,
  LiebherrResponseError,
  parseControls,
  parseDevices
});
//# sourceMappingURL=homeApiClient.js.map
