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
  /**
   * Consumes realtime control updates until the server closes the stream or the signal is aborted.
   *
   * @param deviceId Appliance identifier returned by getDevices.
   * @param handlers Stream lifecycle and event callbacks.
   * @param signal Signal used by the adapter to stop the long-lived request.
   */
  async streamControls(deviceId, handlers, signal) {
    var _a;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/sse/devices/${encodeURIComponent(deviceId)}/controls`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "api-key": this.apiKey
        },
        signal
      });
    } catch {
      if (signal.aborted) {
        return;
      }
      throw new LiebherrNetworkError();
    }
    if (!response.ok) {
      throw this.createApiError(response);
    }
    if (!response.body) {
      throw new LiebherrResponseError("The HomeAPI SSE response has no body");
    }
    (_a = handlers.onOpen) == null ? void 0 : _a.call(handlers);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];
    const dispatch = async () => {
      var _a2;
      if (dataLines.length === 0) {
        return;
      }
      const data = dataLines.join("\n");
      dataLines = [];
      let controls;
      try {
        controls = parseControls(JSON.parse(data));
      } catch (error) {
        const responseError = error instanceof LiebherrResponseError ? error : new LiebherrResponseError("The HomeAPI SSE event contains invalid JSON");
        (_a2 = handlers.onMalformedEvent) == null ? void 0 : _a2.call(handlers, responseError);
        return;
      }
      await handlers.onControls(controls);
    };
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          if (line === "") {
            await dispatch();
          } else if (line.startsWith("data:")) {
            const value2 = line.slice(5);
            dataLines.push(value2.startsWith(" ") ? value2.slice(1) : value2);
          }
          newline = buffer.indexOf("\n");
        }
        if (done) {
          if (buffer.startsWith("data:")) {
            const value2 = buffer.slice(5).replace(/\r$/, "");
            dataLines.push(value2.startsWith(" ") ? value2.slice(1) : value2);
          }
          await dispatch();
          return;
        }
      }
    } catch {
      if (!signal.aborted) {
        throw new LiebherrNetworkError();
      }
    } finally {
      reader.releaseLock();
    }
  }
  /**
   * Sets the target temperature of one appliance zone.
   *
   * @param deviceId Appliance identifier returned by getDevices.
   * @param request Validated temperature request.
   */
  async setTemperature(deviceId, request) {
    await this.post(`/v1/devices/${encodeURIComponent(deviceId)}/controls/temperature`, request);
  }
  /**
   * Sets one supported boolean appliance control.
   *
   * @param deviceId Appliance identifier returned by getDevices.
   * @param controlName Capability name returned by getControls.
   * @param request Validated toggle request.
   */
  async setToggle(deviceId, controlName, request) {
    await this.post(
      `/v1/devices/${encodeURIComponent(deviceId)}/controls/${encodeURIComponent(controlName)}`,
      request
    );
  }
  async get(path) {
    const response = await this.request(path, { method: "GET" });
    try {
      return await response.json();
    } catch {
      throw new LiebherrResponseError("The HomeAPI returned invalid JSON");
    }
  }
  async post(path, body) {
    await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  async request(path, init) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...init.headers,
          "api-key": this.apiKey
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      throw new LiebherrNetworkError();
    }
    if (!response.ok) {
      throw this.createApiError(response);
    }
    return response;
  }
  createApiError(response) {
    return new LiebherrApiError(
      `The Liebherr HomeAPI returned HTTP ${response.status}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after"))
    );
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
