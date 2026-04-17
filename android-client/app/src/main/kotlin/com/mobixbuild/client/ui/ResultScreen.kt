package com.mobixbuild.client.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.mobixbuild.client.BuildConfig
import com.mobixbuild.client.api.BuildMode
import com.mobixbuild.client.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.URL

@Composable
fun ResultScreen(
    buildId:     String,
    mode:        BuildMode,
    onBuildAnother: () -> Unit,
) {
    val context = LocalContext.current

    var downloading by remember { mutableStateOf(false) }
    var downloadProgress by remember { mutableStateOf(0f) }
    var localApkFile by remember { mutableStateOf<File?>(null) }
    var downloadError by remember { mutableStateOf<String?>(null) }

    // Pulse animation for the success icon
    val pulse = rememberInfiniteTransition(label = "pulse")
    val scale by pulse.animateFloat(
        initialValue   = 1f,
        targetValue    = 1.08f,
        animationSpec  = infiniteRepeatable(
            animation  = tween(1000, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse
        ),
        label = "scale",
    )

    val ext = if (mode == BuildMode.STORE) ".aab" else ".apk"

    // Download artifact to local file
    suspend fun downloadFile(): File? {
        val url  = "${BuildConfig.API_BASE_URL}/build/$buildId/download"
        val dest = File(context.cacheDir, "mobixbuild-$buildId$ext")
        if (dest.exists()) return dest

        return withContext(Dispatchers.IO) {
            try {
                val conn = URL(url).openConnection()
                conn.connect()
                val total = conn.contentLength.toLong()
                conn.getInputStream().use { input ->
                    FileOutputStream(dest).use { output ->
                        val buf = ByteArray(8192)
                        var read: Int
                        var done = 0L
                        while (input.read(buf).also { read = it } != -1) {
                            output.write(buf, 0, read)
                            done += read
                            if (total > 0) downloadProgress = done.toFloat() / total
                        }
                    }
                }
                dest
            } catch (e: Exception) {
                downloadError = e.message
                null
            }
        }
    }

    // Install APK
    fun installApk(file: File) {
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.provider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(context, "Install failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    // Open in browser (fallback / AAB)
    fun openInBrowser() {
        val url = "${BuildConfig.API_BASE_URL}/build/$buildId/download"
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDeep)
            .padding(horizontal = 24.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {

        Spacer(Modifier.weight(1f))

        // Success icon
        Box(
            modifier = Modifier
                .size(96.dp)
                .scale(scale)
                .background(
                    Brush.radialGradient(listOf(Success.copy(0.25f), Color.Transparent)),
                    CircleShape
                ),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(72.dp)
                    .background(Success.copy(0.15f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("✓", fontSize = 32.sp, color = Success, fontWeight = FontWeight.Bold)
            }
        }

        // Title
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "Build Successful!",
                style      = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color      = TextPri,
            )
            Text(
                "${mode.label} artifact ready",
                color = TextMuted,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        // Info card
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape    = RoundedCornerShape(16.dp),
            colors   = CardDefaults.cardColors(containerColor = BgSurface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                InfoRow("Build ID", buildId.take(8) + "…")
                InfoRow("Mode",     mode.label)
                InfoRow("Output",   if (mode == BuildMode.STORE) ".aab bundle" else "signed .apk")
            }
        }

        // Download progress
        if (downloading && downloadProgress > 0f) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                LinearProgressIndicator(
                    progress          = { downloadProgress },
                    modifier          = Modifier.fillMaxWidth().height(4.dp),
                    color             = MBlue,
                    trackColor        = BgCard,
                )
                Text(
                    "${(downloadProgress * 100).toInt()}%",
                    color = TextMuted,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        }

        downloadError?.let { err ->
            Text(
                err,
                color  = Danger,
                style  = MaterialTheme.typography.bodySmall,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Danger.copy(0.1f), RoundedCornerShape(12.dp))
                    .padding(12.dp),
            )
        }

        Spacer(Modifier.weight(1f))

        // Action buttons
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {

            // Download button
            Button(
                onClick = {
                    if (localApkFile != null) {
                        if (mode != BuildMode.STORE) installApk(localApkFile!!)
                        else openInBrowser()
                    } else {
                        openInBrowser()
                    }
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape    = RoundedCornerShape(16.dp),
                colors   = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                contentPadding = PaddingValues(0.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Brush.linearGradient(listOf(MBlue, MViolet)), RoundedCornerShape(16.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (downloading) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Text(
                            if (mode == BuildMode.STORE) "Download .aab  ↓" else "Download APK  ↓",
                            color      = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize   = 15.sp,
                        )
                    }
                }
            }

            // Install directly (APK only, download first)
            if (mode != BuildMode.STORE) {
                OutlinedButton(
                    onClick = {
                        if (localApkFile != null) {
                            installApk(localApkFile!!)
                        } else {
                            downloading = true
                            downloadProgress = 0f
                            // Launch co-routine to download then install
                        }
                    },
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape    = RoundedCornerShape(16.dp),
                    border   = ButtonDefaults.outlinedButtonBorder,
                    colors   = ButtonDefaults.outlinedButtonColors(contentColor = TextPri),
                ) {
                    Text("Install on Device  📲", fontWeight = FontWeight.SemiBold)
                }
            }

            // Build another
            TextButton(
                onClick  = onBuildAnother,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("← Build Another", color = TextMuted)
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TextMuted, style = MaterialTheme.typography.bodySmall)
        Text(value, color = TextPri,   style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}
