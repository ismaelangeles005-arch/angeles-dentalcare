// Authoritative catalog. Browser copy: dental-tooth-catalog.js (byte-identical; tested).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DentalToothCatalog = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const permanent = ["CENTRAL_INCISOR", "LATERAL_INCISOR", "CANINE", "FIRST_PREMOLAR", "SECOND_PREMOLAR", "FIRST_MOLAR", "SECOND_MOLAR", "THIRD_MOLAR"];
  const primary = ["CENTRAL_INCISOR", "LATERAL_INCISOR", "CANINE", "FIRST_MOLAR", "SECOND_MOLAR"];
  const quadrants = [["UPPER", "RIGHT", true], ["UPPER", "LEFT", false], ["LOWER", "LEFT", true], ["LOWER", "RIGHT", false]];
  const teeth = [];
  for (const [dentition, types, base] of [["PERMANENT", permanent, 1], ["PRIMARY", primary, 5]]) {
    let universal = 0;
    quadrants.forEach(([arch, side, reverse], quadrant) => {
      const positions = types.map((type, index) => ({ type, position: index + 1 }));
      if (reverse) positions.reverse();
      for (const { type, position } of positions) {
        const toothId = [dentition, arch, side, type].join("_");
        const labels = Object.freeze({
          FDI: String(base + quadrant) + String(position),
          UNIVERSAL: dentition === "PERMANENT" ? String(++universal) : String.fromCharCode(65 + universal++)
        });
        const surfaces = Object.freeze(["MESIAL", "DISTAL", "BUCCAL", arch === "UPPER" ? "PALATAL" : "LINGUAL",
          position <= 3 ? "INCISAL" : "OCCLUSAL"]);
        teeth.push(Object.freeze({ toothId, dentition, arch, side, type, position, labels, surfaces,
          FDI: labels.FDI, UNIVERSAL: labels.UNIVERSAL }));
      }
    });
  }
  const TOOTH_MAP = Object.freeze(teeth);
  const TOOTH_IDS = Object.freeze(teeth.map(tooth => tooth.toothId));
  const byId = new Map(teeth.map(tooth => [tooth.toothId, tooth]));
  const getTooth = id => typeof id === "string" ? byId.get(id) : undefined;
  const isValidToothId = id => Boolean(getTooth(id));
  const getLabel = (id, system) => getTooth(id)?.labels[system] || "";
  const validSurfaces = id => getTooth(id)?.surfaces || Object.freeze([]);
  const isValidSurfaceForTooth = (id, surface) => isValidToothId(id) && (surface === null || validSurfaces(id).includes(surface));
  const getTeethByDentition = mode => mode === "MIXED" ? TOOTH_MAP : TOOTH_MAP.filter(tooth => tooth.dentition === mode);

  // Only an actual locked original may supply the historical exception.
  function isValidCorrectionSurface(toothId, surface, original) {
    if (!original || original.tooth_id !== toothId) return false;
    if (surface === original.surface) return true;
    // A non-anatomical historical surface cannot silently become "whole tooth".
    if (original.surface !== null && !isValidSurfaceForTooth(toothId, original.surface) && surface === null) return false;
    return isValidSurfaceForTooth(toothId, surface);
  }

  function cleanToothSelections(value) {
    if (value == null) return [];
    const invalid = () => { const error = new Error("La seleccion dental no es valida"); error.status = error.statusCode = 400; throw error; };
    if (!Array.isArray(value) || value.length > TOOTH_IDS.length) return invalid();
    const seen = new Set();
    return value.map(item => {
      if (!item || !isValidToothId(item.toothId) || !["FDI", "UNIVERSAL"].includes(item.numberingSystem) || seen.has(item.toothId)) return invalid();
      seen.add(item.toothId);
      return { toothId: item.toothId, numberingSystem: item.numberingSystem, displayCode: getLabel(item.toothId, item.numberingSystem) };
    });
  }
  return Object.freeze({ TOOTH_MAP, TOOTH_IDS, getTooth, getLabel, validSurfaces, getTeethByDentition,
    isValidToothId, isValidSurfaceForTooth, isValidCorrectionSurface, cleanToothSelections });
});
