const KEY = 'mqttConfig';
const KEY_CONFIG_DRAFT = 'mqttConfigDraft';
const KEY_LAST_BROKER = 'mqttLastConnectedBroker';
const KEY_CHAT_PREFIX = 'mqttChat_';
const CHAT_MESSAGE_LIMIT = 100;

function load() {
  try {
    const raw = wx.getStorageSync(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function save(config) {
  try {
    wx.setStorageSync(KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    return false;
  }
}

function getLastConnectedBroker() {
  try {
    return wx.getStorageSync(KEY_LAST_BROKER) || '';
  } catch (e) {
    return '';
  }
}

function setLastConnectedBroker(url) {
  try {
    wx.setStorageSync(KEY_LAST_BROKER, url || '');
    return true;
  } catch (e) {
    return false;
  }
}

function chatKey(clientId) {
  return KEY_CHAT_PREFIX + (clientId || 'default');
}

function loadChatMessages(clientId) {
  try {
    const raw = wx.getStorageSync(chatKey(clientId));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveChatMessages(clientId, messages) {
  if (!messages || !Array.isArray(messages)) return false;
  const list = messages.slice(-CHAT_MESSAGE_LIMIT);
  try {
    wx.setStorageSync(chatKey(clientId), JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

function loadConfigDraft() {
  try {
    const raw = wx.getStorageSync(KEY_CONFIG_DRAFT);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveConfigDraft(draft) {
  if (!draft || typeof draft !== 'object') return false;
  try {
    wx.setStorageSync(KEY_CONFIG_DRAFT, JSON.stringify(draft));
    return true;
  } catch (e) {
    return false;
  }
}

function clearConfigDraft() {
  try {
    wx.removeStorageSync(KEY_CONFIG_DRAFT);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  load,
  save,
  getLastConnectedBroker,
  setLastConnectedBroker,
  loadChatMessages,
  saveChatMessages,
  loadConfigDraft,
  saveConfigDraft,
  clearConfigDraft,
};
