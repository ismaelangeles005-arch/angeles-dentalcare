const initializePlatformUsers = (() => {
    let organization, initialized = false, loading = false, saving = false, resetUser = null, pinUser = null;
    const el = id => document.getElementById(id);
    const labels = { head_admin: "Administrador principal", admin: "Administrador", clinic_admin: "Administrador de clínica",
        doctor: "Doctor", owner_doctor: "Doctor administrador", recepcion: "Recepción", receptionist: "Recepcionista",
        assistant: "Asistente", independent_assistant: "Asistente independiente", cashier: "Caja" };
    const tell = text => { el("usersMessage").textContent = text; };
    const form = () => el("userForm");
    const field = name => form().elements.namedItem(name);
    function doctorFields() {
        const doctor = ["doctor", "owner_doctor"].includes(field("role").value);
        el("doctorFields").hidden = !doctor;
        field("doctorSpecialty").required = doctor;
        for (const name of ["doctorSpecialty", "doctorPhone", "doctorEmail"]) field(name).disabled = !doctor;
    }
    async function loadUsers(success) {
        if (loading) return;
        loading = true; el("refreshUsers").disabled = true; el("newUser").disabled = true; tell("Cargando usuarios...");
        try {
            const data = await DentalApi.getPlatformOrganizationUsers(organization.id);
            organization.ownerUserId = data.ownerUserId;
            organization.active = data.organizationActive;
            field("role").replaceChildren();
            for (const role of data.allowedRoles) {
                const option = document.createElement("option"); option.value = role; option.textContent = labels[role] || role; field("role").append(option);
            }
            el("newUser").disabled = !data.organizationActive || !data.allowedRoles.length;
            el("usersRows").replaceChildren();
            const cell = (row, text) => { const td = document.createElement("td"); td.textContent = text; row.append(td); return td; };
            for (const user of data.users) {
                const row = document.createElement("tr");
                cell(row, `${user.fullName} (${user.username})${user.id === data.ownerUserId ? " · Propietario" : ""}`);
                cell(row, labels[user.role] || user.role); cell(row, user.active ? "Activo" : "Inactivo");
                cell(row, user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("es-DO") : "Sin acceso registrado");
                cell(row, user.mustChangePassword ? "Cambio requerido" : "Normal");
                cell(row, `${user.pinConfigured ? "Configurado" : "No configurado"} / ${user.pinEnabled ? "Activo" : "Inactivo"}${user.pinConfigured ? (user.pinLocked ? " / Bloqueado" : " / Disponible") : ""}`);
                const actions = cell(row, "");
                const status = document.createElement("button"); status.type = "button"; status.textContent = user.active ? "Desactivar" : "Activar";
                status.disabled = user.active && user.id === data.ownerUserId;
                if (status.disabled) status.title = "No se puede desactivar al propietario actual";
                status.onclick = async () => {
                    if (saving || !window.confirm(`${status.textContent} a ${user.fullName}?`)) return;
                    saving = true; status.disabled = true;
                    try { await DentalApi.setPlatformOrganizationUserStatus(organization.id, user.id, !user.active); await loadUsers("Estado actualizado."); }
                    catch (error) { tell(error.message); status.disabled = user.active && user.id === data.ownerUserId; }
                    finally { saving = false; }
                };
                const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "Resetear contraseña";
                reset.onclick = () => { if (saving) return; resetUser = user; el("resetForm").reset(); el("resetError").textContent = ""; el("resetIdentity").textContent = `${user.fullName} (${user.username})`; el("resetDialog").showModal(); };
                actions.append(status, " ", reset);
                const pin = document.createElement("button"); pin.type = "button"; pin.textContent = user.pinConfigured ? "Cambiar PIN" : "Asignar PIN";
                pin.onclick = () => {
                    if (saving) return;
                    pinUser = user; el("pinForm").reset(); el("pinError").textContent = "";
                    el("pinTitle").textContent = pin.textContent; el("pinIdentity").textContent = `${user.fullName} (${user.username})`;
                    el("pinDialog").showModal();
                };
                actions.append(" ", pin);
                const securityAction = (label, operation) => {
                    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
                    button.onclick = async () => {
                        if (saving || !window.confirm(`${label}: ${user.fullName}?`)) return;
                        saving = true; button.disabled = true;
                        try { await operation(); await loadUsers("Seguridad del usuario actualizada."); }
                        catch (error) { tell(error.message); }
                        finally { saving = false; button.disabled = false; }
                    };
                    actions.append(" ", button);
                };
                if (user.pinConfigured) securityAction(user.pinEnabled ? "Desactivar PIN" : "Activar PIN",
                    () => DentalApi.setPlatformOrganizationUserPinStatus(organization.id, user.id, !user.pinEnabled));
                if (user.pinLocked) securityAction("Desbloquear PIN", () => DentalApi.unlockPlatformOrganizationUserPin(organization.id, user.id));
                securityAction("Forzar cambio de contraseña", () => DentalApi.forcePlatformOrganizationUserPasswordChange(organization.id, user.id));
                el("usersRows").append(row);
            }
            if (!data.users.length) { const row = document.createElement("tr"); cell(row, "Sin usuarios registrados").colSpan = 7; el("usersRows").append(row); }
            tell(success || (!data.organizationActive ? "Organización inactiva: la creación de usuarios está bloqueada." : ""));
        } catch (error) { el("usersRows").replaceChildren(); tell(error.message); }
        finally { loading = false; el("refreshUsers").disabled = false; }
    }
    return data => {
        organization = data;
        if (initialized) { if (!el("usersPanel").hidden) loadUsers(); return; }
        initialized = true;
        const show = users => {
            el("summaryPanel").hidden = users; el("usersPanel").hidden = !users;
            el("summaryTab").setAttribute("aria-selected", String(!users)); el("usersTab").setAttribute("aria-selected", String(users));
            if (users) loadUsers();
        };
        el("summaryTab").onclick = () => { show(false); el("refresh").click(); };
        el("usersTab").onclick = () => show(true);
        el("refreshUsers").onclick = () => loadUsers();
        el("newUser").onclick = () => { if (saving) return; form().reset(); doctorFields(); el("userError").textContent = ""; el("userDialog").showModal(); };
        field("role").onchange = doctorFields;
        for (const [dialog, cancel, formId] of [["userDialog", "cancelUser", "userForm"], ["resetDialog", "cancelReset", "resetForm"], ["pinDialog", "cancelPin", "pinForm"]]) {
            const close = () => { if (!saving) { el(formId).reset(); el(dialog).close(); resetUser = null; pinUser = null; } };
            el(cancel).onclick = close;
            el(dialog).addEventListener("cancel", event => { event.preventDefault(); close(); });
        }
        el("pinForm").onsubmit = async event => {
            event.preventDefault(); if (saving || !pinUser || !el("pinForm").reportValidity()) return;
            const pin = el("pinForm").elements.namedItem("pin"), confirmation = el("pinForm").elements.namedItem("confirmPin");
            if (!/^[0-9]{4}$/.test(pin.value) || pin.value !== confirmation.value) { el("pinError").textContent = "El PIN debe tener cuatro dígitos y coincidir con la confirmación."; return; }
            saving = true; el("savePin").disabled = true;
            try {
                await DentalApi.setPlatformOrganizationUserPin(organization.id, pinUser.id, pin.value, pinUser.pinConfigured ? pinUser.pinEnabled : true);
                el("pinForm").reset(); pinUser = null; el("pinDialog").close(); await loadUsers("PIN guardado y bloqueo reiniciado.");
            } catch (error) { el("pinError").textContent = error.message; }
            finally { pin.value = ""; confirmation.value = ""; saving = false; el("savePin").disabled = false; }
        };
        form().onsubmit = async event => {
            event.preventDefault(); if (saving || !form().reportValidity()) return;
            saving = true; el("saveUser").disabled = true;
            const payload = {};
            for (const name of ["fullName", "username", "password", "role", "doctorSpecialty", "doctorPhone", "doctorEmail"]) if (!field(name).disabled) payload[name] = field(name).value;
            try { await DentalApi.createPlatformOrganizationUser(organization.id, payload); form().reset(); el("userDialog").close(); await loadUsers("Usuario creado. Debe cambiar su contraseña al iniciar sesión."); }
            catch (error) { el("userError").textContent = error.message; }
            finally { payload.password = ""; field("password").value = ""; saving = false; el("saveUser").disabled = false; }
        };
        el("resetForm").onsubmit = async event => {
            event.preventDefault(); if (saving || !resetUser || !el("resetForm").reportValidity()) return;
            saving = true; el("saveReset").disabled = true;
            const password = el("resetForm").elements.namedItem("password");
            try { await DentalApi.resetPlatformOrganizationUserPassword(organization.id, resetUser.id, password.value); el("resetDialog").close(); resetUser = null; await loadUsers("Contraseña temporal actualizada. Cambio obligatorio en el próximo acceso."); }
            catch (error) { el("resetError").textContent = error.message; }
            finally { password.value = ""; saving = false; el("saveReset").disabled = false; }
        };
    };
})();
