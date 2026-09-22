(function () {
    "use strict";

    const TOOTH_MAP = [
        ["PERMANENT_UPPER_RIGHT_THIRD_MOLAR", "1.8", "1"],
        ["PERMANENT_UPPER_RIGHT_SECOND_MOLAR", "1.7", "2"],
        ["PERMANENT_UPPER_RIGHT_FIRST_MOLAR", "1.6", "3"],
        ["PERMANENT_UPPER_RIGHT_SECOND_PREMOLAR", "1.5", "4"],
        ["PERMANENT_UPPER_RIGHT_FIRST_PREMOLAR", "1.4", "5"],
        ["PERMANENT_UPPER_RIGHT_CANINE", "1.3", "6"],
        ["PERMANENT_UPPER_RIGHT_LATERAL_INCISOR", "1.2", "7"],
        ["PERMANENT_UPPER_RIGHT_CENTRAL_INCISOR", "1.1", "8"],
        ["PERMANENT_UPPER_LEFT_CENTRAL_INCISOR", "2.1", "9"],
        ["PERMANENT_UPPER_LEFT_LATERAL_INCISOR", "2.2", "10"],
        ["PERMANENT_UPPER_LEFT_CANINE", "2.3", "11"],
        ["PERMANENT_UPPER_LEFT_FIRST_PREMOLAR", "2.4", "12"],
        ["PERMANENT_UPPER_LEFT_SECOND_PREMOLAR", "2.5", "13"],
        ["PERMANENT_UPPER_LEFT_FIRST_MOLAR", "2.6", "14"],
        ["PERMANENT_UPPER_LEFT_SECOND_MOLAR", "2.7", "15"],
        ["PERMANENT_UPPER_LEFT_THIRD_MOLAR", "2.8", "16"],
        ["PERMANENT_LOWER_LEFT_THIRD_MOLAR", "3.8", "17"],
        ["PERMANENT_LOWER_LEFT_SECOND_MOLAR", "3.7", "18"],
        ["PERMANENT_LOWER_LEFT_FIRST_MOLAR", "3.6", "19"],
        ["PERMANENT_LOWER_LEFT_SECOND_PREMOLAR", "3.5", "20"],
        ["PERMANENT_LOWER_LEFT_FIRST_PREMOLAR", "3.4", "21"],
        ["PERMANENT_LOWER_LEFT_CANINE", "3.3", "22"],
        ["PERMANENT_LOWER_LEFT_LATERAL_INCISOR", "3.2", "23"],
        ["PERMANENT_LOWER_LEFT_CENTRAL_INCISOR", "3.1", "24"],
        ["PERMANENT_LOWER_RIGHT_CENTRAL_INCISOR", "4.1", "25"],
        ["PERMANENT_LOWER_RIGHT_LATERAL_INCISOR", "4.2", "26"],
        ["PERMANENT_LOWER_RIGHT_CANINE", "4.3", "27"],
        ["PERMANENT_LOWER_RIGHT_FIRST_PREMOLAR", "4.4", "28"],
        ["PERMANENT_LOWER_RIGHT_SECOND_PREMOLAR", "4.5", "29"],
        ["PERMANENT_LOWER_RIGHT_FIRST_MOLAR", "4.6", "30"],
        ["PERMANENT_LOWER_RIGHT_SECOND_MOLAR", "4.7", "31"],
        ["PERMANENT_LOWER_RIGHT_THIRD_MOLAR", "4.8", "32"]
    ].map(([toothId, FDI, UNIVERSAL]) => ({ toothId, FDI, UNIVERSAL }));

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
        const selected = Array.isArray(options.initialSelected) ? [...options.initialSelected] : [];

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
            grid.innerHTML = TOOTH_MAP.map(tooth => `
                <button type="button" class="tooth-button ${selected.includes(tooth.toothId) ? "selected" : ""}"
                        onclick="${options.toggleFunctionName}('${tooth.toothId}')">${escapeHtml(tooth[system])}</button>
            `).join("");
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
            render();
        }

        function toggle(toothId) {
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
        toothMap: TOOTH_MAP,
        createSelector
    };
})();
