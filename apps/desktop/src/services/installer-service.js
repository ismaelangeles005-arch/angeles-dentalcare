class InstallerService {
  constructor(config) {
    this.config = config;
  }

  getInstallerMetadata() {
    return {
      productName: this.config.product.name,
      version: this.config.product.version,
      target: "windows"
    };
  }
}

module.exports = { InstallerService };
