package com.clawdbot.android.gateway

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.eclipse.paho.android.service.MqttAndroidClient
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttException
import org.eclipse.paho.client.mqttv3.MqttMessage
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val TOPIC_PREFIX = "moltbot/gw"
private const val QOS = 1

/**
 * MQTT implementation of [GatewayTransport]. Connects to Broker, publishes to req topic,
 * subscribes to res/evt; uses role-specific topics per scheme (operator/node).
 * skipConnectChallenge = true (loopback).
 */
class MqttGatewayTransport(
  private val context: Context,
  private val scope: CoroutineScope,
  private val brokerUrl: String,
  private val clientId: String,
  private val role: String,
  private val username: String?,
  private val password: String?,
) : GatewayTransport {

  override val remoteAddress: String = brokerUrl

  override val skipConnectChallenge: Boolean = true

  override var onOpen: (() -> Unit)? = null
  override var onMessage: ((String) -> Unit)? = null
  override var onClose: ((String) -> Unit)? = null

  private val reqTopic = "$TOPIC_PREFIX/$clientId/$role/req"
  private val resTopic = "$TOPIC_PREFIX/$clientId/$role/res"
  private val evtTopic = "$TOPIC_PREFIX/$clientId/$role/evt"

  private val openDeferred = CompletableDeferred<Unit>()
  private val closedDeferred = CompletableDeferred<Unit>()
  private var client: MqttAndroidClient? = null

  override suspend fun open() = withContext(Dispatchers.IO) {
    val opts = MqttConnectOptions().apply {
      isCleanSession = true
      keepAliveInterval = 60
      username?.takeIf { it.isNotBlank() }?.let { userName = it }
      password?.takeIf { it.isNotBlank() }?.toCharArray()?.let { this.password = it }
    }
    val c = MqttAndroidClient(context, brokerUrl, "${clientId}_$role")
    client = c
    c.setCallback(
      object : MqttCallback {
        override fun connectionLost(cause: Throwable?) {
          scope.launch {
            closedDeferred.complete(Unit)
            onClose?.invoke("MQTT connection lost: ${cause?.message ?: "unknown"}")
          }
        }

        override fun messageArrived(topic: String, message: MqttMessage) {
          val payload = message.payload?.toString(Charsets.UTF_8) ?: return
          scope.launch { onMessage?.invoke(payload) }
        }

        override fun deliveryComplete(token: org.eclipse.paho.client.mqttv3.IMqttDeliveryToken?) {}
      },
    )
    connectAndSubscribe(c, opts)
    openDeferred.await()
  }

  private fun connectAndSubscribe(c: MqttAndroidClient, opts: MqttConnectOptions) {
    c.connect(
      opts,
      null,
      object : IMqttActionListener {
        override fun onSuccess(asyncActionToken: IMqttToken?) {
          try {
            c.subscribe(arrayOf(resTopic, evtTopic), intArrayOf(QOS, QOS), null, object : IMqttActionListener {
              override fun onSuccess(subToken: IMqttToken?) {
                openDeferred.complete(Unit)
                scope.launch { onOpen?.invoke() }
              }

              override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                openDeferred.completeExceptionally(exception ?: RuntimeException("subscribe failed"))
              }
            })
          } catch (e: MqttException) {
            openDeferred.completeExceptionally(e)
          }
        }

        override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
          openDeferred.completeExceptionally(exception ?: RuntimeException("connect failed"))
        }
      },
    )
  }

  override fun send(json: String) {
    val c = client ?: return
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
    try {
      client?.disconnect()
      client?.close()
    } catch (_: Throwable) {}
    client = null
    closedDeferred.complete(Unit)
  }

  override suspend fun awaitClose() {
    closedDeferred.await()
  }
}
