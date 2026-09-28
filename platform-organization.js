async function startPlatformOrganization() {
    const el = id => document.getElementById(id);
    const message = (text, error = false) => { el("message").textContent = text; el("message").dataset.error = String(error); };
    const redirectError = error => {
        if (error.code === "PASSWORD_CHANGE_REQUIRED") window.location.replace("cambiar-password.html");
        else if (error.code === "PLATFORM_ACCESS_REQUIRED") window.location.replace("dashboard.html");
        else if (error.status === 401 || error.status === 403) window.location.replace("index.html");
        else return false;
        return true;
    };
    try {
        const user = await DentalApi.getCurrentUser();
        const platform = user?.role === "PLATFORM_SUPER_ADMIN" && user.scope === "PLATFORM" && user.organizationId === null;
        const tenant = user && user.role !== "PLATFORM_SUPER_ADMIN" && user.scope === "ORGANIZATION" && Boolean(user.organizationId);
        if (!platform && !tenant) { window.location.replace("index.html"); return; }
        if (user.mustChangePassword) { window.location.replace("cambiar-password.html"); return; }
        if (tenant) { window.location.replace("dashboard.html"); return; }
        el("identity").textContent = user.fullName || user.username;
        el("sessionMessage").hidden = true;
        el("detailApp").hidden = false;
    } catch (error) {
        if (!redirectError(error)) el("sessionMessage").textContent = "No fue posible verificar la sesión. Recarga para reintentar.";
        return;
    }
    el("logout").onclick = async () => {
        try { await DentalApi.logout(); window.location.replace("index.html"); }
        catch (error) { message("No fue posible cerrar la sesión. Intenta nuevamente.", true); }
    };
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        message("Selecciona una organización válida desde la lista de organizaciones.", true); return;
    }
    let organization = null, busy = false, ownerSaving = false, ownerLoading = false, ownerCandidates = [];
    const date = value => value ? new Date(value).toLocaleString("es-DO") : "-";
    const load = async success => {
        busy = true; el("refresh").disabled = true; el("toggleStatus").disabled = true; el("changeOwner").disabled = true;
        message("Cargando organización...");
        try {
            const data = await DentalApi.getPlatformOrganization(id);
            organization = data;
            if (typeof initializePlatformUsers === "function") initializePlatformUsers(data);
            for (const [key, value] of Object.entries({ organizationTitle: data.name, organizationName: data.name,
                organizationType: data.organizationType === "INDEPENDENT" ? "Independiente" : "Clínica",
                organizationStatus: data.active ? "Activa" : "Inactiva", organizationId: data.id,
                createdAt: date(data.createdAt), updatedAt: date(data.updatedAt),
                totalUsers: data.summary.totalUsers, activeUsers: data.summary.activeUsers, inactiveUsers: data.summary.inactiveUsers })) el(key).textContent = value;
            el("organizationStatus").className = data.active ? "active" : "inactive";
            el("changeOwner").textContent = data.owner ? "Cambiar propietario" : "Asignar propietario";
            el("ownerFields").hidden = !data.owner;
            el("ownerWarning").hidden = Boolean(data.owner);
            if (data.owner) {
                el("ownerName").textContent = data.owner.fullName;
                el("ownerUsername").textContent = data.owner.username;
                el("ownerRole").textContent = data.owner.role;
                el("ownerActive").textContent = data.owner.active ? "Activo" : "Inactivo";
            } else el("ownerWarning").textContent = data.ownerState === "UNAVAILABLE"
                ? "La referencia del propietario no está disponible o requiere revisión."
                : "Sin propietario asignado.";
            el("organizationContent").hidden = false;
            el("toggleStatus").hidden = false;
            el("toggleStatus").textContent = data.active ? "Desactivar organización" : "Activar organización";
            message(success || "");
        } catch (error) {
            organization = null; el("organizationContent").hidden = true; el("toggleStatus").hidden = true;
            if (!redirectError(error)) message(error.status === 404 ? "Organización no encontrada."
                : "No fue posible cargar la organización. Intenta nuevamente.", true);
        } finally { busy = false; el("refresh").disabled = false; el("toggleStatus").disabled = false; el("changeOwner").disabled = !organization; }
    };
    el("changeOwner").onclick = async () => {
        if (busy || ownerLoading || ownerSaving || !organization) return;
        ownerLoading = true; ownerCandidates = [];
        el("ownerCandidate").replaceChildren(); el("saveOwner").disabled = true;
        el("ownerDialogMessage").textContent = "Cargando candidatos..."; el("ownerDialog").showModal();
        try {
            const data = await DentalApi.getPlatformOrganizationUsers(id);
            const roles = organization.organizationType === "CLINIC" ? ["head_admin", "admin", "clinic_admin"]
                : organization.organizationType === "INDEPENDENT" ? ["owner_doctor"] : [];
            ownerCandidates = data.users.filter(user => user.active && roles.includes(user.role) && user.id !== data.ownerUserId);
            for (const user of ownerCandidates) {
                const option = document.createElement("option"); option.value = user.id;
                option.textContent = `${user.fullName} (${user.username}) · ${user.role}`; el("ownerCandidate").append(option);
            }
            el("saveOwner").disabled = !ownerCandidates.length;
            el("ownerDialogMessage").textContent = ownerCandidates.length ? "" : "No hay usuarios activos con un rol elegible para ser propietario.";
        } catch (error) {
            if (!redirectError(error)) el("ownerDialogMessage").textContent = "No fue posible cargar los candidatos. Cierra y vuelve a intentar.";
        } finally { ownerLoading = false; }
    };
    const closeOwner = () => { if (!ownerSaving && !ownerLoading) { ownerCandidates = []; el("ownerDialog").close(); } };
    el("cancelOwner").onclick = closeOwner;
    el("ownerDialog").oncancel = event => { event.preventDefault(); closeOwner(); };
    el("ownerForm").onsubmit = async event => {
        event.preventDefault();
        if (ownerSaving || ownerLoading || busy) return;
        const candidate = ownerCandidates.find(user => user.id === el("ownerCandidate").value);
        if (!candidate || !window.confirm(`Confirmar a ${candidate.fullName} (${candidate.username}) como propietario?`)) return;
        ownerSaving = true; el("saveOwner").disabled = true;
        try {
            await DentalApi.setPlatformOrganizationOwner(id, candidate.id);
            el("ownerDialog").close(); ownerCandidates = [];
            await load("Propietario actualizado correctamente.");
        } catch (error) {
            if (!redirectError(error)) el("ownerDialogMessage").textContent = error.status === 404 || error.status === 409
                ? "El usuario ya no está disponible o no cumple los requisitos. Cierra y actualiza los candidatos."
                : "No fue posible confirmar el cambio. Actualiza la organización antes de reintentar.";
        } finally { ownerSaving = false; el("saveOwner").disabled = !ownerCandidates.length; }
    };
    el("refresh").hidden = false;
    el("refresh").onclick = () => { if (!busy) return load(); };
    el("toggleStatus").onclick = async () => {
        if (busy || !organization) return;
        const active = !organization.active;
        if (!window.confirm(`${active ? "Activar" : "Desactivar"} ${organization.name}?${active ? "" : " Sus usuarios perderán el acceso mientras esté inactiva."}`)) return;
        busy = true; el("toggleStatus").disabled = true; el("refresh").disabled = true;
        try {
            await DentalApi.setPlatformOrganizationStatus(id, active);
            await load("Estado actualizado correctamente.");
        } catch (error) {
            if (!redirectError(error)) message("No fue posible cambiar el estado. Actualiza antes de reintentar.", true);
        } finally { busy = false; el("toggleStatus").disabled = false; el("refresh").disabled = false; }
    };
    await load();
}
document.addEventListener("DOMContentLoaded", startPlatformOrganization);
window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
