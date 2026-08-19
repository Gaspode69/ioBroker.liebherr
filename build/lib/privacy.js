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
var privacy_exports = {};
__export(privacy_exports, {
  maskDeviceId: () => maskDeviceId,
  redactDeviceId: () => redactDeviceId
});
module.exports = __toCommonJS(privacy_exports);
var import_controlMapper = require("./controlMapper");
function maskDeviceId(deviceId) {
  const suffix = deviceId.replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return suffix ? `****${suffix}` : "****";
}
function redactDeviceId(text, deviceId) {
  const masked = maskDeviceId(deviceId);
  return text.split(deviceId).join(masked).split((0, import_controlMapper.toIdSegment)(deviceId)).join(masked);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  maskDeviceId,
  redactDeviceId
});
//# sourceMappingURL=privacy.js.map
