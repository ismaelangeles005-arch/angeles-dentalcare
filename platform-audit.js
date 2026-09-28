function platformAuditDestination(user) {
    if (!user) return "index.html";

    const platform =
        user.role === "PLATFORM_SUPER_ADMIN" &&
        user.scope === "PLATFORM" &&
        user.organizationId === null;

    const tenant =
        user.role !== "PLATFORM_SUPER_ADMIN" &&
        user.scope === "ORGANIZATION" &&
        Boolean(user.organizationId);

    if (!platform && !tenant) return "index.html";
    if (user.mustChangePassword) return "cambiar-password.html";

    return platform ? null : "dashboard.html";
}

async function startPlatformAudit() {
    const el = id => document.getElementById(id);
    const pageSize = 50;
    let offset = 0;
    let loading = false;
    let exporting = false;
    let loaded = false;
    let hasMore = false;
    let appliedFilters = {};

    const updateControls = () => {
        for (const id of ["refresh", "applyFilters", "clearFilters"]) el(id).disabled = loading || exporting;
        el("exportCsv").disabled = loading || exporting || !loaded;
        el("previous").disabled = loading || exporting || offset === 0;
        el("next").disabled = loading || exporting || !hasMore;
    };

    const message = (text, error = false) => {
        el("message").textContent = text;
        el("message").dataset.error = String(error);
    };

    const date = value =>
        value ? new Date(value).toLocaleString("es-DO") : "-";

    const actionLabel = action => ({
        platform_create_admin: "Crear Super Admin",
        platform_activate_admin: "Activar Super Admin",
        platform_deactivate_admin: "Desactivar Super Admin",
        platform_reset_admin_password: "Resetear contraseña de Super Admin",
        platform_force_admin_password_change: "Forzar cambio de contraseña de Super Admin",
        platform_create_organization: "Crear organización",
        platform_change_organization_owner: "Cambiar propietario",
        platform_activate_organization: "Activar organización",
        platform_deactivate_organization: "Desactivar organización",
        platform_create_user: "Crear usuario",
        platform_activate_user: "Activar usuario",
        platform_deactivate_user: "Desactivar usuario",
        platform_reset_user_password: "Resetear contraseña",
        platform_set_user_pin: "Asignar/cambiar PIN",
        platform_enable_user_pin: "Activar PIN",
        platform_disable_user_pin: "Desactivar PIN",
        platform_unlock_user_pin: "Desbloquear PIN",
        platform_force_password_change: "Forzar cambio de contraseña"
    })[action] || action;

    const appendCell = (row, value) => {
        const td = document.createElement("td");
        td.textContent = value ?? "-";
        row.append(td);
    };

    try {
        const user = await DentalApi.getCurrentUser();
        const destination = platformAuditDestination(user);

        if (destination) {
            window.location.replace(destination);
            return;
        }

        el("identity").textContent = user.fullName || user.username;
        el("sessionError").hidden = true;
        el("platformAuditApp").hidden = false;
    } catch (error) {
        if (error.status === 401) {
            window.location.replace("index.html");
        } else if (error.status === 403 && error.code === "PASSWORD_CHANGE_REQUIRED") {
            window.location.replace("cambiar-password.html");
        } else if (error.status === 403) {
            window.location.replace("index.html");
        } else {
            el("sessionError").textContent =
                "No fue posible verificar la sesión. Recarga para reintentar.";
        }
        return;
    }

    async function loadOrganizations() {
        const result = await DentalApi.getPlatformOrganizations();
        const select = el("organizationFilter");

        for (const org of result.organizations) {
            const option = document.createElement("option");
            option.value = org.id;
            option.textContent = org.name;
            select.append(option);
        }
    }

    function buildFilters() {
        const from = el("fromFilter").value;
        const to = el("toFilter").value;

        return {
            organizationId: el("organizationFilter").value,
            action: el("actionFilter").value,
            actor: el("actorFilter").value.trim(),
            targetUserId: el("targetUserFilter").value.trim(),
            from: from ? `${from}T00:00:00` : "",
            to: to ? `${to}T23:59:59.999` : ""
        };
    }

    async function refresh(filters = appliedFilters, nextOffset = offset) {
        if (loading || exporting) return;
        loading = true;
        updateControls();
        message("Cargando auditoría...");

        try {
            const result = await DentalApi.getPlatformAudit({ ...filters, limit: pageSize, offset: nextOffset });
            appliedFilters = { ...filters };
            offset = nextOffset;
            loaded = true;
            hasMore = result.events.length === pageSize && result.pagination.hasMore;
            el("events").replaceChildren();

            if (!result.events.length) {
                const row = document.createElement("tr");
                const cell = document.createElement("td");
                cell.colSpan = 5;
                cell.textContent = "No hay eventos para mostrar.";
                row.append(cell);
                el("events").append(row);
            }

            for (const event of result.events) {
                const row = document.createElement("tr");

                appendCell(row, date(event.createdAt));
                appendCell(row, event.organization?.name || (['platform_create_admin', 'platform_activate_admin', 'platform_deactivate_admin', 'platform_reset_admin_password', 'platform_force_admin_password_change'].includes(event.action) ? "Plataforma MAELVEN" : "-"));
                appendCell(
                    row,
                    event.actor
                        ? `${event.actor.fullName || event.actor.username} (${event.actor.username})`
                        : "Actor no disponible"
                );
                appendCell(row, actionLabel(event.action));
                appendCell(
                    row,
                    event.targetUser
                        ? `${event.targetUser.fullName || event.targetUser.username} (${event.targetUser.username})`
                        : "-"
                );

                el("events").append(row);
            }

            el("pageInfo").textContent =
                result.events.length ? `Mostrando ${offset + 1}–${offset + result.events.length}` : "Sin resultados";

            message("");
        } catch (error) {
            message("No fue posible cargar la auditoría.", true);
        } finally {
            loading = false;
            updateControls();
        }
    }

    el("applyFilters").onclick = async () => {
        await refresh(buildFilters(), 0);
    };

    el("clearFilters").onclick = async () => {
        if (loading || exporting) return;
        el("organizationFilter").value = "";
        el("actionFilter").value = "";
        el("actorFilter").value = "";
        el("targetUserFilter").value = "";
        el("fromFilter").value = "";
        el("toFilter").value = "";
        await refresh(buildFilters(), 0);
    };

    el("refresh").onclick = () => refresh();

    el("previous").onclick = async () => {
        if (el("previous").disabled) return;
        await refresh(appliedFilters, Math.max(0, offset - pageSize));
    };

    el("next").onclick = async () => {
        if (el("next").disabled) return;
        await refresh(appliedFilters, offset + pageSize);
    };

    const csvCell = value => {
        let text = String(value ?? "");
        // Quoting alone does not prevent spreadsheet formula execution.
        if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    };
    el("exportCsv").onclick = async () => {
        if (loading || exporting || !loaded) return;
        exporting = true;
        updateControls();
        message("Exportando auditoría...");
        const filters = { ...appliedFilters };
        const lines = [["Fecha", "Acción", "Organización", "Actor", "Usuario objetivo", "Entidad", "ID entidad"].map(csvCell).join(",")];
        const seen = new Set();
        const batchSize = 100;
        try {
            for (let exportOffset = 0; ; exportOffset += batchSize) {
                // Fail without downloading a partial export if the browser safety bound is exceeded.
                if (exportOffset >= 100000) throw new Error("Export limit exceeded");
                const result = await DentalApi.getPlatformAudit({ ...filters, limit: batchSize, offset: exportOffset });
                for (const event of result.events) {
                    // Offset pages can overlap when the live audit grows during export.
                    if (seen.has(event.id)) throw new Error("Audit changed during export");
                    seen.add(event.id);
                    const person = user => user ? `${user.fullName || user.username} (${user.username})` : "-";
                    lines.push([date(event.createdAt), actionLabel(event.action),
                        event.organization?.name || "-", person(event.actor), person(event.targetUser),
                        event.entity, event.entityId].map(csvCell).join(","));
                }
                if (result.events.length < batchSize) break;
            }
            const blob = new Blob(["\uFEFF", lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const now = new Date(), pad = value => String(value).padStart(2, "0");
            link.href = url;
            link.download = `maelven-platform-audit-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
            try { document.body.append(link); link.click(); }
            finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
            message("CSV exportado correctamente.");
        } catch (error) {
            message("No fue posible exportar la auditoría.", true);
        } finally {
            exporting = false;
            updateControls();
        }
    };

    el("back").onclick = () => {
        window.location.href = "platform.html";
    };

    el("logout").onclick = async () => {
        try {
            await DentalApi.logout();
            window.location.replace("index.html");
        } catch (error) {
            message("No fue posible cerrar la sesión.", true);
        }
    };

    try {
        updateControls();
        await loadOrganizations();
        await refresh();
    } catch (error) {
        message("No fue posible cargar la auditoría.", true);
    }
}

document.addEventListener("DOMContentLoaded", startPlatformAudit);
window.addEventListener("pageshow", event => {
    if (event.persisted) window.location.reload();
});
