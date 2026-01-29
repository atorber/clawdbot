package com.clawdbot.android.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttException
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence

private const val TOPIC_PREFIX = "moltbot/gw"
private const val QOS = 1

/** MQTT broker connection state for UI display. */
sealed class MqttConnectionState {
  data object Disconnected : MqttConnectionState()
  data object Connecting : MqttConnectionState()
  data object Connected : MqttConnectionState()
  data class Error(val message: String) : MqttConnectionState()
}

/**
 * Shared MQTT connection that supports multiple roles (operator/node) over a single broker connection.
 * Uses one MQTT client ID and subscribes to all role-specific topics.
 *
 * This simplifies broker configuration: only one device registration is needed instead of two.
 */
class MqttGatewayConnection(
  private val scope: CoroutineScope,
  private val brokerUrl: String,
  private val clientId: String,
  private val username: String?,
  private val password: String?,
  private val onStateChange: ((MqttConnectionState) -> Unit)? = null,
) {
  private val mutex = Mutex()

  private val _connectionState = MutableStateFlow<MqttConnectionState>(MqttConnectionState.Disconnected)
  val connectionState: StateFlow<MqttConnectionState> = _connectionState.asStateFlow()

  @Volatile private var client: MqttAsyncClient? = null
  @Volatile private var connectionDeferred: CompletableDeferred<Unit>? = null

  private val roleTransports = mutableMapOf<String, RoleTransport>()

  private fun setState(state: MqttConnectionState) {
    _connectionState.value = state
    onStateChange?.invoke(state)
  }

  /**
   * Transport interface for a specific role (operator or node).
   */
  inner class RoleTransport(val role: String) : GatewayTransport {
    private val reqTopic = "$TOPIC_PREFIX/$clientId/$role/req"
    private val resTopic = "$TOPIC_PREFIX/$clientId/$role/res"
    private val evtTopic = "$TOPIC_PREFIX/$clientId/$role/evt"

    private val closedDeferred = CompletableDeferred<Unit>()

    override val remoteAddress: String = brokerUrl
    override val skipConnectChallenge: Boolean = true

    override var onOpen: (() -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null
    override var onClose: ((String) -> Unit)? = null

    val subscribeTopics: Array<String> = arrayOf(resTopic, evtTopic)

    override suspend fun open() {
      // Register this transport
      mutex.withLock {
        roleTransports[role] = this
      }

      try {
        // Ensure connection is established
        ensureConnected()

        // Subscribe to our topics
        val c = client ?: throw IllegalStateException("MQTT client not available after connect")
        subscribeTopics(c)

        scope.launch { onOpen?.invoke() }
      } catch (e: Exception) {
        mutex.withLock {
          roleTransports.remove(role)
        }
        throw e
      }
    }

    private suspend fun subscribeTopics(c: MqttAsyncClient) {
      val deferred = CompletableDeferred<Unit>()
      try {
        c.subscribe(subscribeTopics, intArrayOf(QOS, QOS), null, object : IMqttActionListener {
          override fun onSuccess(asyncActionToken: IMqttToken?) {
            deferred.complete(Unit)
          }

          override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
            deferred.completeExceptionally(exception ?: RuntimeException("subscribe failed"))
          }
        })
      } catch (e: MqttException) {
        deferred.completeExceptionally(e)
      }
      deferred.await()
    }

    override fun send(json: String) {
      val c = client
      if (c == null || !c.isConnected) {
        scope.launch {
          closedDeferred.complete(Unit)
          onClose?.invoke("MQTT client not connected")
        }
        return
      }
      try {
        c.publish(reqTopic, json.toByteArray(Charsets.UTF_8), QOS, false)
      } catch (e: MqttException) {
        scope.launch {
          closedDeferred.complete(Unit)
          onClose?.invoke("MQTT publish failed: ${e.message}")
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
            connectionDeferred = null
            roleTransports.values.toList()
          }
          transports.forEach { it.dispatchClose(reason) }
        }
      }

      override fun messageArrived(topic: String, message: MqttMessage) {
        val payload = message.payload?.toString(Charsets.UTF_8) ?: return
        // Route message to appropriate role transport based on topic
        // Topic format: moltbot/gw/{clientId}/{role}/res or evt
        val parts = topic.split("/")
        if (parts.size >= 4) {
          val role = parts[3] // operator or node
          scope.launch {
            val transport = mutex.withLock { roleTransports[role] }
            transport?.dispatchMessage(payload)
          }
        }
      }

      override fun deliveryComplete(token: org.eclipse.paho.client.mqttv3.IMqttDeliveryToken?) {}
    })

    setState(MqttConnectionState.Connecting)
    c.connect(opts, null, object : IMqttActionListener {
      override fun onSuccess(asyncActionToken: IMqttToken?) {
        setState(MqttConnectionState.Connected)
        scope.launch {
          mutex.withLock {
            connectionDeferred = null
          }
        }
        deferred.complete(Unit)
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
