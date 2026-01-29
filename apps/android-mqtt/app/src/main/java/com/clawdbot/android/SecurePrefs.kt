@file:Suppress("DEPRECATION")

package com.clawdbot.android

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

class SecurePrefs(context: Context) {
  companion object {
    val defaultWakeWords: List<String> = listOf("clawd", "claude")
    private const val displayNameKey = "node.displayName"
    private const val voiceWakeModeKey = "voiceWake.mode"
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val masterKey =
    MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()

  private val prefs =
    EncryptedSharedPreferences.create(
      context,
      "moltbot.node.secure",
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  private val _instanceId = MutableStateFlow(loadOrCreateInstanceId())
  val instanceId: StateFlow<String> = _instanceId

  private val _displayName =
    MutableStateFlow(loadOrMigrateDisplayName(context = context))
  val displayName: StateFlow<String> = _displayName

  private val _cameraEnabled = MutableStateFlow(prefs.getBoolean("camera.enabled", true))
  val cameraEnabled: StateFlow<Boolean> = _cameraEnabled

  private val _locationMode =
    MutableStateFlow(LocationMode.fromRawValue(prefs.getString("location.enabledMode", "off")))
  val locationMode: StateFlow<LocationMode> = _locationMode

  private val _locationPreciseEnabled =
    MutableStateFlow(prefs.getBoolean("location.preciseEnabled", true))
  val locationPreciseEnabled: StateFlow<Boolean> = _locationPreciseEnabled

  private val _preventSleep = MutableStateFlow(prefs.getBoolean("screen.preventSleep", true))
  val preventSleep: StateFlow<Boolean> = _preventSleep

  private val _mqttBrokerUrl = MutableStateFlow(prefs.getString("gateway.mqtt.brokerUrl", "")?.trim().orEmpty())
  val mqttBrokerUrl: StateFlow<String> = _mqttBrokerUrl

  private val _mqttUsername = MutableStateFlow(prefs.getString("gateway.mqtt.username", null)?.trim().orEmpty())
  val mqttUsername: StateFlow<String> = _mqttUsername

  private val _mqttPassword = MutableStateFlow(prefs.getString("gateway.mqtt.password", null)?.trim().orEmpty())
  val mqttPassword: StateFlow<String> = _mqttPassword

  private val _mqttClientId = MutableStateFlow(prefs.getString("gateway.mqtt.clientId", null)?.trim().orEmpty())
  val mqttClientId: StateFlow<String> = _mqttClientId

  private val _canvasDebugStatusEnabled =
    MutableStateFlow(prefs.getBoolean("canvas.debugStatusEnabled", false))
  val canvasDebugStatusEnabled: StateFlow<Boolean> = _canvasDebugStatusEnabled

  private val _wakeWords = MutableStateFlow(loadWakeWords())
  val wakeWords: StateFlow<List<String>> = _wakeWords

  private val _voiceWakeMode = MutableStateFlow(loadVoiceWakeMode())
  val voiceWakeMode: StateFlow<VoiceWakeMode> = _voiceWakeMode

  private val _talkEnabled = MutableStateFlow(prefs.getBoolean("talk.enabled", false))
  val talkEnabled: StateFlow<Boolean> = _talkEnabled

  fun setDisplayName(value: String) {
    val trimmed = value.trim()
    prefs.edit { putString(displayNameKey, trimmed) }
    _displayName.value = trimmed
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.edit { putBoolean("camera.enabled", value) }
    _cameraEnabled.value = value
  }

  fun setLocationMode(mode: LocationMode) {
    prefs.edit { putString("location.enabledMode", mode.rawValue) }
    _locationMode.value = mode
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    prefs.edit { putBoolean("location.preciseEnabled", value) }
    _locationPreciseEnabled.value = value
  }

  fun setPreventSleep(value: Boolean) {
    prefs.edit { putBoolean("screen.preventSleep", value) }
    _preventSleep.value = value
  }

  fun setMqttBrokerUrl(value: String) {
    val trimmed = value.trim()
    prefs.edit { putString("gateway.mqtt.brokerUrl", trimmed) }
    _mqttBrokerUrl.value = trimmed
  }

  fun setMqttUsername(value: String) {
    val trimmed = value.trim()
    prefs.edit { putString("gateway.mqtt.username", trimmed) }
    _mqttUsername.value = trimmed
  }

  fun setMqttPassword(value: String) {
    val trimmed = value.trim()
    prefs.edit { putString("gateway.mqtt.password", trimmed) }
    _mqttPassword.value = trimmed
  }

  fun setMqttClientId(value: String) {
    val trimmed = value.trim()
    prefs.edit { putString("gateway.mqtt.clientId", trimmed) }
    _mqttClientId.value = trimmed
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.edit { putBoolean("canvas.debugStatusEnabled", value) }
    _canvasDebugStatusEnabled.value = value
  }

  fun loadGatewayToken(): String? {
    val key = "gateway.token.${_instanceId.value}"
    val stored = prefs.getString(key, null)?.trim()
    if (!stored.isNullOrEmpty()) return stored
    val legacy = prefs.getString("bridge.token.${_instanceId.value}", null)?.trim()
    return legacy?.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayToken(token: String) {
    val key = "gateway.token.${_instanceId.value}"
    prefs.edit { putString(key, token.trim()) }
  }

  fun loadGatewayPassword(): String? {
    val key = "gateway.password.${_instanceId.value}"
    val stored = prefs.getString(key, null)?.trim()
    return stored?.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayPassword(password: String) {
    val key = "gateway.password.${_instanceId.value}"
    prefs.edit { putString(key, password.trim()) }
  }

  fun getString(key: String): String? {
    return prefs.getString(key, null)
  }

  fun putString(key: String, value: String) {
    prefs.edit { putString(key, value) }
  }

  fun remove(key: String) {
    prefs.edit { remove(key) }
  }

  private fun loadOrCreateInstanceId(): String {
    val existing = prefs.getString("node.instanceId", null)?.trim()
    if (!existing.isNullOrBlank()) return existing
    val fresh = UUID.randomUUID().toString()
    prefs.edit { putString("node.instanceId", fresh) }
    return fresh
  }

  private fun loadOrMigrateDisplayName(context: Context): String {
    val existing = prefs.getString(displayNameKey, null)?.trim().orEmpty()
    if (existing.isNotEmpty() && existing != "Android Node") return existing

    val candidate = DeviceNames.bestDefaultNodeName(context).trim()
    val resolved = candidate.ifEmpty { "Android Node" }

    prefs.edit { putString(displayNameKey, resolved) }
    return resolved
  }

  fun setWakeWords(words: List<String>) {
    val sanitized = WakeWords.sanitize(words, defaultWakeWords)
    val encoded =
      JsonArray(sanitized.map { JsonPrimitive(it) }).toString()
    prefs.edit { putString("voiceWake.triggerWords", encoded) }
    _wakeWords.value = sanitized
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    prefs.edit { putString(voiceWakeModeKey, mode.rawValue) }
    _voiceWakeMode.value = mode
  }

  fun setTalkEnabled(value: Boolean) {
    prefs.edit { putBoolean("talk.enabled", value) }
    _talkEnabled.value = value
  }

  private fun loadVoiceWakeMode(): VoiceWakeMode {
    val raw = prefs.getString(voiceWakeModeKey, null)
    val resolved = VoiceWakeMode.fromRawValue(raw)

    // Default ON (foreground) when unset.
    if (raw.isNullOrBlank()) {
      prefs.edit { putString(voiceWakeModeKey, resolved.rawValue) }
    }

    return resolved
  }

  private fun loadWakeWords(): List<String> {
    val raw = prefs.getString("voiceWake.triggerWords", null)?.trim()
    if (raw.isNullOrEmpty()) return defaultWakeWords
    return try {
      val element = json.parseToJsonElement(raw)
      val array = element as? JsonArray ?: return defaultWakeWords
      val decoded =
        array.mapNotNull { item ->
          when (item) {
            is JsonNull -> null
            is JsonPrimitive -> item.content.trim().takeIf { it.isNotEmpty() }
            else -> null
          }
        }
      WakeWords.sanitize(decoded, defaultWakeWords)
    } catch (_: Throwable) {
      defaultWakeWords
    }
  }

}
