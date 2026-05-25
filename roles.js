const DentalRoles = (() => {
    const rol = localStorage.getItem("rol") || "";
    const doctor = localStorage.getItem("doctor") || "";

    function normalizeText(value) {
        return (value || "")
            .toString()
            .replace(/&oacute;/g, "\u00f3")
            .replace(/&iacute;/g, "\u00ed")
            .replace(/&aacute;/g, "\u00e1")
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

    function notify(message, type = "success") {
        let container = document.querySelector(".toast-container");

        if (!container) {
            container = document.createElement("div");
            container.className = "toast-container";
            document.body.appendChild(container);
        }

        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        window.setTimeout(() => {
            toast.classList.add("hide");
            window.setTimeout(() => toast.remove(), 220);
        }, 2600);
    }

    function escapeHtml(value) {
        return (value || "")
            .toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function confirmAction(options = {}) {
        const title = options.title || "Confirmar acción";
        const message = options.message || "¿Deseas continuar?";
        const confirmText = options.confirmText || "Confirmar";
        const cancelText = options.cancelText || "Cancelar";
        const type = options.type || "danger";

        const current = document.querySelector(".confirm-backdrop");
        if (current) {
            current.remove();
        }

        const backdrop = document.createElement("div");
        backdrop.className = "confirm-backdrop";
        backdrop.innerHTML = `
            <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
                <h3 id="confirmTitle">${title}</h3>
                <p>${message}</p>
                <div class="confirm-actions">
                    <button type="button" class="confirm-secondary" data-confirm-cancel>${cancelText}</button>
                    <button type="button" class="confirm-danger ${type}" data-confirm-ok>${confirmText}</button>
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();

        backdrop.querySelector("[data-confirm-cancel]").addEventListener("click", close);
        backdrop.addEventListener("click", event => {
            if (event.target === backdrop) {
                close();
            }
        });

        backdrop.querySelector("[data-confirm-ok]").addEventListener("click", () => {
            close();
            if (typeof options.onConfirm === "function") {
                options.onConfirm();
            }
        });
    }

    function showDetails(title, rows = []) {
        const current = document.querySelector(".detail-backdrop");
        if (current) {
            current.remove();
        }

        const backdrop = document.createElement("div");
        backdrop.className = "detail-backdrop";
        backdrop.innerHTML = `
            <div class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
                <div class="detail-top">
                    <h3 id="detailTitle">${escapeHtml(title)}</h3>
                    <button type="button" class="detail-close" aria-label="Cerrar detalle" data-detail-close>&times;</button>
                </div>
                <div class="detail-list">
                    ${rows.map(row => `
                        <div class="detail-row">
                            <span>${escapeHtml(row.label)}</span>
                            <strong>${escapeHtml(row.value || "No registrado")}</strong>
                        </div>
                    `).join("")}
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector("[data-detail-close]").addEventListener("click", close);
        backdrop.addEventListener("click", event => {
            if (event.target === backdrop) {
                close();
            }
        });
    }

    return {
        rol,
        doctor,
        normalizeText,
        sameDoctor,
        protectPage,
        notify,
        confirmAction,
        showDetails,
        logout
    };
})();
