class UpdateService {
  async checkForUpdates() {
    return { available: false, channel: "local", message: "Actualizador preparado; sin proveedor remoto configurado." };
  }
}

class VersionManager {
  constructor(currentVersion) {
    this.currentVersion = currentVersion;
  }
}

class ReleaseChecker {
  async fetchLatestRelease() {
    return null;
  }
}

module.exports = { UpdateService, VersionManager, ReleaseChecker };
