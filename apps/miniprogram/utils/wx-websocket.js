/**
 * 微信小程序 WebSocket 适配器，使 wx.connectSocket 兼容标准 WebSocket 接口，
 * 供 MQTT over WebSocket 使用。
 */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function WxWebSocket(url) {
  this.url = url;
  this.readyState = CONNECTING;
  this._task = null;
  this._handlers = { open: null, message: null, error: null, close: null };
  this._connect();
}

WxWebSocket.prototype.send = function (data) {
  if (this.readyState !== OPEN || !this._task) return;
  this._task.send({ data: data });
};

WxWebSocket.prototype.close = function (code, reason) {
  if (this.readyState === CLOSED || this.readyState === CLOSING) return;
  this.readyState = CLOSING;
  if (this._task) {
    this._task.close({ code: code || 1000, reason: reason || '' });
    this._task = null;
  }
  this.readyState = CLOSED;
  if (this._handlers.close) this._handlers.close({ code: code, reason: reason });
};

Object.defineProperty(WxWebSocket.prototype, 'onopen', {
  get: function () { return this._handlers.open; },
  set: function (fn) { this._handlers.open = fn; }
});
Object.defineProperty(WxWebSocket.prototype, 'onmessage', {
  get: function () { return this._handlers.message; },
  set: function (fn) { this._handlers.message = fn; }
});
Object.defineProperty(WxWebSocket.prototype, 'onerror', {
  get: function () { return this._handlers.error; },
  set: function (fn) { this._handlers.error = fn; }
});
Object.defineProperty(WxWebSocket.prototype, 'onclose', {
  get: function () { return this._handlers.close; },
  set: function (fn) { this._handlers.close = fn; }
});

WxWebSocket.prototype._connect = function () {
  const self = this;
  const url = this.url.replace(/^mqtts?\:\/\//i, 'wss://').replace(/^ws:\/\//i, 'ws://');
  const wsUrl = url.startsWith('wss://') || url.startsWith('ws://') ? url : 'wss://' + url;
  const task = wx.connectSocket({
    url: wsUrl,
    fail: function (err) {
      self.readyState = CLOSED;
      if (self._handlers.error) self._handlers.error(err);
      if (self._handlers.close) self._handlers.close({ code: 1006, reason: err.errMsg || 'connect fail' });
    }
  });
  task.onOpen(function () {
    self.readyState = OPEN;
    self._task = task;
    if (self._handlers.open) self._handlers.open({});
  });
  task.onMessage(function (res) {
    if (self._handlers.message) {
      const data = res.data;
      self._handlers.message({ data: typeof data === 'string' ? data : (data && data.byteLength !== undefined ? data : String(data)) });
    }
  });
  task.onError(function (err) {
    if (self._handlers.error) self._handlers.error(err);
  });
  task.onClose(function (res) {
    self._task = null;
    self.readyState = CLOSED;
    if (self._handlers.close) self._handlers.close({ code: res.code, reason: res.reason });
  });
};

module.exports = WxWebSocket;
