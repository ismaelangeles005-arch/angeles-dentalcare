/* Platform pages never use tenant role normalization or local storage as authority. */
function platformDestination(user) {
    if (!user) return "index.html";
    const platform = user.role === "PLATFORM_SUPER_ADMIN" && user.scope === "PLATFORM" && user.organizationId === null;
    const tenant = user.role !== "PLATFORM_SUPER_ADMIN" && user.scope === "ORGANIZATION" && Boolean(user.organizationId);
    if (!platform && !tenant) return "index.html";
    if (user.mustChangePassword) return "cambiar-password.html";
    return platform ? null : "dashboard.html";
}

async function startPlatform() {
    const el = id => document.getElementById(id);
    const message = (text, error = false) => { el("message").textContent = text; el("message").dataset.error = String(error); };
    const cell = (row, text) => { const td = document.createElement("td"); td.textContent = text; row.append(td); return td; };
    const date = value => value ? new Date(value).toLocaleString("es-DO") : "-";
    const type = value => value === "INDEPENDENT" ? "Independiente" : "Clínica";
    try {
        const user = await DentalApi.getCurrentUser();
        const destination = platformDestination(user);
        if (destination) { window.location.replace(destination); return; }
        el("identity").textContent = user.fullName || user.username;
        el("sessionError").hidden = true;
        el("platformApp").hidden = false;
    } catch (error) {
        if (error.status === 401 || error.status === 403) window.location.replace("index.html");
        else el("sessionError").textContent = "No fue posible verificar la sesión. Recarga para reintentar.";
        return;
    }

    let organizations = [];
    function renderOrganizations() {
        const search = el("organizationSearch").value.trim().toLowerCase();
        const selectedType = el("organizationTypeFilter").value;
        const status = el("organizationStatusFilter").value;
        const visible = organizations.filter(org => org.name.toLowerCase().includes(search)
            && (!selectedType || org.organizationType === selectedType)
            && (!status || org.active === (status === "ACTIVE")));
        el("organizationResults").textContent = `${visible.length} de ${organizations.length} organizaciones`;
        el("organizations").replaceChildren();
        if (!visible.length) {
            const row = document.createElement("tr"); cell(row, organizations.length ? "No hay organizaciones que coincidan con los filtros." : "Sin organizaciones registradas").colSpan = 6; el("organizations").append(row);
        }
        for (const org of visible) {
            const row = document.createElement("tr");
            cell(row, org.name); cell(row, type(org.organizationType));
            cell(row, org.active ? "Activa" : "Inactiva").className = org.active ? "active" : "inactive";
            cell(row, date(org.createdAt)); cell(row, date(org.updatedAt));
            const actions = cell(row, "");
            const details = document.createElement("button"); details.textContent = "Ver detalle"; details.type = "button";
            details.onclick = () => { window.location.href = `platform-organization.html?id=${encodeURIComponent(org.id)}`; };
            const toggle = document.createElement("button"); toggle.type = "button"; toggle.textContent = org.active ? "Desactivar" : "Activar";
            toggle.onclick = async () => {
                if (!window.confirm(`${toggle.textContent} ${org.name}?${org.active ? " Sus usuarios perderán el acceso mientras esté inactiva." : ""}`)) return;
                toggle.disabled = true;
                try { await DentalApi.setPlatformOrganizationStatus(org.id, !org.active); message("Estado actualizado."); await refresh(); }
                catch (error) { message(error.message, true); } finally { toggle.disabled = false; }
            };
            actions.append(details, " ", toggle); el("organizations").append(row);
        }
    }
    el("organizationSearch").oninput = renderOrganizations;
    el("organizationTypeFilter").onchange = renderOrganizations;
    el("organizationStatusFilter").onchange = renderOrganizations;
    async function refresh() {
        el("refresh").disabled = true;
        try {
            const [status, result] = await Promise.all([DentalApi.getPlatformStatus(), DentalApi.getPlatformOrganizations()]);
            el("metrics").replaceChildren();
            const metrics = [["Organizaciones", status.organizations.total_organizations], ["Activas", status.organizations.active_organizations],
                ["Inactivas", status.organizations.inactive_organizations], ["Clínicas", status.organizations.clinics],
                ["Independientes", status.organizations.independent], ["Administradores de plataforma", status.platformAdmins]];
            for (const [label, value] of metrics) {
                const item = document.createElement("div"); item.className = "metric"; item.textContent = label;
                const number = document.createElement("strong"); number.textContent = value; item.append(number); el("metrics").append(item);
            }
            organizations = result.organizations;
            renderOrganizations();
        } catch (error) { message(`No se pudo actualizar el panel: ${error.message}`, true); }
        finally { el("refresh").disabled = false; }
    }
    el("audit").onclick = () => { window.location.href = "platform-audit.html"; };
    el("refresh").onclick = () => { message("Actualizando..."); refresh().then(() => { if (el("message").dataset.error !== "true") message(""); }); };
    el("logout").onclick = async () => { try { await DentalApi.logout(); window.location.replace("index.html"); } catch (error) { message(error.message, true); } };
    const form = el("createForm"), dialog = el("createDialog");
    let saving = false;
    const cancel = () => { if (!saving) { form.reset(); dialog.close(); } };
    dialog.addEventListener("cancel", event => { event.preventDefault(); cancel(); });
    el("cancelCreate").onclick = cancel;
    el("newOrganization").onclick = () => { form.reset(); el("formError").textContent = ""; dialog.showModal(); };
    form.onsubmit = async event => {
        event.preventDefault(); if (saving || !form.reportValidity()) return;
        saving = true; el("saveCreate").disabled = true; el("cancelCreate").disabled = true;
        el("formError").textContent = "";
        const value = name => form.elements.namedItem(name).value;
        const payload = { organization: { name: value("organizationName"), organizationType: value("organizationType") },
            initialUser: { username: value("username"), fullName: value("fullName"), password: value("password") } };
        try {
            await DentalApi.createPlatformOrganization(payload);
            form.reset(); dialog.close(); message("Organización y propietario creados. El usuario deberá cambiar su contraseña."); await refresh();
        } catch (error) { el("formError").textContent = error.message; }
        finally { payload.initialUser.password = ""; form.elements.namedItem("password").value = ""; saving = false; el("saveCreate").disabled = false; el("cancelCreate").disabled = false; }
    };
    message("Cargando organizaciones...");
    await refresh();
    if (el("message").dataset.error !== "true") message("");
}
document.addEventListener("DOMContentLoaded", startPlatform);
window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
