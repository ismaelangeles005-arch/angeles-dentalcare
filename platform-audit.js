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

    const message = (text, error = false) => {
        el("message").textContent = text;
        el("message").dataset.error = String(error);
    };

    const date = value =>
        value ? new Date(value).toLocaleString("es-DO") : "-";

    const actionLabel = action => ({
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
            from: from ? `${from}T00:00:00` : "",
            to: to ? `${to}T23:59:59.999` : "",
            limit: pageSize,
            offset
        };
    }

    async function refresh() {
        if (loading) return;
        loading = true;
        el("refresh").disabled = true;
        el("applyFilters").disabled = true;

        try {
            const result = await DentalApi.getPlatformAudit(buildFilters());
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
                appendCell(row, event.organization?.name || "-");
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

            el("previous").disabled = offset === 0;
            el("next").disabled = !result.pagination.hasMore;
            el("pageInfo").textContent =
                `Registros ${result.events.length ? offset + 1 : 0}-${offset + result.events.length}`;

            message("");
        } catch (error) {
            message("No fue posible cargar la auditoría.", true);
        } finally {
            loading = false;
            el("refresh").disabled = false;
            el("applyFilters").disabled = false;
        }
    }

    el("applyFilters").onclick = async () => {
        offset = 0;
        await refresh();
    };

    el("clearFilters").onclick = async () => {
        el("organizationFilter").value = "";
        el("actionFilter").value = "";
        el("actorFilter").value = "";
        el("fromFilter").value = "";
        el("toFilter").value = "";
        offset = 0;
        await refresh();
    };

    el("refresh").onclick = refresh;

    el("previous").onclick = async () => {
        offset = Math.max(0, offset - pageSize);
        await refresh();
    };

    el("next").onclick = async () => {
        offset += pageSize;
        await refresh();
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
