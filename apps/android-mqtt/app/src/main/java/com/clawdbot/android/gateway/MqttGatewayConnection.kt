package com.clawdbot.android.gateway

import com.clawdbot.android.BuildConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttException
import android.util.Log
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence

private const val TAG = "MqttGateway"
private const val TOPIC_PREFIX = "moltbot/gw"
private const val QOS = 1
/** All MQTT payloads are UTF-8 encoded JSON (req/res/evt frames). */
private val MQTT_PAYLOAD_CHARSET = Charsets.UTF_8
/** Strip NUL and trim so payload is safe for MQTT/JSON (some brokers truncate at \0). */
private fun sanitizeMqttPayload(raw: String): String = raw.replace("\u0000", "").trim()

/** MQTT broker connection state for UI display. */
sealed class MqttConnectionState {
  data object Disconnected : MqttConnectionState()
  data object Connecting : MqttConnectionState()
  data object Connected : MqttConnectionState()
  data class Error(val message: String) : MqttConnectionState()
}

/**
 * Shared MQTT connection that supports multiple roles (operator/node) over a single broker connection.
 *
 * Two client IDs are used:
 * - clientId: MQTT broker connection ID (should be random/unique to avoid conflicts)
 * - topicClientId: Used in topic paths (moltbot/gw/{topicClientId}/...), must match Gateway Bridge config
 *
 * This simplifies broker configuration: only one device registration is needed instead of two.
 */
class MqttGatewayConnection(
  private val scope: CoroutineScope,
  private val brokerUrl: String,
  private val clientId: String,
  private val topicClientId: String,
  private val username: String?,
  private val password: String?,
  private val onStateChange: ((MqttConnectionState) -> Unit)? = null,
  private val onLog: ((String) -> Unit)? = null,
) {
  private val mutex = Mutex()
  /** Serializes full open() so only one role does connect+subscribe at a time (ensures connect handshake can run; avoids Paho "Not initialized"). */
  /** Serializes full open() so only one role does connect at a time (ensures connect handshake can run). */
  private val openMutex = Mutex()
  /** Serializes publish so concurrent send from operator/node don't trigger Paho "Not initialized". */
  private val publishLock = ReentrantLock()

  private val _connectionState = MutableStateFlow<MqttConnectionState>(MqttConnectionState.Disconnected)
  val connectionState: StateFlow<MqttConnectionState> = _connectionState.asStateFlow()

  @Volatile private var client: MqttAsyncClient? = null
  @Volatile private var connectionDeferred: CompletableDeferred<Unit>? = null

  private val roleTransports = mutableMapOf<String, RoleTransport>()

  private fun setState(state: MqttConnectionState) {
    _connectionState.value = state
    Log.d(TAG, "connection state: $state")
    onStateChange?.invoke(state)
    // Log state change
    if (state is MqttConnectionState.Error) onLog?.invoke("Error: ${state.message}")
  }

  /**
   * Transport interface for a specific role (operator or node).
   * Uses topicClientId for topic paths (not the MQTT connection clientId).
   */
  inner class RoleTransport(val role: String) : GatewayTransport {
    private val reqTopic = "$TOPIC_PREFIX/$topicClientId/$role/req"
    private val resTopic = "$TOPIC_PREFIX/$topicClientId/$role/res"
    private val evtTopic = "$TOPIC_PREFIX/$topicClientId/$role/evt"

    private val closedDeferred = CompletableDeferred<Unit>()

    override val remoteAddress: String = brokerUrl
    override val skipConnectChallenge: Boolean = true

    override var onOpen: (() -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null
    override var onClose: ((String) -> Unit)? = null



    override suspend fun open() {
      mutex.withLock {
        roleTransports[role] = this
      }

      try {
        // One role at a time: connect, so both can later sendConnect()
        openMutex.withLock {
          ensureConnected()
          val c = client
          if (c == null || !c.isConnected) {
            throw IllegalStateException("MQTT client not connected after ensureConnected")
          }
          scope.launch { onOpen?.invoke() }
        }
      } catch (e: Exception) {
        mutex.withLock {
          roleTransports.remove(role)
        }
        throw e
      }
    }

    /** Sends one JSON frame. [json] must be a valid UTF-8 JSON string (unified payload format). */
    override fun send(json: String) {
      val c = client
      if (c == null || !c.isConnected) {
        scope.launch {
          closedDeferred.complete(Unit)
          onClose?.invoke("MQTT client not connected")
        }
        return
      }
      publishLock.withLock block@{
        val cur = client
        if (cur == null || !cur.isConnected) {
          scope.launch {
            closedDeferred.complete(Unit)
            onClose?.invoke("MQTT client not connected")
          }
          return@block
        }
        try {
          val safe = sanitizeMqttPayload(json)
          if (safe.isEmpty()) {
            Log.w(TAG, "MQTT send skipped: payload empty after sanitize (role=$role topic=$reqTopic)")
            return@block
          }
          if (BuildConfig.DEBUG) {
            val preview = if (safe.length <= 200) safe else safe.take(200) + "..."
            Log.d(TAG, "MQTT send topic=$reqTopic len=${safe.length} payload=$preview")
          }
          onLog?.invoke("TX [$role]: $safe")
          cur.publish(reqTopic, safe.toByteArray(MQTT_PAYLOAD_CHARSET), QOS, false)
        } catch (e: MqttException) {
          Log.e(TAG, "MQTT publish failed topic=$reqTopic role=$role: ${e.message} reasonCode=${e.reasonCode}", e)
          scope.launch {
            closedDeferred.complete(Unit)
            onClose?.invoke("MQTT publish failed: ${e.message}")
          }
        }
      }
    }

    override fun close() {
      scope.launch {
        mutex.withLock {
          roleTransports.remove(role)
        }
        closedDeferred.complete(Unit)
      }
    }

    override suspend fun awaitClose() {
      closedDeferred.await()
    }

    fun dispatchMessage(payload: String) {
      scope.launch { onMessage?.invoke(payload) }
    }

    fun dispatchClose(reason: String) {
      closedDeferred.complete(Unit)
      scope.launch { onClose?.invoke(reason) }
    }
  }

  /**
   * Creates a transport for the specified role. Multiple roles can share the same connection.
   */
  fun createTransport(role: String): GatewayTransport {
    return RoleTransport(role)
  }

  /**
   * Ensures the MQTT connection is established. If already connected, returns immediately.
   * If connection is in progress, waits for it. If not connected, starts a new connection.
   */
  private suspend fun ensureConnected() = withContext(Dispatchers.IO) {
    // Fast path: already connected
    val existingClient = client
    if (existingClient?.isConnected == true) {
      return@withContext
    }

    // Check if connection is in progress or needs to be started
    val deferredToAwait: CompletableDeferred<Unit>
    mutex.withLock {
      // Double-check after acquiring lock
      val c = client
      if (c?.isConnected == true) {
        return@withContext
      }

      // If there's already a connection attempt in progress, wait for it
      val existing = connectionDeferred
      if (existing != null) {
        deferredToAwait = existing
      } else {
        // Start new connection
        val newDeferred = CompletableDeferred<Unit>()
        connectionDeferred = newDeferred
        deferredToAwait = newDeferred
        startConnection(newDeferred)
      }
    }

    // Wait for connection outside of lock
    deferredToAwait.await()
  }

  private fun startConnection(deferred: CompletableDeferred<Unit>) {
    val opts = MqttConnectOptions().apply {
      isCleanSession = true
      keepAliveInterval = 60
      connectionTimeout = 30
      mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
      val u = this@MqttGatewayConnection.username
      val p = this@MqttGatewayConnection.password
      if (!u.isNullOrBlank()) userName = u
      if (!p.isNullOrBlank()) this.password = p.toCharArray()
    }

    val c = MqttAsyncClient(brokerUrl, clientId, MemoryPersistence())
    client = c

    c.setCallback(object : MqttCallback {
      override fun connectionLost(cause: Throwable?) {
        val reason = "MQTT connection lost: ${cause?.message ?: "unknown"}"
        setState(MqttConnectionState.Disconnected)
        scope.launch {
          val transports = mutex.withLock {
            // Clear client reference so reconnect creates a fresh client
            client = null
            connectionDeferred = null
            roleTransports.values.toList()
          }
          transports.forEach { it.dispatchClose(reason) }
        }
      }

      override fun messageArrived(topic: String, message: MqttMessage) {
        // onLog?.invoke("RX: $topic") // Too verbose maybe? Let's log if it fails processing
        if (!topic.startsWith(TOPIC_PREFIX)) {
          onLog?.invoke("RX Ignored: $topic (Filtered)")
          return
        }
        val raw = message.payload?.toString(MQTT_PAYLOAD_CHARSET) ?: return
        val payload = sanitizeMqttPayload(raw)
        if (payload.isEmpty() || (!payload.startsWith("{") && !payload.startsWith("["))) {
          onLog?.invoke("RX Ignored: Not JSON ($topic)")
          Log.w(TAG, "MQTT message ignored: payload not JSON (topic=$topic)")
          return
        }
        val parts = topic.split("/")
        if (parts.size >= 4) {
          val role = parts[3]
          onLog?.invoke("RX [$role]: $payload")
          scope.launch {
            val transport = mutex.withLock { roleTransports[role] }
            transport?.dispatchMessage(payload)
          }
        }
      }

      override fun deliveryComplete(token: org.eclipse.paho.client.mqttv3.IMqttDeliveryToken?) {}
    })

    setState(MqttConnectionState.Connecting)
    onLog?.invoke("Connecting to $brokerUrl...")
    c.connect(opts, null, object : IMqttActionListener {
      override fun onSuccess(asyncActionToken: IMqttToken?) {
        setState(MqttConnectionState.Connected)
        // Brief delay so client is fully ready
        scope.launch {
          delay(100)
          // Unified subscription for ALL roles (simulating E2E test script behavior)
          val allTopics = arrayOf(
            "$TOPIC_PREFIX/$topicClientId/operator/res",
            "$TOPIC_PREFIX/$topicClientId/operator/evt",
            "$TOPIC_PREFIX/$topicClientId/node/res",
            "$TOPIC_PREFIX/$topicClientId/node/evt"
          )
          val qos = IntArray(allTopics.size) { QOS }
          onLog?.invoke("Subscribing to: ${allTopics.joinToString()}")
          try {
            c.subscribe(allTopics, qos, null, object : IMqttActionListener {
              override fun onSuccess(asyncActionToken: IMqttToken?) {
                Log.d(TAG, "Unified subscribe success")
                onLog?.invoke("Subscribe Success")
                scope.launch {
                  mutex.withLock { connectionDeferred = null }
                  deferred.complete(Unit)
                }
              }
              override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                Log.w(TAG, "Unified subscribe failed (non-fatal)", exception)
                onLog?.invoke("Subscribe Failed: ${exception?.message}")
                // Even on failure, we proceed (keep connection open)
                scope.launch {
                  mutex.withLock { connectionDeferred = null }
                  deferred.complete(Unit)
                }
              }
            })
          } catch (e: MqttException) {
             Log.w(TAG, "Unified subscribe error (non-fatal)", e)
             onLog?.invoke("Subscribe Error: ${e.message}")
             mutex.withLock { connectionDeferred = null }
             deferred.complete(Unit)
          }
        }
      }

      override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
        val msg = exception?.message ?: "MQTT connect failed"
        setState(MqttConnectionState.Error(msg))
        scope.launch {
          mutex.withLock {
            client = null
            connectionDeferred = null
          }
        }
        deferred.completeExceptionally(exception ?: RuntimeException(msg))
      }
    })
  }
}
