package com.mobixbuild.client

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.mobixbuild.client.api.Api
import com.mobixbuild.client.api.BuildMode
import com.mobixbuild.client.ui.theme.*
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import java.net.URL

// ─── State ────────────────────────────────────────────────────────────────────

sealed class Screen {
    object Idle    : Screen()
    object Building: Screen()
    object Success : Screen()
    object Failed  : Screen()
}

// ─── Activity ─────────────────────────────────────────────────────────────────

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MobixBuildTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = BgDeep) {
                    MobixBuildApp()
                }
            }
        }
    }
}

// ─── Main composable (single screen) ─────────────────────────────────────────

@Composable
fun MobixBuildApp() {
    val context    = LocalContext.current
    val focus      = LocalFocusManager.current
    val scope      = rememberCoroutineScope()

    // ── State ────────────────────────────────────────────────────────────────
    var screen     by remember { mutableStateOf<Screen>(Screen.Idle) }
    var repoUrl    by remember { mutableStateOf("") }
    var fileUri    by remember { mutableStateOf<Uri?>(null) }
    var fileName   by remember { mutableStateOf("") }
    var mode       by remember { mutableStateOf(BuildMode.QUICK) }
    var buildId    by remember { mutableStateOf("") }
    var logs       by remember { mutableStateOf(listOf<String>()) }
    var progress   by remember { mutableStateOf(0f) }
    var elapsed    by remember { mutableStateOf(0) }
    var localApk   by remember { mutableStateOf<File?>(null) }
    var error      by remember { mutableStateOf("") }

    val logState   = rememberLazyListState()
    var pollJob    by remember { mutableStateOf<Job?>(null) }

    // Auto-scroll logs
    LaunchedEffect(logs.size) {
        if (logs.isNotEmpty()) logState.animateScrollToItem(logs.size - 1)
    }

    // File picker
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { fileUri = it; fileName = it.lastPathSegment ?: "archive.zip" }
    }

    // ── Build logic ──────────────────────────────────────────────────────────
    fun startBuild() {
        focus.clearFocus()
        val url = repoUrl.trim().ifEmpty { null }
        if (url == null && fileUri == null) { error = "Enter a GitHub URL or pick a ZIP file"; return }

        error = ""
        screen = Screen.Building
        logs = listOf()
        progress = 0f
        elapsed = 0
        localApk = null

        pollJob = scope.launch {
            // Submit
            val id = try {
                val modeBody    = mode.id.toRequestBody("text/plain".toMediaTypeOrNull())
                val repoBody    = url?.toRequestBody("text/plain".toMediaTypeOrNull())
                var archivePart: MultipartBody.Part? = null
                if (fileUri != null) {
                    val tmp = File(context.cacheDir, "upload_${System.currentTimeMillis()}.zip")
                    context.contentResolver.openInputStream(fileUri!!)?.use { i ->
                        FileOutputStream(tmp).use { o -> i.copyTo(o) }
                    }
                    archivePart = MultipartBody.Part.createFormData(
                        "archive", "archive.zip",
                        tmp.asRequestBody("application/zip".toMediaTypeOrNull())
                    )
                }
                Api.service.startBuild(repoBody, archivePart, modeBody).id
            } catch (e: Exception) {
                error = e.message ?: "Submit failed"
                screen = Screen.Failed
                return@launch
            }

            buildId = id
            val startMs = System.currentTimeMillis()
            val totalSecs = mode.estSeconds.toFloat()

            // Poll loop
            while (isActive) {
                delay(2000)
                try {
                    val s = Api.service.getStatus(id)
                    logs = s.logs
                    elapsed = ((System.currentTimeMillis() - startMs) / 1000).toInt()
                    progress = minOf(0.92f,
                        (1f - Math.exp((-3.0 * elapsed / totalSecs).toDouble()).toFloat()))

                    when (s.status) {
                        "success" -> { progress = 1f; screen = Screen.Success; return@launch }
                        "failed"  -> { screen = Screen.Failed; return@launch }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    fun reset() {
        pollJob?.cancel()
        screen = Screen.Idle
        buildId = ""; logs = listOf(); progress = 0f; elapsed = 0; error = ""
    }

    fun downloadApk() {
        scope.launch {
            try {
                val dest = File(context.cacheDir, "mobixbuild_${buildId.take(8)}${ if (mode == BuildMode.STORE) ".aab" else ".apk" }")
                withContext(Dispatchers.IO) {
                    URL("${BuildConfig.API_BASE_URL}/build/$buildId/download")
                        .openStream().use { i -> FileOutputStream(dest).use { o -> i.copyTo(o) } }
                }
                localApk = dest
                Toast.makeText(context, "Downloaded: ${dest.name}", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun installApk(file: File) {
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.provider", file)
            context.startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (e: Exception) {
            Toast.makeText(context, "Install error: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDeep)
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {

        Spacer(Modifier.height(8.dp))

        // Header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier
                    .size(36.dp)
                    .background(Brush.linearGradient(listOf(MViolet, MBlue)), RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center
            ) { Text("M", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
            Text("MobixBuild", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = TextPri)
            Spacer(Modifier.weight(1f))
            if (screen != Screen.Idle) {
                TextButton(onClick = ::reset) { Text("← New", color = TextMuted, fontSize = 13.sp) }
            }
        }

        HorizontalDivider(color = BgCard, thickness = 1.dp)

        // ── INPUT (only visible when idle) ────────────────────────────────────
        AnimatedVisibility(screen == Screen.Idle, enter = fadeIn(), exit = fadeOut()) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {

                // URL input
                OutlinedTextField(
                    value         = repoUrl,
                    onValueChange = { repoUrl = it },
                    modifier      = Modifier.fillMaxWidth(),
                    placeholder   = { Text("GitHub repo URL", color = TextMuted, fontSize = 13.sp) },
                    singleLine    = true,
                    label         = { Text("Repository", color = TextMuted, fontSize = 12.sp) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                    shape  = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor   = MBlue,
                        unfocusedBorderColor = BgCard,
                        focusedTextColor     = TextPri,
                        unfocusedTextColor   = TextPri,
                        cursorColor          = MBlue,
                        focusedLabelColor    = MBlue,
                        unfocusedLabelColor  = TextMuted,
                    ),
                )

                // File picker row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, if (fileUri != null) Success.copy(.4f) else BgCard, RoundedCornerShape(12.dp))
                        .clickable { filePicker.launch("application/zip") }
                        .padding(12.dp),
                    verticalAlignment   = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(if (fileUri != null) "📦" else "📂", fontSize = 20.sp)
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (fileUri != null) fileName else "Pick ZIP archive (optional)",
                            color = if (fileUri != null) TextPri else TextMuted,
                            fontSize = 13.sp,
                            fontWeight = if (fileUri != null) FontWeight.Medium else FontWeight.Normal,
                        )
                        if (fileUri != null)
                            Text("tap to change", color = TextMuted, fontSize = 11.sp)
                    }
                    if (fileUri != null) {
                        Text("✕", color = TextMuted, fontSize = 16.sp,
                            modifier = Modifier.clickable { fileUri = null; fileName = "" })
                    }
                }

                // Mode selector
                Text("Mode", color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    letterSpacing = 1.sp, modifier = Modifier.padding(top = 4.dp))

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BuildMode.entries.forEach { m ->
                        val sel = mode == m
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .border(
                                    1.dp,
                                    if (sel) MBlue.copy(.7f) else BgCard,
                                    RoundedCornerShape(12.dp)
                                )
                                .background(
                                    if (sel) MBlue.copy(.1f) else BgSurface,
                                    RoundedCornerShape(12.dp)
                                )
                                .clickable { mode = m }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(when (m) { BuildMode.QUICK -> "⚡"; BuildMode.PRODUCTION -> "🔒"; BuildMode.STORE -> "🚀" }, fontSize = 18.sp)
                                Text(m.label, color = if (sel) MBlue else TextMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }

                // Error
                if (error.isNotEmpty()) {
                    Text(error, color = Danger, fontSize = 12.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Danger.copy(.08f), RoundedCornerShape(10.dp))
                            .padding(10.dp))
                }

                // Build button
                Button(
                    onClick   = ::startBuild,
                    modifier  = Modifier.fillMaxWidth().height(50.dp),
                    shape     = RoundedCornerShape(14.dp),
                    colors    = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Brush.horizontalGradient(listOf(MBlue, MViolet)), RoundedCornerShape(14.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("Build Now →", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    }
                }
            }
        }

        // ── STATUS BAR (visible while building or done) ───────────────────────
        AnimatedVisibility(screen != Screen.Idle) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {

                // Status chip + timer
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val (dot, label, dotColor) = when (screen) {
                        Screen.Building -> Triple("●", "Building…", MBlue)
                        Screen.Success  -> Triple("●", "Success",   Success)
                        Screen.Failed   -> Triple("●", "Failed",    Danger)
                        else -> Triple("●", "", TextMuted)
                    }
                    Text(dot, color = dotColor, fontSize = 10.sp)
                    Text(label, color = dotColor, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Spacer(Modifier.weight(1f))
                    val m = elapsed / 60; val s = elapsed % 60
                    Text(String.format("%d:%02d", m, s), color = TextMuted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }

                // Progress bar
                Box(Modifier.fillMaxWidth().height(4.dp).background(BgCard, RoundedCornerShape(2.dp))) {
                    Box(
                        Modifier
                            .fillMaxWidth(progress)
                            .height(4.dp)
                            .background(Brush.horizontalGradient(listOf(MBlue, MViolet)), RoundedCornerShape(2.dp))
                    )
                }

                if (buildId.isNotEmpty()) {
                    Text(buildId, color = TextMuted.copy(.5f), fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }
            }
        }

        // ── LOG TERMINAL (visible while building or done) ─────────────────────
        AnimatedVisibility(screen != Screen.Idle, modifier = Modifier.weight(1f)) {
            Card(
                modifier = Modifier.fillMaxSize(),
                shape    = RoundedCornerShape(14.dp),
                colors   = CardDefaults.cardColors(containerColor = Color(0xFF0D1117)),
            ) {
                Column {
                    // Terminal chrome bar
                    Row(
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Box(Modifier.size(9.dp).background(Color(0xFFFF5F57), RoundedCornerShape(50)))
                        Box(Modifier.size(9.dp).background(Color(0xFFFFBD2E), RoundedCornerShape(50)))
                        Box(Modifier.size(9.dp).background(Color(0xFF28C840), RoundedCornerShape(50)))
                        Spacer(Modifier.weight(1f))
                        Text("stdout", color = TextMuted.copy(.3f), fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                    }
                    HorizontalDivider(color = BgCard.copy(.5f), thickness = .5.dp)

                    if (logs.isEmpty()) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Waiting…", color = TextMuted.copy(.4f), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                        }
                    } else {
                        LazyColumn(state = logState, modifier = Modifier.fillMaxSize().padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            items(logs) { line ->
                                Text(
                                    line,
                                    fontSize   = 10.sp,
                                    lineHeight = 14.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = when {
                                        line.contains("ERROR", true) || line.contains("[ERR]") -> Danger.copy(.9f)
                                        line.contains("success", true) || line.contains("BUILD SUCCESS") -> Success.copy(.9f)
                                        line.contains("[MOBIXBUILD]") -> MBlue.copy(.9f)
                                        line.contains("WARNING", true) -> Warning.copy(.8f)
                                        else -> TextPri.copy(.6f)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── ACTION BUTTONS (success state) ────────────────────────────────────
        AnimatedVisibility(screen == Screen.Success) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {

                Button(
                    onClick   = {
                        if (localApk != null) {
                            if (mode != BuildMode.STORE) installApk(localApk!!)
                            else context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse("${BuildConfig.API_BASE_URL}/build/$buildId/download"))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        } else {
                            downloadApk()
                        }
                    },
                    modifier  = Modifier.fillMaxWidth().height(48.dp),
                    shape     = RoundedCornerShape(12.dp),
                    colors    = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Brush.horizontalGradient(listOf(MBlue, MViolet)), RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            if (localApk != null && mode != BuildMode.STORE) "Install APK 📲"
                            else if (mode == BuildMode.STORE) "Download AAB ↓"
                            else "Download APK ↓",
                            color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp
                        )
                    }
                }

                if (localApk == null) {
                    OutlinedButton(
                        onClick  = { downloadApk() },
                        modifier = Modifier.fillMaxWidth().height(44.dp),
                        shape    = RoundedCornerShape(12.dp),
                        colors   = ButtonDefaults.outlinedButtonColors(contentColor = TextPri),
                    ) {
                        Text("Save to device", fontSize = 13.sp)
                    }
                }
            }
        }

        // ── RETRY (failed state) ──────────────────────────────────────────────
        AnimatedVisibility(screen == Screen.Failed) {
            Button(
                onClick  = ::reset,
                modifier = Modifier.fillMaxWidth().height(44.dp),
                shape    = RoundedCornerShape(12.dp),
                colors   = ButtonDefaults.buttonColors(containerColor = Danger.copy(.15f)),
            ) {
                Text("Try Again", color = Danger, fontWeight = FontWeight.SemiBold)
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}
