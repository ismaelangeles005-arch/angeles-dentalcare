class BackupService {
  constructor(config) {
    this.config = config;
  }

  createBackup() {
    throw new Error("BackupService.createBackup queda preparado para la siguiente fase.");
  }

  restoreBackup() {
    throw new Error("BackupService.restoreBackup queda preparado para la siguiente fase.");
  }

  validateBackup() {
    throw new Error("BackupService.validateBackup queda preparado para la siguiente fase.");
  }
}

module.exports = { BackupService };
