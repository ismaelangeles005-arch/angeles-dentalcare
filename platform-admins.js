async function startPlatformAdmins() {
    const el = id => document.getElementById(id);
    const message = (text, error = false) => { el('message').textContent = text; el('message').dataset.error = String(error); };
    const authError = error => {
        if (error.code === 'PASSWORD_CHANGE_REQUIRED') window.location.replace('cambiar-password.html');
        else if (error.status === 401 || error.status === 403) window.location.replace('index.html');
        else return false;
        return true;
    };
    let actor, busy = false, saving = false, target = null;
    try {
        actor = await DentalApi.getCurrentUser();
        const platform = actor?.role === 'PLATFORM_SUPER_ADMIN' && actor.scope === 'PLATFORM' && actor.organizationId === null;
        const tenant = actor && actor.role !== 'PLATFORM_SUPER_ADMIN' && actor.scope === 'ORGANIZATION' && Boolean(actor.organizationId);
        if (!platform && !tenant) { window.location.replace('index.html'); return; }
        if (actor.mustChangePassword) { window.location.replace('cambiar-password.html'); return; }
        if (tenant) { window.location.replace('dashboard.html'); return; }
    } catch (error) { if (!authError(error)) el('sessionMessage').textContent = 'No fue posible verificar la sesión. Recarga para reintentar.'; return; }
    el('sessionMessage').hidden = true; el('adminsApp').hidden = false; el('identity').textContent = actor.fullName || actor.username;
    const open = user => {
        if (busy || saving) return;
        target = user; el('adminForm').reset(); el('formError').textContent = '';
        el('dialogTitle').textContent = user ? `Resetear contraseña: ${user.username}` : 'Crear Super Admin';
        for (const name of ['fullName', 'username']) el(name).disabled = Boolean(user);
        el('nameLabel').hidden = el('usernameLabel').hidden = Boolean(user); el('adminDialog').showModal();
    };
    const load = async success => {
        busy = true; el('refresh').disabled = true; el('createAdmin').disabled = true;
        message('Cargando Super Admins...'); el('adminRows').replaceChildren();
        try {
            const data = await DentalApi.getPlatformAdmins();
            const date = value => value ? new Date(value).toLocaleString('es-DO') : '-';
            for (const user of data.admins) {
                const row = document.createElement('tr');
                const cell = text => { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; };
                cell(`${user.fullName}${user.id === actor.id ? ' · Tú' : ''}`).className = user.id === actor.id ? 'admin-current' : '';
                cell(user.username); cell(user.active ? 'Activo' : 'Inactivo').className = user.active ? 'admin-active' : 'admin-inactive';
                cell(date(user.lastLoginAt)); cell(user.mustChangePassword ? 'Sí' : 'No'); cell(date(user.createdAt));
                const actions = cell('');
                const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; actions.append(b); };
                const mutate = async (label, operation, selfForce = false) => {
                    if (busy || saving || !window.confirm(`${label}: ${user.fullName}?`)) return;
                    saving = true;
                    try { await operation(); if (selfForce) window.location.replace('cambiar-password.html'); else await load('Cambio guardado.'); }
                    catch (error) { if (!authError(error)) message('No fue posible guardar el cambio. Actualiza antes de reintentar.', true); }
                    finally { saving = false; }
                };
                if (user.id !== actor.id) {
                    button(user.active ? 'Desactivar' : 'Activar', () => mutate(user.active ? 'Desactivar' : 'Activar', () => DentalApi.setPlatformAdminStatus(user.id, !user.active)));
                    button('Resetear contraseña', () => open(user));
                }
                button('Forzar cambio de contraseña', () => mutate('Forzar cambio de contraseña', () => DentalApi.forcePlatformAdminPasswordChange(user.id), user.id === actor.id));
                el('adminRows').append(row);
            }
            message(success || (data.admins.length ? '' : 'Sin Super Admins registrados.'));
        } catch (error) { if (!authError(error)) message('No fue posible cargar los Super Admins. Intenta nuevamente.', true); }
        finally { busy = false; el('refresh').disabled = false; el('createAdmin').disabled = false; }
    };
    el('refresh').onclick = () => { if (!busy && !saving) return load(); };
    el('createAdmin').onclick = () => open(null);
    const close = () => { if (!saving) { el('adminForm').reset(); target = null; el('adminDialog').close(); } };
    el('cancelAdmin').onclick = close; el('adminDialog').oncancel = event => { event.preventDefault(); close(); };
    el('adminForm').onsubmit = async event => {
        event.preventDefault(); if (busy || saving || !el('adminForm').reportValidity()) return;
        saving = true; el('saveAdmin').disabled = true;
        try {
            if (target) await DentalApi.resetPlatformAdminPassword(target.id, el('password').value);
            else await DentalApi.createPlatformAdmin({ fullName: el('fullName').value, username: el('username').value, password: el('password').value });
            el('password').value = ''; el('adminDialog').close(); target = null;
            await load('Guardado. Se requiere cambio de contraseña en el próximo acceso.');
        } catch (error) {
            if (!authError(error)) el('formError').textContent = error.status === 409 ? 'El usuario ya existe o la operación no está permitida.' : 'No fue posible guardar. Revisa los datos y vuelve a intentar.';
        } finally { el('password').value = ''; saving = false; el('saveAdmin').disabled = false; }
    };
    el('logout').onclick = async () => { if (saving) return; try { await DentalApi.logout(); window.location.replace('index.html'); } catch (error) { message('No fue posible cerrar sesión. Reintenta.', true); } };
    await load();
}
document.addEventListener('DOMContentLoaded', startPlatformAdmins);
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
