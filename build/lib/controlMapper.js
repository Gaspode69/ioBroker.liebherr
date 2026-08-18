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
var controlMapper_exports = {};
__export(controlMapper_exports, {
  mapControl: () => mapControl,
  reconcileDeviceIds: () => reconcileDeviceIds,
  toIdSegment: () => toIdSegment
});
module.exports = __toCommonJS(controlMapper_exports);
var import_writeController = require("./writeController");
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isTemperatureControl(control) {
  return control.type === "TemperatureControl" && isFiniteNumber(control.zoneId) && isFiniteNumber(control.value) && isFiniteNumber(control.target) && isFiniteNumber(control.min) && isFiniteNumber(control.max) && typeof control.unit === "string";
}
function isToggleControl(control) {
  return control.type === "ToggleControl" && typeof control.value === "boolean";
}
function toIdSegment(value) {
  return Array.from(value, (character) => {
    var _a;
    if (/^[A-Za-z0-9-]$/.test(character)) {
      return character;
    }
    return `_${(_a = character.codePointAt(0)) == null ? void 0 : _a.toString(16)}_`;
  }).join("");
}
function temperatureState(id, name, value, unit) {
  return {
    id,
    common: {
      name,
      type: "number",
      role: "value.temperature",
      read: true,
      write: false,
      unit
    },
    value
  };
}
function mapControl(control) {
  if (isTemperatureControl(control)) {
    const targetTemperature = temperatureState(
      "targetTemperature",
      "Target temperature",
      control.target,
      control.unit
    );
    targetTemperature.common.min = control.min;
    targetTemperature.common.max = control.max;
    targetTemperature.common.role = "level.temperature";
    targetTemperature.common.write = true;
    targetTemperature.native = {
      controlName: control.name,
      controlType: control.type,
      zoneId: control.zoneId,
      ...control.zonePosition !== void 0 ? { zonePosition: control.zonePosition } : {},
      unit: control.unit,
      min: control.min,
      max: control.max,
      setTemperatureStepsEnabled: control.setTemperatureStepsEnabled === true,
      ...Array.isArray(control.setTemperatureSteps) ? { setTemperatureSteps: control.setTemperatureSteps } : {}
    };
    const states = [
      temperatureState("temperature", "Current temperature", control.value, control.unit),
      targetTemperature,
      temperatureState("minTemperature", "Minimum target temperature", control.min, control.unit),
      temperatureState("maxTemperature", "Maximum target temperature", control.max, control.unit),
      {
        id: "unit",
        common: {
          name: "Temperature unit",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        value: control.unit
      }
    ];
    if (typeof control.setTemperatureStepsEnabled === "boolean") {
      states.push({
        id: "setTemperatureStepsEnabled",
        common: {
          name: "Temperature steps enabled",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        },
        value: control.setTemperatureStepsEnabled
      });
    }
    if (Array.isArray(control.setTemperatureSteps) && control.setTemperatureSteps.every(isFiniteNumber)) {
      states.push({
        id: "setTemperatureSteps",
        common: {
          name: "Allowed temperature steps",
          type: "string",
          role: "json",
          read: true,
          write: false
        },
        value: JSON.stringify(control.setTemperatureSteps)
      });
    }
    return {
      scope: "zone",
      zoneId: control.zoneId,
      zonePosition: control.zonePosition,
      states
    };
  }
  if (isToggleControl(control)) {
    const writable = (0, import_writeController.isWritableToggleControl)(control.name, control.zoneId);
    return {
      scope: "device",
      zoneId: isFiniteNumber(control.zoneId) ? control.zoneId : void 0,
      zonePosition: control.zonePosition,
      states: [
        {
          id: toIdSegment(control.name),
          common: {
            name: control.name,
            type: "boolean",
            role: writable ? "switch" : "indicator",
            read: true,
            write: writable
          },
          value: control.value,
          native: {
            controlName: control.name,
            controlType: control.type,
            ...isFiniteNumber(control.zoneId) ? { zoneId: control.zoneId } : {},
            ...control.zonePosition !== void 0 ? { zonePosition: control.zonePosition } : {}
          }
        }
      ]
    };
  }
  return void 0;
}
function reconcileDeviceIds(known, current) {
  const currentSet = new Set(current);
  return {
    present: [...currentSet],
    missing: [...new Set(known)].filter((deviceId) => !currentSet.has(deviceId))
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapControl,
  reconcileDeviceIds,
  toIdSegment
});
//# sourceMappingURL=controlMapper.js.map
