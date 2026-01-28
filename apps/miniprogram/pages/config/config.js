const storage = require('../../utils/storage.js');
const { MqttClient } = require('../../utils/mqtt-client.js');

function replaceId(tpl, id) {
  if (!tpl || !id) return tpl || '';
  return tpl.replace(/\+\+/g, id).replace(/\{id\}/g, id).replace(/\+/g, id);
}

function brokerHostLabel(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = url.replace(/^wss?:\/\//i, '').split('/')[0] || '';
    return u.split(':')[0] || u;
  } catch (e) {
    return url.slice(0, 40);
  }
}

const TEST_TIMEOUT_MS = 15000;
const VERSION = '0.1.0';

// 默认 MQTT 配置（百度 IoT）
const DEFAULT_BROKER_URL = 'wss://bdiot.iot.gz.baidubce.com:443/mqtt';
const DEFAULT_USERNAME = '';
const DEFAULT_PASSWORD = '';

Page({
  data: {
    brokerUrl: DEFAULT_BROKER_URL,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    clientId: '',
    topicIn: 'devices/+/in',
    topicOut: 'devices/+/out',
    testing: false,
    lastConnectedBroker: '',
    version: VERSION,
  },
  _testClient: null,
  _testTimeout: null,
  onLoad() {
    const config = storage.load();
    const draft = storage.loadConfigDraft();
    const lastBroker = storage.getLastConnectedBroker();
    const source = config && config.brokerUrl ? config : (draft || {});
    this.setData({
      brokerUrl: (source.brokerUrl && source.brokerUrl.trim()) || DEFAULT_BROKER_URL,
      username: source.username != null && source.username !== '' ? source.username : DEFAULT_USERNAME,
      password: source.password != null ? source.password : DEFAULT_PASSWORD,
      clientId: (source.clientId && source.clientId.trim()) || '',
      topicIn: (source.topicIn && source.topicIn.trim()) || 'devices/+/in',
      topicOut: (source.topicOut && source.topicOut.trim()) || 'devices/+/out',
      lastConnectedBroker: lastBroker ? brokerHostLabel(lastBroker) : '',
      version: VERSION,
    });
  },
  onHide() {
    storage.saveConfigDraft({
      brokerUrl: this.data.brokerUrl,
      username: this.data.username,
      password: this.data.password,
      clientId: this.data.clientId,
      topicIn: this.data.topicIn,
      topicOut: this.data.topicOut,
    });
  },
  onUnload() {
    storage.saveConfigDraft({
      brokerUrl: this.data.brokerUrl,
      username: this.data.username,
      password: this.data.password,
      clientId: this.data.clientId,
      topicIn: this.data.topicIn,
      topicOut: this.data.topicOut,
    });
    if (this._testTimeout) {
      clearTimeout(this._testTimeout);
      this._testTimeout = null;
    }
    if (this._testClient) {
      this._testClient.end();
      this._testClient = null;
    }
  },
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },
  save() {
    const { brokerUrl, clientId, topicIn, topicOut, username, password } = this.data;
    if (!brokerUrl || !clientId) {
      wx.showToast({ title: '请填写 Broker 地址和客户端 ID', icon: 'none' });
      return false;
    }
    const topicInResolved = replaceId(topicIn, clientId);
    const topicOutResolved = replaceId(topicOut, clientId);
    const config = {
      brokerUrl: brokerUrl.trim(),
      username: (username || '').trim(),
      password: (password || '').trim(),
      clientId: clientId.trim(),
      topicIn: topicIn.trim(),
      topicOut: topicOut.trim(),
      topicInResolved,
      topicOutResolved,
    };
    storage.save(config);
    storage.clearConfigDraft();
    getApp().globalData.mqttConfig = config;
    return true;
  },

  saveAndBack() {
    if (!this.save()) return;
    wx.showToast({ title: '已保存', icon: 'success' });
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.redirectTo({ url: '/pages/chat/chat' });
    }
  },
  openDoc() {
    wx.setClipboardData({
      data: 'https://github.com/moltbot/moltbot/tree/main/extensions/mqtt',
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    });
  },

  testConnect() {
    const { brokerUrl, username, password } = this.data;
    const url = (brokerUrl || '').trim();
    if (!url) {
      wx.showToast({ title: '请填写 Broker 地址', icon: 'none' });
      return;
    }
    if (this.data.testing) return;
    this.setData({ testing: true });
    wx.showLoading({ title: '连接测试中...' });

    const self = this;
    const done = (success, msg) => {
      if (self._testTimeout) {
        clearTimeout(self._testTimeout);
        self._testTimeout = null;
      }
      if (self._testClient) {
        self._testClient.end();
        self._testClient = null;
      }
      self.setData({ testing: false });
      wx.hideLoading();
      wx.showToast({ title: msg, icon: success ? 'success' : 'none', duration: success ? 2000 : 3000 });
    };

    const client = new MqttClient();
    this._testClient = client;

    client.on('connect', () => {
      done(true, '连接成功');
    });
    client.on('error', (err) => {
      const msg = (err && err.message) ? err.message : String(err);
      done(false, '连接失败: ' + (msg.length > 30 ? msg.slice(0, 30) + '…' : msg));
    });
    client.on('close', () => {});

    client.connect(url, {
      clientId: 'test-' + Date.now(),
      username: (username || '').trim() || undefined,
      password: (password || '').trim() || undefined,
      keepalive: 60,
    });

    this._testTimeout = setTimeout(() => {
      if (this._testClient) {
        done(false, '连接超时，请检查地址与网络');
      }
    }, TEST_TIMEOUT_MS);
  },

});
