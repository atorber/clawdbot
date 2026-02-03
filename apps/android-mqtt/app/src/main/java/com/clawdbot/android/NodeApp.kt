package com.clawdbot.android

import android.app.Application
import android.os.StrictMode
import java.security.KeyPairGenerator
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class NodeApp : Application() {
  val runtime: NodeRuntime by lazy { NodeRuntime(this) }

  companion object {
    private val ed25519Ready = AtomicBoolean(false)
    private val ed25519Latch = CountDownLatch(1)

    /** Wait for Ed25519 provider to be ready (max 25 seconds). Returns true if ready. */
    fun waitForEd25519Ready(): Boolean {
      if (ed25519Ready.get()) return true
      ed25519Latch.await(25, TimeUnit.SECONDS)
      return ed25519Ready.get()
    }
  }

  override fun onCreate() {
    super.onCreate()
    // Warm Ed25519 provider on a background thread with aggressive retry.
    // Other code can call waitForEd25519Ready() before using Ed25519.
    Thread {
      // Disable StrictMode for this thread as it may interfere with security provider init
      StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.LAX)

      val delays = longArrayOf(0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2500, 3000, 3500, 4000)
      for ((attempt, delayMs) in delays.withIndex()) {
        if (delayMs > 0) Thread.sleep(delayMs)
        try {
          KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
          ed25519Ready.set(true)
          ed25519Latch.countDown()
          android.util.Log.i("NodeApp", "Ed25519 warm-up succeeded on attempt $attempt")
          return@Thread
        } catch (e: Throwable) {
          android.util.Log.w("NodeApp", "Ed25519 warm-up attempt $attempt failed: ${e.message}")
        }
      }
      // Give up after all attempts, let downstream code handle failure
      android.util.Log.e("NodeApp", "Ed25519 warm-up failed after ${delays.size} attempts")
      ed25519Latch.countDown()
    }.start()
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }
}
