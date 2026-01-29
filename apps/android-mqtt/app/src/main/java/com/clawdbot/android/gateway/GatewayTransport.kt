package com.clawdbot.android.gateway

/**
 * Connection target: WebSocket (endpoint + tls) or MQTT (shared connection).
 * Used by [GatewaySession.connect] to choose transport.
 */
sealed class GatewayConnectionTarget {
  data class Ws(val endpoint: GatewayEndpoint, val tls: GatewayTlsParams?) : GatewayConnectionTarget()

  /**
   * MQTT target using a shared [MqttGatewayConnection].
   * The connection is shared across multiple roles (operator/node), requiring only one device registration.
   */
  data class Mqtt(
    val connection: MqttGatewayConnection,
    val role: String,
  ) : GatewayConnectionTarget()
}

/**
 * Transport for Gateway JSON protocol (req/res/event). Session drives handshake and
 * message routing; transport only sends/receives raw JSON frames.
 */
interface GatewayTransport {
  /** Display address (e.g. "host:port" or "brokerUrl") */
  val remoteAddress: String

  /** True if this transport skips connect.challenge (e.g. MQTT loopback). */
  val skipConnectChallenge: Boolean
    get() = false

  /** Called when transport is ready to send/receive (e.g. WebSocket open, MQTT connected+subscribed). */
  var onOpen: (() -> Unit)?

  /** Called for each incoming JSON frame. */
  var onMessage: ((String) -> Unit)?

  /** Called when transport is closed. */
  var onClose: ((String) -> Unit)?

  /** Connect and start receiving. When ready, invokes [onOpen]. */
  suspend fun open()

  /** Send one JSON frame. */
  fun send(json: String)

  /** Close the transport. Idempotent. */
  fun close()

  /** Suspend until transport is closed. */
  suspend fun awaitClose()
}
