package com.clawdbot.android.gateway

import android.content.Context
import android.os.StrictMode
import android.util.Base64
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class DeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class DeviceIdentityStore(context: Context) {
  private val json = Json { ignoreUnknownKeys = true }
  private val identityFile = File(context.filesDir, "moltbot/identity/device.json")

  /** In-memory cache so subsequent calls skip disk I/O. */
  @Volatile private var cachedIdentity: DeviceIdentity? = null

  /**
   * Returns cached/persisted identity or generates a new one.
   * Uses double-checked locking: expensive generate() runs outside lock to avoid contention.
   */
  fun loadOrCreate(): DeviceIdentity {
    // Fast path: return cached value
    cachedIdentity?.let { return it }

    // First check (unlocked): try to load from disk
    val existing = load()
    if (existing != null) {
      val identity = maybeFixDeviceId(existing)
      cachedIdentity = identity
      return identity
    }

    // Generate outside lock (expensive, may retry/sleep)
    val fresh = generate()

    // Second check (locked): another thread may have created identity while we were generating
    synchronized(this) {
      cachedIdentity?.let { return it }
      val diskCheck = load()
      if (diskCheck != null) {
        val identity = maybeFixDeviceId(diskCheck)
        cachedIdentity = identity
        return identity
      }
      save(fresh)
      cachedIdentity = fresh
      return fresh
    }
  }

  /** If deviceId doesn't match derived value, fix and persist. */
  private fun maybeFixDeviceId(identity: DeviceIdentity): DeviceIdentity {
    val derived = deriveDeviceId(identity.publicKeyRawBase64)
    return if (derived != null && derived != identity.deviceId) {
      val updated = identity.copy(deviceId = derived)
      save(updated)
      updated
    } else {
      identity
    }
  }

  fun signPayload(payload: String, identity: DeviceIdentity): String? {
    return try {
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
      val keyFactory = KeyFactory.getInstance("Ed25519")
      val privateKey = keyFactory.generatePrivate(keySpec)
      val signature = Signature.getInstance("Ed25519")
      signature.initSign(privateKey)
      signature.update(payload.toByteArray(Charsets.UTF_8))
      base64UrlEncode(signature.sign())
    } catch (_: Throwable) {
      null
    }
  }

  fun publicKeyBase64Url(identity: DeviceIdentity): String? {
    return try {
      val raw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      base64UrlEncode(raw)
    } catch (_: Throwable) {
      null
    }
  }

  private fun load(): DeviceIdentity? {
    return try {
      if (!identityFile.exists()) return null
      val raw = identityFile.readText(Charsets.UTF_8)
      val decoded = json.decodeFromString(DeviceIdentity.serializer(), raw)
      if (decoded.deviceId.isBlank() ||
        decoded.publicKeyRawBase64.isBlank() ||
        decoded.privateKeyPkcs8Base64.isBlank()
      ) {
        null
      } else {
        decoded
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun save(identity: DeviceIdentity) {
    try {
      identityFile.parentFile?.mkdirs()
      val encoded = json.encodeToString(DeviceIdentity.serializer(), identity)
      identityFile.writeText(encoded, Charsets.UTF_8)
    } catch (_: Throwable) {
      // best-effort only
    }
  }

  private fun generate(): DeviceIdentity {
    // Wait for Ed25519 provider warm-up (started in NodeApp.onCreate)
    com.clawdbot.android.NodeApp.waitForEd25519Ready()

    // Temporarily disable StrictMode as it may interfere with security provider initialization
    val oldPolicy = StrictMode.getThreadPolicy()
    StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.LAX)

    try {
      // More aggressive retry with longer waits (total ~15s max)
      val delays = longArrayOf(0, 500, 1000, 1500, 2000, 2500, 3000, 3500)
      for ((attempt, delayMs) in delays.withIndex()) {
        if (delayMs > 0) Thread.sleep(delayMs)
        try {
          val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
          val spki = keyPair.public.encoded
          val rawPublic = stripSpkiPrefix(spki)
          val deviceId = sha256Hex(rawPublic)
          val privateKey = keyPair.private.encoded
          return DeviceIdentity(
            deviceId = deviceId,
            publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
            privateKeyPkcs8Base64 = Base64.encodeToString(privateKey, Base64.NO_WRAP),
            createdAtMs = System.currentTimeMillis(),
          )
        } catch (e: Throwable) {
          android.util.Log.w("DeviceIdentityStore", "generate attempt $attempt failed: ${e.message}")
        }
      }
    } finally {
      StrictMode.setThreadPolicy(oldPolicy)
    }

    // Ed25519 not available on this device (e.g. Android 16 Beta bug).
    // Return a fallback identity with random deviceId but no signing capability.
    android.util.Log.e("DeviceIdentityStore", "Ed25519 unavailable, using fallback identity without signing")
    val randomId = java.util.UUID.randomUUID().toString().replace("-", "")
    return DeviceIdentity(
      deviceId = randomId,
      publicKeyRawBase64 = "",
      privateKeyPkcs8Base64 = "",
      createdAtMs = System.currentTimeMillis(),
    )
  }

  private fun deriveDeviceId(publicKeyRawBase64: String): String? {
    return try {
      val raw = Base64.decode(publicKeyRawBase64, Base64.DEFAULT)
      sha256Hex(raw)
    } catch (_: Throwable) {
      null
    }
  }

  private fun stripSpkiPrefix(spki: ByteArray): ByteArray {
    if (spki.size == ED25519_SPKI_PREFIX.size + 32 &&
      spki.copyOfRange(0, ED25519_SPKI_PREFIX.size).contentEquals(ED25519_SPKI_PREFIX)
    ) {
      return spki.copyOfRange(ED25519_SPKI_PREFIX.size, spki.size)
    }
    return spki
  }

  private fun sha256Hex(data: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(data)
    val out = StringBuilder(digest.size * 2)
    for (byte in digest) {
      out.append(String.format("%02x", byte))
    }
    return out.toString()
  }

  private fun base64UrlEncode(data: ByteArray): String {
    return Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }

  companion object {
    private val ED25519_SPKI_PREFIX =
      byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      )
  }
}
