App({
  globalData: {
    mqttConfig: null,
  },
  onLaunch() {
    const config = wx.getStorageSync('mqttConfig');
    if (config && config.brokerUrl) {
      this.globalData.mqttConfig = config;
    }
  },
});
