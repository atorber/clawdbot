package com.clawdbot.android

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

data class LogEntry(
  val id: Long,
  val timestamp: Long,
  val tag: String,
  val message: String,
  val type: LogType = LogType.INFO
) {
  enum class LogType { INFO, ERROR, TX, RX }
  
  fun formattedTime(): String {
    return SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date(timestamp))
  }
}

class DebugLogStore(private val maxSize: Int = 200) {
  private val _logs = MutableStateFlow<List<LogEntry>>(emptyList())
  val logs: StateFlow<List<LogEntry>> = _logs.asStateFlow()
  
  private val lock = ReentrantLock()
  private var nextId = 0L

  fun add(tag: String, message: String, type: LogEntry.LogType = LogEntry.LogType.INFO) {
    lock.withLock {
      val entry = LogEntry(
        id = nextId++,
        timestamp = System.currentTimeMillis(),
        tag = tag,
        message = message,
        type = type
      )
      val current = _logs.value.toMutableList()
      current.add(entry)
      if (current.size > maxSize) {
        current.removeAt(0)
      }
      _logs.value = current
    }
  }

  fun clear() {
    lock.withLock {
      _logs.value = emptyList()
    }
  }
}
