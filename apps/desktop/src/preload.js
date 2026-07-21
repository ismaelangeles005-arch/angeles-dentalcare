const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("DentalDesktop", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getConfig: () => ipcRenderer.invoke("app:get-config")
});
