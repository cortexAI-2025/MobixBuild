package com.mobixbuild.client.api

import android.content.Context
import com.mobixbuild.client.BuildConfig
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

interface ApiService {

    @Multipart
    @POST("build")
    suspend fun startBuild(
        @Part("repoUrl")  repoUrl: RequestBody?,
        @Part             archive: MultipartBody.Part?,
        @Part("mode")     mode: RequestBody,
    ): BuildResponse

    @GET("build/{id}/status")
    suspend fun getStatus(@Path("id") id: String): BuildStatus

    @POST("build/{id}/cancel")
    suspend fun cancel(@Path("id") id: String): retrofit2.Response<Unit>

    @GET("health")
    suspend fun health(): Health
}

/**
 * Server URL and API token are chosen at runtime (Settings panel) and persisted,
 * so one APK works against an emulator, a LAN machine or a hosted server.
 */
object Api {
    private const val PREFS     = "mobixbuild"
    private const val KEY_URL   = "server_url"
    private const val KEY_TOKEN = "api_token"

    var baseUrl: String = BuildConfig.API_BASE_URL
        private set
    var token: String = ""
        private set

    private var cachedService: ApiService? = null
    private var cachedClient: OkHttpClient? = null

    fun init(context: Context) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        baseUrl = p.getString(KEY_URL, null) ?: BuildConfig.API_BASE_URL
        token   = p.getString(KEY_TOKEN, null) ?: ""
    }

    fun save(context: Context, url: String, newToken: String) {
        baseUrl = normalize(url)
        token   = newToken.trim()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, baseUrl)
            .putString(KEY_TOKEN, token)
            .apply()
        cachedService = null
        cachedClient  = null
    }

    fun normalize(url: String): String {
        val u = url.trim().trimEnd('/')
        return if (u.startsWith("http://") || u.startsWith("https://")) u else "http://$u"
    }

    private fun client(): OkHttpClient = cachedClient ?: OkHttpClient.Builder()
        .addInterceptor { chain ->
            val req = chain.request()
            chain.proceed(
                if (token.isEmpty()) req
                else req.newBuilder().header("Authorization", "Bearer $token").build()
            )
        }
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(300, TimeUnit.SECONDS)
        .build()
        .also { cachedClient = it }

    val service: ApiService
        get() = cachedService ?: Retrofit.Builder()
            .baseUrl("$baseUrl/")
            .client(client())
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
            .also { cachedService = it }

    /** Browser-friendly link (the token travels as a query parameter). */
    fun downloadUrl(buildId: String): String {
        val base = "$baseUrl/build/$buildId/download"
        return if (token.isEmpty()) base else "$base?token=${URLEncoder.encode(token, "UTF-8")}"
    }

    /** Streams the artifact to [dest] with the auth header. Blocking — call on Dispatchers.IO. */
    fun download(buildId: String, dest: File) {
        val req = Request.Builder().url("$baseUrl/build/$buildId/download").build()
        client().newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}: ${res.body?.string()?.take(200)}")
            val body = res.body ?: throw IOException("Empty response")
            dest.outputStream().use { out -> body.byteStream().copyTo(out) }
        }
    }

    /** Turns Retrofit/network exceptions into a message a user can act on. */
    fun describe(e: Throwable): String = when (e) {
        is retrofit2.HttpException -> {
            val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val msg = body?.let { Regex("\"error\"\\s*:\\s*\"([^\"]*)\"").find(it)?.groupValues?.get(1) }
            when (e.code()) {
                401  -> "Invalid or missing API token (⚙ Settings)"
                else -> msg ?: "Server error ${e.code()}"
            }
        }
        is java.net.ConnectException,
        is java.net.UnknownHostException,
        is java.net.SocketTimeoutException -> "Cannot reach $baseUrl — check the server URL in ⚙ Settings"
        else -> e.message ?: e.javaClass.simpleName
    }
}
