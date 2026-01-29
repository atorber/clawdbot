package com.clawdbot.android.gateway

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * WebSocket implementation of [GatewayTransport]. Uses OkHttp; open() suspends until socket is open.
 */
class WsGatewayTransport(
  private val scope: CoroutineScope,
  private val endpoint: GatewayEndpoint,
  private val tls: GatewayTlsParams?,
  private val onTlsFingerprint: ((stableId: String, fingerprint: String) -> Unit)? = null,
) : GatewayTransport {

  override val remoteAddress: String =
    if (endpoint.host.contains(":")) "[${endpoint.host}]:${endpoint.port}"
    else "${endpoint.host}:${endpoint.port}"

  override val skipConnectChallenge: Boolean = isLoopbackHost(endpoint.host)

  override var onOpen: (() -> Unit)? = null
  override var onMessage: ((String) -> Unit)? = null
  override var onClose: ((String) -> Unit)? = null

  private val openDeferred = CompletableDeferred<Unit>()
  private val closedDeferred = CompletableDeferred<Unit>()
  private val writeLock = ReentrantLock()
  private val client: OkHttpClient = buildClient()
  private var socket: WebSocket? = null

  override suspend fun open() {
    val scheme = if (tls != null) "wss" else "ws"
    val url = "$scheme://${endpoint.host}:${endpoint.port}"
    val request = Request.Builder().url(url).build()
    socket = client.newWebSocket(request, Listener())
    openDeferred.await()
  }

  override fun send(json: String) {
    writeLock.withLock { socket?.send(json) }
  }

  override fun close() {
    socket?.close(1000, "bye")
    socket = null
    closedDeferred.complete(Unit)
  }

  override suspend fun awaitClose() {
    closedDeferred.await()
  }

  private fun buildClient(): OkHttpClient {
    val builder = OkHttpClient.Builder()
    val tlsConfig = buildGatewayTlsConfig(tls) { fingerprint ->
      onTlsFingerprint?.invoke(tls?.stableId ?: endpoint.stableId, fingerprint)
    }
    if (tlsConfig != null) {
      builder.sslSocketFactory(tlsConfig.sslSocketFactory, tlsConfig.trustManager)
      builder.hostnameVerifier(tlsConfig.hostnameVerifier)
    }
    return builder.build()
  }

  private inner class Listener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      scope.launch {
        openDeferred.complete(Unit)
        onOpen?.invoke()
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      scope.launch { onMessage?.invoke(text) }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (!openDeferred.isCompleted) openDeferred.completeExceptionally(t)
      closedDeferred.complete(Unit)
      onClose?.invoke("Gateway error: ${t.message ?: t::class.java.simpleName}")
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (!openDeferred.isCompleted) openDeferred.completeExceptionally(RuntimeException("Gateway closed: $reason"))
      closedDeferred.complete(Unit)
      onClose?.invoke("Gateway closed: $reason")
    }
  }
}

private fun isLoopbackHost(raw: String?): Boolean {
  val host = raw?.trim()?.lowercase().orEmpty()
  if (host.isEmpty()) return false
  if (host == "localhost") return true
  if (host == "::1") return true
  if (host == "0.0.0.0" || host == "::") return true
  return host.startsWith("127.")
}
