package com.mobixbuild.client.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobixbuild.client.api.BuildMode
import com.mobixbuild.client.ui.theme.*

@Composable
fun HomeScreen(onBuildStart: (repoUrl: String?, fileUri: Uri?, mode: BuildMode) -> Unit) {
    val focusManager = LocalFocusManager.current

    var tab       by remember { mutableStateOf(0) }   // 0=URL, 1=ZIP
    var repoUrl   by remember { mutableStateOf("") }
    var fileUri   by remember { mutableStateOf<Uri?>(null) }
    var fileName  by remember { mutableStateOf("") }
    var mode      by remember { mutableStateOf(BuildMode.QUICK) }
    var error     by remember { mutableStateOf<String?>(null) }

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        uri?.let {
            fileUri  = it
            fileName = it.lastPathSegment ?: "archive.zip"
            tab      = 1
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDeep)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        // ── Logo ──────────────────────────────────────────────────────────────
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .background(
                        Brush.linearGradient(listOf(MViolet, MBlue)),
                        RoundedCornerShape(12.dp)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Text("M", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
            Text(
                buildString {
                    append("Mobix")
                    append("Build")
                },
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = TextPri,
            )
        }

        // ── Hero ──────────────────────────────────────────────────────────────
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "Build Mobile Apps.\nInstantly.",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = TextPri,
                lineHeight = 36.sp,
            )
            Text(
                "From repo to APK in one tap",
                style = MaterialTheme.typography.bodyMedium,
                color = TextMuted,
            )
        }

        // ── Input card ────────────────────────────────────────────────────────
        Card(
            shape  = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = BgSurface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {

                // Tab row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(BgCard, RoundedCornerShape(12.dp))
                        .padding(4.dp),
                ) {
                    listOf("🔗  GitHub URL", "📦  Upload ZIP").forEachIndexed { i, label ->
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .background(
                                    if (tab == i) BgSurface else Color.Transparent,
                                    RoundedCornerShape(10.dp)
                                )
                                .clickable { tab = i }
                                .padding(vertical = 8.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                label,
                                style    = MaterialTheme.typography.labelMedium,
                                color    = if (tab == i) TextPri else TextMuted,
                                fontWeight = if (tab == i) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }

                // Input area
                if (tab == 0) {
                    OutlinedTextField(
                        value         = repoUrl,
                        onValueChange = { repoUrl = it; error = null },
                        modifier      = Modifier.fillMaxWidth(),
                        placeholder   = { Text("https://github.com/user/repo", color = TextMuted, fontSize = 13.sp) },
                        singleLine    = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction    = ImeAction.Done
                        ),
                        keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
                        shape  = RoundedCornerShape(12.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor   = MBlue,
                            unfocusedBorderColor = BgCard,
                            focusedTextColor     = TextPri,
                            unfocusedTextColor   = TextPri,
                            cursorColor          = MBlue,
                        ),
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(100.dp)
                            .background(BgCard, RoundedCornerShape(12.dp))
                            .border(
                                BorderStroke(1.dp, if (fileUri != null) Success.copy(alpha = 0.5f) else TextMuted.copy(alpha = 0.2f)),
                                RoundedCornerShape(12.dp)
                            )
                            .clickable { filePicker.launch("application/zip") },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (fileUri != null) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("📦", fontSize = 24.sp)
                                Text(fileName, color = TextPri, style = MaterialTheme.typography.bodySmall)
                                Text("tap to change", color = TextMuted, style = MaterialTheme.typography.labelSmall)
                            }
                        } else {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("↑", fontSize = 28.sp, color = TextMuted)
                                Text("Tap to pick a .zip file", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }

        // ── Mode selector ─────────────────────────────────────────────────────
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "BUILD MODE",
                style      = MaterialTheme.typography.labelSmall,
                color      = TextMuted,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.SemiBold,
            )
            BuildMode.entries.forEach { m ->
                val selected = mode == m
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { mode = m },
                    shape  = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = if (selected) MBlue.copy(alpha = 0.1f) else BgSurface
                    ),
                    border = BorderStroke(1.dp, if (selected) MBlue.copy(alpha = 0.6f) else BgCard),
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        val icon = when (m) {
                            BuildMode.QUICK      -> "⚡"
                            BuildMode.PRODUCTION -> "🔒"
                            BuildMode.STORE      -> "🚀"
                        }
                        Text(icon, fontSize = 22.sp)
                        Column(Modifier.weight(1f)) {
                            Text(m.label, color = TextPri, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                            Text(m.badge, color = TextMuted, style = MaterialTheme.typography.labelSmall)
                        }
                        Text(
                            "~${m.estSeconds / 60}m",
                            color = TextMuted,
                            style = MaterialTheme.typography.labelSmall,
                        )
                        if (selected) {
                            Box(
                                modifier = Modifier
                                    .size(20.dp)
                                    .background(MBlue, RoundedCornerShape(50)),
                                contentAlignment = Alignment.Center
                            ) {
                                Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }

        // ── Error ─────────────────────────────────────────────────────────────
        AnimatedVisibility(error != null) {
            Text(
                error ?: "",
                color    = Danger,
                style    = MaterialTheme.typography.bodySmall,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Danger.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
                    .padding(12.dp),
            )
        }

        // ── CTA ───────────────────────────────────────────────────────────────
        Button(
            onClick = {
                focusManager.clearFocus()
                val url = repoUrl.trim().ifEmpty { null }
                if (url == null && fileUri == null) {
                    error = "Enter a GitHub URL or pick a ZIP file"
                    return@Button
                }
                onBuildStart(url, fileUri, mode)
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape  = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
            contentPadding = PaddingValues(0.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.linearGradient(listOf(MBlue, MViolet)),
                        RoundedCornerShape(16.dp)
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text("Build Now  →", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
            }
        }
    }
}
