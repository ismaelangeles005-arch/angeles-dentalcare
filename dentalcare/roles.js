const DentalRoles = (() => {
    const rol = localStorage.getItem("rol") || "";
    const doctor = localStorage.getItem("doctor") || "";

    function normalizeText(value) {
        return (value || "")
            .toString()
            .replace(/&oacute;/g, "?")
            .replace(/&iacute;/g, "?")
            .replace(/&aacute;/g, "?")
            .replace(/\?/g, "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();
    }

    function sameDoctor(a, b) {
        return normalizeText(a) === normalizeText(b);
    }

    function protectPage(options = {}) {
        if (!rol) {
            window.location.href = "index.html";
            return false;
        }

        if (options.adminOnly && rol !== "admin") {
            window.location.href = "dashboard.html";
            return false;
        }

        document.body.classList.add(`role-${rol}`);
        applyShell(options.active);
        return true;
    }

    function applyShell(active) {
        document.querySelectorAll(".menu button").forEach(button => {
            button.classList.remove("active");
        });

        if (active) {
            document.querySelectorAll(`[data-nav="${active}"]`).forEach(button => {
                button.classList.add("active");
            });
        }

        if (rol !== "admin") {
            document.querySelectorAll('[data-nav="reportes"]').forEach(button => {
                button.style.display = "none";
            });
        }
    }

    function logout() {
        localStorage.removeItem("rol");
        localStorage.removeItem("doctor");
        window.location.href = "index.html";
    }

    return {
        rol,
        doctor,
        normalizeText,
        sameDoctor,
        protectPage,
        logout
    };
})();
