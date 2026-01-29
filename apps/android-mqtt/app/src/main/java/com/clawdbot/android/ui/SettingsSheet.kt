package com.clawdbot.android.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.clawdbot.android.BuildConfig
import com.clawdbot.android.LocationMode
import com.clawdbot.android.MainViewModel
import com.clawdbot.android.gateway.MqttConnectionState
import com.clawdbot.android.NodeForegroundService
import com.clawdbot.android.VoiceWakeMode
import com.clawdbot.android.WakeWords

@Composable
fun SettingsSheet(viewModel: MainViewModel) {
  val context = LocalContext.current
  val instanceId by viewModel.instanceId.collectAsState()
  val displayName by viewModel.displayName.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val wakeWords by viewModel.wakeWords.collectAsState()
  val voiceWakeMode by viewModel.voiceWakeMode.collectAsState()
  val voiceWakeStatusText by viewModel.voiceWakeStatusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val manualEnabled by viewModel.manualEnabled.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val connectionMode by viewModel.connectionMode.collectAsState()
  val mqttConnectionState by viewModel.mqttConnectionState.collectAsState()
  val mqttBrokerUrl by viewModel.mqttBrokerUrl.collectAsState()
  val mqttUsername by viewModel.mqttUsername.collectAsState()
  val mqttPassword by viewModel.mqttPassword.collectAsState()
  val mqttClientId by viewModel.mqttClientId.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val gateways by viewModel.gateways.collectAsState()
  val discoveryStatusText by viewModel.discoveryStatusText.collectAsState()

  val listState = rememberLazyListState()
  val (wakeWordsText, setWakeWordsText) = remember { mutableStateOf("") }
  val (advancedExpanded, setAdvancedExpanded) = remember { mutableStateOf(false) }
  val focusManager = LocalFocusManager.current
  var wakeWordsHadFocus by remember { mutableStateOf(false) }
  val deviceModel =
    remember {
      listOfNotNull(Build.MANUFACTURER, Build.MODEL)
        .joinToString(" ")
        .trim()
        .ifEmpty { "Android" }
    }
  val appVersion =
    remember {
      val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
      if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
        "$versionName-dev"
      } else {
        versionName
      }
    }

  LaunchedEffect(wakeWords) { setWakeWordsText(wakeWords.joinToString(", ")) }
  val commitWakeWords = {
    val parsed = WakeWords.parseIfChanged(wakeWordsText, wakeWords)
    if (parsed != null) {
      viewModel.setWakeWords(parsed)
    }
  }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val cameraOk = perms[Manifest.permission.CAMERA] == true
      viewModel.setCameraEnabled(cameraOk)
    }

  var pendingLocationMode by remember { mutableStateOf<LocationMode?>(null) }
  var pendingPreciseToggle by remember { mutableStateOf(false) }

  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val fineOk = perms[Manifest.permission.ACCESS_FINE_LOCATION] == true
      val coarseOk = perms[Manifest.permission.ACCESS_COARSE_LOCATION] == true
      val granted = fineOk || coarseOk
      val requestedMode = pendingLocationMode
      pendingLocationMode = null

      if (pendingPreciseToggle) {
        pendingPreciseToggle = false
        viewModel.setLocationPreciseEnabled(fineOk)
        return@rememberLauncherForActivityResult
      }

      if (!granted) {
        viewModel.setLocationMode(LocationMode.Off)
        return@rememberLauncherForActivityResult
      }

      if (requestedMode != null) {
        viewModel.setLocationMode(requestedMode)
        if (requestedMode == LocationMode.Always) {
          val backgroundOk =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
              PackageManager.PERMISSION_GRANTED
          if (!backgroundOk) {
            openAppSettings(context)
          }
        }
      }
    }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
      // Status text is handled by NodeRuntime.
    }

  val smsPermissionAvailable =
    remember {
      context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }
  var smsPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val smsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      smsPermissionGranted = granted
      viewModel.refreshGatewayConnection()
    }

  fun setCameraEnabledChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setCameraEnabled(false)
      return
    }

    val cameraOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
    if (cameraOk) {
      viewModel.setCameraEnabled(true)
    } else {
      permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
    }
  }

  fun requestLocationPermissions(targetMode: LocationMode) {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk || coarseOk) {
      viewModel.setLocationMode(targetMode)
      if (targetMode == LocationMode.Always) {
        val backgroundOk =
          ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!backgroundOk) {
          openAppSettings(context)
        }
      }
    } else {
      pendingLocationMode = targetMode
      locationPermissionLauncher.launch(
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
      )
    }
  }

  fun setPreciseLocationChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setLocationPreciseEnabled(false)
      return
    }
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk) {
      viewModel.setLocationPreciseEnabled(true)
    } else {
      pendingPreciseToggle = true
      locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION))
    }
  }

  val visibleGateways =
    if (isConnected && remoteAddress != null) {
      gateways.filterNot { "${it.host}:${it.port}" == remoteAddress }
    } else {
      gateways
    }

  val gatewayDiscoveryFooterText =
    if (visibleGateways.isEmpty()) {
      discoveryStatusText
    } else if (isConnected) {
      "发现已开启 · 另有 ${visibleGateways.size} 个网关"
    } else {
      "发现已开启 · 共 ${visibleGateways.size} 个网关"
    }

  LazyColumn(
    state = listState,
    modifier =
      Modifier
        .fillMaxWidth()
        .fillMaxHeight()
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    // Order parity: Node → Gateway → Voice → Camera → Messaging → Location → Screen.
    item { Text("节点", style = MaterialTheme.typography.titleSmall) }
    item {
      OutlinedTextField(
        value = displayName,
        onValueChange = viewModel::setDisplayName,
        label = { Text("名称") },
        modifier = Modifier.fillMaxWidth(),
      )
    }
    item { Text("实例 ID：$instanceId", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    item { Text("设备：$deviceModel", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    item { Text("版本：$appVersion", color = MaterialTheme.colorScheme.onSurfaceVariant) }

    item { HorizontalDivider() }

    // Gateway
    item { Text("网关", style = MaterialTheme.typography.titleSmall) }
    item { ListItem(headlineContent = { Text("状态") }, supportingContent = { Text(statusText) }) }
    item {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        Text("连接模式", style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
              selected = connectionMode == "ws",
              onClick = { viewModel.setConnectionMode("ws") },
            )
            Text("WebSocket（发现）", modifier = Modifier.clickable { viewModel.setConnectionMode("ws") })
          }
          Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
              selected = connectionMode == "mqtt",
              onClick = { viewModel.setConnectionMode("mqtt") },
            )
            Text("MQTT", modifier = Modifier.clickable { viewModel.setConnectionMode("mqtt") })
          }
        }
      }
    }
    if (serverName != null) {
      item { ListItem(headlineContent = { Text("服务器") }, supportingContent = { Text(serverName!!) }) }
    }
    if (remoteAddress != null) {
      item { ListItem(headlineContent = { Text("地址") }, supportingContent = { Text(remoteAddress!!) }) }
    }
    item {
      if (isConnected && remoteAddress != null) {
        Button(
          onClick = {
            viewModel.disconnect()
            NodeForegroundService.stop(context)
          },
        ) {
          Text("断开连接")
        }
      }
    }

    item { HorizontalDivider() }

    if (!isConnected || visibleGateways.isNotEmpty()) {
      item {
        Text(
          if (isConnected) "其他网关" else "已发现网关",
          style = MaterialTheme.typography.titleSmall,
        )
      }
      if (!isConnected && visibleGateways.isEmpty()) {
        item { Text("暂未发现网关。", color = MaterialTheme.colorScheme.onSurfaceVariant) }
      } else {
        items(items = visibleGateways, key = { it.stableId }) { gateway ->
          val detailLines =
            buildList {
              add("IP: ${gateway.host}:${gateway.port}")
              gateway.lanHost?.let { add("LAN: $it") }
              gateway.tailnetDns?.let { add("Tailnet: $it") }
              if (gateway.gatewayPort != null || gateway.canvasPort != null) {
                val gw = (gateway.gatewayPort ?: gateway.port).toString()
                val canvas = gateway.canvasPort?.toString() ?: "—"
                add("Ports: gw $gw · canvas $canvas")
              }
            }
          ListItem(
            headlineContent = { Text(gateway.name) },
            supportingContent = {
              Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                detailLines.forEach { line ->
                  Text(line, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
              }
            },
            trailingContent = {
              Button(
                onClick = {
                  NodeForegroundService.start(context)
                  viewModel.connect(gateway)
                },
              ) {
                Text("连接")
              }
            },
          )
        }
      }
      item {
        Text(
          gatewayDiscoveryFooterText,
          modifier = Modifier.fillMaxWidth(),
          textAlign = TextAlign.Center,
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }

    item { HorizontalDivider() }

    item {
      ListItem(
        headlineContent = { Text("高级") },
        supportingContent = { Text("手动连接网关") },
        trailingContent = {
          Icon(
            imageVector = if (advancedExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
            contentDescription = if (advancedExpanded) "收起" else "展开",
          )
        },
        modifier =
          Modifier.clickable {
            setAdvancedExpanded(!advancedExpanded)
          },
      )
    }
    item {
      AnimatedVisibility(visible = advancedExpanded) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
          if (connectionMode == "mqtt") {
            val mqttStatusText =
              when (mqttConnectionState) {
                is MqttConnectionState.Disconnected -> "离线"
                is MqttConnectionState.Connecting -> "连接中…"
                is MqttConnectionState.Connected -> "已连接"
                is MqttConnectionState.Error -> "错误: ${(mqttConnectionState as MqttConnectionState.Error).message}"
              }
            ListItem(
              headlineContent = { Text("MQTT 状态") },
              supportingContent = { Text(mqttStatusText, color = MaterialTheme.colorScheme.onSurfaceVariant) },
            )
            OutlinedTextField(
              value = mqttBrokerUrl,
              onValueChange = viewModel::setMqttBrokerUrl,
              label = { Text("Broker 地址") },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              placeholder = { Text("tcp://主机:1883 或 ssl://主机:8883") },
            )
            OutlinedTextField(
              value = mqttUsername,
              onValueChange = viewModel::setMqttUsername,
              label = { Text("用户名（选填）") },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
            )
            OutlinedTextField(
              value = mqttPassword,
              onValueChange = viewModel::setMqttPassword,
              label = { Text("密码（选填）") },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
            )
            OutlinedTextField(
              value = mqttClientId,
              onValueChange = viewModel::setMqttClientId,
              label = { Text("客户端 ID（选填，默认用实例 ID）") },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
            )
            val brokerOk = mqttBrokerUrl.trim().isNotEmpty()
            Button(
              onClick = {
                NodeForegroundService.start(context)
                viewModel.connectManual()
              },
              enabled = brokerOk,
            ) {
              Text("连接 (MQTT)")
            }
          } else {
            ListItem(
              headlineContent = { Text("使用手动网关") },
              supportingContent = { Text("发现被阻断时使用。") },
              trailingContent = { Switch(checked = manualEnabled, onCheckedChange = viewModel::setManualEnabled) },
            )

            OutlinedTextField(
              value = manualHost,
              onValueChange = viewModel::setManualHost,
              label = { Text("主机") },
              modifier = Modifier.fillMaxWidth(),
              enabled = manualEnabled,
            )
            OutlinedTextField(
              value = manualPort.toString(),
              onValueChange = { v -> viewModel.setManualPort(v.toIntOrNull() ?: 0) },
              label = { Text("端口") },
              modifier = Modifier.fillMaxWidth(),
              enabled = manualEnabled,
            )
            ListItem(
              headlineContent = { Text("要求 TLS") },
              supportingContent = { Text("首次连接时固定网关证书。") },
              trailingContent = { Switch(checked = manualTls, onCheckedChange = viewModel::setManualTls, enabled = manualEnabled) },
              modifier = Modifier.alpha(if (manualEnabled) 1f else 0.5f),
            )

            val hostOk = manualHost.trim().isNotEmpty()
            val portOk = manualPort in 1..65535
            Button(
              onClick = {
                NodeForegroundService.start(context)
                viewModel.connectManual()
              },
              enabled = manualEnabled && hostOk && portOk,
            ) {
              Text("连接（手动）")
            }
          }
        }
      }
    }

    item { HorizontalDivider() }

    // Voice
    item { Text("语音", style = MaterialTheme.typography.titleSmall) }
    item {
      val enabled = voiceWakeMode != VoiceWakeMode.Off
      ListItem(
        headlineContent = { Text("语音唤醒") },
        supportingContent = { Text(voiceWakeStatusText) },
        trailingContent = {
          Switch(
            checked = enabled,
            onCheckedChange = { on ->
              if (on) {
                val micOk =
                  ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                viewModel.setVoiceWakeMode(VoiceWakeMode.Foreground)
              } else {
                viewModel.setVoiceWakeMode(VoiceWakeMode.Off)
              }
            },
          )
        },
      )
    }
    item {
      AnimatedVisibility(visible = voiceWakeMode != VoiceWakeMode.Off) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
          ListItem(
            headlineContent = { Text("仅前台") },
            supportingContent = { Text("仅在 Moltbot 打开时聆听。") },
            trailingContent = {
              RadioButton(
                selected = voiceWakeMode == VoiceWakeMode.Foreground,
                onClick = {
                  val micOk =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                      PackageManager.PERMISSION_GRANTED
                  if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  viewModel.setVoiceWakeMode(VoiceWakeMode.Foreground)
                },
              )
            },
          )
          ListItem(
            headlineContent = { Text("始终") },
            supportingContent = { Text("后台持续聆听（会显示常驻通知）。") },
            trailingContent = {
              RadioButton(
                selected = voiceWakeMode == VoiceWakeMode.Always,
                onClick = {
                  val micOk =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                      PackageManager.PERMISSION_GRANTED
                  if (!micOk) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  viewModel.setVoiceWakeMode(VoiceWakeMode.Always)
                },
              )
            },
          )
        }
      }
    }
    item {
      OutlinedTextField(
        value = wakeWordsText,
        onValueChange = setWakeWordsText,
        label = { Text("唤醒词（逗号分隔）") },
        modifier =
          Modifier.fillMaxWidth().onFocusChanged { focusState ->
            if (focusState.isFocused) {
              wakeWordsHadFocus = true
            } else if (wakeWordsHadFocus) {
              wakeWordsHadFocus = false
              commitWakeWords()
            }
          },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions =
          KeyboardActions(
            onDone = {
              commitWakeWords()
              focusManager.clearFocus()
            },
          ),
      )
    }
    item { Button(onClick = viewModel::resetWakeWordsDefaults) { Text("恢复默认") } }
    item {
      Text(
        if (isConnected) {
          "任意节点可编辑唤醒词，变更会经网关同步。"
        } else {
          "连接网关后可全局同步唤醒词。"
        },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Camera
    item { Text("相机", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("允许相机") },
        supportingContent = { Text("允许网关请求拍照或短视频（仅前台）。") },
        trailingContent = { Switch(checked = cameraEnabled, onCheckedChange = ::setCameraEnabledChecked) },
      )
    }
    item {
      Text(
        "提示：需要麦克风权限才能录制带声音的视频。",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Messaging
    item { Text("短信", style = MaterialTheme.typography.titleSmall) }
    item {
      val buttonLabel =
        when {
          !smsPermissionAvailable -> "不可用"
          smsPermissionGranted -> "管理"
          else -> "授权"
        }
      ListItem(
        headlineContent = { Text("短信权限") },
        supportingContent = {
          Text(
            if (smsPermissionAvailable) {
              "允许网关从此设备发送短信。"
            } else {
              "短信功能需要设备支持电话功能。"
            },
          )
        },
        trailingContent = {
          Button(
            onClick = {
              if (!smsPermissionAvailable) return@Button
              if (smsPermissionGranted) {
                openAppSettings(context)
              } else {
                smsPermissionLauncher.launch(Manifest.permission.SEND_SMS)
              }
            },
            enabled = smsPermissionAvailable,
          ) {
            Text(buttonLabel)
          }
        },
      )
    }

    item { HorizontalDivider() }

    // Location
    item { Text("位置", style = MaterialTheme.typography.titleSmall) }
    item {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        ListItem(
          headlineContent = { Text("关闭") },
          supportingContent = { Text("不共享位置。") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.Off,
              onClick = { viewModel.setLocationMode(LocationMode.Off) },
            )
          },
        )
        ListItem(
          headlineContent = { Text("使用期间") },
          supportingContent = { Text("仅在 Moltbot 打开时。") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.WhileUsing,
              onClick = { requestLocationPermissions(LocationMode.WhileUsing) },
            )
          },
        )
        ListItem(
          headlineContent = { Text("始终") },
          supportingContent = { Text("允许后台位置（需系统权限）。") },
          trailingContent = {
            RadioButton(
              selected = locationMode == LocationMode.Always,
              onClick = { requestLocationPermissions(LocationMode.Always) },
            )
          },
        )
      }
    }
    item {
      ListItem(
        headlineContent = { Text("精确位置") },
        supportingContent = { Text("在可用时使用精确 GPS。") },
        trailingContent = {
          Switch(
            checked = locationPreciseEnabled,
            onCheckedChange = ::setPreciseLocationChecked,
            enabled = locationMode != LocationMode.Off,
          )
        },
      )
    }
    item {
      Text(
        "「始终」可能需在系统设置中允许后台位置。",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    // Screen
    item { Text("屏幕", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("防止息屏") },
        supportingContent = { Text("Moltbot 打开时保持屏幕常亮。") },
        trailingContent = { Switch(checked = preventSleep, onCheckedChange = viewModel::setPreventSleep) },
      )
    }

    item { HorizontalDivider() }

    // Debug
    item { Text("调试", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("调试画布状态") },
        supportingContent = { Text("调试开启时在画布中显示状态文字。") },
        trailingContent = {
          Switch(
            checked = canvasDebugStatusEnabled,
            onCheckedChange = viewModel::setCanvasDebugStatusEnabled,
          )
        },
      )
    }

    item { Spacer(modifier = Modifier.height(20.dp)) }
  }
}

private fun openAppSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    )
  context.startActivity(intent)
}
