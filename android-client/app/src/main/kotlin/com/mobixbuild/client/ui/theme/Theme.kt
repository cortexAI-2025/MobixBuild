package com.mobixbuild.client.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val BgDeep     = Color(0xFF0B0F1A)
val BgSurface  = Color(0xFF111827)
val BgCard     = Color(0xFF1A2235)
val MBlue      = Color(0xFF2563EB)
val MViolet    = Color(0xFF7C3AED)
val TextPri    = Color(0xFFF5F7FA)
val TextMuted  = Color(0xFF6B7280)
val Success    = Color(0xFF22C55E)
val Danger     = Color(0xFFEF4444)
val Warning    = Color(0xFFF59E0B)

private val MobixColorScheme = darkColorScheme(
    background        = BgDeep,
    surface           = BgSurface,
    primary           = MBlue,
    secondary         = MViolet,
    onBackground      = TextPri,
    onSurface         = TextPri,
    onPrimary         = Color.White,
)

@Composable
fun MobixBuildTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MobixColorScheme,
        content     = content,
    )
}
