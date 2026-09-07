const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("managerLogin", {
  context: () => ipcRenderer.invoke("manager:login-context"),
  login: (credentials) => ipcRenderer.invoke("manager:login", credentials),
  selectAccount: (selection) =>
    ipcRenderer.invoke("manager:select-account", selection),
});
