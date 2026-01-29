const storage = require('../../utils/storage.js');
const { MqttClient } = require('../../utils/mqtt-client.js');
const { mdToNodes } = require('../../utils/md-render.js');

function replaceId(tpl, id) {
  if (!tpl || !id) return tpl || '';
  return tpl.replace(/\+\+/g, id).replace(/\{id\}/g, id).replace(/\+/g, id);
}

function timeText() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

const CONNECTION_STATE = { CONNECTED: 'connected', CONNECTING: 'connecting', ERROR: 'error', DISCONNECTED: 'disconnected' };
const CONNECTION_STATE_TEXT = {
  connected: '已连接',
  connecting: '连接中…',
  error: '连接错误',
  disconnected: '未连接',
};
const PENDING_REPLY_TIMEOUT_MS = 60000;

Page({
  data: {
    connected: false,
    connectionState: 'disconnected',
    connectionStateText: CONNECTION_STATE_TEXT.disconnected,
    messages: [],
    inputText: '',
    inputFocus: false,
    scrollToId: '',
    sending: false,
    pendingReply: false,
    lastError: '',
    configValid: false,
    replyTo: null,
    actionMessageId: null,
  },
  mqttClient: null,
  config: null,
  _lastConnectUrl: null,
  _pendingReplyTimer: null,

  onLoad() {
    this.loadConfig();
    if (!this.config) {
      wx.redirectTo({ url: '/pages/config/config' });
      return;
    }
    const cached = storage.loadChatMessages(this.config.clientId);
    const messages = (cached || []).map(function (m) {
      return Object.assign({}, m, { contentNodes: m.contentNodes || mdToNodes(m.content || '') });
    });
    this.setData({ configValid: true, messages });
    this.connect();
  },

  onShow() {
    if (!this.config) return;
    this.loadConfig();
    if (!this.config) return;
    if (this.mqttClient && this.config.brokerUrl !== this._lastConnectUrl) {
      this.disconnect();
    }
    if (!this.mqttClient && this.config) {
      this.connect();
    }
  },

  onUnload() {
    this._clearPendingReply();
    this.disconnect();
  },

  loadConfig() {
    let config = storage.load();
    if (!config || !config.brokerUrl || !config.clientId) {
      this.config = null;
      this.setData({ configValid: false });
      return;
    }
    if (!config.topicInResolved || !config.topicOutResolved) {
      config.topicInResolved = replaceId(config.topicIn || 'devices/+/in', config.clientId);
      config.topicOutResolved = replaceId(config.topicOut || 'devices/+/out', config.clientId);
      storage.save(config);
    }
    this.config = config;
    this.setData({ configValid: true });
  },

  toggleConnect() {
    if (this.data.connected) {
      this.disconnect();
    } else {
      this.connect();
    }
  },

  connect() {
    if (!this.config) {
      this.loadConfig();
      if (!this.config) return;
    }
    const cfg = this.config;
    this._lastConnectUrl = cfg.brokerUrl;
    this.setData({
      connectionState: CONNECTION_STATE.CONNECTING,
      connectionStateText: CONNECTION_STATE_TEXT.connecting,
      lastError: '',
    });
    const client = new MqttClient();
    this.mqttClient = client;

    client.on('connect', () => {
      storage.setLastConnectedBroker(cfg.brokerUrl);
      this.setData({
        connected: true,
        connectionState: CONNECTION_STATE.CONNECTED,
        connectionStateText: CONNECTION_STATE_TEXT.connected,
        lastError: '',
      });
      wx.showToast({ title: '已连接', icon: 'success' });
      client.subscribe(cfg.topicOutResolved, { qos: 1 }, (err) => {
        if (err) wx.showToast({ title: '订阅失败', icon: 'none' });
      });
    });

    client.on('message', (topic, payload) => {
      this._clearPendingReply();
      let text = payload;
      if (typeof payload === 'string') {
        try {
          const obj = JSON.parse(payload);
          text = obj.text != null ? obj.text : (obj.content != null ? obj.content : payload);
        } catch (e) {
          text = payload;
        }
      }
      const msgId = 'r-' + Date.now();
      const newMsg = {
        id: msgId,
        role: 'assistant',
        content: text,
        contentNodes: mdToNodes(text),
        timeText: timeText(),
      };
      const messages = this.data.messages.concat([newMsg]);
      this.setData({
        messages,
        scrollToId: 'msg-' + msgId,
      });
      storage.saveChatMessages(this.config.clientId, messages);
    });

    client.on('error', (err) => {
      const msg = (err && err.message) ? err.message : '连接错误';
      this.setData({
        connectionState: CONNECTION_STATE.ERROR,
        connectionStateText: CONNECTION_STATE_TEXT.error,
        lastError: msg,
      });
      wx.showToast({ title: msg, icon: 'none' });
    });

    client.on('close', () => {
      this.setData({
        connected: false,
        connectionState: CONNECTION_STATE.DISCONNECTED,
        connectionStateText: CONNECTION_STATE_TEXT.disconnected,
      });
      this.mqttClient = null;
    });

    client.connect(cfg.brokerUrl, {
      clientId: cfg.clientId + '-' + Date.now(),
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      keepalive: 60,
    });
    wx.showLoading({ title: '连接中...' });
    setTimeout(() => wx.hideLoading(), 8000);
  },

  _clearPendingReply() {
    if (this._pendingReplyTimer) {
      clearTimeout(this._pendingReplyTimer);
      this._pendingReplyTimer = null;
    }
    this.setData({ pendingReply: false });
  },

  _startPendingReply() {
    this._clearPendingReply();
    this.setData({ pendingReply: true, scrollToId: 'msg-pending' });
    this._pendingReplyTimer = setTimeout(() => {
      this._pendingReplyTimer = null;
      this.setData({ pendingReply: false });
    }, PENDING_REPLY_TIMEOUT_MS);
  },

  disconnect() {
    if (this.mqttClient) {
      this.mqttClient.end();
      this.mqttClient = null;
    }
    this.setData({
      connected: false,
      connectionState: CONNECTION_STATE.DISCONNECTED,
      connectionStateText: CONNECTION_STATE_TEXT.disconnected,
    });
  },

  dismissError() {
    this.setData({ lastError: '' });
  },

  retryConnect() {
    this.setData({ lastError: '' });
    this.connect();
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  onLongPressMessage(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ actionMessageId: id });
  },

  clearMessageActions() {
    if (this.data.actionMessageId) this.setData({ actionMessageId: null });
  },

  preventBubble() {},

  copyMessage(e) {
    const id = e.currentTarget.dataset.id;
    const msg = this.data.messages.find((m) => m.id === id);
    if (!msg) return;
    wx.setClipboardData({
      data: msg.content,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
    this.setData({ actionMessageId: null });
  },

  quoteMessage(e) {
    const id = e.currentTarget.dataset.id;
    const msg = this.data.messages.find((m) => m.id === id);
    if (!msg) return;
    const preview = msg.content.length > 40 ? msg.content.slice(0, 40) + '…' : msg.content;
    this.setData({
      replyTo: {
        id: msg.id,
        content: msg.content,
        role: msg.role,
        timeText: msg.timeText,
        preview,
      },
      actionMessageId: null,
    });
  },

  cancelReply() {
    this.setData({ replyTo: null });
  },

  send() {
    let text = (this.data.inputText || '').trim();
    if (!text) return;
    const replyTo = this.data.replyTo;
    if (replyTo) {
      const quoteLine = '> ' + replyTo.content.split(/\r?\n/).join('\n> ');
      text = quoteLine + '\n\n' + text;
      this.setData({ replyTo: null });
    }
    if (!this.data.connected || !this.mqttClient || !this.config) {
      this.setData({ lastError: '请先连接 MQTT' });
      return;
    }
    this.setData({ sending: true, inputText: '' });
    const messageId = 'mp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const payload = JSON.stringify({ messageId, text: text });
    const topicIn = this.config.topicInResolved;

    const userMsg = {
      id: 'u-' + messageId,
      role: 'user',
      content: text,
      contentNodes: mdToNodes(text),
      timeText: timeText(),
    };
    const messages = this.data.messages.concat([userMsg]);
    this.setData({
      messages,
      scrollToId: 'msg-u-' + messageId,
    });
    storage.saveChatMessages(this.config.clientId, messages);
    this._startPendingReply();

    this.mqttClient.publish(topicIn, payload, { qos: 1 }, (err) => {
      this.setData({ sending: false });
      if (err) {
        this._clearPendingReply();
        this.setData({ lastError: '发送失败' });
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    });
  },

  goConfig() {
    wx.navigateTo({ url: '/pages/config/config' });
  },
});
