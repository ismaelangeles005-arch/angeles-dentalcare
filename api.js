const DentalApi = (() => {
    const API_URL = localStorage.getItem("apiUrl") || "http://127.0.0.1:3001/api";

    function getToken() {
        return localStorage.getItem("sessionActive") || "";
    }

    async function request(path, options = {}) {
        const isFormData = options.body instanceof FormData;
        const headers = {
            ...(!isFormData ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        };

        const response = await fetch(`${API_URL}${path}`, {
            ...options,
            headers,
            credentials: "include"
        });

        if (response.status === 204) {
            return null;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            if (response.status === 401 && path !== "/auth/login") {
                clearSession();
                window.location.href = "index.html";
            }

            throw new Error(data.message || "Error de conexion con el servidor");
        }

        return data;
    }

    async function login(username, password) {
        const data = await request("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        localStorage.removeItem("token");
        localStorage.setItem("sessionActive", "true");
        localStorage.setItem("rol", data.user.role);
        localStorage.setItem("usuario", data.user.username);
        localStorage.setItem("organizationId", data.user.organizationId || "");
        localStorage.setItem("organizationName", data.user.organizationName || "");
        localStorage.setItem("organizationType", data.user.organizationType || "CLINIC");

        localStorage.setItem("mustChangePassword", data.user.mustChangePassword ? "true" : "false");

        if (data.user.doctor) {
            localStorage.setItem("doctor", data.user.doctor);
        }
        else {
            localStorage.removeItem("doctor");
        }

        return data.user;
    }


    async function pinLogin(pin) {
        const data = await request("/auth/pin-login", {
            method: "POST",
            body: JSON.stringify({
                pin,
                organizationId: localStorage.getItem("organizationId") || undefined
            })
        });

        localStorage.removeItem("token");
        localStorage.setItem("sessionActive", "true");
        localStorage.setItem("rol", data.user.role);
        localStorage.setItem("usuario", data.user.username || "");
        localStorage.setItem("organizationId", data.user.organizationId || data.user.organization_id || "");
        localStorage.setItem("organizationName", data.user.organizationName || "");
        localStorage.setItem("organizationType", data.user.organizationType || data.user.operating_mode || "CLINIC");
        localStorage.setItem("mustChangePassword", data.user.mustChangePassword ? "true" : "false");

        if (data.user.doctor || data.user.doctorId || data.user.doctor_id) {
            localStorage.setItem("doctor", data.user.doctor || data.user.doctorId || data.user.doctor_id);
        }
        else {
            localStorage.removeItem("doctor");
        }

        return data.user;
    }
    function clearSession() {
        localStorage.removeItem("token");
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
        try {
            await request("/auth/logout", { method: "POST" });
        }
        catch (error) {
            // Local session state is still cleared if the API is unavailable.
        }

        clearSession();
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

    function getProcedures(includeInactive = false) {
        const query = includeInactive ? "?includeInactive=true" : "";
        return request("/procedures" + query);
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
        getProcedures,
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













