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
var writeController_exports = {};
__export(writeController_exports, {
  ControlValidationError: () => ControlValidationError,
  WRITABLE_TOGGLE_CONTROLS: () => WRITABLE_TOGGLE_CONTROLS,
  createControlWrite: () => createControlWrite,
  isWritableToggleControl: () => isWritableToggleControl,
  processStateWrite: () => processStateWrite
});
module.exports = __toCommonJS(writeController_exports);
const WRITABLE_TOGGLE_CONTROLS = /* @__PURE__ */ new Set(["nightmode", "partymode", "supercool", "superfrost"]);
const ZONE_TOGGLE_CONTROLS = /* @__PURE__ */ new Set(["supercool", "superfrost"]);
function isWritableToggleControl(controlName, zoneId) {
  if (!WRITABLE_TOGGLE_CONTROLS.has(controlName)) {
    return false;
  }
  return !ZONE_TOGGLE_CONTROLS.has(controlName) || typeof zoneId === "number" && Number.isFinite(zoneId);
}
class ControlValidationError extends Error {
  /** @param message Safe validation failure description. */
  constructor(message) {
    super(message);
    this.name = "ControlValidationError";
  }
}
function createControlWrite(control, value) {
  var _a;
  if (control.kind === "toggle") {
    if (typeof value !== "boolean") {
      throw new ControlValidationError("Toggle values must be boolean");
    }
    const zoneScoped = ZONE_TOGGLE_CONTROLS.has(control.controlName);
    if (zoneScoped && control.zoneId === void 0) {
      throw new ControlValidationError(`${control.controlName} requires a zone ID`);
    }
    return {
      kind: "toggle",
      deviceId: control.deviceId,
      controlName: control.controlName,
      request: {
        value,
        ...zoneScoped ? { zoneId: control.zoneId } : {}
      }
    };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ControlValidationError("Target temperature must be a finite number");
  }
  if (value < control.min || value > control.max) {
    throw new ControlValidationError(
      `Target temperature must be between ${control.min} and ${control.max} ${control.unit}`
    );
  }
  if (control.stepsEnabled && ((_a = control.steps) == null ? void 0 : _a.length) && !control.steps.some((step) => Math.abs(step - value) < Number.EPSILON)) {
    throw new ControlValidationError(`Target temperature ${value} is not an allowed value`);
  }
  return {
    kind: "temperature",
    deviceId: control.deviceId,
    request: { zoneId: control.zoneId, target: value, unit: control.unit }
  };
}
async function processStateWrite(state, control, write, waitForReadback, readback) {
  if (!state || state.ack) {
    return false;
  }
  const operation = createControlWrite(control, state.val);
  await write(operation);
  await waitForReadback();
  await readback();
  return true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ControlValidationError,
  WRITABLE_TOGGLE_CONTROLS,
  createControlWrite,
  isWritableToggleControl,
  processStateWrite
});
//# sourceMappingURL=writeController.js.map
