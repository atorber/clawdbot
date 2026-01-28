/**
 * 最小 MQTT 3.1.1 over WebSocket 客户端，用于微信小程序。
 * 仅支持 CONNECT、SUBSCRIBE、PUBLISH 与接收 PUBLISH，与 Gateway MQTT channel 协议兼容。
 */
const WxWebSocket = require('./wx-websocket.js');

const CMD_CONNECT = 1;
const CMD_PUBLISH = 3;
const CMD_SUBSCRIBE = 8;

function encodeLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}

function encodeUtf8(str) {
  const utf8 = unescape(encodeURIComponent(str));
  const len = utf8.length;
  return [len >> 8, len & 0xff].concat([].map.call(utf8, function (c) { return c.charCodeAt(0); }));
}

function buildConnect(opts) {
  const clientId = opts.clientId || 'miniprogram-' + Math.random().toString(36).slice(2, 10);
  const username = opts.username || '';
  const password = opts.password || '';
  const keepalive = opts.keepalive || 60;

  const payload = [];
  payload.push.apply(payload, encodeUtf8(clientId));
  if (username) {
    payload.push.apply(payload, encodeUtf8(username));
    payload.push.apply(payload, encodeUtf8(password));
  }

  const varHeader = [];
  varHeader.push(0, 4, 77, 81, 84, 84); // "MQTT" length 4
  varHeader.push(4); // level 3.1.1
  varHeader.push(username ? 0xc2 : 0x02); // flags: clean session=1, user=1 pass=1 if present
  varHeader.push(keepalive >> 8, keepalive & 0xff);

  const payloadBytes = payload.map(function (x) { return x & 0xff; });
  const len = varHeader.length + payloadBytes.length;
  const fixed = [0x10].concat(encodeLength(len));
  return new Uint8Array(fixed.concat(varHeader).concat(payloadBytes));
}

function buildSubscribe(topic, qos, packetId) {
  const topicBytes = [].map.call(unescape(encodeURIComponent(topic)), function (c) { return c.charCodeAt(0); });
  const topicLen = topicBytes.length;
  const payload = [topicLen >> 8, topicLen & 0xff].concat(topicBytes).concat([qos || 0]);
  const len = 2 + payload.length;
  const fixed = [0x82].concat(encodeLength(len));
  return new Uint8Array(fixed.concat([packetId >> 8, packetId & 0xff]).concat(payload));
}

function buildPublish(topic, payload, qos, packetId) {
  const topicBytes = [].map.call(unescape(encodeURIComponent(topic)), function (c) { return c.charCodeAt(0); });
  const topicLen = topicBytes.length;
  let varHeader = [topicLen >> 8, topicLen & 0xff].concat(topicBytes);
  if (qos > 0 && packetId) {
    varHeader = varHeader.concat([packetId >> 8, packetId & 0xff]);
  }
  const payloadArr = typeof payload === 'string'
    ? [].map.call(unescape(encodeURIComponent(payload)), function (c) { return c.charCodeAt(0); })
    : Array.from(new Uint8Array(payload));
  const len = varHeader.length + payloadArr.length;
  const fixed = [0x30 + (qos << 1)].concat(encodeLength(len));
  return new Uint8Array(fixed.concat(varHeader).concat(payloadArr));
}

/** QoS 1 收到 PUBLISH 后必须回 PUBACK，否则 broker 会重复投递。 */
function buildPuback(packetId) {
  return new Uint8Array([0x40, 2, packetId >> 8, packetId & 0xff]);
}

function parseRemainingLength(buf, start) {
  let n = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    n += (buf[i] & 0x7f) << shift;
    if ((buf[i] & 0x80) === 0) return { len: n, next: i + 1 };
    shift += 7;
    i++;
    if (i - start > 4) return null;
  }
  return null;
}

function parseUtf8Ret(buf, offset) {
  if (offset + 2 > buf.length) return null;
  const len = buf[offset] * 256 + buf[offset + 1];
  if (offset + 2 + len > buf.length) return null;
  const bytes = buf.slice(offset + 2, offset + 2 + len);
  const str = String.fromCharCode.apply(null, bytes);
  try {
    return { str: decodeURIComponent(escape(str)), offset: offset, length: 2 + len };
  } catch (e) {
    return { str: str, offset: offset, length: 2 + len };
  }
}

function parsePublishCorrect(buf) {
  if (buf.length < 2) return null;
  const rl = parseRemainingLength(buf, 1);
  if (!rl) return null;
  const topicRet = parseUtf8Ret(buf, rl.next);
  if (!topicRet) return null;
  const topic = topicRet.str;
  let payloadStart = rl.next + topicRet.length;
  const flags = buf[0] & 0x0f;
  const qos = (flags >> 1) & 3;
  let packetId = 0;
  if (qos > 0 && payloadStart + 2 <= buf.length) {
    packetId = buf[payloadStart] * 256 + buf[payloadStart + 1];
    payloadStart += 2;
  }
  const payloadBuf = buf.slice(payloadStart);
  const payloadStr = String.fromCharCode.apply(null, payloadBuf);
  let payloadDecoded;
  try {
    payloadDecoded = decodeURIComponent(escape(payloadStr));
  } catch (e) {
    payloadDecoded = payloadStr;
  }
  return { topic: topic, payload: payloadDecoded, qos: qos, packetId: packetId };
}

function MqttClient() {
  this._ws = null;
  this._connected = false;
  this._packetId = 0;
  this._onMessage = null;
  this._onConnect = null;
  this._onError = null;
  this._onClose = null;
  this._buffer = [];
}

MqttClient.prototype._nextPacketId = function () {
  this._packetId = (this._packetId + 1) % 65536;
  return this._packetId || 1;
};

MqttClient.prototype.connect = function (url, opts) {
  const self = this;
  opts = opts || {};
  const wsUrl = url.replace(/^mqtts?\:\/\//i, 'wss://').replace(/^ws:\/\//i, 'ws://');
  if (!wsUrl.match(/^wss?:\/\//)) {
    if (self._onError) self._onError(new Error('URL 需为 wss:// 或 ws://'));
    return;
  }
  this._ws = new WxWebSocket(wsUrl);
  this._ws.onopen = function () {
    const packet = buildConnect({
      clientId: opts.clientId || 'mp-' + Date.now(),
      username: opts.username,
      password: opts.password,
      keepalive: opts.keepalive || 60,
    });
    self._ws.send(packet.buffer);
    self._buffer = [];
  };
  this._ws.onmessage = function (ev) {
    const data = ev.data;
    let buf;
    if (typeof data === 'string') {
      buf = new Uint8Array([].map.call(data, function (c) { return c.charCodeAt(0) & 0xff; }));
    } else if (data instanceof ArrayBuffer) {
      buf = new Uint8Array(data);
    } else if (data && data.buffer instanceof ArrayBuffer) {
      buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return;
    }
    if (buf.length < 4) return;
    const type = (buf[0] >> 4) & 0x0f;
    if (type === 2) {
      const returnCode = buf[3];
      if (returnCode === 0) {
        self._connected = true;
        if (self._onConnect) self._onConnect();
      } else if (self._onError) {
        self._onError(new Error('CONNACK 失败 code ' + returnCode));
      }
      return;
    }
    if (type === 3) {
      const parsed = parsePublishCorrect(buf);
      if (parsed) {
        if (parsed.qos >= 1 && parsed.packetId && self._ws) {
          self._ws.send(buildPuback(parsed.packetId).buffer);
        }
        if (self._onMessage) self._onMessage(parsed.topic, parsed.payload);
      }
    }
  };
  this._ws.onerror = function (err) {
    if (self._onError) self._onError(err);
  };
  this._ws.onclose = function (ev) {
    self._connected = false;
    if (self._onClose) self._onClose(ev);
  };
};

MqttClient.prototype.subscribe = function (topic, opts, cb) {
  if (!this._connected || !this._ws) {
    if (cb) cb(new Error('未连接'));
    return;
  }
  const qos = (opts && opts.qos) || 1;
  const packet = buildSubscribe(topic, qos, this._nextPacketId());
  this._ws.send(packet.buffer);
  if (cb) cb(null);
};

MqttClient.prototype.publish = function (topic, payload, opts, cb) {
  if (!this._connected || !this._ws) {
    if (cb) cb(new Error('未连接'));
    return;
  }
  const qos = (opts && opts.qos) !== undefined ? opts.qos : 1;
  const packetId = qos > 0 ? this._nextPacketId() : 0;
  const packet = buildPublish(topic, payload, qos, packetId);
  this._ws.send(packet.buffer);
  if (cb) cb(null);
};

MqttClient.prototype.end = function () {
  if (this._ws) {
    this._ws.close();
    this._ws = null;
  }
  this._connected = false;
};

MqttClient.prototype.on = function (event, fn) {
  if (event === 'connect') this._onConnect = fn;
  else if (event === 'message') this._onMessage = fn;
  else if (event === 'error') this._onError = fn;
  else if (event === 'close') this._onClose = fn;
};

module.exports = { MqttClient: MqttClient };
