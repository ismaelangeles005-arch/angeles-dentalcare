function validateStrongPassword(password) {
  if (typeof password !== "string" || password.length < 6 || password.length > 200) {
    return "La contrasena debe tener entre 6 y 200 caracteres";
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contrasena debe incluir al menos una letra y un numero";
  }

  return null;
}

module.exports = { validateStrongPassword };
