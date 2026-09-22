const DentalApi = (() => {
    const API_URL = localStorage.getItem("apiUrl") || "http://127.0.0.1:3001/api";
    let sessionVerified = false;

    function getToken() {
        return sessionVerified ? "true" : "";
    }

    function normalizeRole(role) {
        const aliases = {
            owner_doctor: "head_admin",
            clinic_admin: "admin",
            receptionist: "recepcion",
            independent_assistant: "recepcion",
            assistant: "recepcion",
            cashier: "recepcion"
        };
        return ["head_admin", "admin", "doctor", "recepcion"].includes(role)
            ? role : (Object.prototype.hasOwnProperty.call(aliases, role) ? aliases[role] : "");
    }

    function storeSession(user) {
        if (!user || !user.id || !normalizeRole(user.role)) {
            throw new Error("No fue posible validar el acceso de esta cuenta.");
        }
        clearSession();
        sessionVerified = true;
        localStorage.setItem("sessionActive", "true");
        localStorage.setItem("userRole", user.role);
        localStorage.setItem("rol", normalizeRole(user.role));
        localStorage.setItem("usuario", user.username || "");
        localStorage.setItem("organizationId", user.organizationId || "");
        localStorage.setItem("organizationName", user.organizationName || "");
        localStorage.setItem("organizationType", user.organizationType || "CLINIC");
        localStorage.setItem("mustChangePassword", user.mustChangePassword ? "true" : "false");
        if (user.doctor) localStorage.setItem("doctor", user.doctor);
        return user;
    }

    async function getCurrentUser() {
        // A failed logout must not silently restore the remaining HttpOnly cookie.
        if (localStorage.getItem("logoutPending") === "true") {
            await request("/auth/logout", { method: "POST" });
            localStorage.removeItem("logoutPending");
            clearSession();
            const error = new Error("Inicia sesión para continuar.");
            error.status = 401;
            throw error;
        }
        const data = await request("/auth/me", { cache: "no-store" });
        return storeSession(data.user);
    }

    function ensureSessionNotClosing(path) {
        if (localStorage.getItem("logoutPending") === "true" &&
            !["/auth/login", "/auth/pin-login", "/auth/logout"].includes(path)) {
            clearSession();
            window.location.href = "index.html";
            const error = new Error("Inicia sesión para continuar.");
            error.status = 401;
            throw error;
        }
    }

    async function request(path, options = {}) {
        ensureSessionNotClosing(path);
        const isFormData = options.body instanceof FormData;
        const headers = {
            ...(!isFormData ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        };

        let response;
        const controller = new AbortController();
        const timeout = path.startsWith("/auth/")
            ? window.setTimeout(() => controller.abort(), 15000) : null;
        try {
            response = await fetch(`${API_URL}${path}`, {
                ...options,
                headers,
                credentials: "include",
                signal: options.signal || controller.signal
            });
        }
        catch (error) {
            throw new Error("No fue posible conectar con el servidor. Intenta nuevamente.");
        }
        finally {
            if (timeout !== null) window.clearTimeout(timeout);
        }

        if (response.status === 204) {
            return null;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const credentialRequest = ["/auth/login", "/auth/pin-login"].includes(path);
            const incorrectCurrentPassword = path === "/auth/change-password" && data.code === "INVALID_CURRENT_PASSWORD";
            if (response.status === 401 && !credentialRequest && !incorrectCurrentPassword && path !== "/auth/me") {
                clearSession();
                window.location.href = "index.html";
            }
            if (response.status === 403 && data.code === "PASSWORD_CHANGE_REQUIRED") {
                localStorage.setItem("mustChangePassword", "true");
                window.location.href = "cambiar-password.html";
            }
            const message = response.status >= 500
                ? "No fue posible completar la solicitud. Intenta nuevamente."
                : credentialRequest && response.status === 401
                    ? "Credenciales incorrectas. Intenta nuevamente."
                    : data.message || "No fue posible completar la solicitud.";
            const error = new Error(message);
            error.status = response.status;
            error.code = data.code;
            throw error;
        }

        return data;
    }

    async function login(username, password) {
        const data = await request("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        localStorage.removeItem("logoutPending");
        return storeSession(data.user);
    }


    async function pinLogin(pin) {
        const data = await request("/auth/pin-login", {
            method: "POST",
            body: JSON.stringify({
                pin,
                organizationId: localStorage.getItem("organizationId") || undefined
            })
        });

        localStorage.removeItem("logoutPending");
        return storeSession(data.user);
    }
    function clearSession() {
        sessionVerified = false;
        localStorage.removeItem("token");
        localStorage.removeItem("userRole");
        localStorage.removeItem("mustChangePassword");
        localStorage.removeItem("sessionActive");
        localStorage.removeItem("rol");
        localStorage.removeItem("doctor");
        localStorage.removeItem("usuario");
        localStorage.removeItem("organizationId");
        localStorage.removeItem("organizationName");
        localStorage.removeItem("organizationType");
        localStorage.removeItem("pacientes");
        localStorage.removeItem("citas");
    }

    async function logout() {
        localStorage.setItem("logoutPending", "true");
        clearSession();
        try {
            await request("/auth/logout", { method: "POST" });
            localStorage.removeItem("logoutPending");
            return true;
        }
        catch (error) {
            return false;
        }
    }

    async function changePassword(currentPassword, newPassword) {
        await request("/auth/change-password", {
            method: "POST",
            body: JSON.stringify({ currentPassword, newPassword })
        });
        localStorage.setItem("mustChangePassword", "false");
    }

    function getDoctors() {
        return request("/doctors");
    }

    function createDoctor(doctor) {
        return request("/doctors", {
            method: "POST",
            body: JSON.stringify(doctor)
        });
    }

    function getUsers() {
        return request("/users");
    }

    function createUser(user) {
        return request("/users", {
            method: "POST",
            body: JSON.stringify(user)
        });
    }

    function updateUserStatus(id, active) {
        return request(`/users/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ active })
        });
    }

    function resetUserPassword(id, password) {
        return request(`/users/${id}/password`, {
            method: "PATCH",
            body: JSON.stringify({ password })
        });
    }

    function setUserPin(id, pin, confirmPin, enabled = true) {
        return request(`/users/${id}/pin`, {
            method: "PATCH",
            body: JSON.stringify({ pin, confirmPin, enabled })
        });
    }

    function updateUserPinStatus(id, enabled) {
        return request(`/users/${id}/pin/status`, {
            method: "PATCH",
            body: JSON.stringify({ enabled })
        });
    }

    function deleteUser(id) {
        return request(`/users/${id}`, {
            method: "DELETE"
        });
    }

    function getPatients() {
        return request("/patients");
    }

    function createPatient(patient) {
        return request("/patients", {
            method: "POST",
            body: JSON.stringify(patient)
        });
    }

    function assignPatient(id, doctorId) {
        return request(`/patients/${id}/assign`, {
            method: "PATCH",
            body: JSON.stringify({ doctorId })
        });
    }

    function claimPatient(id) {
        return request(`/patients/${id}/claim`, {
            method: "PATCH"
        });
    }

    function assignPatientToMe(id) {
        return request(`/patients/${id}/assign-to-me`, {
            method: "PATCH"
        });
    }

    function updatePatientStatus(id, status) {
        return request(`/patients/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status })
        });
    }

    function updatePatientType(id, patientType) {
        return request(`/patients/${id}/type`, {
            method: "PATCH",
            body: JSON.stringify({ patientType })
        });
    }

    function updatePatientClassification(id, classification, observation) {
        return request(`/patients/${id}/classification`, {
            method: "PATCH",
            body: JSON.stringify({ classification, observation })
        });
    }

    function updatePatientMedicalConditions(id, conditions) {
        return request(`/patients/${id}/medical-conditions`, {
            method: "PUT",
            body: JSON.stringify({ conditions })
        });
    }

    function deletePatient(id) {
        return request(`/patients/${id}`, {
            method: "DELETE"
        });
    }

    function getPatientFiles(patientId) {
        return request(`/patients/${patientId}/files`);
    }

    function uploadPatientFile(patientId, formData) {
        return request(`/patients/${patientId}/files`, {
            method: "POST",
            body: formData
        });
    }

    async function downloadPatientFile(patientId, fileId, name) {
        ensureSessionNotClosing("/patients/files");
        const response = await fetch(
            `${API_URL}/patients/${patientId}/files/${fileId}/download`,
            { credentials: "include" }
        );

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.message || "No se pudo descargar el archivo");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name || "archivo";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async function viewPatientFile(patientId, fileId) {
        ensureSessionNotClosing("/patients/files");
        const response = await fetch(
            `${API_URL}/patients/${patientId}/files/${fileId}/view`,
            { credentials: "include" }
        );

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.message || "No se pudo abrir el archivo");
        }

        return {
            blob: await response.blob(),
            type: response.headers.get("Content-Type") || ""
        };
    }

    function deletePatientFile(patientId, fileId) {
        return request(`/patients/${patientId}/files/${fileId}`, {
            method: "DELETE"
        });
    }

    function getNotifications() {
        return request("/notifications");
    }

    function markNotificationRead(id) {
        return request(`/notifications/${id}/read`, { method: "PATCH" });
    }

    function markAllNotificationsRead() {
        return request("/notifications/read-all", { method: "PATCH" });
    }

    function getAuditLogs() {
        return request("/audit-logs");
    }

    function getAvailability(doctorId = "") {
        const query = doctorId ? `?doctorId=${encodeURIComponent(doctorId)}` : "";
        return request(`/availability${query}`);
    }

    function saveAvailability(rule) {
        return request("/availability", {
            method: "POST",
            body: JSON.stringify(rule)
        });
    }

    function deleteAvailability(id) {
        return request(`/availability/${id}`, {
            method: "DELETE"
        });
    }

    function getClinicalNotes(filters = {}) {
        const params = new URLSearchParams();

        if (filters.patientId) {
            params.set("patientId", filters.patientId);
        }

        if (filters.appointmentId) {
            params.set("appointmentId", filters.appointmentId);
        }

        if (filters.type) {
            params.set("type", filters.type);
        }

        const query = params.toString() ? `?${params.toString()}` : "";
        return request(`/clinical-notes${query}`);
    }

    function createClinicalNote(note) {
        return request("/clinical-notes", {
            method: "POST",
            body: JSON.stringify(note)
        });
    }

    function getPatientOdontogramCurrent(patientId) {
        return request(`/odontogram/patient/${patientId}/current`);
    }

    function createOdontogramEntry(entry) {
        return request("/odontogram", {
            method: "POST",
            body: JSON.stringify(entry)
        });
    }

    function updateOdontogramEntryStatus(id, status, reason) {
        return request(`/odontogram/${encodeURIComponent(id)}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status, reason })
        });
    }

    function correctOdontogramEntry(id, reason, entry) {
        return request(`/odontogram/${encodeURIComponent(id)}/correct`, {
            method: "POST",
            body: JSON.stringify({ ...entry, reason })
        });
    }

    function getProcedures(includeInactive = false) {
        const query = includeInactive ? "?includeInactive=true" : "";
        return request("/procedures" + query);
    }

    function getPatientTreatmentPlans(patientId) {
        return request(`/treatment-plans/patient/${encodeURIComponent(patientId)}`);
    }

    function getTreatmentPlan(planId) {
        return request(`/treatment-plans/${encodeURIComponent(planId)}`);
    }

    function createTreatmentPlan(plan) {
        return request("/treatment-plans", { method: "POST", body: JSON.stringify(plan) });
    }

    function addTreatmentPlanItem(planId, item) {
        return request(`/treatment-plans/${encodeURIComponent(planId)}/items`, { method: "POST", body: JSON.stringify(item) });
    }

    function presentTreatmentPlan(planId) {
        return request(`/treatment-plans/${encodeURIComponent(planId)}/status`, { method: "PATCH", body: JSON.stringify({ status: "PRESENTED" }) });
    }

    function createTreatmentPlanAcceptance(planId, acceptance) {
        return request(`/treatment-plans/${encodeURIComponent(planId)}/acceptance`, { method: "POST", body: JSON.stringify(acceptance) });
    }

    function decideTreatmentPlanItem(planId, itemId, status) {
        return request(`/treatment-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    }

    function createProcedure(procedure) {
        return request("/procedures", {
            method: "POST",
            body: JSON.stringify(procedure)
        });
    }

    function updateProcedure(id, procedure) {
        return request("/procedures/" + id, {
            method: "PATCH",
            body: JSON.stringify(procedure)
        });
    }

    function getBillingEstimates() {
        return request("/billing/estimates");
    }

    function getBillingEstimate(id) {
        return request("/billing/estimates/" + id);
    }

    function createBillingEstimate(estimate) {
        return request("/billing/estimates", {
            method: "POST",
            body: JSON.stringify(estimate)
        });
    }

    function updateBillingEstimateStatus(id, status) {
        return request("/billing/estimates/" + id + "/status", {
            method: "PATCH",
            body: JSON.stringify({ status })
        });
    }

    function addBillingPayment(id, payment) {
        return request("/billing/estimates/" + id + "/payments", {
            method: "POST",
            body: JSON.stringify(payment)
        });
    }

    function getAppointments() {
        return request("/appointments");
    }

    function createAppointment(appointment) {
        return request("/appointments", {
            method: "POST",
            body: JSON.stringify(appointment)
        });
    }

    function updateAppointmentStatus(id, status) {
        return request(`/appointments/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status })
        });
    }

    function deleteAppointment(id) {
        return request(`/appointments/${id}`, {
            method: "DELETE"
        });
    }

    return {
        API_URL,
        request,
        login,
        pinLogin,
        logout,
        clearSession,
        getToken,
        getCurrentUser,
        normalizeRole,
        changePassword,
        getDoctors,
        createDoctor,
        getUsers,
        createUser,
        updateUserStatus,
        resetUserPassword,
        setUserPin,
        updateUserPinStatus,
        deleteUser,
        getPatients,
        createPatient,
        assignPatient,
        claimPatient,
        assignPatientToMe,
        updatePatientStatus,
        updatePatientType,
        updatePatientClassification,
        updatePatientMedicalConditions,
        deletePatient,
        getPatientFiles,
        uploadPatientFile,
        downloadPatientFile,
        viewPatientFile,
        deletePatientFile,
        getNotifications,
        markNotificationRead,
        markAllNotificationsRead,
        getAuditLogs,
        getAvailability,
        saveAvailability,
        deleteAvailability,
        getClinicalNotes,
        createClinicalNote,
        getPatientOdontogramCurrent,
        createOdontogramEntry,
        updateOdontogramEntryStatus,
        correctOdontogramEntry,
        getProcedures,
        getPatientTreatmentPlans,
        getTreatmentPlan,
        createTreatmentPlan,
        addTreatmentPlanItem,
        presentTreatmentPlan,
        createTreatmentPlanAcceptance,
        decideTreatmentPlanItem,
        createProcedure,
        updateProcedure,
        getBillingEstimates,
        getBillingEstimate,
        createBillingEstimate,
        updateBillingEstimateStatus,
        addBillingPayment,
        getAppointments,
        createAppointment,
        updateAppointmentStatus,
        deleteAppointment
    };
})();













