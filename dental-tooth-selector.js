(function () {
    "use strict";

    const catalog = window.DentalToothCatalog;
    const TOOTH_MAP = catalog.TOOTH_MAP;

    function escapeHtml(value) {
        if (window.DentalRoles?.escapeHtml) return window.DentalRoles.escapeHtml(value);
        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        }[char]));
    }

    function createSelector(options) {
        const selected = Array.isArray(options.initialSelected) ? [...new Set(options.initialSelected.filter(catalog.isValidToothId))] : [];
        let mode = "PERMANENT";
        function dentitionMode() { return (options.dentitionModeId && document.getElementById(options.dentitionModeId)?.value) || mode; }

        function countMode() {
            return document.getElementById(options.countModeId)?.value || "";
        }

        function numberingSystem() {
            return document.getElementById(options.numberingSystemId)?.value || "FDI";
        }

        function selections() {
            const system = numberingSystem();
            return selected.map(id => {
                const tooth = TOOTH_MAP.find(item => item.toothId === id);
                return { toothId: id, numberingSystem: system, displayCode: tooth?.[system] || "" };
            }).filter(item => item.displayCode);
        }

        function syncHiddenInput() {
            const input = document.getElementById(options.hiddenInputId);
            if (input) input.value = selections()[0]?.displayCode || "";
        }

        function render() {
            const grid = document.getElementById(options.gridId);
            if (!grid) return;
            const system = numberingSystem();
            let group = "";
            grid.innerHTML = catalog.getTeethByDentition(dentitionMode()).map(tooth => {
                const key = tooth.dentition + tooth.arch;
                const heading = dentitionMode() === "MIXED" && key !== group
                    ? '<strong style="grid-column:1/-1">' + (tooth.dentition === "PRIMARY" ? "Temporal" : "Permanente") + (tooth.arch === "UPPER" ? " superior" : " inferior") + '</strong>' : "";
                group = key;
                const isSelected = selected.includes(tooth.toothId);
                const visual = options.visual === true;
                const description = `Pieza ${tooth[system]} · ${clinicalName(tooth.toothId)}`;
                return heading + `
                <button type="button"
                        class="tooth-button ${visual ? "clinical-visual-tooth odontogram-tooth" : ""} ${isSelected ? "selected" : ""}"
                        onclick="${options.toggleFunctionName}('${tooth.toothId}')"
                        aria-pressed="${isSelected}"
                        aria-label="${escapeHtml(description)}"
                        title="${escapeHtml(description)}">
                    ${visual ? clinicalIllustration(tooth.toothId) : ""}
                    <span class="${visual ? "odontogram-code" : ""}">${escapeHtml(tooth[system])}</span>
                </button>
            `; }).join("");
            syncHiddenInput();
        }

        function reset() {
            selected.splice(0, selected.length);
            syncHiddenInput();
        }

        function setSelected(nextSelected) {
            reset();
            (nextSelected || []).forEach(item => {
                const toothId = typeof item === "string" ? item : item?.toothId;
                if (TOOTH_MAP.some(tooth => tooth.toothId === toothId) && !selected.includes(toothId)) {
                    selected.push(toothId);
                }
            });
            if (selected.some(id => !catalog.getTeethByDentition(dentitionMode()).some(tooth => tooth.toothId === id))) {
                mode = selected.every(id => catalog.getTooth(id).dentition === "PRIMARY") ? "PRIMARY" : "MIXED";
                const control = options.dentitionModeId && document.getElementById(options.dentitionModeId);
                if (control) control.value = mode;
            }
            render();
        }

        function toggle(toothId) {
            if (!catalog.isValidToothId(toothId) || !catalog.getTeethByDentition(dentitionMode()).some(tooth => tooth.toothId === toothId)) return;
            const mode = countMode();
            if (!mode) {
                reset();
            } else if (selected.includes(toothId)) {
                selected.splice(selected.indexOf(toothId), 1);
            } else {
                if (["1", "2", "3", "4"].includes(mode) && selected.length >= Number(mode)) {
                    if (window.DentalRoles?.notify) {
                        window.DentalRoles.notify("La cantidad de piezas ya fue alcanzada.", "warning");
                    }
                    return;
                }
                selected.push(toothId);
            }
            render();
        }

        function isValid() {
            const mode = countMode();
            if (["1", "2", "3", "4"].includes(mode)) return selected.length === Number(mode);
            if (mode === "multiple") return selected.length >= 5;
            return selected.length === 0;
        }

        return {
            setDentitionMode: value => {
                if (!["PERMANENT", "PRIMARY", "MIXED"].includes(value)) return;
                mode = value;
                const control = options.dentitionModeId && document.getElementById(options.dentitionModeId);
                if (control) control.value = value;
                render();
            },
            render,
            toggle,
            isValid,
            selections,
            reset,
            setSelected,
            selectedToothIds: () => [...selected],
            toothMap: TOOTH_MAP
        };
    }

    function clinicalName(toothId) {
        const tooth = catalog.getTooth(toothId);
        if (!tooth) return "Pieza dental";
        const names = {
            CENTRAL_INCISOR: "Incisivo central", LATERAL_INCISOR: "Incisivo lateral",
            CANINE: "Canino", FIRST_PREMOLAR: "Primer premolar", SECOND_PREMOLAR: "Segundo premolar",
            FIRST_MOLAR: "Primer molar", SECOND_MOLAR: "Segundo molar", THIRD_MOLAR: "Tercer molar"
        };
        return `${names[tooth.type] || "Pieza"} ${tooth.arch === "UPPER" ? "superior" : "inferior"} ${tooth.side === "RIGHT" ? "derecho" : "izquierdo"}${tooth.dentition === "PRIMARY" ? " temporal" : " permanente"}`;
    }

    // Schematic crowns/roots only; identity and anatomy come from the canonical catalog.
    function clinicalIllustration(toothId) {
        const tooth = catalog.getTooth(toothId);
        if (!tooth) return "";
        const family = tooth.type.includes("INCISOR") ? "incisor" : tooth.type === "CANINE" ? "canine"
            : tooth.type.includes("PREMOLAR") ? "premolar" : "molar";
        const shapes = {
            incisor: ['M19 10 Q30 7 41 10 L39 33 Q35 44 32 66 Q30 73 28 66 L22 34 Z', 'M20 15 L40 15 M23 32 Q30 35 37 32'],
            canine: ['M17 20 L30 6 L43 20 L39 36 L33 68 Q30 76 27 68 L21 36 Z', 'M30 7 L30 31 M21 34 Q30 39 39 34'],
            premolar: ['M13 15 Q18 5 29 12 Q41 4 47 17 L43 36 L37 65 Q34 70 31 44 Q28 70 24 65 L17 36 Z', 'M15 20 L25 25 L31 17 L39 25 L45 20 M19 34 Q30 39 42 34'],
            molar: ['M8 17 Q10 6 21 11 Q30 5 38 11 Q51 5 52 19 L48 37 L46 65 Q43 72 38 46 L33 63 Q30 71 27 62 L22 46 Q17 73 14 65 L11 37 Z', 'M10 22 L21 26 L30 18 L40 26 L51 21 M30 18 L30 34 M13 35 Q30 42 47 35']
        };
        const [outline, detail] = shapes[family];
        return `<svg class="odontogram-anatomy" data-family="${family}" viewBox="0 0 60 80" aria-hidden="true" focusable="false"><g${tooth.arch === "UPPER" ? ' transform="rotate(180 30 40)"' : ""}><path class="tooth-outline" d="${outline}"/><path class="tooth-detail" d="${detail}"/></g></svg>`;
    }

    window.DentalToothSelector = {
        clinicalName,
        clinicalIllustration,
        getTooth: catalog.getTooth,
        getLabel: catalog.getLabel,
        getTeethByDentition: catalog.getTeethByDentition,
        validSurfaces: catalog.validSurfaces,
        toothMap: TOOTH_MAP,
        createSelector
    };
})();
