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
                return heading + `
                <button type="button" class="tooth-button ${selected.includes(tooth.toothId) ? "selected" : ""}"
                        onclick="${options.toggleFunctionName}('${tooth.toothId}')">${escapeHtml(tooth[system])}</button>
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

    window.DentalToothSelector = {
        getTooth: catalog.getTooth,
        getLabel: catalog.getLabel,
        getTeethByDentition: catalog.getTeethByDentition,
        validSurfaces: catalog.validSurfaces,
        toothMap: TOOTH_MAP,
        createSelector
    };
})();
