const DentalRoles = (() => {
    const hasSession = localStorage.getItem("sessionActive") === "true";
    const rol = hasSession ? (localStorage.getItem("rol") || "") : "";
    const doctor = hasSession ? (localStorage.getItem("doctor") || "") : "";
    const mustChangePassword = hasSession && localStorage.getItem("mustChangePassword") === "true";

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

        if (mustChangePassword && !options.allowPasswordChange) {
            window.location.href = "cambiar-password.html";
            return false;
        }

        if (options.adminOnly && !["head_admin", "admin"].includes(rol)) {
            window.location.href = "dashboard.html";
            return false;
        }

        if (Array.isArray(options.allowedRoles) && !options.allowedRoles.includes(rol)) {
            window.location.href = "dashboard.html";
            return false;
        }

        document.body.classList.add(`role-${rol}`);
        setupInactivityLock();
        applyShell(options.active);
        return true;
    }


    function setupInactivityLock() {
        const minutes = Number(localStorage.getItem("autoLockMinutes") || 15);
        if (!Number.isFinite(minutes) || minutes <= 0 || window.__dentalAutoLockReady) {
            return;
        }

        window.__dentalAutoLockReady = true;
        const timeoutMs = minutes * 60 * 1000;
        let timer;
        const resetTimer = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                logout();
            }, timeoutMs);
        };

        ["click", "keydown", "mousemove", "touchstart", "scroll"].forEach(eventName => {
            window.addEventListener(eventName, resetTimer, { passive: true });
        });
        resetTimer();
    }
    function applyShell(active) {
        ensureAdminMenu();
        ensureDoctorMenu();
        ensureReceptionMenu();

        document.querySelectorAll(".menu button").forEach(button => {
            button.classList.remove("active");
        });

        if (active) {
            document.querySelectorAll(`[data-nav="${active}"]`).forEach(button => {
                button.classList.add("active");
            });
        }

        if (!["head_admin", "admin"].includes(rol)) {
            document.querySelectorAll('[data-nav="reportes"]').forEach(button => {
                button.style.display = "none";
            });
        }

        setupNotifications();
    }

    function ensureAdminMenu() {
        const menu = document.querySelector(".menu");
        if (!menu || !["head_admin", "admin"].includes(rol)) {
            return;
        }

        if (!menu.querySelector('[data-nav="usuarios"]')) {
            const usersButton = document.createElement("button");
            usersButton.type = "button";
            usersButton.dataset.nav = "usuarios";
            usersButton.innerHTML = '<i class="fa-solid fa-users-gear" aria-hidden="true"></i> Usuarios';
            usersButton.addEventListener("click", () => {
                window.location.href = "usuarios.html";
            });
            menu.appendChild(usersButton);
        }

        if (!menu.querySelector('[data-nav="auditoria"]')) {
            const auditButton = document.createElement("button");
            auditButton.type = "button";
            auditButton.dataset.nav = "auditoria";
            auditButton.innerHTML = '<i class="fa-solid fa-clipboard-list" aria-hidden="true"></i> Auditoría';
            auditButton.addEventListener("click", () => {
                window.location.href = "auditoria.html";
            });
            menu.appendChild(auditButton);
        }

        if (!menu.querySelector('[data-nav="procedimientos"]')) {
            const proceduresButton = document.createElement("button");
            proceduresButton.type = "button";
            proceduresButton.dataset.nav = "procedimientos";
            proceduresButton.innerHTML = '<i class="fa-solid fa-list-check" aria-hidden="true"></i> Procedimientos';
            proceduresButton.addEventListener("click", () => {
                window.location.href = "procedimientos.html";
            });
            menu.appendChild(proceduresButton);
        }

        if (!menu.querySelector('[data-nav="facturacion"]')) {
            const billingButton = document.createElement("button");
            billingButton.type = "button";
            billingButton.dataset.nav = "facturacion";
            billingButton.innerHTML = '<i class="fa-solid fa-file-invoice-dollar" aria-hidden="true"></i> Facturación';
            billingButton.addEventListener("click", () => {
                window.location.href = "facturacion.html";
            });
            menu.appendChild(billingButton);
        }
    }


    function ensureDoctorMenu() {
        const menu = document.querySelector(".menu");
        if (!menu || rol !== "doctor") {
            return;
        }

        if (!menu.querySelector('[data-nav="procedimientos"]')) {
            const proceduresButton = document.createElement("button");
            proceduresButton.type = "button";
            proceduresButton.dataset.nav = "procedimientos";
            proceduresButton.innerHTML = '<i class="fa-solid fa-list-check" aria-hidden="true"></i> Procedimientos';
            proceduresButton.addEventListener("click", () => {
                window.location.href = "procedimientos.html";
            });
            menu.appendChild(proceduresButton);
        }

        if (!menu.querySelector('[data-nav="facturacion"]')) {
            const billingButton = document.createElement("button");
            billingButton.type = "button";
            billingButton.dataset.nav = "facturacion";
            billingButton.innerHTML = '<i class="fa-solid fa-file-invoice-dollar" aria-hidden="true"></i> Facturación';
            billingButton.addEventListener("click", () => {
                window.location.href = "facturacion.html";
            });
            menu.appendChild(billingButton);
        }
    }


    function ensureReceptionMenu() {
        const menu = document.querySelector(".menu");
        if (!menu || rol !== "recepcion") {
            return;
        }

        if (!menu.querySelector('[data-nav="procedimientos"]')) {
            const proceduresButton = document.createElement("button");
            proceduresButton.type = "button";
            proceduresButton.dataset.nav = "procedimientos";
            proceduresButton.innerHTML = '<i class="fa-solid fa-list-check" aria-hidden="true"></i> Procedimientos';
            proceduresButton.addEventListener("click", () => {
                window.location.href = "procedimientos.html";
            });
            menu.appendChild(proceduresButton);
        }

        if (!menu.querySelector('[data-nav="facturacion"]')) {
            const billingButton = document.createElement("button");
            billingButton.type = "button";
            billingButton.dataset.nav = "facturacion";
            billingButton.innerHTML = '<i class="fa-solid fa-file-invoice-dollar" aria-hidden="true"></i> Facturación';
            billingButton.addEventListener("click", () => {
                window.location.href = "facturacion.html";
            });
            menu.appendChild(billingButton);
        }
    }

    async function setupNotifications() {
        const topbar = document.querySelector(".topbar");
        if (!topbar || typeof DentalApi === "undefined" || document.querySelector(".notification-center")) {
            return;
        }

        const logoutButton = topbar.querySelector(".logout-btn");
        const center = document.createElement("div");
        center.className = "notification-center";
        center.innerHTML = `
            <button type="button" class="notification-button" aria-label="Notificaciones" title="Notificaciones">
                <i class="fa-solid fa-bell" aria-hidden="true"></i>
                <span class="notification-badge" hidden>0</span>
            </button>
            <div class="notification-panel" hidden>
                <div class="notification-header">
                    <strong>Notificaciones</strong>
                    <button type="button" data-read-all>Marcar leidas</button>
                </div>
                <div class="notification-list"></div>
            </div>
        `;

        if (logoutButton) {
            logoutButton.textContent = "Bloquear sesion";
            logoutButton.title = "Cerrar la sesion local y volver al acceso por PIN";
            const actions = document.createElement("div");
            actions.className = "topbar-actions";
            logoutButton.parentNode.insertBefore(actions, logoutButton);
            actions.append(center, logoutButton);
        }
        else {
            topbar.appendChild(center);
        }

        const button = center.querySelector(".notification-button");
        const panel = center.querySelector(".notification-panel");

        button.addEventListener("click", event => {
            event.stopPropagation();
            panel.hidden = !panel.hidden;
        });

        panel.addEventListener("click", event => event.stopPropagation());
        document.addEventListener("click", () => {
            panel.hidden = true;
        });

        center.querySelector("[data-read-all]").addEventListener("click", async event => {
            event.currentTarget.disabled = true;
            try {
                await DentalApi.markAllNotificationsRead();
                await loadNotifications(center);
                notify("Notificaciones marcadas como leidas.", "success");
            }
            catch (error) {
                notify(error.message, "error");
            }
            finally {
                event.currentTarget.disabled = false;
            }
        });

        await loadNotifications(center);

        if (!window.dentalNotificationsTimer) {
            window.dentalNotificationsTimer = window.setInterval(() => {
                loadNotifications(center);
            }, 30000);
        }

        if (!window.dentalNotificationsFocusBound) {
            window.dentalNotificationsFocusBound = true;
            document.addEventListener("visibilitychange", () => {
                if (!document.hidden) {
                    loadNotifications();
                }
            });
            window.addEventListener("focus", () => loadNotifications());
        }
    }

    function notificationTargetUrl(entityType, entityId) {
        if (entityType === "appointment") {
            return entityId
                ? `citas.html?cita=${encodeURIComponent(entityId)}`
                : "citas.html";
        }

        if (entityType === "patient" && rol === "doctor") {
            return entityId
                ? `pacientes.html?paciente=${encodeURIComponent(entityId)}&preview=1`
                : "pacientes.html";
        }

        return entityId
            ? `pacientes.html?paciente=${encodeURIComponent(entityId)}`
            : "pacientes.html";
    }

    async function loadNotifications(center = document.querySelector(".notification-center")) {
        if (!center) {
            return;
        }

        const list = center.querySelector(".notification-list");
        const badge = center.querySelector(".notification-badge");

        try {
            const notifications = await DentalApi.getNotifications();
            const unread = notifications.filter(item => !item.read_at).length;
            badge.textContent = unread > 99 ? "99+" : unread;
            badge.hidden = unread === 0;

            list.innerHTML = notifications.length
                ? notifications.map(item => `
                    <button type="button"
                            class="notification-item ${item.read_at ? "" : "unread"}"
                            data-notification-id="${escapeHtml(item.id)}"
                            data-entity-type="${escapeHtml(item.entity_type || "")}"
                            data-entity-id="${escapeHtml(item.entity_id || "")}">
                        <strong>${escapeHtml(item.title)}</strong>
                        <span>${escapeHtml(item.message)}</span>
                        <small>${new Date(item.created_at).toLocaleString("es-DO")}</small>
                    </button>
                `).join("")
                : '<p class="notification-empty">No tienes notificaciones.</p>';

            showNotificationPopup(notifications);

            list.querySelectorAll(".notification-item").forEach(item => {
                item.addEventListener("click", async () => {
                    try {
                        await DentalApi.markNotificationRead(item.dataset.notificationId);
                    }
                    catch (error) {
                        // Navigation remains available if marking the notification fails.
                    }
                    const entityType = item.dataset.entityType || "";
                    const entityId = item.dataset.entityId || "";

                    window.location.href = notificationTargetUrl(entityType, entityId);
                });
            });
        }
        catch (error) {
            list.innerHTML = '<p class="notification-empty">No fue posible cargar las notificaciones.</p>';
        }
    }


    function showNotificationPopup(notifications = []) {
        const unread = notifications.filter(item => !item.read_at);
        if (!unread.length || document.querySelector(".activity-popup") || sessionStorage.getItem("activityPopupDismissed") === "true") {
            return;
        }

        const popup = document.createElement("div");
        popup.className = "activity-popup";
        popup.style.cssText = "position:fixed;right:22px;bottom:22px;z-index:1200;width:min(360px,calc(100vw - 28px));background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.22);overflow:hidden";
        popup.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:#2563eb;color:#fff">
                <strong>Actividades pendientes</strong>
                <button type="button" data-close-popup aria-label="Cerrar" style="width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.18);color:#fff;font-size:20px;cursor:pointer">&times;</button>
            </div>
            <div style="padding:14px 16px;display:grid;gap:10px;max-height:280px;overflow:auto">
                ${unread.slice(0, 4).map(item => `
                    <button type="button" data-popup-id="${escapeHtml(item.id)}" data-entity-type="${escapeHtml(item.entity_type || "")}" data-entity-id="${escapeHtml(item.entity_id || "")}" style="text-align:left;border:1px solid #e2e8f0;background:#f8fafc;border-radius:12px;padding:10px;cursor:pointer">
                        <strong style="display:block;color:#0f172a">${escapeHtml(item.title)}</strong>
                        <span style="display:block;color:#475569;margin-top:4px;font-size:13px">${escapeHtml(item.message)}</span>
                    </button>
                `).join("")}
            </div>
        `;
        document.body.appendChild(popup);
        popup.querySelector("[data-close-popup]").addEventListener("click", () => {
            sessionStorage.setItem("activityPopupDismissed", "true");
            popup.remove();
        });
        popup.querySelectorAll("[data-popup-id]").forEach(button => {
            button.addEventListener("click", async () => {
                try { await DentalApi.markNotificationRead(button.dataset.popupId); } catch (error) {}
                const entityType = button.dataset.entityType || "";
                const entityId = button.dataset.entityId || "";
                window.location.href = notificationTargetUrl(entityType, entityId);

            });
        });
    }

    async function logout() {
        if (typeof DentalApi !== "undefined") {
            await DentalApi.logout();
        }
        else {
            localStorage.removeItem("token");
            localStorage.removeItem("rol");
            localStorage.removeItem("doctor");
            localStorage.removeItem("usuario");
        }

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
        const title = options.title || "Confirmar accion";
        const message = options.message || "Deseas continuar?";
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
        escapeHtml,
        protectPage,
        notify,
        confirmAction,
        showDetails,
        loadNotifications,
        logout
    };
})();















