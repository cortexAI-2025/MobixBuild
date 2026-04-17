package com.mobixbuild.client.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobixbuild.client.api.Api
import com.mobixbuild.client.api.BuildMode
import com.mobixbuild.client.api.BuildStatus
import com.mobixbuild.client.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream

@Composable
fun BuildScreen(
    repoUrl:  String?,
    fileUri:  Uri?,
    mode:     BuildMode,
    onSuccess: (buildId: String, mode: BuildMode) -> Unit,
    onFailed:  () -> Unit,
) {
    val context = LocalContext.current

    var buildId   by remember { mutableStateOf<String?>(null) }
    var status    by remember { mutableStateOf<BuildStatus?>(null) }
    var submitErr by remember { mutableStateOf<String?>(null) }

    // Fake progress tracking
    var progress  by remember { mutableStateOf(0f) }
    var elapsed   by remember { mutableStateOf(0) }

    val listState = rememberLazyListState()

    // Auto-scroll logs
    LaunchedEffect(status?.logs?.size) {
        val size = status?.logs?.size ?: return@LaunchedEffect
        if (size > 0) listState.animateScrollToItem(size - 1)
    }

    // ── Submit build & poll ───────────────────────────────────────────────────
    LaunchedEffect(Unit) {
        // Submit
        try {
            val modeBody = mode.id.toRequestBody("text/plain".toMediaTypeOrNull())
            val repoBody = repoUrl?.toRequestBody("text/plain".toMediaTypeOrNull())

            var archivePart: MultipartBody.Part? = null
            if (fileUri != null) {
                val tmp = File(context.cacheDir, "upload.zip")
                context.contentResolver.openInputStream(fileUri)?.use { input ->
                    FileOutputStream(tmp).use { output -> input.copyTo(output) }
                }
                archivePart = MultipartBody.Part.createFormData(
                    "archive", "archive.zip",
                    tmp.asRequestBody("application/zip".toMediaTypeOrNull())
                )
            }

            val res = Api.service.startBuild(repoBody, archivePart, modeBody)
            buildId = res.id
        } catch (e: Exception) {
            submitErr = "Failed to start build: ${e.message}"
            return@LaunchedEffect
        }

        // Elapsed timer
        val id = buildId ?: return@LaunchedEffect
        val startMs = System.currentTimeMillis()
        val totalSecs = mode.estSeconds.toFloat()

        // Poll loop
        while (isActive) {
            try {
                val s = Api.service.getStatus(id)
                status = s
                elapsed = ((System.currentTimeMillis() - startMs) / 1000).toInt()
                val ticks = elapsed.toFloat()
                progress = minOf(0.92f, 1f - Math.exp((-3.0 * ticks / totalSecs).toDouble()).toFloat())

                when (s.status) {
                    "success" -> { progress = 1f; onSuccess(id, mode); return@LaunchedEffect }
                    "failed"  -> { onFailed(); return@LaunchedEffect }
                }
            } catch (_: Exception) {}
            delay(2000)
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDeep)
            .padding(horizontal = 20.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Header
        Text(
            "${mode.label} Build",
            style      = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color      = TextPri,
        )

        submitErr?.let { err ->
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

        // Status badge
        val currentStatus = status?.status ?: "connecting"
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val (dot, label) = when (currentStatus) {
                "queued"  -> MBlue to "Queued"
                "running" -> Warning to "Running"
                "success" -> Success to "Success"
                "failed"  -> Danger to "Failed"
                else      -> TextMuted to "Connecting…"
            }
            Box(Modifier.size(8.dp).background(dot, RoundedCornerShape(50)))
            Text(label, color = dot, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }

        // Build ID
        buildId?.let { id ->
            Text(
                id,
                color  = TextMuted,
                style  = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
        }

        // Progress bar
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .background(BgCard, RoundedCornerShape(3.dp))
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(progress)
                        .height(6.dp)
                        .background(
                            Brush.horizontalGradient(listOf(MBlue, MViolet)),
                            RoundedCornerShape(3.dp)
                        )
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text("${(progress * 100).toInt()}%", color = TextMuted, style = MaterialTheme.typography.labelSmall)
                val rem = maxOf(0, mode.estSeconds - elapsed)
                Text("~${rem / 60}m ${rem % 60}s remaining", color = TextMuted, style = MaterialTheme.typography.labelSmall)
            }
        }

        // Terminal log viewer
        Card(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            shape    = RoundedCornerShape(16.dp),
            colors   = CardDefaults.cardColors(containerColor = Color(0xFF0D1117)),
        ) {
            Column {
                // Terminal chrome
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(Modifier.size(10.dp).background(Color(0xFFFF5F57), RoundedCornerShape(50)))
                    Box(Modifier.size(10.dp).background(Color(0xFFFFBD2E), RoundedCornerShape(50)))
                    Box(Modifier.size(10.dp).background(Color(0xFF28C840), RoundedCornerShape(50)))
                    Spacer(Modifier.weight(1f))
                    Text("build output", color = TextMuted.copy(alpha = 0.5f), fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }

                Divider(color = BgCard, thickness = 1.dp)

                val logs = status?.logs ?: emptyList()
                if (logs.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Waiting for build…", color = TextMuted, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    }
                } else {
                    LazyColumn(
                        state    = listState,
                        modifier = Modifier.fillMaxSize().padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        items(logs) { line ->
                            val color = when {
                                line.contains("ERROR", true) || line.contains("[ERR]") -> Danger.copy(0.9f)
                                line.contains("success", true) || line.contains("BUILD SUCCESS") -> Success.copy(0.9f)
                                line.contains("[MOBIXBUILD]") -> MBlue.copy(0.9f)
                                line.contains("WARNING", true) -> Warning.copy(0.8f)
                                else -> TextPri.copy(alpha = 0.7f)
                            }
                            Text(
                                line,
                                color      = color,
                                fontSize   = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                lineHeight = 16.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}
