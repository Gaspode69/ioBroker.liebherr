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
var retry_exports = {};
__export(retry_exports, {
  calculateRetryDelay: () => calculateRetryDelay
});
module.exports = __toCommonJS(retry_exports);
var import_homeApiClient = require("./homeApiClient");
const MAX_RETRY_DELAY_MS = 15 * 60 * 1e3;
const AUTH_RETRY_DELAY_MS = 5 * 60 * 1e3;
function calculateRetryDelay(baseDelayMs, consecutiveFailures, error) {
  var _a;
  if (error instanceof import_homeApiClient.LiebherrApiError) {
    if (error.status === 429) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(baseDelayMs, (_a = error.retryAfterMs) != null ? _a : 0));
    }
    if (error.status === 401 || error.status === 403) {
      return Math.max(baseDelayMs, AUTH_RETRY_DELAY_MS);
    }
    if (error.status !== 500 && error.status !== 503) {
      return baseDelayMs;
    }
  }
  if (error instanceof import_homeApiClient.LiebherrNetworkError || error instanceof import_homeApiClient.LiebherrApiError) {
    const exponent = Math.min(Math.max(consecutiveFailures, 1), 5);
    return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** exponent);
  }
  return baseDelayMs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  calculateRetryDelay
});
//# sourceMappingURL=retry.js.map
