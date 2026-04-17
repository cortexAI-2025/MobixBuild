package com.mobixbuild.client.api

import com.mobixbuild.client.BuildConfig
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*
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
}

object Api {
    val service: ApiService by lazy {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BASIC
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(logging)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()

        Retrofit.Builder()
            .baseUrl("${BuildConfig.API_BASE_URL}/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }

    fun downloadUrl(buildId: String) = "${BuildConfig.API_BASE_URL}/build/$buildId/download"
}
