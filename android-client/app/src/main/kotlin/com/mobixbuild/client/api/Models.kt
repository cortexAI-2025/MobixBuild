package com.mobixbuild.client.api

data class BuildResponse(
    val id: String,
    val status: String,
)

data class BuildStatus(
    val id: String,
    val status: String,   // queued | running | success | failed
    val mode: String,
    val logs: List<String> = emptyList(),
    val createdAt: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
)

enum class BuildMode(val id: String, val label: String, val badge: String, val estSeconds: Int) {
    QUICK("quick",      "Quick",       "Debug APK",  120),
    PRODUCTION("production", "Production", "Signed APK", 240),
    STORE("store",      "Play Store",  "AAB",        300),
}
